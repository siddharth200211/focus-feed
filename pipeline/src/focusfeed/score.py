"""Step 2, the same as apps-script/Score.gs: Gemini rates new videos 0-10 → scored_videos.

Candidates are the latest raw row of each video that could reach the feed (embeddable, ≤ 3 minutes,
inside the data rules) with no score yet for this topic and prompt version. The prompt, the
candidate query and the rows written are identical to Phase 1 (tests/test_parity.py runs both), so a
video scored by either phase counts as scored for the other.

What differs is only what Apps Script's 6-minute limit forced: here a run has up to 20 minutes to
start batches, waits out a busy Gemini in-process instead of scheduling itself again, and saves
with ordinary (waited-for) load jobs.
"""
from __future__ import annotations

import json
import math
import time
from datetime import datetime, timezone

from .collect import new_run_id
from .gemini import GeminiError
from .rules import iso, min_published, prompt_version, scoring_rules

SHORTS_MAX_SEC = 180
SCORE_CANDIDATE_LIMIT = 2000
TASTE_EXAMPLES = 8
START_BATCHES_S = 20 * 60   # no new batch after this (the job's timeout is 30 minutes)
RETRY_UNTIL_S = 25 * 60     # no Gemini retries after this
SAVE_EVERY_ROWS = 100       # a crash loses at most this many scores
IDLE_WAIT_S = 3 * 60        # every model busy: wait, then start again from the main model
IDLE_ROUNDS_MAX = 3
SCORE_SCHEMA = {
    "type": "ARRAY",
    "items": {
        "type": "OBJECT",
        "properties": {
            "id": {"type": "STRING"},
            "score": {"type": "INTEGER"},
            "reason": {"type": "STRING"},
        },
        "required": ["id", "score", "reason"],
    },
}
WHY = {"server": "overloaded", "rate_limit": "rate-limited", "daily_quota": "out of daily quota", "not_found": "not found"}


# ---------- JavaScript semantics, so prompts and rows match Phase 1 byte for byte ----------

def js_json(v) -> str:
    """JSON.stringify (no spaces, non-ASCII kept)."""
    return json.dumps(v, ensure_ascii=False, separators=(",", ":"))


def js_str(v) -> str:
    """String(v) for the values that come out of Gemini or BigQuery."""
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v)


def js_cut(v, n: int) -> str:
    """String(v || '').slice(0, n): JavaScript counts UTF-16 code units, so an emoji is 2 long.
    (One difference: half an emoji at the cut is dropped, where JavaScript would keep a broken half.)"""
    s = js_str(v) if v else ""
    u = s.encode("utf-16-le", "surrogatepass")
    if len(u) <= 2 * n:
        return s
    u = u[:2 * n]
    if 0xD800 <= int.from_bytes(u[-2:], "little") <= 0xDBFF:
        u = u[:-2]
    return u.decode("utf-16-le", "surrogatepass")


def js_number(v) -> float:
    """Number(v)."""
    if v is None:
        return 0.0
    if isinstance(v, bool):
        return float(v)
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip()
    if not s:
        return 0.0
    try:
        return float(s)
    except ValueError:
        return math.nan


def js_round(x: float) -> float:
    """Math.round: halves go up (Python's round() would go to the even number)."""
    return math.floor(x + 0.5) if math.isfinite(x) else x


# ---------- prompt and query (same text as Score.gs) ----------

