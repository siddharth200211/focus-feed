"""The score step's control flow: batching, saving, model fallback, quotas, waits and logging."""
from datetime import datetime, timezone

import pytest

from conftest import FakeStore
from focusfeed import score
from focusfeed.gemini import GeminiError
from focusfeed.rules import prompt_version

NOW = datetime(2026, 11, 14, 9, 15, tzinfo=timezone.utc)


class ScoreStore(FakeStore):
    def __init__(self, n=60, last_version=None, titles=()):
        super().__init__()
        self.cands = [{"video_id": f"v{i:010d}", "title": f"title {i}", "description": "d", "channel_title": "c",
                       "duration_sec": 40, "collected_at": NOW, "total_candidates": n + 5} for i in range(n)]
        self.last_version, self.titles, self.sql = last_version, list(titles), []

    def query(self, sql, params=None):
        self.sql.append((sql.splitlines()[0], params))
        if sql.startswith("-- focusfeed: score candidates"):
            return self.cands
        if sql.startswith("-- focusfeed: last prompt version"):
            return [{"prompt_version": self.last_version}] if self.last_version else []
        if sql.startswith("-- focusfeed: taste titles"):
            return [{"video_id": i, "title": f"liked {i}", "channel_title": "ch"} for i in params["ids"] if i in self.titles]
        raise AssertionError(sql)


class FakeGemini:
    """Scores every video 8. plan: {call number: error kind or callable(model) -> kind|None}."""

    def __init__(self, plan=None, always=None):
        self.calls, self.plan, self.always = [], plan or {}, always or {}

    def json(self, model, system, user, schema, max_attempts, deadline, no_thinking):
        self.calls.append({"model": model, "system": system, "max_attempts": max_attempts, "deadline": deadline})
        kind = self.always.get(model) or self.plan.get(len(self.calls))
        if kind:
            raise GeminiError(kind, f"{kind} on {model}")
        items = __import__("json").loads(user)
        return {"data": [{"id": x["id"], "score": 8, "reason": "good"} for x in items], "model_version": model + "-001", "ms": 2000}


class Clock:
    def __init__(self, step=0.0):
        self.t, self.step, self.slept = 1000.0, step, []

    def __call__(self):
        self.t += self.step
        return self.t

    def sleep(self, s):
        self.slept.append(s)
        self.t += s


def run(cfg, store, gem, events=None, clock=None):
    clock = clock or Clock()
    return score.score(cfg, store, gem, events=events, now=NOW, clock=clock, sleep=clock.sleep), clock


@pytest.fixture
def cfg(cfg):
    cfg["GEMINI_MODEL"], cfg["GEMINI_FALLBACK_MODELS"] = "main", ["backup"]
    return cfg


def test_scores_in_batches_saves_and_logs(cfg):
    store, gem = ScoreStore(60), FakeGemini()
    s, _ = run(cfg, store, gem)
    rows = store.rows["scored_videos"]
    assert len(gem.calls) == 3 and len(rows) == 60 and len(store.jobs) == 1
    assert {r["prompt_version"] for r in rows} == {prompt_version(cfg)} and rows[0]["model"] == "main-001"
    assert rows[0]["scored_at"].endswith("Z") and rows[0]["run_id"].startswith("py-")
    log = store.runs[0]
    assert (log["step"], log["status"], log["rows_in"], log["rows_out"], log["quota_units"]) == ("score", "ok", 60, 60, 3)
    assert s["left"] == 5 and s["models_used"] == ["main-001"]
    params = store.sql[0][1]
    assert params["max_duration"] == 180 and params["max_rows"] == 2000 and params["prompt_version"] == prompt_version(cfg)
    assert gem.calls[0]["max_attempts"] == 2, "a fallback exists, so don't sit out a rate limit"


