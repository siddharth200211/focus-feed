-- One row per video per collection run, as collected. Only types and names are tidied here.
select
    run_id,
    collected_at,
    topic,
    search_term,
    video_id,
    title,
    description,
    channel_id,
    channel_title,
    published_at,
    duration_sec,
    embeddable,
    view_count,
    like_count,
    thumbnail_url,
    language,
    starts_with(run_id, 'py-') as collected_by_python
from {{ source('focusfeed', 'raw_videos') }}
