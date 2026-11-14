{{
  config(
    materialized='incremental',
    unique_key='event_id',
    incremental_strategy=('merge' if target.type == 'bigquery' else 'delete+insert'),
    partition_by=({'field': 'event_at', 'data_type': 'timestamp', 'granularity': 'day'} if target.type == 'bigquery' else none),
    cluster_by=['video_id'],
    on_schema_change='append_new_columns'
  )
}}
-- Every web app event once, with the video's channel for analysis by channel.

select
    e.event_id,
    e.event_at,
    e.session_id,
    e.video_id,
    e.event_type,
    e.watch_ms,
    e.position,
    e.topic,
    v.channel_title
from {{ ref('stg_events') }} as e
left join {{ ref('dim_videos') }} as v
    on v.video_id = e.video_id and v.topic = e.topic
{% if is_incremental() %}
where e.event_at > {{ incremental_cutoff('event_at') }}
{% endif %}
