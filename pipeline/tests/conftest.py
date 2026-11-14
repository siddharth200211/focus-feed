import json
import subprocess
from pathlib import Path

import pytest

HERE = Path(__file__).parent


def gas(expr: str):
    """Evaluate a JavaScript expression against the real Apps Script files (needs node)."""
    # On stdin: an expression carrying table fixtures can be longer than one command-line argument may be.
    out = subprocess.run(["node", str(HERE / "gas_eval.js")], input=expr, capture_output=True, text=True, check=True)
    return json.loads(out.stdout) if out.stdout else None


@pytest.fixture
def cfg():
    from focusfeed import config

    c = config.parse({"TOPIC": "TOEFL", "STORAGE": "bigquery"}, env={"GCP_PROJECT_ID": "my-project", "BQ_DATASET": "focus_feed_v2"})
    return c


class FakeStore:
    """In-memory stand-in for BigQueryStore."""

    def __init__(self):
        self.rows: dict[str, list[dict]] = {}
        self.jobs: set[str] = set()
        self.runs: list[dict] = []

    def ref(self, table):
        return f"p.d.{table}"

    def load_rows(self, table, rows, job_id):
        assert job_id not in self.jobs, "job IDs are unique (no double loads)"
        self.jobs.add(job_id)
        json.dumps(rows)  # must be JSON-serialisable for a load job
        self.rows.setdefault(table, []).extend(rows)
        return len(rows)

    def log_run(self, run):
        self.runs.append(dict(run))

    def query(self, sql, params=None):
        return [{"units": 0}]


@pytest.fixture
def store():
    return FakeStore()