def scoring_prompt(topic: str, taste: dict | None, rules: list[str]) -> str:
    lines = [
        f'You curate a study feed of YouTube Shorts for someone learning "{topic}". They watch this feed instead of',
        "random Shorts, so only videos that genuinely help them learn should score high.",
        "",
        "Score each video from 0 to 10, judging only from its title, channel, description and length:",
        f"10  = teaches a specific, correct {topic} skill, tip, strategy or worked example a learner can use right away",
        f"7-9 = clearly about {topic} and educational",
        "4-6 = loosely related or thin: generic advice, motivation, mostly an advert for a course or app, score reveals, vlogs",
        f"1-3 = mentions {topic} but does not help anyone learn it",
        "0   = unrelated, clickbait or spam",
        "",
        "Do not reward hype, emojis or big claims. Reply with a JSON list holding one object per video:",
        "its id, the score, and a reason of at most 12 words.",
    ]
    if rules:
        lines += ["", "The learner's rules. Apply them strictly: a video that breaks any of them scores 2 or less."]
        lines += ["- " + r for r in rules]
    if taste:
        lines += ["",
                  "This learner also marked videos in the app. Use their taste to move a score by at most 2 points;",
                  f"relevance to {topic} always comes first, so never rate an off-topic video highly because of it."]
        if taste["liked"]:
            lines.append("Liked (JSON): " + js_json(taste["liked"]))
        if taste["disliked"]:
            lines.append('Marked "not for me" (JSON): ' + js_json(taste["disliked"]))
    return "\n".join(lines)


def candidates_sql(raw_table: str, scored_table: str) -> str:
    """Latest raw row per video → feed-eligible → not yet scored with this prompt version."""
    return f"""-- focusfeed: score candidates
SELECT video_id, title, description, channel_title, duration_sec, collected_at,
  COUNT(*) OVER () AS total_candidates
FROM (
  SELECT video_id, title, description, channel_title, duration_sec, embeddable, collected_at, published_at, language,
    ROW_NUMBER() OVER (PARTITION BY video_id ORDER BY collected_at DESC) AS rn
  FROM {raw_table}
  WHERE topic = @topic
)
WHERE rn = 1
  AND embeddable
  AND duration_sec BETWEEN 1 AND @max_duration
  AND (published_at IS NULL OR published_at >= TIMESTAMP(@min_published))
  AND (@language = '' OR language IS NULL OR STARTS_WITH(LOWER(language), @language))
  AND video_id NOT IN (
    SELECT video_id FROM {scored_table}
    WHERE topic = @topic AND prompt_version = @prompt_version
  )
ORDER BY collected_at DESC, video_id
LIMIT @max_rows"""


TASTE_TITLES_SQL = """-- focusfeed: taste titles
SELECT video_id, title, channel_title
FROM {raw}
WHERE topic = @topic AND video_id IN UNNEST(@ids)
QUALIFY ROW_NUMBER() OVER (PARTITION BY video_id ORDER BY collected_at DESC) = 1"""

LAST_VERSION_SQL = """-- focusfeed: last prompt version
SELECT prompt_version FROM {scored}
WHERE topic = @topic
ORDER BY scored_at DESC
LIMIT 1"""


def table(store, name: str) -> str:
    return f"`{store.ref(name)}`"


def candidates(cfg: dict, store, now: datetime) -> tuple[list[dict], int]:
    rows = store.query(candidates_sql(table(store, "raw_videos"), table(store, "scored_videos")), {
        "topic": cfg["TOPIC"], "prompt_version": prompt_version(cfg), "max_duration": SHORTS_MAX_SEC,
        "max_rows": SCORE_CANDIDATE_LIMIT, "min_published": min_published(cfg, now), "language": cfg["LANGUAGE_FILTER"],
    })
    return rows, (int(rows[0]["total_candidates"]) if rows else 0)


# ---------- the viewer's taste (Learn.gs) ----------

