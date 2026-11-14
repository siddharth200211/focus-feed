{#
  The point an incremental model reads new rows from: the newest `column` already in the model
  minus `lookback_days`, so rows that arrive a little late are still picked up (the merge on the
  unique key keeps them from doubling). An empty model reads everything.
#}
{% macro incremental_cutoff(column) -%}
  (select coalesce({{ focusfeed.ts_minus_days('max(' ~ column ~ ')', var('lookback_days') | int) }},
                   {{ focusfeed.ts_lit('1970-01-01T00:00:00.000Z') }})
   from {{ this }})
{%- endmacro %}

{% macro ts_minus_days(expression, days) -%}
  {{ return(adapter.dispatch('ts_minus_days', 'focusfeed')(expression, days)) }}
{%- endmacro %}

{% macro bigquery__ts_minus_days(expression, days) -%}
  timestamp_sub({{ expression }}, interval {{ days | int }} day)
{%- endmacro %}

{% macro default__ts_minus_days(expression, days) -%}
  ({{ expression }} - interval {{ days | int }} day)
{%- endmacro %}
