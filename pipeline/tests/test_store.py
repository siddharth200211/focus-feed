"""BigQueryStore against a fake client (real google-cloud-bigquery classes, no network)."""
import pytest
from google.api_core.exceptions import NotFound
from google.cloud import bigquery

from focusfeed.schema import TABLES
from focusfeed.store import BigQueryStore


class FakeJob:
    def __init__(self, rows=None, out=0):
        self._rows, self.output_rows = rows or [], out

    def result(self, timeout=None):
        return self._rows


class FakeClient:
    def __init__(self):
        self.datasets, self.tables, self.loads, self.queries, self.updates = set(), {}, [], [], []

    def get_dataset(self, ref):
        if str(ref.dataset_id) not in self.datasets:
            raise NotFound("ds")

    def create_dataset(self, ds):
        self.datasets.add(ds.dataset_id)

    def get_table(self, ref):
        if ref not in self.tables:
            raise NotFound("t")
        return self.tables[ref]

    def create_table(self, t):
        self.tables[f"{t.project}.{t.dataset_id}.{t.table_id}"] = t

    def update_table(self, t, fields):
        self.updates.append((t.table_id, fields))

    def load_table_from_json(self, rows, dest, job_config, job_id):
        self.loads.append((rows, dest, job_config, job_id))
        return FakeJob(out=len(rows))

    def query(self, sql, job_config):
        self.queries.append((sql, job_config))
        return FakeJob(rows=[bigquery.Row((3,), {"n": 0})])


def make():
    c = FakeClient()
    return BigQueryStore("p", "focus_feed_v2", "US", client=c), c


def test_ensure_creates_dataset_and_partitioned_clustered_tables_once():
    s, c = make()
    changes = s.ensure()
    assert changes[0] == "created dataset focus_feed_v2" and len(changes) == 1 + len(TABLES)
    raw = c.tables["p.focus_feed_v2.raw_videos"]
    assert raw.time_partitioning.field == "collected_at" and raw.clustering_fields == ["video_id"]
    assert [f.name for f in raw.schema][-1] == "language"
    assert c.tables["p.focus_feed_v2.feed"].time_partitioning is None
    assert s.ensure() == [], "second run changes nothing"


def test_ensure_adds_missing_columns_as_nullable():
    s, c = make()
    s.ensure()
    raw = c.tables["p.focus_feed_v2.raw_videos"]
    raw.schema = [f for f in raw.schema if f.name != "language"]
    assert s.ensure() == ["raw_videos: +language"]
    added = raw.schema[-1]
    assert (added.name, added.mode) == ("language", "NULLABLE")
    assert c.updates == [("raw_videos", ["schema"])]


def test_load_rows_is_one_append_job_with_the_given_id():
    s, c = make()
    assert s.load_rows("raw_videos", [{"video_id": "x"}], "focusfeed_raw_videos_py-1") == 1
    rows, dest, cfg, job_id = c.loads[0]
    assert dest == "p.focus_feed_v2.raw_videos" and job_id == "focusfeed_raw_videos_py-1"
    assert cfg.write_disposition == "WRITE_APPEND" and cfg.source_format == "NEWLINE_DELIMITED_JSON"
    assert s.load_rows("raw_videos", [], "j2") == 0 and len(c.loads) == 1


def test_query_parameters_get_bigquery_types():
    s, c = make()
    s.query("SELECT 1", {"topic": "TOEFL", "n": 7, "flag": True, "ids": ["a", "b"]})
    params = {p.name: p for p in c.queries[0][1].query_parameters}
    assert params["topic"].type_ == "STRING" and params["n"].type_ == "INT64" and params["flag"].type_ == "BOOL"
    assert params["ids"].array_type == "STRING" and params["ids"].values == ["a", "b"]


class Copy:
    def __init__(self, client):
        self.client = client

    def result(self, timeout=None):
        return self


def test_seed_copies_phase_1_tables_into_empty_ones_only():
    s, c = make()
    s.ensure()
    for name, rows in (("raw_videos", 1200), ("scored_videos", 900)):
        t = bigquery.Table(f"p.focus_feed.{name}")
        t._properties["numRows"] = str(rows)
        c.tables[f"p.focus_feed.{name}"] = t
    c.tables["p.focus_feed_v2.scored_videos"]._properties["numRows"] = "5"
    c.copies = []
    c.copy_table = lambda src, dst, job_config: c.copies.append((src, dst, job_config.write_disposition)) or Copy(c)
    out = s.seed_from("focus_feed")
    assert c.copies == [("p.focus_feed.raw_videos", "p.focus_feed_v2.raw_videos", "WRITE_TRUNCATE")]
    assert out == ["raw_videos: copied 1,200 rows from focus_feed", "scored_videos: already has 5 rows, left as is",
                   "events: not in focus_feed, skipped"]


def test_seed_refuses_to_copy_a_dataset_onto_itself():
    s, _ = make()
    with pytest.raises(ValueError):
        s.seed_from("focus_feed_v2")