def test_saves_every_100_rows_with_unique_job_ids(cfg):
    store = ScoreStore(250)
    run(cfg, store, FakeGemini())
    assert sorted(store.jobs) == [f"focusfeed_scored_videos_{store.runs[0]['run_id']}_{n}" for n in (1, 2, 3)]
    assert len(store.rows["scored_videos"]) == 250


def test_nothing_to_score_makes_no_calls(cfg):
    store, gem = ScoreStore(0), FakeGemini()
    s, _ = run(cfg, store, gem)
    assert gem.calls == [] and "scored_videos" not in store.rows and s["total"] == 0
    assert store.runs[0]["status"] == "ok"
    assert score.summary(s)[0].startswith("Nothing new to score")


def test_overloaded_main_model_hands_over_to_the_fallback(cfg):
    store, gem = ScoreStore(60), FakeGemini(plan={2: "server"})
    s, _ = run(cfg, store, gem)
    assert [c["model"] for c in gem.calls] == ["main", "main", "backup", "backup"]
    assert gem.calls[2]["max_attempts"] == 4, "last model left: wait out rate limits"
    assert len(store.rows["scored_videos"]) == 60 and store.runs[0]["rows_in"] == 60
    assert any("main overloaded" in n and "switched to backup" in n for n in s["notes"])
    assert s["models_used"] == ["main-001", "backup-001"]


def test_every_model_out_of_daily_quota_stops_cleanly(cfg):
    store, gem = ScoreStore(100), FakeGemini(plan={3: "daily_quota", 4: "daily_quota"})
    s, _ = run(cfg, store, gem)
    assert s["stopped"] == "quota" and len(store.rows["scored_videos"]) == 50 and s["left"] == 55
    assert store.runs[0]["status"] == "ok" and store.runs[0]["quota_units"] == 2
    assert "out of daily quota; the rest is scored on the next run" in store.runs[0]["message"]


def test_no_model_exists_is_a_settings_error(cfg):
    store = ScoreStore(10)
    with pytest.raises(RuntimeError, match="None of the Gemini models exist"):
        run(cfg, store, FakeGemini(always={"main": "not_found", "backup": "not_found"}))
    assert store.runs[0]["status"] == "error" and "GEMINI_FALLBACK_MODELS" in store.runs[0]["message"]


def test_busy_models_are_waited_for_then_retried(cfg):
    store, gem = ScoreStore(50), FakeGemini(plan={2: "server", 3: "rate_limit"})
    s, clock = run(cfg, store, gem)
    assert clock.slept == [score.IDLE_WAIT_S]
    assert [c["model"] for c in gem.calls] == ["main", "main", "backup", "main"]
    assert len(store.rows["scored_videos"]) == 50 and s["stopped"] is None


def test_busy_for_too_long_gives_up_for_today(cfg):
    store, gem = ScoreStore(50), FakeGemini(always={"main": "server", "backup": "server"})
    s, clock = run(cfg, store, gem)
    assert clock.slept == [score.IDLE_WAIT_S] * score.IDLE_ROUNDS_MAX
    assert s["stopped"] == "busy" and "scored_videos" not in store.rows and store.runs[0]["status"] == "ok"
    assert store.runs[0]["rows_in"] == 0
    assert score.summary(s)[0] == "Nothing scored yet: 55 videos are waiting for the next run."


def test_quota_on_one_and_busy_on_the_other_waits_only_for_the_busy_one(cfg):
    store, gem = ScoreStore(25), FakeGemini(plan={1: "daily_quota", 2: "server"})
    s, clock = run(cfg, store, gem)
    assert [c["model"] for c in gem.calls] == ["main", "backup", "backup"]
    assert clock.slept == [score.IDLE_WAIT_S] and len(store.rows["scored_videos"]) == 25


