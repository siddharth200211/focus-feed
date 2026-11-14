{#
  Settings values (topic, prompt version, …) reach SQL as literals. They are escaped here, per
  warehouse, so a topic like "TOEFL's speaking" can't break or change a query.
#}

{% macro lit(value) -%}
  {{ return(adapter.dispatch('lit', 'focusfeed')(value)) }}
{%- endmacro %}

{% macro bigquery__lit(value) -%}
  '{{ value | string | replace("\\", "\\\\") | replace("'", "\\'") | replace("\n", "\\n") }}'
{%- endmacro %}

{% macro default__lit(value) -%}
  '{{ value | string | replace("'", "''") }}'
{%- endmacro %}


{# An ISO timestamp such as 2024-11-14T08:30:00.000Z as a TIMESTAMP value. #}
{% macro ts_lit(value) -%}
  {{ return(adapter.dispatch('ts_lit', 'focusfeed')(value)) }}
{%- endmacro %}

{% macro bigquery__ts_lit(value) -%}
  timestamp({{ focusfeed.lit(value) }})
{%- endmacro %}

{% macro default__ts_lit(value) -%}
  cast({{ focusfeed.lit(value) }} as timestamptz)
{%- endmacro %}
