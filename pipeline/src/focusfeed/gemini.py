"""A small Gemini API client that returns parsed JSON: the Python twin of apps-script/Gemini.gs.

The key travels in a header, never in a URL. Rate limits (HTTP 429) are retried after the delay
Gemini asks for, overloads (5xx) with backoff, and a used-up daily quota is reported at once so the
caller can switch models instead of waiting.
"""
from __future__ import annotations

import json
import math
import re
import time

import requests

GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/"
# Least thinking first. Gemini 3+ models take thinkingLevel ("minimal" on Flash); 2.x models take
# thinkingBudget 0. A model that rejects a step moves to the next one, remembered per model.
THINKING_LADDER = [{"thinkingLevel": "minimal"}, {"thinkingLevel": "low"}, {"thinkingBudget": 0}, None]


class GeminiError(Exception):
    """kind: daily_quota | rate_limit | server | not_found | request | output"""

    def __init__(self, kind: str, message: str):
        super().__init__(message)
        self.kind = kind


class Gemini:
    def __init__(self, api_key: str, session=None, sleep=time.sleep, clock=time.monotonic):
        self.api_key = api_key
        self.session = session or requests.Session()
        self.sleep, self.clock = sleep, clock
        self.thinking_step: dict[str, int] = {}

    def json(self, model: str, system: str, user: str, schema: dict, max_attempts: int = 4,
             deadline: float | None = None, no_thinking: bool = True) -> dict:
        """generateContent with a JSON response schema. Returns {data, model_version, ms}."""
        if not self.api_key:
            raise GeminiError("request", "No Gemini key: set the GEMINI_API_KEY secret.")
        body = {
            "systemInstruction": {"parts": [{"text": system}]},
            "contents": [{"role": "user", "parts": [{"text": user}]}],
            "generationConfig": {"temperature": 0, "responseMimeType": "application/json", "responseSchema": schema},
        }
        gen = body["generationConfig"]
        step = min(self.thinking_step.get(model, 0), len(THINKING_LADDER) - 1) if no_thinking else len(THINKING_LADDER) - 1

        def apply_thinking():
            if THINKING_LADDER[step]:
                gen["thinkingConfig"] = THINKING_LADDER[step]
            else:
                gen.pop("thinkingConfig", None)

        apply_thinking()
        t0 = self.clock()
        deadline = deadline if deadline is not None else t0 + 60
        attempt = 0
        while True:
            attempt += 1
            res = self.session.post(f"{GEMINI_URL}{requests.utils.quote(model, safe='')}:generateContent",
                                    headers={"x-goog-api-key": self.api_key, "Content-Type": "application/json"},
                                    data=json.dumps(body).encode("utf-8"), timeout=120)
            code = res.status_code
            if code == 200:
                out = parse_response(res.text)
                out["ms"] = int((self.clock() - t0) * 1000)
                return out
            try:
                err = json.loads(res.text).get("error") or {}
            except (ValueError, AttributeError):
                err = {}
            message = err.get("message") or f"HTTP {code}"
            if code == 400 and "thinkingConfig" in gen and re.search("thinking", message, re.I):
                step += 1
                self.thinking_step[model] = step
                apply_thinking()
                attempt -= 1  # not a real failure: send again with the next setting
                continue
            if code == 429 and is_daily_quota(err):
                raise GeminiError("daily_quota", message)
            if code == 404:
                raise GeminiError("not_found", message)
            if not (code == 429 or code >= 500):
                raise GeminiError("request", message)
            wait = retry_delay_s(err, 20) if code == 429 else 5 * 2 ** (attempt - 1)  # 5, 10, 20 s
            if attempt >= max_attempts or self.clock() + wait > deadline:
                raise GeminiError("rate_limit" if code == 429 else "server", message)
            self.sleep(wait)

    def model_status(self, model: str) -> str:
        """For `check`: "ok", "not found" or the error. Reads model metadata only (no quota used)."""
        if not self.api_key:
            return "no GEMINI_API_KEY"
        res = self.session.get(f"{GEMINI_URL}{requests.utils.quote(model, safe='')}",
                               headers={"x-goog-api-key": self.api_key}, timeout=30)
        if res.status_code == 200:
            return "ok"
        if res.status_code == 404:
            return "not found"
        try:
            return (json.loads(res.text).get("error") or {}).get("message") or f"HTTP {res.status_code}"
        except (ValueError, AttributeError):
            return f"HTTP {res.status_code}"


def parse_response(text: str) -> dict:
    res = json.loads(text)
    cands = res.get("candidates") or []
    cand = cands[0] if cands else None
    parts = ((cand or {}).get("content") or {}).get("parts") or []
    out = "".join(p.get("text") or "" for p in parts)
    if not out:
        why = (cand or {}).get("finishReason") or (res.get("promptFeedback") or {}).get("blockReason") or "empty response"
        raise GeminiError("output", f"Gemini returned no text ({why})")
    try:
        data = json.loads(out)
    except ValueError:
        raise GeminiError("output", "Gemini returned malformed JSON") from None
    return {"data": data, "model_version": res.get("modelVersion")}


def is_daily_quota(err: dict) -> bool:
    """A 429 caused by a per-day limit won't clear by waiting a few seconds."""
    return any(re.search("PerDay", str(v.get("quotaId", "")), re.I)
               for d in err.get("details") or [] for v in d.get("violations") or [])


def retry_delay_s(err: dict, fallback_s: float) -> float:
    """Gemini's RetryInfo, e.g. "retryDelay": "17s" → 17.5 (capped at 60 s), same as Gemini.gs."""
    info = next((d for d in err.get("details") or [] if d.get("retryDelay")), None)
    m = re.match(r"\s*(\d+(?:\.\d+)?)", str(info["retryDelay"])) if info else None
    if not m:
        return min(fallback_s, 60)
    return min((math.ceil(float(m.group(1)) * 1000) + 500) / 1000, 60)
