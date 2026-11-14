"""python -m focusfeed build (dbt in-process, logged to pipeline_runs) and compare."""
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace as NS

import pytest

from conftest import FakeStore
from focusfeed import build, compare, rules
from test_dbt import NOW, add_rows, fixture_rows, make_db, settings


class CountStore(FakeStore):
    def __init__(self, n=42):
        super().__init__()
        self.n, self.sql = n, []

    def query(self, sql, params=None):
        self.sql.append((sql, params))
        return [{"n": self.n}]


def node(kind, name, status, message=None, billed=None):
    return NS(node=NS(resource_type=kind, name=name), status=status, message=message,
              adapter_response={"bytes_billed": billed} if billed is not None else {})


class FakeRunner:
    def __init__(self, build_results, fresh_results=(), success=True, fresh_success=True):
        self.calls = []
        self.answers = [NS(success=success, exception=None, result=NS(results=list(build_results))),
                        NS(success=fresh_success, exception=None, result=NS(results=list(fresh_results)))]

    def invoke(self, args):
        self.calls.append(args)
        return self.answers[len(self.calls) - 1]


def test_build_passes_settings_and_logs_the_run(monkeypatch):
    monkeypatch.delenv("FOCUSFEED_PROJECT", raising=False)
    cfg = settings(BQ_PROJECT_ID="my-project", BQ_DATASET="focus_feed_v2", LANGUAGE_FILTER="en")
    store = CountStore(213)
    runner = FakeRunner([node("model", "feed", "success", billed=10_485_760), node("model", "dim_videos", "success"),
                         node("test", "unique_feed_video_id", "pass")], [node("source", "raw_videos", "pass")])
    out = build.build(cfg, store, runner, now=NOW)
    args = runner.calls[0]
    assert args[:3] == ["build", "--exclude-resource-type", "unit_test"]
    assert args[args.index("--target") + 1] == "prod"
    assert __import__("json").loads(args[args.index("--vars") + 1]) == build.dbt_vars(cfg, NOW)
    assert runner.calls[1][:2] == ["source", "freshness"]
    import os
    assert (os.environ["FOCUSFEED_PROJECT"], os.environ["FOCUSFEED_DATASET"]) == ("my-project", "focus_feed_v2")
    run = store.runs[0]
    assert (run["step"], run["status"], run["rows_in"], run["rows_out"]) == ("build_feed", "ok", 2, 213)
    assert run["message"] == "dbt: 2 models, 1 tests, 10.5 MB billed"
    assert "Feed built: 213 videos in focus_feed_v2.feed" in build.summary(out, cfg)
    assert "`p.d.feed`" in store.sql[0][0] and store.sql[0][1] == {"topic": "TOEFL"}


def test_failed_model_or_test_fails_the_run():
    store = CountStore()
    runner = FakeRunner([node("model", "feed", "error", "Syntax error: Unexpected keyword"),
                         node("test", "unique_feed_video_id", "fail", "Got 2 results")], success=False)
    out = build.build(settings(), store, runner, now=NOW)
    assert store.runs[0]["status"] == "error"
    assert out["failed"] == ["feed: Syntax error: Unexpected keyword", "unique_feed_video_id: Got 2 results"]
    assert "FAILED feed: Syntax error: Unexpected keyword" in build.summary(out, settings())


def test_stale_sources_warn_or_fail():
    warn = build.build(settings(), CountStore(), FakeRunner([], [node("source", "scored_videos", "warn")]), now=NOW)
    assert warn["run"]["status"] == "ok" and warn["stale"] == ["scored_videos: warn"]
    err = build.build(settings(), CountStore(), FakeRunner([], [node("source", "raw_videos", "error")]), now=NOW)
    assert err["run"]["status"] == "error" and "stale raw_videos: error" in err["run"]["message"]


def test_dbt_crash_is_logged_not_lost():
    class Boom:
        def invoke(self, args):
            raise RuntimeError("profiles.yml not found")
    store = CountStore()
    out = build.build(settings(), store, Boom(), now=NOW)
    assert store.runs[0]["status"] == "error" and out["failed"] == ["RuntimeError: profiles.yml not found"]


def test_build_end_to_end_with_real_dbt_on_duckdb(tmp_path, monkeypatch):
    """The real dbtRunner: result objects, statuses and freshness as dbt reports them."""
    from dbt.cli.main import dbtRunner

    monkeypatch.setenv("FOCUSFEED_DUCKDB", str(tmp_path / "e2e.duckdb"))
    monkeypatch.setenv("DBT_TARGET_PATH", str(tmp_path / "target"))
    monkeypatch.setenv("DBT_LOG_PATH", str(tmp_path / "logs"))
    cfg = settings()
    raw, scored = fixture_rows()
    for s in scored:
        s["prompt_version"] = s["prompt_version"] or rules.prompt_version(cfg)
    make_db(tmp_path / "e2e.duckdb", raw, scored)

    out = build.build(cfg, CountStore(), dbtRunner(), now=NOW, target="ci")
    assert out["failed"] == [] and out["models"] == 9 and out["tests"] > 10
    assert "raw_videos: error" in out["stale"], "the fixture's newest collection is weeks old"
    assert out["run"]["status"] == "error"

    import duckdb
    con = duckdb.connect(str(tmp_path / "e2e.duckdb"))
    add_rows(con, "raw_videos", [dict(raw[0], run_id="py-today", collected_at=datetime.now(timezone.utc))])
    add_rows(con, "scored_videos", [dict(scored[0], run_id="py-today", scored_at=datetime.now(timezone.utc))])
    con.close()
    out = build.build(cfg, CountStore(), dbtRunner(), now=NOW, target="ci")
    assert out["stale"] == [] and out["run"]["status"] == "ok"


class CompareStore(FakeStore):
    def query(self, sql, params=None):
        self.last = (sql, params)
        if "compare feeds" in sql:
            assert "`p.focus_feed.feed`" in sql and "`p.focus_feed_v2.feed`" in sql
            return [{"in_both": 200, "only_v1": 13, "only_v2": 9, "same_score": 190,
                     "sample_only_v1": [{"video_id": "aaaaaaaaaaa", "title": "Old pick", "score": 7}],
                     "sample_only_v2": []}]
        assert "score agreement" in sql and params["min_score"] == 7
        return [{"scored_by_both": 109, "same": 70, "within_one": 101, "cross_min_score": 6}]


def test_compare_reports_overlap_and_score_agreement():
    cfg = settings(BQ_PROJECT_ID="p", BQ_DATASET="focus_feed_v2")
    lines = compare.compare(cfg, CompareStore(), "focus_feed")
    text = "\n".join(lines)
    assert "Phase 1 (focus_feed) 213 videos · Phase 2 (focus_feed_v2) 209 videos" in text
    assert "in both: 200 (94% of the larger) · only Phase 1: 13 · only Phase 2: 9" in text
    assert "only in Phase 1: aaaaaaaaaaa (7) Old pick" in text
    assert "same score: 64% · within 1 point: 93% · on different sides of MIN_SCORE (7): 6" in text
    with pytest.raises(ValueError):
        compare.compare(dict(cfg, BQ_DATASET="focus_feed"), CompareStore(), "focus_feed")
