{{ config(materialized='table') }}
-- Pipeline health per day, step and phase: for a monitoring dashboard (e.g. Looker Studio).

select
    cast(started_at as date) as run_date,
    phase,
    step,
    count(*) as runs,
    sum(case when status = 'error' then 1 else 0 end) as failed_runs,
    sum(rows_in) as rows_in,
    sum(rows_out) as rows_out,
    sum(quota_units) as quota_units,
    avg(duration_sec) as avg_duration_sec,
    max(duration_sec) as max_duration_sec
from {{ ref('stg_pipeline_runs') }}
group by run_date, phase, step
