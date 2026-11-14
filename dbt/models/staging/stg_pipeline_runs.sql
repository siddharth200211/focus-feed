-- Every pipeline step run, tagged with the phase that ran it.
select
    run_id,
    step,
    started_at,
    finished_at,
    status,
    rows_in,
    rows_out,
    quota_units,
    message,
    case when starts_with(run_id, 'py-') then 'python' else 'apps_script' end as phase,
    {{ dbt.datediff('started_at', 'finished_at', 'second') }} as duration_sec
from {{ source('focusfeed', 'pipeline_runs') }}