def _event_time(v) -> float:
    """events tab times: serial day numbers (Sheets API, unformatted) or ISO strings."""
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return float(v)
    try:
        return datetime.fromisoformat(str(v).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return 0.0


def viewer_marks(events: list[dict]) -> tuple[list[str], list[str]]:
    """Videos currently liked / disliked, newest mark first (viewerSignals_ in Learn.gs)."""
    like: dict[str, bool] = {}
    dislike: dict[str, bool] = {}
    last_at: dict[str, float] = {}
    for e in sorted(events, key=lambda e: _event_time(e.get("event_at"))):
        t, vid, at = e.get("event_type"), e.get("video_id"), _event_time(e.get("event_at"))
        if t in ("like", "unlike"):
            like[vid] = t == "like"
            last_at[vid] = at
        if t in ("dislike", "undislike"):
            dislike[vid] = t == "dislike"
            last_at[vid] = at

    def on(m):
        return sorted([k for k, v in m.items() if v is True], key=lambda k: last_at[k], reverse=True)

    return on(like), on(dislike)


def taste_profile(events: list[dict], lookup) -> dict | None:
    """The newest liked and disliked videos (title + channel) for the prompt. lookup(ids) → {id: row}."""
    liked, disliked = viewer_marks(events)
    if not liked and not disliked:
        return None
    by_id = lookup(liked + disliked)

    def pick(ids):
        return [{"title": js_cut(js_str(by_id[i].get("title")), 120), "channel": js_cut(by_id[i].get("channel_title"), 60)}
                for i in [i for i in ids if i in by_id][:TASTE_EXAMPLES]]

    taste = {"liked": pick(liked), "disliked": pick(disliked)}
    return taste if taste["liked"] or taste["disliked"] else None


def title_lookup(cfg: dict, store):
    def lookup(ids: list[str]) -> dict:
        if not ids:
            return {}
        rows = store.query(TASTE_TITLES_SQL.format(raw=table(store, "raw_videos")), {"topic": cfg["TOPIC"], "ids": ids})
        return {r["video_id"]: r for r in rows}
    return lookup


# ---------- one Gemini call ----------

def score_row(cfg: dict, run: dict, video_id: str, score, reason: str, model: str, now: datetime | None = None) -> dict:
    return {
        "run_id": run["run_id"],
        "scored_at": iso(now or datetime.now(timezone.utc)),
        "topic": cfg["TOPIC"],
        "video_id": video_id,
        "score": score,
        "reason": reason,
        "model": model,
        "prompt_version": prompt_version(cfg),
    }


def score_batch(cfg: dict, run: dict, batch: list[dict], gemini, model: str, last_model: bool,
                taste: dict | None, deadline: float) -> dict:
    """Up to SCORE_BATCH_SIZE videos in one call. Short numeric IDs keep the model from mangling YouTube IDs."""
    items = [{"id": str(i + 1), "title": js_cut(v.get("title"), 200), "channel": js_cut(v.get("channel_title"), 80),
              "description": js_cut(v.get("description"), 300), "seconds": v.get("duration_sec")}
             for i, v in enumerate(batch)]
    res = gemini.json(model=model, system=scoring_prompt(cfg["TOPIC"], taste, scoring_rules(cfg)), user=js_json(items),
                      schema=SCORE_SCHEMA, max_attempts=4 if last_model else 2, deadline=deadline, no_thinking=True)
    data = res["data"]
    if not isinstance(data, list):
        raise GeminiError("output", "expected a JSON list")
    by_id: dict[str, dict] = {}
    for x in data:
        if isinstance(x, dict) and "id" in x and js_str(x["id"]) not in by_id:
            by_id[js_str(x["id"])] = x
    used = res.get("model_version") or model
    rows = []
    for i, v in enumerate(batch):
        x = by_id.get(str(i + 1))
        s = js_round(js_number(x["score"])) if x and "score" in x else math.nan
        if math.isfinite(s) and 0 <= s <= 10:
            rows.append(score_row(cfg, run, v["video_id"], int(s), js_cut(x.get("reason"), 200), used))
        else:
            rows.append(score_row(cfg, run, v["video_id"], None, "model skipped this video", used))
    return {"rows": rows, "model": used, "ms": res.get("ms") or 0}


# ---------- the step ----------

def score(cfg: dict, store, gemini, events=None, now: datetime | None = None,
          clock=time.monotonic, sleep=time.sleep) -> dict:
    """events: a callable returning the events tab rows (for the taste profile), or None."""
    now = now or datetime.now(timezone.utc)
    t0 = clock()
    run = {"run_id": new_run_id(now), "step": "score", "started_at": iso(now), "finished_at": None,
           "status": "ok", "rows_in": 0, "rows_out": 0, "quota_units": 0, "message": ""}
    notes: list[str] = []
    stats = {"total": 0, "calls": 0, "call_ms": 0, "models_used": [], "notes": notes, "failures": [], "stopped": None,
             "titles": {}, "rows": [], "run": run, "min_score": cfg["MIN_SCORE"]}
    unsaved: list[dict] = []
    saves = 0

    def save():
        nonlocal unsaved, saves
        if unsaved:
            saves += 1
            run["rows_out"] += store.load_rows("scored_videos", unsaved, f"focusfeed_scored_videos_{run['run_id']}_{saves}")
            unsaved = []

    def keep(rows):
        nonlocal unsaved
        stats["rows"].extend(rows)
        unsaved = unsaved + rows
        if len(unsaved) >= SAVE_EVERY_ROWS:
            save()

    # Main model first, then the fallbacks. Out of quota or not found: skipped for the rest of the run.
    models: list[str] = []
    for m in [cfg["GEMINI_MODEL"], *cfg["GEMINI_FALLBACK_MODELS"]]:
        if m and m.lower() != "none" and m not in models:
            models.append(m)
    dead: set[str] = set()
    failure = None
    try:
        version = prompt_version(cfg)
        cands, stats["total"] = candidates(cfg, store, now)
        taste = None
        if cands and events is not None:
            try:
                taste = taste_profile(events(), title_lookup(cfg, store))
            except Exception as e:  # noqa: BLE001 - taste is a bonus, never a reason to fail
                notes.append(f"taste skipped: {str(e)[:150]}")
        if cands:
            last = store.query(LAST_VERSION_SQL.format(scored=table(store, "scored_videos")), {"topic": cfg["TOPIC"]})
            if last and last[0]["prompt_version"] != version:
                notes.append(f"new scoring rules (version {version}): every video is re-scored once")
        if taste:
            notes.append(f"taste: {len(taste['liked'])} liked, {len(taste['disliked'])} disliked examples in the prompt")
        for v in cands:
            stats["titles"][v["video_id"]] = v.get("title")

        size = cfg["SCORE_BATCH_SIZE"]
        current, idle_rounds, i = 0, 0, 0
        while i < len(cands):
            if clock() - t0 > START_BATCHES_S:
                notes.append(f"stopped starting batches after {START_BATCHES_S // 60} minutes; the rest is scored on the next run")
                break
            batch = cands[i:i + size]
            model = models[current]
            later = [j for j in range(current + 1, len(models)) if models[j] not in dead]
            run["rows_in"] += len(batch)
            try:
                res = score_batch(cfg, run, batch, gemini, model, not later, taste, t0 + RETRY_UNTIL_S)
            except GeminiError as e:
                if e.kind in WHY:
                    run["rows_in"] -= len(batch)
                    stats["failures"].append(e.kind)
                    if e.kind in ("daily_quota", "not_found"):
                        dead.add(model)
                    detail = f"{model} {WHY[e.kind]} ({str(e)[:120]})"
                    if later:
                        notes.append(f"{detail}; switched to {models[later[0]]}")
                        current = later[0]
                        continue
                    notes.append(detail)
                    live = [m for m in models if m not in dead]
                    if not live:
                        if all(k == "not_found" for k in stats["failures"]):
                            raise RuntimeError(f"None of the Gemini models exist ({', '.join(models)}). "
                                               "Fix GEMINI_MODEL / GEMINI_FALLBACK_MODELS in Settings.") from e
                        stats["stopped"] = "quota"
                        notes.append("every Gemini model is out of daily quota; the rest is scored on the next run")
                        break
                    if idle_rounds >= IDLE_ROUNDS_MAX or clock() - t0 + IDLE_WAIT_S > START_BATCHES_S:
                        stats["stopped"] = "busy"
                        notes.append("no Gemini model is available right now; the rest is scored on the next run")
                        break
                    idle_rounds += 1
                    notes.append(f"every model busy: waiting {IDLE_WAIT_S // 60} min ({idle_rounds}/{IDLE_ROUNDS_MAX})")
                    sleep(IDLE_WAIT_S)
                    current = models.index(live[0])
                    continue
                if e.kind == "output":
                    # Unusable answer for this batch: record it so these videos aren't retried forever.
                    stats["calls"] += 1
                    run["quota_units"] += 1
                    keep([score_row(cfg, run, v["video_id"], None, f"no usable score: {e}", model) for v in batch])
                    notes.append(f"one batch got no usable answer ({e})")
                    i += size
                    continue
                run["rows_in"] -= len(batch)
                raise  # bad key or bad request: nothing later will work either
            stats["calls"] += 1
            stats["call_ms"] += res["ms"]
            run["quota_units"] += 1
            if res["model"] not in stats["models_used"]:
                stats["models_used"].append(res["model"])
            keep(res["rows"])
            idle_rounds = 0
            i += size
    except Exception as e:  # noqa: BLE001 - saved and logged below, then raised
        failure = e
    try:
        save()  # the rest, even if the run failed part-way
    except Exception as e:  # noqa: BLE001
        failure = failure or e
    run["status"] = "error" if failure else "ok"
    stats["avg_s"] = round(stats["call_ms"] / stats["calls"] / 1000) if stats["calls"] else 0
    if stats["calls"]:
        notes.append(f"avg {stats['avg_s']}s per Gemini call")
    run["message"] = ((str(failure) + ("; " if notes else "")) if failure else "") + "; ".join(notes)
    run["message"] = run["message"][:1000]
    run["finished_at"] = iso(datetime.now(timezone.utc))
    store.log_run(run)
    if failure:
        raise failure
    stats["left"] = max(0, stats["total"] - len(stats["rows"]))
    return stats


def summary(r: dict) -> list[str]:
    """What the GitHub Actions log shows (scoreSummary_ in Score.gs)."""
    n = lambda x: f"{x:,}"  # noqa: E731
    run = r["run"]
    if not r["total"]:
        return ["Nothing new to score. Run collect first, or wait for the next daily run.", f"Run ID: {run['run_id']}"]
    if not r["rows"]:
        return [f"Nothing scored yet: {n(r['total'])} videos are waiting for the next run.",
                *[f"note: {x}" for x in r["notes"]], f"Run ID: {run['run_id']}"]
    scored = [x for x in r["rows"] if x["score"] is not None]
    band = lambda lo, hi: sum(1 for x in scored if lo <= x["score"] <= hi)  # noqa: E731
    lines = [
        f"Scored {n(len(scored))} videos in {r['calls']} Gemini calls ({', '.join(r['models_used']) or 'Gemini'})",
        f"{n(sum(1 for x in scored if x['score'] >= r['min_score']))} scored {r['min_score']} or more (MIN_SCORE): these can reach the feed",
        f"Spread: 0-3: {band(0, 3)} · 4-6: {band(4, 6)} · 7-8: {band(7, 8)} · 9-10: {band(9, 10)}",
        f"{n(run['rows_out'])} rows written to scored_videos",
    ]
    ranked = sorted(scored, key=lambda x: -x["score"])
    show = lambda x: f'"{str(r["titles"].get(x["video_id"]) or x["video_id"])[:70]}" — {x["score"]}: {x["reason"]}'  # noqa: E731
    if ranked:
        lines.append("Top: " + show(ranked[0]))
    if len(ranked) > 1:
        lines.append("Lowest: " + show(ranked[-1]))
    skipped = len(r["rows"]) - len(scored)
    if skipped:
        lines.append(f"({skipped} videos got no usable score and won't be retried)")
    if r["left"]:
        lines.append(f"{n(r['left'])} left for the next run.")
    lines += [f"note: {x}" for x in r["notes"]]
    lines.append(f"Run ID: {run['run_id']}")
    return lines
