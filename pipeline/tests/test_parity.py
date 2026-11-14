"""Phase 1 (Apps Script) and Phase 2 (Python) must agree, or the two would fight over the same tables."""
from datetime import datetime, timezone

import pytest

from conftest import gas
from focusfeed import collect, config, rules, schema


def test_schema_matches_apps_script():
    js = gas("TABLES")
    assert list(js) == list(schema.TABLES)
    for name, spec in schema.TABLES.items():
        assert [tuple(f) for f in js[name]["fields"]] == spec["fields"], name
        assert js[name].get("partitionField") == spec["partition_field"], name
        assert js[name].get("clusterFields") == spec["cluster_fields"], name
        assert js[name]["description"] == spec["description"], name


def test_settings_match_apps_script():
    js = gas("SETTINGS")
    assert [s["key"] for s in js] == [s[0] for s in config.SETTINGS]
    for s, (key, default, kind, extra) in zip(js, config.SETTINGS):
        assert s["def"] == default, key
        assert s["type"] == kind, key
        for k in ("min", "max", "options", "maxLength", "required"):
            assert s.get(k) == extra.get(k), f"{key}.{k}"
        assert (s.get("pattern") or None) == (extra.get("pattern") or None), f"{key}.pattern"


def test_search_modifiers_and_orders_match():
    assert gas("SEARCH_MODIFIERS") == collect.SEARCH_MODIFIERS
    assert gas("SEARCH_ORDERS") == collect.SEARCH_ORDERS


@pytest.mark.parametrize("when", ["2026-11-14T08:00:00Z", "2026-11-15T23:59:00Z", "2027-03-01T00:00:00Z"])
@pytest.mark.parametrize("terms,per_day", [([], 50), (["TOEFL speaking template"], 90), (["a", "b"], 7)])
def test_search_plan_matches(when, terms, per_day):
    cfg = {"TOPIC": "TOEFL", "SEARCH_TERMS": terms, "SEARCHES_PER_DAY": per_day}
    js = gas(f"searchPlan_({__import__('json').dumps(cfg)}, new Date('{when}'))")
    py = collect.search_plan(cfg, datetime.fromisoformat(when.replace("Z", "+00:00")))
    assert py == js


@pytest.mark.parametrize("cfg", [
    {"LANGUAGE_FILTER": "", "EXCLUDE_ADS": "no", "SCORING_GUIDANCE": ""},
    {"LANGUAGE_FILTER": "", "EXCLUDE_ADS": "yes", "SCORING_GUIDANCE": ""},
    {"LANGUAGE_FILTER": "en", "EXCLUDE_ADS": "yes", "SCORING_GUIDANCE": "Only the new TOEFL format (2026): Build a Sentence…"},
    {"LANGUAGE_FILTER": "xx", "EXCLUDE_ADS": "no", "SCORING_GUIDANCE": 'Quotes " and \\ and new\nline, emoji 🎯, Hindi हिंदी'},
])
def test_rules_and_prompt_version_match(cfg):
    import json

    assert rules.scoring_rules(cfg) == gas(f"scoringRules_({json.dumps(cfg)})")
    assert rules.prompt_version(cfg) == gas(f"promptVersion_({json.dumps(cfg)})")


def test_hash_matches_for_tricky_strings():
    import json

    for s in ["", "a", "TOEFL", "x" * 500, "हिंदी 🎯  "]:
        assert rules.hash_str(s) == gas(f"hashStr_({json.dumps(s)})"), s


def test_iso_duration_matches():
    for s in ["PT45S", "PT1M5S", "PT1H2M3S", "P0D", "P1DT2H", "junk", ""]:
        assert collect.parse_iso_duration(s) == gas(f"parseIsoDuration_({__import__('json').dumps(s)})"), s
