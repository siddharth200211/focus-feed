"""The dbt project, run end to end on DuckDB (no Google account needed).

- The feed dbt builds must equal what Phase 1 builds from the same rows: buildFeedRows_ from the
  real apps-script/Feed.gs, with the vars `python -m focusfeed build` would pass.
- dim_videos built incrementally, day by day, must equal a full rebuild (late rows included).
- The dbt unit tests and data tests pass.
"""
import json
import os
import random
import shutil
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from conftest import gas
from focusfeed import build, rules
from focusfeed.schema import TABLES

duckdb = pytest.importorskip("duckdb")
pytest.importorskip("dbt.adapters.duckdb")

DBT = str(Path(sys.executable).with_name("dbt")) if Path(sys.executable).with_name("dbt").exists() else shutil.which("dbt")
NOW = datetime(2026, 11, 14, 9, 15, tzinfo=timezone.utc)
DUCK_TYPES = {"STRING": "VARCHAR", "INT64": "BIGINT", "BOOL": "BOOLEAN", "TIMESTAMP": "TIMESTAMPTZ"}


def iso(dt):
    return rules.iso(dt) if dt else None


def make_db(path, raw, scored, events=(), runs=()):
    con = duckdb.connect(str(path))
    for name, spec in TABLES.items():
        con.execute(f"create or replace table main.{name} ({', '.join(f'{n} {DUCK_TYPES[t]}' for n, t, _, _ in spec['fields'])})")
    add_rows(con, "raw_videos", raw)
    add_rows(con, "scored_videos", scored)
    add_rows(con, "events", events)
    add_rows(con, "pipeline_runs", runs)
    con.close()


def add_rows(con, table, rows):
    cols = [f[0] for f in TABLES[table]["fields"]]
    if rows:
        con.executemany(f"insert into main.{table} ({', '.join(cols)}) values ({', '.join('?' * len(cols))})",
                        [[r.get(c) for c in cols] for r in rows])


def dbt(path, *args, vars_=None):
    env = dict(os.environ, FOCUSFEED_DUCKDB=str(path), DBT_SEND_ANONYMOUS_USAGE_STATS="false")
    cmd = [DBT, *args, "--project-dir", str(build.DBT_DIR), "--profiles-dir", str(build.DBT_DIR), "--target", "ci",
           "--target-path", str(Path(path).with_suffix(".target")), "--log-path", str(Path(path).with_suffix(".logs"))]
    if vars_ is not None:
        cmd += ["--vars", json.dumps(vars_)]
    out = subprocess.run(cmd, env=env, capture_output=True, text=True, encoding="utf-8", errors="replace")
    assert out.returncode == 0, out.stdout[-4000:] + out.stderr[-2000:]
    return out.stdout


def query(path, sql):
    con = duckdb.connect(str(path), read_only=True)
    cur = con.execute(sql)
    cols = [d[0] for d in cur.description]
    rows = [dict(zip(cols, r)) for r in cur.fetchall()]
    con.close()
    return rows


def fixture_rows(seed=7):
    """Raw and scored rows that exercise every feed rule, with no ties in time."""
    rnd = random.Random(seed)
    raw, scored = [], []
    t0 = NOW - timedelta(days=20)
    for i in range(300):
        vid = f"vid{i:08d}"
        topic = "TOEFL" if i % 17 else "IELTS"
        for k in range(1 + i % 3):  # collected 1-3 times; details change between collections
            raw.append({
                "run_id": f"r{k}", "collected_at": t0 + timedelta(days=3 * k, minutes=i), "topic": topic,
                "search_term": "TOEFL tips", "video_id": vid, "title": f"Title {i}.{k}", "description": "d",
                "channel_id": f"UC{i % 9}", "channel_title": None if i % 23 == 0 else f"Channel {i % 9}",
                "published_at": None if i % 19 == 0 else NOW - timedelta(days=rnd.choice([30, 400, 900])),
                "duration_sec": rnd.choice([None, 0, 1, 45, 180, 181]) if k == 0 else rnd.choice([45, 120, 200]),
                "embeddable": None if i % 29 == 0 else (i % 11 != 0),
                "view_count": i * 10, "like_count": i, "thumbnail_url": None,
                "language": rnd.choice([None, "en", "en-US", "EN-gb", "hi", "fr"]),
            })
        for k in range(i % 4):  # 0-3 scores; some null, some under an old prompt version
            scored.append({
                "run_id": f"py-s{k}", "scored_at": t0 + timedelta(days=2 + 4 * k, minutes=i), "topic": topic,
                "video_id": vid, "score": None if (i + k) % 13 == 0 else rnd.randint(0, 10),
                "reason": f"reason {i}.{k}", "model": "m",
                "prompt_version": "v1-old000" if (i + k) % 7 == 0 else None,  # filled in per cfg below
            })
    return raw, scored


