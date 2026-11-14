"""One schema for every table, identical to apps-script/Schema.gs (tests/test_parity.py checks).

Field: (name, BigQuery type, mode, description). Changes are additive only: new columns go at
the end and are added to existing tables as NULLABLE.
"""
TABLES = {
    "raw_videos": {
        "description": "Every video returned by a YouTube search, one row per video per collection run. Append-only.",
        "partition_field": "collected_at",
        "cluster_fields": ["video_id"],
        "fields": [
            ("run_id", "STRING", "REQUIRED", "Collection run that fetched this row"),
            ("collected_at", "TIMESTAMP", "REQUIRED", "When the search ran"),
            ("topic", "STRING", "REQUIRED", "TOPIC setting at collection time"),
            ("search_term", "STRING", "NULLABLE", "Query sent to YouTube"),
            ("video_id", "STRING", "REQUIRED", "YouTube video ID"),
            ("title", "STRING", "NULLABLE", ""),
            ("description", "STRING", "NULLABLE", ""),
            ("channel_id", "STRING", "NULLABLE", ""),
            ("channel_title", "STRING", "NULLABLE", ""),
            ("published_at", "TIMESTAMP", "NULLABLE", "When the video was published"),
            ("duration_sec", "INT64", "NULLABLE", "From videos.list contentDetails.duration"),
            ("embeddable", "BOOL", "NULLABLE", "From videos.list status.embeddable"),
            ("view_count", "INT64", "NULLABLE", ""),
            ("like_count", "INT64", "NULLABLE", ""),
            ("thumbnail_url", "STRING", "NULLABLE", ""),
            ("language", "STRING", "NULLABLE", "defaultAudioLanguage (or defaultLanguage) from videos.list"),
        ],
    },
    "scored_videos": {
        "description": "Gemini relevance scores, one row per video per scoring run. Append-only.",
        "partition_field": "scored_at",
        "cluster_fields": ["video_id"],
        "fields": [
            ("run_id", "STRING", "REQUIRED", "Scoring run"),
            ("scored_at", "TIMESTAMP", "REQUIRED", ""),
            ("topic", "STRING", "REQUIRED", ""),
            ("video_id", "STRING", "REQUIRED", ""),
            ("score", "INT64", "NULLABLE", "0-10 fit with the topic"),
            ("reason", "STRING", "NULLABLE", "One-line reason from the model"),
            ("model", "STRING", "NULLABLE", "Gemini model that scored it"),
            ("prompt_version", "STRING", "NULLABLE", "Version tag of the scoring prompt"),
        ],
    },
    "feed": {
        "description": "Videos ready to show: latest score >= MIN_SCORE and embeddable. Rebuilt in full from scored_videos + raw_videos.",
        "partition_field": None,
        "cluster_fields": ["topic"],
        "fields": [
            ("video_id", "STRING", "REQUIRED", ""),
            ("topic", "STRING", "REQUIRED", ""),
            ("title", "STRING", "NULLABLE", ""),
            ("channel_title", "STRING", "NULLABLE", ""),
            ("duration_sec", "INT64", "NULLABLE", ""),
            ("published_at", "TIMESTAMP", "NULLABLE", ""),
            ("score", "INT64", "NULLABLE", ""),
            ("reason", "STRING", "NULLABLE", ""),
            ("first_seen_at", "TIMESTAMP", "NULLABLE", "First collection of this video"),
            ("built_at", "TIMESTAMP", "NULLABLE", "When this feed snapshot was built"),
        ],
    },
    "events": {
        "description": "What the viewer did in the web app (impression, watch, skip). Lands in the events tab, loaded into BigQuery nightly.",
        "partition_field": "event_at",
        "cluster_fields": ["video_id"],
        "fields": [
            ("event_id", "STRING", "REQUIRED", "Random ID, makes nightly loads safe to re-run"),
            ("event_at", "TIMESTAMP", "REQUIRED", ""),
            ("session_id", "STRING", "NULLABLE", "One per web app visit"),
            ("video_id", "STRING", "REQUIRED", ""),
            ("event_type", "STRING", "REQUIRED", "watch | skip | error | like | unlike | dislike | undislike"),
            ("watch_ms", "INT64", "NULLABLE", "Time on the video before moving on"),
            ("position", "INT64", "NULLABLE", "Index of the video in the feed"),
            ("topic", "STRING", "NULLABLE", ""),
            ("loaded_at", "TIMESTAMP", "NULLABLE", "Set by the nightly load"),
        ],
    },
    "pipeline_runs": {
        "description": "One row per pipeline step run: status, row counts and YouTube quota used.",
        "partition_field": "started_at",
        "cluster_fields": None,
        "fields": [
            ("run_id", "STRING", "REQUIRED", ""),
            ("step", "STRING", "REQUIRED", "collect | score | build_feed | load_events"),
            ("started_at", "TIMESTAMP", "REQUIRED", ""),
            ("finished_at", "TIMESTAMP", "NULLABLE", ""),
            ("status", "STRING", "NULLABLE", "ok | error"),
            ("rows_in", "INT64", "NULLABLE", ""),
            ("rows_out", "INT64", "NULLABLE", ""),
            ("quota_units", "INT64", "NULLABLE", "API usage: YouTube units (collect) or Gemini calls (score)"),
            ("message", "STRING", "NULLABLE", "Error or note"),
        ],
    },
}


def column_names(table: str) -> list[str]:
    return [f[0] for f in TABLES[table]["fields"]]
