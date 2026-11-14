from datetime import datetime, timezone

import pytest

from focusfeed import collect, youtube

NOW = datetime(2026, 11, 14, 8, 30, tzinfo=timezone.utc)
vid = lambda k: "v" + str(k).zfill(10)


class FakeYouTube:
    """50 results per search from a pool of 1,200, so searches overlap. Every 13th video has vanished
    by the details lookup; every 5th is over 3 minutes; every 11th isn't embeddable."""

    def __init__(self, quota_on=0, fail_on=()):
        self.searches, self.detail_calls = [], []
        self.quota_on, self.fail_on = quota_on, set(fail_on)

    def search(self, term, order, language, published_after):
        self.searches.append((term, order, language, published_after))
        n = len(self.searches)
        if n == self.quota_on:
            raise youtube.QuotaExceeded("quota")
        if n in self.fail_on:
            raise RuntimeError("Backend Error")
        return [{"id": {"videoId": vid((n * 37 + i) % 1200)}, "snippet": {
            "title": f"Don&#39;t miss {vid((n * 37 + i) % 1200)}", "channelTitle": "Prep &amp; Co", "channelId": "UC1",
            "publishedAt": "2026-10-01T10:00:00Z", "description": "d", "thumbnails": {"high": {"url": "https://i/x.jpg"}}}}
            for i in range(50)]

    def videos(self, ids):
        assert len(ids) <= 50
        self.detail_calls.append(ids)
        out = []
        for i in ids:
            k = int(i[1:])
            if k % 13 == 0:
                continue
            out.append({"id": i, "contentDetails": {"duration": "PT3M30S" if k % 5 == 0 else "PT45S"},
                        "status": {"embeddable": k % 11 != 0}, "statistics": {"viewCount": str(k * 10), "likeCount": str(k)},
                        "snippet": {"defaultAudioLanguage": "hi" if k % 10 == 3 else "en-US"}})
        return out


def run(cfg, store, yt=None, used=0):
    yt = yt or FakeYouTube()
    stats = collect.collect(cfg, store, yt, youtube.Budget(store, units_today=used), now=NOW)
    return stats, yt


def test_collect_loads_unique_rows_and_logs_the_run(cfg, store):
    stats, yt = run(cfg, store)
    rows = store.rows["raw_videos"]
    assert len(yt.searches) == 50
    assert len({r["video_id"] for r in rows}) == len(rows) > 500
    r = next(x for x in rows if x["video_id"] == vid(38))
    assert r["title"] == f"Don't miss {vid(38)}" and r["channel_title"] == "Prep & Co"
    assert (r["duration_sec"], r["embeddable"], r["view_count"], r["language"]) == (45, True, 380, "en-US")
    gone = next(x for x in rows if int(x["video_id"][1:]) % 13 == 0)
    assert gone["duration_sec"] is None and gone["embeddable"] is None
    assert all(set(x) == set(__import__("focusfeed.schema", fromlist=["x"]).column_names("raw_videos")) for x in rows)
    assert all(x["run_id"].startswith("py-") and x["collected_at"] == "2026-11-14T08:30:00.000Z" for x in rows)
    log = store.runs[0]
    assert (log["step"], log["status"], log["rows_in"], log["rows_out"]) == ("collect", "ok", 50, len(rows))
    assert log["quota_units"] == 50 * 100 + len(yt.detail_calls)
    assert stats["embeddable_shorts"] == sum(1 for x in rows if x["embeddable"] and x["duration_sec"] and x["duration_sec"] <= 180)


def test_age_rule_narrows_the_search(cfg, store):
    cfg["MAX_VIDEO_AGE_DAYS"] = 730
    _, yt = run(cfg, store)
    assert yt.searches[0][3] == "2024-11-14T08:30:00.000Z"
    cfg2 = dict(cfg, MAX_VIDEO_AGE_DAYS=0)
    _, yt2 = run(cfg2, type(store)())
    assert yt2.searches[0][3] is None


def test_budget_stops_before_the_quota(cfg, store):
    stats, yt = run(cfg, store, used=9_000)
    assert 0 < len(yt.searches) < 10
    assert "stopped early: daily YouTube quota budget reached" in stats["notes"]


def test_youtube_quota_error_keeps_what_was_found(cfg, store):
    stats, yt = run(cfg, store, FakeYouTube(quota_on=6))
    assert len(yt.searches) == 6 and store.runs[0]["rows_in"] == 5
    assert store.rows["raw_videos"]


def test_three_failures_abort_and_are_logged(cfg, store):
    with pytest.raises(RuntimeError, match="failed 3 times"):
        run(cfg, store, FakeYouTube(fail_on=(2, 4, 6)))
    assert store.runs[0]["status"] == "error"
    assert "raw_videos" not in store.rows


class FakeHttp:
    def __init__(self, code, data):
        self.headers, self.calls, self.code, self.data = {}, [], code, data

    def get(self, url, params, timeout):
        self.calls.append((url, params))
        return type("R", (), {"status_code": self.code, "ok": self.code < 400, "json": lambda s: self.data, "text": str(self.data)})()


def test_api_key_goes_in_a_header_not_the_url():
    http = FakeHttp(200, {"items": []})
    yt = youtube.YouTube("AIza-secret", session=http)
    yt.search("TOEFL", "date", "en", None)
    url, params = http.calls[0]
    assert http.headers["X-Goog-Api-Key"] == "AIza-secret"
    assert "AIza" not in url and "AIza" not in str(params)
    assert params["q"] == "TOEFL #shorts" and "publishedAfter" not in params


def test_quota_errors_are_recognised():
    http = FakeHttp(403, {"error": {"message": "over", "errors": [{"reason": "quotaExceeded"}]}})
    with pytest.raises(youtube.QuotaExceeded):
        youtube.YouTube("k", session=http).search("t", "date", "en", None)
