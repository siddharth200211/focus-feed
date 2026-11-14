"""BigQuery storage: create/migrate tables, batch-load rows, run queries, log runs.

Same rules as Phase 1: tables created through the API, data arrives by load jobs (free), and
schema changes are additive. Job IDs come from run IDs, so a retried run never loads twice.
"""
from __future__ import annotations

from .schema import TABLES


class BigQueryStore:
    def __init__(self, project: str, dataset: str, location: str = "US", client=None):
        from google.cloud import bigquery  # imported lazily so tests don't need it

        self.bq = bigquery
        self.project, self.dataset, self.location = project, dataset, location
        self.client = client or bigquery.Client(project=project, location=location)

    def ref(self, table: str) -> str:
        return f"{self.project}.{self.dataset}.{table}"

    def _fields(self, table: str):
        return [self.bq.SchemaField(n, t, mode=m, description=d or None) for n, t, m, d in TABLES[table]["fields"]]

    def ensure(self) -> list[str]:
        """Dataset and every table; appends missing columns (as NULLABLE). Returns what changed."""
        changes = []
        ds = self.bq.Dataset(f"{self.project}.{self.dataset}")
        ds.location = self.location
        ds.labels = {"app": "focusfeed"}
        try:
            self.client.get_dataset(ds.reference)
        except Exception:  # NotFound
            self.client.create_dataset(ds)
            changes.append(f"created dataset {self.dataset}")
        for name, spec in TABLES.items():
            try:
                table = self.client.get_table(self.ref(name))
            except Exception:  # NotFound
                table = self.bq.Table(self.ref(name), schema=self._fields(name))
                table.description = spec["description"]
                table.labels = {"app": "focusfeed"}
                if spec["partition_field"]:
                    table.time_partitioning = self.bq.TimePartitioning(type_="DAY", field=spec["partition_field"])
                if spec["cluster_fields"]:
                    table.clustering_fields = spec["cluster_fields"]
                self.client.create_table(table)
                changes.append(f"created {name}")
                continue
            have = {f.name.lower() for f in table.schema}
            missing = [f for f in self._fields(name) if f.name.lower() not in have]
            if missing:
                table.schema = list(table.schema) + [self.bq.SchemaField(f.name, f.field_type, mode="NULLABLE",
                                                                          description=f.description) for f in missing]
                self.client.update_table(table, ["schema"])
                changes.append(f"{name}: +{', '.join(f.name for f in missing)}")
        return changes

    def load_rows(self, table: str, rows: list[dict], job_id: str) -> int:
        """One batch load job (newline-delimited JSON, append). Waits and returns rows loaded."""
        if not rows:
            return 0
        config = self.bq.LoadJobConfig(
            source_format=self.bq.SourceFormat.NEWLINE_DELIMITED_JSON,
            write_disposition=self.bq.WriteDisposition.WRITE_APPEND,
            create_disposition=self.bq.CreateDisposition.CREATE_NEVER,
        )
        job = self.client.load_table_from_json(rows, self.ref(table), job_config=config, job_id=job_id)
        job.result(timeout=300)
        return int(job.output_rows or len(rows))

    def query(self, sql: str, params: dict | None = None) -> list[dict]:
        qp = []
        for name, v in (params or {}).items():
            if isinstance(v, list):
                qp.append(self.bq.ArrayQueryParameter(name, "STRING", [str(x) for x in v]))
            elif isinstance(v, bool):
                qp.append(self.bq.ScalarQueryParameter(name, "BOOL", v))
            elif isinstance(v, int):
                qp.append(self.bq.ScalarQueryParameter(name, "INT64", v))
            else:
                qp.append(self.bq.ScalarQueryParameter(name, "STRING", str(v)))
        job = self.client.query(sql, job_config=self.bq.QueryJobConfig(query_parameters=qp))
        return [dict(r.items()) for r in job.result(timeout=300)]

    def seed_from(self, source_dataset: str, tables=("raw_videos", "scored_videos", "events")) -> list[str]:
        """Copies Phase 1's history into this (empty) dataset with copy jobs, which are free, so both
        phases start from the same data and their feeds can be compared. Never overwrites rows."""
        from google.api_core.exceptions import NotFound

        if source_dataset == self.dataset:
            raise ValueError(f"Source and target are both {self.dataset}: nothing to seed.")
        out = []
        for name in tables:
            src = f"{self.project}.{source_dataset}.{name}"
            try:
                source = self.client.get_table(src)
            except NotFound:
                out.append(f"{name}: not in {source_dataset}, skipped")
                continue
            try:
                target = self.client.get_table(self.ref(name))
                if target.num_rows:
                    out.append(f"{name}: already has {target.num_rows:,} rows, left as is")
                    continue
            except NotFound:
                pass
            config = self.bq.CopyJobConfig(write_disposition=self.bq.WriteDisposition.WRITE_TRUNCATE)
            self.client.copy_table(src, self.ref(name), job_config=config).result(timeout=300)
            out.append(f"{name}: copied {source.num_rows:,} rows from {source_dataset}")
        return out

    def log_run(self, run: dict) -> None:
        """One pipeline_runs row. Never raises: a logging problem must not hide the real result."""
        try:
            self.load_rows("pipeline_runs", [run], f"focusfeed_pipeline_runs_{run['run_id']}_{run['step']}")
        except Exception as e:  # noqa: BLE001
            print(f"warning: could not log run {run['run_id']}: {e}")
