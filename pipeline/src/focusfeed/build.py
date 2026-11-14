"""Step 3: dbt builds the feed (and the rest of the models) from the raw tables.

The Settings tab decides the rules, so they reach dbt as vars computed here: the same topic,
prompt version, minimum score, age limit and language that Score and the Apps Script use.
The run is logged to pipeline_runs as step build_feed, like Phase 1's feed rebuild.
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path

from .collect import new_run_id
from .rules import iso, min_published, prompt_version
from .score import SHORTS_MAX_SEC

DBT_DIR = Path(os.environ.get("FOCUSFEED_DBT_DIR") or Path(__file__).resolve().parents[3] / "dbt")
FAILED = {"error", "fail", "runtime error"}


def dbt_vars(cfg: dict, now: datetime | None = None) -> dict:
    return {
        "topic": cfg["TOPIC"],
        "prompt_version": prompt_version(cfg),
        "min_score": cfg["MIN_SCORE"],
        "max_duration_sec": SHORTS_MAX_SEC,
        "min_published": min_published(cfg, now),
        "language": cfg["LANGUAGE_FILTER"],
    }


def dbt_args(command: list[str], cfg: dict, now: datetime | None = None, target: str = "prod") -> list[str]:
    return [*command, "--project-dir", str(DBT_DIR), "--profiles-dir", str(DBT_DIR), "--target", target,
            "--vars", json.dumps(dbt_vars(cfg, now))]


def dbt_env(cfg: dict) -> dict[str, str]:
    """What profiles.yml reads: where to build."""
    return {"FOCUSFEED_PROJECT": cfg["BQ_PROJECT_ID"], "FOCUSFEED_DATASET": cfg["BQ_DATASET"],
            "FOCUSFEED_LOCATION": cfg["BQ_LOCATION"]}


def results(res) -> list:
    """The node results of a dbtRunner call (empty when dbt failed before running anything)."""
    return list(getattr(getattr(res, "result", None), "results", None) or [])


def status(r) -> str:
    return str(getattr(r.status, "value", r.status)).lower()


def build(cfg: dict, store, runner=None, now: datetime | None = None, target: str = "prod") -> dict:
    """dbt build (models + data tests; unit tests run in CI), then source freshness."""
    if runner is None:
        from dbt.cli.main import dbtRunner

        runner = dbtRunner()
    now = now or datetime.now(timezone.utc)
    run = {"run_id": new_run_id(now), "step": "build_feed", "started_at": iso(now), "finished_at": None,
           "status": "ok", "rows_in": 0, "rows_out": 0, "quota_units": 0, "message": ""}
    out = {"run": run, "failed": [], "warned": [], "stale": [], "models": 0, "tests": 0, "mb_billed": 0.0,
           "feed_rows": None}
    os.environ.update(dbt_env(cfg))
    try:
        res = runner.invoke(dbt_args(["build", "--exclude-resource-type", "unit_test"], cfg, now, target))
        for r in results(res):
            kind = str(getattr(r.node.resource_type, "value", r.node.resource_type))
            st = status(r)
            if kind == "model":
                out["models"] += 1
                billed = getattr(r, "adapter_response", None) or {}
                out["mb_billed"] += (billed.get("bytes_billed") or 0) / 1e6
            elif kind == "test":
                out["tests"] += 1
            if st in FAILED:
                out["failed"].append(f"{r.node.name}: {str(r.message or st)[:200]}")
            elif st == "warn":
                out["warned"].append(r.node.name)
        if not res.success and not out["failed"]:
            out["failed"].append(f"dbt build: {res.exception or 'failed'}")
        run["rows_in"] = out["models"]

        fresh = runner.invoke(dbt_args(["source", "freshness"], cfg, now, target))
        for r in results(fresh):
            st = status(r)
            if st != "pass":
                out["stale"].append(f"{getattr(r.node, 'name', '?')}: {st}")
        if not fresh.success and not out["stale"]:
            out["stale"].append(f"source freshness: {fresh.exception or 'failed'}")

        rows = store.query(f"-- focusfeed: feed size\nSELECT COUNT(*) AS n FROM `{store.ref('feed')}` WHERE topic = @topic",
                           {"topic": cfg["TOPIC"]})
        out["feed_rows"] = int(rows[0]["n"]) if rows else 0
        run["rows_out"] = out["feed_rows"]
    except Exception as e:  # noqa: BLE001 - logged below, then raised
        out["failed"].append(f"{type(e).__name__}: {e}")
    stale_errors = [s for s in out["stale"] if not s.endswith(": warn")]
    if out["failed"] or stale_errors:
        run["status"] = "error"
    notes = [f"dbt: {out['models']} models, {out['tests']} tests, {out['mb_billed']:.1f} MB billed"]
    notes += [f"failed {x}" for x in out["failed"]] + [f"stale {x}" for x in out["stale"]]
    notes += [f"warning {x}" for x in out["warned"]]
    run["message"] = "; ".join(notes)[:1000]
    run["finished_at"] = iso(datetime.now(timezone.utc))
    store.log_run(run)
    return out


def summary(out: dict, cfg: dict) -> list[str]:
    run = out["run"]
    lines = []
    if out["feed_rows"] is not None:
        lines.append(f"Feed built: {out['feed_rows']:,} videos in {cfg['BQ_DATASET']}.feed")
    lines.append(f"dbt: {out['models']} models and {out['tests']} data tests; {out['mb_billed']:.1f} MB billed by BigQuery")
    lines += [f"FAILED {x}" for x in out["failed"]]
    lines += [f"stale source {x}" for x in out["stale"]]
    lines += [f"warning {x}" for x in out["warned"]]
    lines.append(f"Run ID: {run['run_id']}")
    return lines
