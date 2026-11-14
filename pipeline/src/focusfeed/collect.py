"""Step 1, the same as apps-script/Collect.gs: rotating searches → video details → raw_videos."""
from __future__ import annotations

import html
import math
import re
import secrets
from datetime import datetime, timezone

from .rules import iso, min_published
from .youtube import SEARCH_UNITS, Budget, QuotaExceeded, YouTube

SEARCH_MODIFIERS = [
    "", "tips", "tricks", "explained", "in 60 seconds", "in 1 minute", "mistakes to avoid",
    "common mistakes", "practice", "practice questions", "how to", "for beginners", "advanced",
    "hacks", "examples", "quick lesson", "must know", "shortcuts", "study tips", "strategy",
    "secrets", "cheat sheet", "vocabulary", "myths", "quiz", "tutorial", "did you know", "lesson",
]
SEARCH_ORDERS = ["relevance", "viewCount", "date"]
DAY_MS = 24 * 60 * 60 * 1000


def new_run_id(now: datetime) -> str:
    return f"py-{now.strftime('%Y%m%dT%H%M%S')}_{secrets.token_hex(2)}"


def search_plan(cfg: dict, now: datetime) -> list[dict]:
    """SEARCHES_PER_DAY (term, order) pairs rotating through every combination, day by day."""
    seen, terms = set(), []
    for t in [cfg["TOPIC"], *cfg["SEARCH_TERMS"], *[f"{cfg['TOPIC']} {m}" for m in SEARCH_MODIFIERS if m]]:
        if t.lower() not in seen:
            seen.add(t.lower())
            terms.append(t)
    combos = [{"term": t, "order": o} for t in terms for o in SEARCH_ORDERS]
    n = min(cfg["SEARCHES_PER_DAY"], len(combos))
    day = math.floor(now.timestamp() * 1000 / DAY_MS)
    start = (day * n) % len(combos)
    return [combos[(start + i) % len(combos)] for i in range(n)]


def parse_iso_duration(s: str | None) -> int | None:
    m = re.fullmatch(r"P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?", s or "")
    if not m:
        return None
    d, h, mi, se = (int(x) if x else 0 for x in m.groups())
    return d * 86400 + h * 3600 + mi * 60 + se


def collect(cfg: dict, store, youtube: YouTube, budget: Budget | None = None, now: datetime | None = None) -> dict:
    now = now or datetime.now(timezone.utc)
    budget = budget or Budget(store)
    run = {"run_id": new_run_id(now), "step": "collect", "started_at": iso(now), "finished_at": None,
           "status": "ok", "rows_in": 0, "rows_out": 0, "quota_units": 0, "message": ""}
    notes: list[str] = []
    stats = {"searches": 0, "unique": 0, "embeddable_shorts": 0, "notes": notes, "run": run}
    try:
        published_after = min_published(cfg, now) if cfg["MAX_VIDEO_AGE_DAYS"] > 0 else None
        hits, seen, failures = [], set(), 0
        for s in search_plan(cfg, now):
            if not budget.can_spend(SEARCH_UNITS + 1):
                notes.append("stopped early: daily YouTube quota budget reached")
                break
            budget.spend(SEARCH_UNITS)
            run["quota_units"] += SEARCH_UNITS
            try:
                items = youtube.search(s["term"], s["order"], cfg["SEARCH_LANGUAGE"], published_after)
            except QuotaExceeded:
                notes.append("stopped: YouTube says the daily quota is used up")
                break
            except Exception as e:  # noqa: BLE001
                failures += 1
                notes.append(f'search "{s["term"]}" failed: {e}')
                if failures >= 3:
                    raise RuntimeError(f"YouTube search failed 3 times: {e}") from e
                continue
            stats["searches"] += 1
            run["rows_in"] += 1
            for item in items:
                vid = (item.get("id") or {}).get("videoId")
                if vid and vid not in seen:
                    seen.add(vid)
                    hits.append({"video_id": vid, "term": s["term"], "snippet": item.get("snippet") or {}})

        details: dict[str, dict] = {}
        for i in range(0, len(hits), 50):
            budget.spend(1)
            run["quota_units"] += 1
            for v in youtube.videos([h["video_id"] for h in hits[i:i + 50]]):
                stats_ = v.get("statistics") or {}
                sn = v.get("snippet") or {}
                details[v["id"]] = {
                    "duration_sec": parse_iso_duration((v.get("contentDetails") or {}).get("duration")),
                    "embeddable": bool((v.get("status") or {}).get("embeddable")),
                    "view_count": int(stats_["viewCount"]) if "viewCount" in stats_ else None,
                    "like_count": int(stats_["likeCount"]) if "likeCount" in stats_ else None,
                    "language": sn.get("defaultAudioLanguage") or sn.get("defaultLanguage") or None,
                }
        rows = [raw_row(cfg, run, h, details.get(h["video_id"], {})) for h in hits]
        stats["unique"] = len(rows)
        stats["embeddable_shorts"] = sum(1 for r in rows if r["embeddable"] and r["duration_sec"] and 0 < r["duration_sec"] <= 180)
        run["rows_out"] = store.load_rows("raw_videos", rows, f"focusfeed_raw_videos_{run['run_id']}")
        run["message"] = "; ".join(notes)
    except Exception as e:
        run["status"] = "error"
        run["message"] = str(e)[:1000]
        raise
    finally:
        run["finished_at"] = iso(datetime.now(timezone.utc))
        store.log_run(run)
    return stats


def raw_row(cfg: dict, run: dict, hit: dict, d: dict) -> dict:
    sn = hit["snippet"]
    thumbs = sn.get("thumbnails") or {}
    thumb = thumbs.get("high") or thumbs.get("medium") or thumbs.get("default") or {}
    return {
        "run_id": run["run_id"],
        "collected_at": run["started_at"],
        "topic": cfg["TOPIC"],
        "search_term": hit["term"],
        "video_id": hit["video_id"],
        "title": html.unescape(sn.get("title") or ""),
        "description": html.unescape(sn.get("description") or ""),
        "channel_id": sn.get("channelId"),
        "channel_title": html.unescape(sn.get("channelTitle") or ""),
        "published_at": sn.get("publishedAt"),
        "duration_sec": d.get("duration_sec"),
        "embeddable": d.get("embeddable"),
        "view_count": d.get("view_count"),
        "like_count": d.get("like_count"),
        "thumbnail_url": thumb.get("url"),
        "language": d.get("language"),
    }
