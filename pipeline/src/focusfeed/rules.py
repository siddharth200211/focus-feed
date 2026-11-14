"""Content rules: identical to apps-script/Rules.gs, including the prompt-version hash, so a video
scored by either phase counts as scored for the other."""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

SCORE_PROMPT_VERSION = "v1"
DAY = timedelta(days=1)
LANGUAGE_NAMES = {
    "en": "English", "hi": "Hindi", "mr": "Marathi", "gu": "Gujarati", "ta": "Tamil", "te": "Telugu", "bn": "Bengali",
    "es": "Spanish", "fr": "French", "de": "German", "pt": "Portuguese", "it": "Italian", "ru": "Russian",
    "ar": "Arabic", "zh": "Chinese", "ja": "Japanese", "ko": "Korean",
}


def hash_str(s: str) -> int:
    """FNV-1a over UTF-16 code units, exactly like hashStr_ in Feed.gs (Math.imul semantics)."""
    h = 2166136261
    data = s.encode("utf-16-le")
    for i in range(0, len(data), 2):
        h = ((h ^ (data[i] | data[i + 1] << 8)) * 16777619) & 0xFFFFFFFF
    return h


def base36(n: int) -> str:
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    out = ""
    while True:
        n, r = divmod(n, 36)
        out = digits[r] + out
        if n == 0:
            return out


def js_json_string(s: str) -> str:
    """JSON.stringify for a string."""
    return json.dumps(s, ensure_ascii=False)


def scoring_rules(cfg: dict) -> list[str]:
    rules = []
    lang = cfg.get("LANGUAGE_FILTER")
    if lang:
        name = LANGUAGE_NAMES.get(lang, f'the language with code "{lang}"')
        rules.append(f"Only videos in {name}. A video mainly in another language breaks this rule.")
    if cfg.get("EXCLUDE_ADS") == "yes":
        rules.append("No advertisements: a video that mainly promotes a paid course, coaching, an app, a book or a "
                     "discount code breaks this rule, even when it is on topic.")
    if cfg.get("SCORING_GUIDANCE"):
        rules.append(f"In the learner's own words: {js_json_string(cfg['SCORING_GUIDANCE'])}")
    return rules


def prompt_version(cfg: dict) -> str:
    rules = scoring_rules(cfg)
    return f"{SCORE_PROMPT_VERSION}-{base36(hash_str('|'.join(rules)))[:6]}" if rules else SCORE_PROMPT_VERSION


def min_published(cfg: dict, now: datetime | None = None) -> str:
    """Oldest allowed publish time (ISO, ms, Z), or the epoch when there is no age limit."""
    days = cfg.get("MAX_VIDEO_AGE_DAYS") or 0
    if days <= 0:
        return "1970-01-01T00:00:00.000Z"
    now = now or datetime.now(timezone.utc)
    return iso(now - days * DAY)


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
