-- The newest usable score for each video, for the current topic and scoring rules
-- (prompt_version). Same logic as latest_score in apps-script/Feed.gs.
select video_id, score, reason, model, scored_at, scored_by_python
from (
    select
        *,
        row_number() over (partition by video_id order by scored_at desc, run_id desc) as score_rank
    from {{ ref('stg_scored_videos') }}
    where topic = {{ lit(var('topic')) }}
      and prompt_version = {{ lit(var('prompt_version')) }}
      and score is not null
) as ranked
where score_rank = 1