def settings(**over):
    cfg = {"TOPIC": "TOEFL", "MIN_SCORE": 7, "MAX_VIDEO_AGE_DAYS": 0, "LANGUAGE_FILTER": "", "EXCLUDE_ADS": "yes",
           "SCORING_GUIDANCE": "", "BQ_PROJECT_ID": "p", "BQ_DATASET": "d", "BQ_LOCATION": "US"}
    cfg.update(over)
    return cfg


def feed_key(r):
    return (r["video_id"], r["topic"], r["title"], r["channel_title"], r["duration_sec"], r["published_at"],
            int(r["score"]), r["reason"], r["first_seen_at"])


@pytest.mark.parametrize("over", [
    {},
    {"MIN_SCORE": 5, "LANGUAGE_FILTER": "en"},
    {"MAX_VIDEO_AGE_DAYS": 730, "SCORING_GUIDANCE": "Only the new format"},
    {"MIN_SCORE": 8, "MAX_VIDEO_AGE_DAYS": 500, "LANGUAGE_FILTER": "hi", "EXCLUDE_ADS": "no"},
])
def test_feed_matches_apps_script(tmp_path, over):
    cfg = settings(**over)
    raw, scored = fixture_rows()
    version = rules.prompt_version(cfg)
    for s in scored:
        s["prompt_version"] = s["prompt_version"] or version
    db = tmp_path / "feed.duckdb"
    make_db(db, raw, scored)
    dbt(db, "build", "--exclude-resource-type", "unit_test", vars_=build.dbt_vars(cfg, NOW))
    py = query(db, "select * from main.feed")
    for r in py:
        r["published_at"], r["first_seen_at"] = iso(r["published_at"]), iso(r["first_seen_at"])

    as_js = [{k: (iso(v) if isinstance(v, datetime) else v) for k, v in r.items()} for r in raw]
    scored_js = [{k: (iso(v) if isinstance(v, datetime) else v) for k, v in s.items()} for s in scored]
    js_cfg = {k: cfg[k] for k in ("TOPIC", "MIN_SCORE", "MAX_VIDEO_AGE_DAYS", "LANGUAGE_FILTER", "EXCLUDE_ADS",
                                    "SCORING_GUIDANCE")}
    # Feed.gs measures the age limit from "now": run it at the same moment the vars were made for.
    js = gas(f"""(() => {{ const real = Date.now; Date.now = () => {int(NOW.timestamp() * 1000)};
      try {{ return buildFeedRows_({json.dumps(js_cfg)}, {json.dumps(as_js)}, {json.dumps(scored_js)}, new Date()); }}
      finally {{ Date.now = real; }} }})()""")
    assert len(js) >= 3, "the fixture should put some videos in the feed"
    assert sorted(map(feed_key, py)) == sorted(map(feed_key, js))
    assert len({r["video_id"] for r in py}) == len(py)