def test_unusable_answer_is_recorded_once_not_retried_forever(cfg):
    store, gem = ScoreStore(50), FakeGemini(plan={1: "output"})
    s, _ = run(cfg, store, gem)
    rows = store.rows["scored_videos"]
    assert len(rows) == 50 and sum(r["score"] is None for r in rows) == 25
    assert rows[0]["reason"].startswith("no usable score: ") and store.runs[0]["quota_units"] == 2
    assert "(25 videos got no usable score and won't be retried)" in score.summary(s)


def test_bad_key_fails_the_run_but_keeps_what_was_scored(cfg):
    store = ScoreStore(75)
    with pytest.raises(GeminiError, match="request"):
        run(cfg, store, FakeGemini(plan={3: "request"}))
    assert len(store.rows["scored_videos"]) == 50
    log = store.runs[0]
    assert (log["status"], log["rows_in"], log["rows_out"]) == ("error", 50, 50) and log["message"].startswith("request on main")


def test_time_budget_stops_new_batches(cfg):
    store = ScoreStore(500)
    s, _ = run(cfg, store, FakeGemini(), clock=Clock(step=200))
    assert 0 < len(store.rows["scored_videos"]) < 500
    assert any("stopped starting batches after 20 minutes" in n for n in s["notes"])
    assert s["left"] == 505 - len(store.rows["scored_videos"])


def test_retry_deadline_is_passed_to_gemini(cfg):
    gem = FakeGemini()
    _, clock = run(cfg, ScoreStore(10), gem)
    assert gem.calls[0]["deadline"] == pytest.approx(1000 + score.RETRY_UNTIL_S, abs=1)


def test_taste_from_the_events_tab_goes_into_the_prompt(cfg):
    store = ScoreStore(10, titles=["v0000000001"])
    events = [{"event_at": 45960.5, "video_id": "v0000000001", "event_type": "like"},
              {"event_at": 45961.5, "video_id": "unknown0000", "event_type": "dislike"}]
    gem = FakeGemini()
    s, _ = run(cfg, store, gem, events=lambda: events)
    assert 'Liked (JSON): [{"title":"liked v0000000001","channel":"ch"}]' in gem.calls[0]["system"]
    assert "not for me" not in gem.calls[0]["system"]
    assert "taste: 1 liked, 0 disliked examples in the prompt" in s["notes"]


def test_unreadable_events_tab_only_skips_the_taste(cfg):
    def boom():
        raise RuntimeError("403 Forbidden")
    gem = FakeGemini()
    s, _ = run(cfg, ScoreStore(10), gem, events=boom)
    assert "taste skipped: 403 Forbidden" in s["notes"] and "Liked" not in gem.calls[0]["system"]
    assert len(gem.calls) == 1


def test_changed_rules_are_announced(cfg):
    s, _ = run(cfg, ScoreStore(10, last_version="v1-oldold"), FakeGemini())
    assert any(n.startswith(f"new scoring rules (version {prompt_version(cfg)})") for n in s["notes"])
    s2, _ = run(cfg, ScoreStore(10, last_version=prompt_version(cfg)), FakeGemini())
    assert not any("new scoring rules" in n for n in s2["notes"])


def test_none_disables_fallback(cfg):
    cfg["GEMINI_FALLBACK_MODELS"] = ["none"]
    store, gem = ScoreStore(25), FakeGemini(always={"main": "daily_quota"})
    s, _ = run(cfg, store, gem)
    assert [c["model"] for c in gem.calls] == ["main"] and s["stopped"] == "quota"
    assert gem.calls[0]["max_attempts"] == 4


def test_summary_reads_well(cfg):
    s, _ = run(cfg, ScoreStore(30), FakeGemini())
    text = "\n".join(score.summary(s))
    assert "Scored 30 videos in 2 Gemini calls (main-001)" in text
    assert "30 scored 7 or more (MIN_SCORE)" in text and "Spread: 0-3: 0 · 4-6: 0 · 7-8: 30 · 9-10: 0" in text
    assert 'Top: "title 0" — 8: good' in text and "5 left for the next run." in text
