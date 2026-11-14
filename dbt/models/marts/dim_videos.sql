{{
  config(
    materialized='incremental',
    unique_key=['topic', 'video_id'],
    incremental_strategy=('merge' if target.type == 'bigquery' else 'delete+insert'),
    cluster_by=['topic', 'video_id'],
    on_schema_change='append_new_columns'
  )
}}
-- One row per video and topic: its newest details from YouTube, plus when it was first and last
-- collected. Incremental: each run reads only the rows collected since the newest it already
-- has (minus lookback_days) and merges them in on (topic, video_id).

with new_rows as (
    select *
    from {{ ref('stg_raw_videos') }}
    {% if is_incremental() %}
    where collected_at > {{ incremental_cutoff('last_seen_at') }}
    {% endif %}
),

newest as (
    select *
    from (
        select
            *,
            row_number() over (partition by topic, video_id order by collected_at desc, run_id desc) as recency
        from new_rows
    ) as ranked
    where recency = 1
),

seen as (
    select topic, video_id, min(collected_at) as first_seen_at, max(collected_at) as last_seen_at
    from new_rows
    group by topic, video_id
)

select
    n.topic,
    n.video_id,
    n.title,
    n.description,
    n.channel_id,
    n.channel_title,
    n.published_at,
    n.duration_sec,
    n.embeddable,
    n.view_count,
    n.like_count,
    n.thumbnail_url,
    n.language,
    {% if is_incremental() %}
    least(s.first_seen_at, coalesce(old.first_seen_at, s.first_seen_at)) as first_seen_at,
    greatest(s.last_seen_at, coalesce(old.last_seen_at, s.last_seen_at)) as last_seen_at,
    {% else %}
    s.first_seen_at,
    s.last_seen_at,
    {% endif %}
    n.collected_at as details_collected_at
from newest as n
join seen as s
    on s.topic = n.topic and s.video_id = n.video_id
{% if is_incremental() %}
left join {{ this }} as old
    on old.topic = n.topic and old.video_id = n.video_id
{% endif %}