def test_incremental_runs_equal_a_full_rebuild(tmp_path):
    cfg = settings()
    raw, scored = fixture_rows(seed=11)
    for s in scored:
        s["prompt_version"] = s["prompt_version"] or rules.prompt_version(cfg)
    vars_ = build.dbt_vars(cfg, NOW)
    t0 = NOW - timedelta(days=20)  # fixture_rows collects at t0, t0 + 3 days and t0 + 6 days
    cut1, cut2 = t0 + timedelta(days=2), t0 + timedelta(days=5)
    first = [r for r in raw if r["collected_at"] < cut1]
    second = [r for r in raw if cut1 <= r["collected_at"] < cut2]
    third = [r for r in raw if r["collected_at"] >= cut2]
    assert first and second and third
    late = third[:5]  # collected before the newest rows already loaded, but inside lookback_days
    for r in late:
        r["collected_at"] = cut2 - timedelta(hours=30)

    inc = tmp_path / "inc.duckdb"
    make_db(inc, first, scored)
    dbt(inc, "run", vars_=vars_)
    con = duckdb.connect(str(inc))
    add_rows(con, "raw_videos", second + third[5:])
    con.close()
    dbt(inc, "run", vars_=vars_)
    con = duckdb.connect(str(inc))
    add_rows(con, "raw_videos", late)
    con.close()
    dbt(inc, "run", vars_=vars_)

    full = tmp_path / "full.duckdb"
    make_db(full, first + second + third, scored)
    dbt(full, "run", vars_=vars_)

    dim = "select * from main.dim_videos order by topic, video_id"
    assert query(inc, dim) == query(full, dim)
    feed = "select * exclude (built_at) from main.feed order by video_id"
    assert query(inc, feed) == query(full, feed)
    assert len(query(inc, feed)) > 3


def test_unit_and_data_tests_pass(tmp_path):
    cfg = settings(LANGUAGE_FILTER="en")
    raw, scored = fixture_rows(seed=3)
    for s in scored:
        s["prompt_version"] = s["prompt_version"] or rules.prompt_version(cfg)
    events = [{"event_id": f"e{i}", "event_at": NOW - timedelta(hours=i), "video_id": "vid00000001",
               "event_type": "watch", "topic": "TOEFL", "loaded_at": NOW} for i in range(5)]
    events.append(dict(events[0], loaded_at=NOW + timedelta(hours=1)))  # a nightly load that ran twice
    runs = [{"run_id": "py-1", "step": "collect", "started_at": NOW, "finished_at": NOW + timedelta(seconds=40),
             "status": "ok", "rows_in": 50, "rows_out": 900, "quota_units": 5000},
            {"run_id": "20261114_x", "step": "score", "started_at": NOW, "finished_at": None, "status": "error"}]
    db = tmp_path / "t.duckdb"
    make_db(db, raw, scored, events, runs)
    out = dbt(db, "build", "--exclude-resource-type", "unit_test", vars_=build.dbt_vars(cfg, NOW))
    assert "ERROR=0" in out and "WARN=0" in out
    out = dbt(db, "test", "--select", "test_type:unit")
    assert "PASS=2" in out
    assert [r["event_id"] for r in query(db, "select event_id from main.fct_events where event_id = 'e0'")] == ["e0"]
    daily = query(db, "select phase, step, runs, failed_runs from main.pipeline_daily order by phase")
    assert daily == [{"phase": "apps_script", "step": "score", "runs": 1, "failed_runs": 1},
                     {"phase": "python", "step": "collect", "runs": 1, "failed_runs": 0}]


def test_settings_reach_dbt_as_vars():
    cfg = settings(MAX_VIDEO_AGE_DAYS=730, LANGUAGE_FILTER="en", SCORING_GUIDANCE="x")
    v = build.dbt_vars(cfg, NOW)
    assert v == {"topic": "TOEFL", "prompt_version": rules.prompt_version(cfg), "min_score": 7, "max_duration_sec": 180,
                 "min_published": "2024-11-14T09:15:00.000Z", "language": "en"}
    assert build.dbt_vars(settings(), NOW)["min_published"] == "1970-01-01T00:00:00.000Z"
    assert gas("SHORTS_MAX_SEC") == v["max_duration_sec"]


def test_awkward_topic_names_are_escaped(tmp_path):
    cfg = settings(TOPIC="TOEFL's \\ \"best\" -- tips")
    raw, scored = fixture_rows()
    for r in raw:
        r["topic"] = cfg["TOPIC"] if r["topic"] == "TOEFL" else r["topic"]
    for s in scored:
        s["topic"] = cfg["TOPIC"] if s["topic"] == "TOEFL" else s["topic"]
        s["prompt_version"] = s["prompt_version"] or rules.prompt_version(cfg)
    db = tmp_path / "q.duckdb"
    make_db(db, raw, scored)
    dbt(db, "run", vars_=build.dbt_vars(cfg, NOW))
    topics = {r["topic"] for r in query(db, "select topic from main.feed")}
    assert topics == {cfg["TOPIC"]}
