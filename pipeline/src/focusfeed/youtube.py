"""YouTube Data API v3 with an API key (sent as a header, never in the URL), plus the daily quota
budget, worked out from pipeline_runs so it survives restarts and needs no extra state."""
from __future__ import annotations

import requests

API = "https://www.googleapis.com/youtube/v3/"
DAILY_QUOTA = 10_000
RESERVE = 300
SEARCH_UNITS = 100


class QuotaExceeded(Exception):
    pass


class YouTube:
    def __init__(self, api_key: str, session: requests.Session | None = None):
        if not api_key:
            raise ValueError("YOUTUBE_API_KEY is not set.")
        self.session = session or requests.Session()
        self.session.headers["X-Goog-Api-Key"] = api_key

    def _get(self, path: str, params: dict) -> dict:
        res = self.session.get(API + path, params={k: v for k, v in params.items() if v is not None}, timeout=30)
        if res.status_code == 403:
            reasons = {e.get("reason") for e in res.json().get("error", {}).get("errors", [])}
            if reasons & {"quotaExceeded", "dailyLimitExceeded", "rateLimitExceeded"}:
                raise QuotaExceeded(res.json()["error"].get("message", "quota exceeded"))
        if not res.ok:
            raise RuntimeError(f"YouTube {path} failed: HTTP {res.status_code} {res.text[:200]}")
        return res.json()

    def search(self, term: str, order: str, language: str, published_after: str | None) -> list[dict]:
        data = self._get("search", {
            "part": "snippet", "q": f"{term} #shorts", "type": "video", "videoDuration": "short",
            "videoEmbeddable": "true", "order": order, "relevanceLanguage": language,
            "safeSearch": "moderate", "maxResults": 50, "publishedAfter": published_after,
        })
        return data.get("items", [])

    def videos(self, ids: list[str]) -> list[dict]:
        return self._get("videos", {"part": "snippet,contentDetails,status,statistics", "id": ",".join(ids),
                                    "maxResults": 50}).get("items", [])


class Budget:
    """YouTube units already spent today (Pacific day, like Google counts) by Phase 2 collect runs."""

    def __init__(self, store, units_today: int | None = None):
        self.store = store
        self.used = units_today if units_today is not None else self._from_runs()

    def _from_runs(self) -> int:
        rows = self.store.query(
            f"""SELECT IFNULL(SUM(quota_units), 0) AS units FROM `{self.store.ref('pipeline_runs')}`
            WHERE step = 'collect' AND STARTS_WITH(run_id, 'py-')
              AND DATE(started_at, 'America/Los_Angeles') = CURRENT_DATE('America/Los_Angeles')""")
        return int(rows[0]["units"]) if rows else 0

    def can_spend(self, units: int) -> bool:
        return self.used + units <= DAILY_QUOTA - RESERVE

    def spend(self, units: int) -> None:
        self.used += units
