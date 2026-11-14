-- One row per video per scoring run.
select
    run_id,
    scored_at,
    topic,
    video_id,
    score,
    reason,
    model,
    prompt_version,
    starts_with(run_id, 'py-') as scored_by_python
from {{ source('focusfeed', 'scored_videos') }}
