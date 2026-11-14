"""Settings, read from the same "Settings" tab as the Apps Script (Key | Value | Notes).

Definitions mirror apps-script/Config.gs (tests/test_parity.py checks keys, defaults and limits).
Two environment variables override the sheet, so Phase 2 can run beside Phase 1:
  GCP_PROJECT_ID → BQ_PROJECT_ID      BQ_DATASET → BQ_DATASET (e.g. focus_feed_v2)
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass

# (key, default, type, extra)
SETTINGS: list[tuple[str, object, str, dict]] = [
    ("TOPIC", "", "string", {"required": True}),
    ("SEARCH_TERMS", "", "list", {}),
    ("SEARCH_LANGUAGE", "en", "string", {"pattern": r"^[a-z]{2}(-[A-Za-z]{2,4})?$"}),
    ("SEARCHES_PER_DAY", 50, "int", {"min": 1, "max": 90}),
    ("COLLECT_HOUR", 14, "int", {"min": 0, "max": 23}),
    ("MIN_SCORE", 7, "int", {"min": 0, "max": 10}),
    ("MAX_VIDEO_AGE_DAYS", 0, "int", {"min": 0, "max": 3650}),
    ("LANGUAGE_FILTER", "", "string", {"pattern": r"^([a-z]{2})?$"}),
    ("EXCLUDE_ADS", "yes", "enum", {"options": ["yes", "no"]}),
    ("SCORING_GUIDANCE", "", "string", {"maxLength": 2000}),
    ("SCORE_BATCH_SIZE", 25, "int", {"min": 1, "max": 50}),
    ("GEMINI_MODEL", "gemini-flash-latest", "string", {}),
    ("GEMINI_FALLBACK_MODELS", "gemini-flash-lite-latest", "list", {}),
    ("APP_ICON_URL", "", "string", {"pattern": r"^(https:\/\/\S+)?$"}),
    ("FEED_PAGE_SIZE", 50, "int", {"min": 10, "max": 200}),
    ("STORAGE", "sheets", "enum", {"options": ["sheets", "bigquery"]}),
    ("LITE_MAX_ROWS", 100000, "int", {"min": 1000, "max": 500000}),
    ("BQ_PROJECT_ID", "", "string", {}),
    ("BQ_DATASET", "focus_feed", "string", {"pattern": r"^[A-Za-z0-9_]{1,1024}$"}),
    ("BQ_LOCATION", "US", "string", {}),
    ("BQ_SANDBOX_EXPIRY", "", "string", {"readOnly": True}),
]


@dataclass
class SheetSource:
    """Reads the Settings tab through the Sheets API with any authorized requests-like session."""

    sheet_id: str
    session: object  # google.auth.transport.requests.AuthorizedSession in production

    def raw(self) -> dict[str, object]:
        url = (f"https://sheets.googleapis.com/v4/spreadsheets/{self.sheet_id}/values/"
               "Settings!A2:B?valueRenderOption=UNFORMATTED_VALUE")
        res = self.session.get(url, timeout=30)
        if res.status_code == 403:
            raise RuntimeError("The pipeline can't read the sheet. Share it with the service account (Viewer).")
        res.raise_for_status()
        out: dict[str, object] = {}
        for row in res.json().get("values", []):
            if row and str(row[0]).strip():
                out[str(row[0]).strip()] = row[1] if len(row) > 1 else ""
        return out

    def table(self, tab: str) -> list[dict[str, object]]:
        """A data tab (header row + rows) as dicts. Dates come back as serial day numbers."""
        url = (f"https://sheets.googleapis.com/v4/spreadsheets/{self.sheet_id}/values/"
               f"{tab}?valueRenderOption=UNFORMATTED_VALUE")
        res = self.session.get(url, timeout=60)
        if res.status_code == 400:
            return []  # no such tab yet
        res.raise_for_status()
        values = res.json().get("values", [])
        if not values:
            return []
        header = [str(h).strip() for h in values[0]]
        return [{h: (row[i] if i < len(row) and row[i] != "" else None) for i, h in enumerate(header)}
                for row in values[1:]]


def coerce(kind: str, value: object) -> object:
    if kind == "int":
        if isinstance(value, bool):
            return value
        try:
            num = float(str(value).strip())
        except ValueError:
            return float("nan")
        return int(num) if num.is_integer() else num
    if kind == "enum":
        return str(value).strip().lower()
    if kind == "list":
        return [x.strip() for x in re.split(r"[,\n]", str(value)) if x.strip()]
    return str(value).strip()


def parse(raw: dict[str, object], env: dict[str, str] | None = None) -> dict[str, object]:
    """Typed settings: blanks fall back to defaults, then the environment overrides."""
    env = os.environ if env is None else env
    cfg: dict[str, object] = {}
    for key, default, kind, _ in SETTINGS:
        v = raw.get(key)
        blank = v is None or str(v).strip() == ""
        cfg[key] = coerce(kind, default if blank else v)
    if env.get("GCP_PROJECT_ID"):
        cfg["BQ_PROJECT_ID"] = env["GCP_PROJECT_ID"].strip()
    if env.get("BQ_DATASET"):
        cfg["BQ_DATASET"] = env["BQ_DATASET"].strip()
    return cfg


def validate(cfg: dict[str, object]) -> list[str]:
    """Same checks as validateSettings_ in Config.gs."""
    errors: list[str] = []
    for key, _, kind, extra in SETTINGS:
        v = cfg[key]
        if extra.get("required") and not v:
            errors.append(f"{key} is empty.")
        if kind == "int" and (not isinstance(v, int) or isinstance(v, bool) or not extra["min"] <= v <= extra["max"]):
            errors.append(f"{key} must be a whole number from {extra['min']} to {extra['max']}.")
        if kind == "enum" and v not in extra["options"]:
            errors.append(f"{key} must be one of: {', '.join(extra['options'])}.")
        if extra.get("pattern") and v and not re.search(extra["pattern"], str(v)):
            errors.append(f'{key} "{v}" doesn\'t look right.')
        if extra.get("maxLength") and v and len(str(v)) > extra["maxLength"]:
            errors.append(f"{key} is longer than {extra['maxLength']} characters.")
    if not cfg.get("BQ_PROJECT_ID"):
        errors.append("No BigQuery project: set GCP_PROJECT_ID (or BQ_PROJECT_ID in Settings).")
    return errors
