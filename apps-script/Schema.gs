/**
 * Schema.gs — one schema, two storage backends.
 *
 * Each table below becomes a BigQuery table (STORAGE = bigquery) or a spreadsheet tab with
 * the same columns (STORAGE = sheets). Data flows raw_videos → scored_videos → feed;
 * events is what the web app logs; pipeline_runs records every step for monitoring.
 *
 * Field: [name, BigQuery type, mode, description]. Types use BigQuery standard SQL names.
 * Changing a schema: only ever ADD columns at the end. Setup adds missing columns to
 * existing tabs/tables (as NULLABLE); it never drops, renames or retypes anything.
 */
const TABLES = {
  raw_videos: {
    description: 'Every video returned by a YouTube search, one row per video per collection run. Append-only.',
    partitionField: 'collected_at',
    clusterFields: ['video_id'],
    fields: [
      ['run_id', 'STRING', 'REQUIRED', 'Collection run that fetched this row'],
      ['collected_at', 'TIMESTAMP', 'REQUIRED', 'When the search ran'],
      ['topic', 'STRING', 'REQUIRED', 'TOPIC setting at collection time'],
      ['search_term', 'STRING', 'NULLABLE', 'Query sent to YouTube'],
      ['video_id', 'STRING', 'REQUIRED', 'YouTube video ID'],
      ['title', 'STRING', 'NULLABLE', ''],
      ['description', 'STRING', 'NULLABLE', ''],
      ['channel_id', 'STRING', 'NULLABLE', ''],
      ['channel_title', 'STRING', 'NULLABLE', ''],
      ['published_at', 'TIMESTAMP', 'NULLABLE', 'When the video was published'],
      ['duration_sec', 'INT64', 'NULLABLE', 'From videos.list contentDetails.duration'],
      ['embeddable', 'BOOL', 'NULLABLE', 'From videos.list status.embeddable'],
      ['view_count', 'INT64', 'NULLABLE', ''],
      ['like_count', 'INT64', 'NULLABLE', ''],
      ['thumbnail_url', 'STRING', 'NULLABLE', ''],
    ],
  },
  scored_videos: {
    description: 'Gemini relevance scores, one row per video per scoring run. Append-only.',
    partitionField: 'scored_at',
    clusterFields: ['video_id'],
    fields: [
      ['run_id', 'STRING', 'REQUIRED', 'Scoring run'],
      ['scored_at', 'TIMESTAMP', 'REQUIRED', ''],
      ['topic', 'STRING', 'REQUIRED', ''],
      ['video_id', 'STRING', 'REQUIRED', ''],
      ['score', 'INT64', 'NULLABLE', '0-10 fit with the topic'],
      ['reason', 'STRING', 'NULLABLE', 'One-line reason from the model'],
      ['model', 'STRING', 'NULLABLE', 'Gemini model that scored it'],
      ['prompt_version', 'STRING', 'NULLABLE', 'Version tag of the scoring prompt'],
    ],
  },
  feed: {
    description: 'Videos ready to show: latest score >= MIN_SCORE and embeddable. Rebuilt in full from scored_videos + raw_videos.',
    clusterFields: ['topic'],
    fields: [
      ['video_id', 'STRING', 'REQUIRED', ''],
      ['topic', 'STRING', 'REQUIRED', ''],
      ['title', 'STRING', 'NULLABLE', ''],
      ['channel_title', 'STRING', 'NULLABLE', ''],
      ['duration_sec', 'INT64', 'NULLABLE', ''],
      ['published_at', 'TIMESTAMP', 'NULLABLE', ''],
      ['score', 'INT64', 'NULLABLE', ''],
      ['reason', 'STRING', 'NULLABLE', ''],
      ['first_seen_at', 'TIMESTAMP', 'NULLABLE', 'First collection of this video'],
      ['built_at', 'TIMESTAMP', 'NULLABLE', 'When this feed snapshot was built'],
    ],
  },
  events: {
    description: 'What the viewer did in the web app (impression, watch, skip). Lands in the events tab, loaded into BigQuery nightly.',
    partitionField: 'event_at',
    clusterFields: ['video_id'],
    fields: [
      ['event_id', 'STRING', 'REQUIRED', 'Random ID, makes nightly loads safe to re-run'],
      ['event_at', 'TIMESTAMP', 'REQUIRED', ''],
      ['session_id', 'STRING', 'NULLABLE', 'One per web app visit'],
      ['video_id', 'STRING', 'REQUIRED', ''],
      ['event_type', 'STRING', 'REQUIRED', 'impression | watch | skip'],
      ['watch_ms', 'INT64', 'NULLABLE', 'Time on the video before moving on'],
      ['position', 'INT64', 'NULLABLE', 'Index of the video in the feed'],
      ['topic', 'STRING', 'NULLABLE', ''],
      ['loaded_at', 'TIMESTAMP', 'NULLABLE', 'Set by the nightly load'],
    ],
  },
  pipeline_runs: {
    description: 'One row per pipeline step run: status, row counts and YouTube quota used.',
    partitionField: 'started_at',
    fields: [
      ['run_id', 'STRING', 'REQUIRED', ''],
      ['step', 'STRING', 'REQUIRED', 'collect | score | build_feed | load_events'],
      ['started_at', 'TIMESTAMP', 'REQUIRED', ''],
      ['finished_at', 'TIMESTAMP', 'NULLABLE', ''],
      ['status', 'STRING', 'NULLABLE', 'ok | error'],
      ['rows_in', 'INT64', 'NULLABLE', ''],
      ['rows_out', 'INT64', 'NULLABLE', ''],
      ['quota_units', 'INT64', 'NULLABLE', 'YouTube API units used'],
      ['message', 'STRING', 'NULLABLE', 'Error or note'],
    ],
  },
};

/** Spreadsheet tabs that hold data for a given STORAGE mode. */
function dataTabsFor_(storage) {
  // With BigQuery the spreadsheet only keeps the events landing tab (the web app writes
  // there; a nightly batch load moves rows into BigQuery — no streaming, sandbox-safe).
  return storage === 'bigquery' ? ['events'] : Object.keys(TABLES);
}

function columnNames_(tableName) {
  return TABLES[tableName].fields.map(f => f[0]);
}
