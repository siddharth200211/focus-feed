-- Web app events, one row per event_id. A re-run nightly load can land an event twice; the copy
-- loaded last wins.
select event_id, event_at, session_id, video_id, event_type, watch_ms, position, topic, loaded_at
from (
    select
        *,
        row_number() over (partition by event_id order by loaded_at desc nulls last) as copy_rank
    from {{ source('focusfeed', 'events') }}
) as ranked
where copy_rank = 1
