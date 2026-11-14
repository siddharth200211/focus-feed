{{ config(materialized='table', cluster_by=['topic']) }}
-- Videos ready to show in the web app: the same rows, columns and rules as buildFeedSql_ in
-- apps-script/Feed.gs (tests/test_dbt.py checks this). The web app reads this table by name.

select
    v.video_id,
    v.topic,
    v.title,
    v.channel_title,
    v.duration_sec,
    v.published_at,
    s.score,
    s.reason,
    v.first_seen_at,
    {{ dbt.current_timestamp() }} as built_at
from {{ ref('dim_videos') }} as v
join {{ ref('int_latest_scores') }} as s
    on s.video_id = v.video_id
where v.topic = {{ lit(var('topic')) }}
  and s.score >= {{ var('min_score') | int }}
  and v.embeddable
  and v.duration_sec between 1 and {{ var('max_duration_sec') | int }}
  and (v.published_at is null or v.published_at >= {{ ts_lit(var('min_published')) }})
  and ({{ lit(var('language')) }} = '' or v.language is null or starts_with(lower(v.language), {{ lit(var('language')) }}))
