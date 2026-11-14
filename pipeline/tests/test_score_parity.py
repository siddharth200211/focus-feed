"""Score step: Phase 2 must send Gemini the same prompt and write the same rows as Score.gs.

Each test runs the real Apps Script functions (tests/gas_eval.js) beside the Python ones. Where the
JavaScript would call Gemini or the sheet, the expression swaps in a stub first.
"""
import json

import pytest

from conftest import gas
from focusfeed import gemini, rules, score

CFGS = [
    {"TOPIC": "TOEFL", "LANGUAGE_FILTER": "", "EXCLUDE_ADS": "no", "SCORING_GUIDANCE": ""},
    {"TOPIC": "TOEFL", "LANGUAGE_FILTER": "en", "EXCLUDE_ADS": "yes",
     "SCORING_GUIDANCE": "Only the new TOEFL format (from January 2026): \"Build a Sentence\", emoji 🎯, हिंदी"},
]
TASTES = [
    None,
    {"liked": [{"title": "Speaking template ✅", "channel": "Prep \"Pro\""}], "disliked": []},
    {"liked": [], "disliked": [{"title": "Buy my course", "channel": "Ads\\Co"}]},
    {"liked": [{"title": "a", "channel": ""}], "disliked": [{"title": "b", "channel": "c"}]},
]


@pytest.mark.parametrize("cfg", CFGS)
@pytest.mark.parametrize("taste", TASTES)
def test_prompt_matches(cfg, taste):
    js = gas(f"scoringPrompt_({json.dumps(cfg['TOPIC'])}, {json.dumps(taste)}, scoringRules_({json.dumps(cfg)}))")
    assert score.scoring_prompt(cfg["TOPIC"], taste, rules.scoring_rules(cfg)) == js


def test_schema_and_limits_match():
    assert gas("SCORE_SCHEMA") == score.SCORE_SCHEMA
    assert gas("[SHORTS_MAX_SEC, SCORE_CANDIDATE_LIMIT, TASTE_EXAMPLES]") == [
        score.SHORTS_MAX_SEC, score.SCORE_CANDIDATE_LIMIT, score.TASTE_EXAMPLES]


def test_candidate_query_matches():
    assert score.candidates_sql("`p.d.raw_videos`", "`p.d.scored_videos`") == gas(
        "scoreCandidatesSql_('`p.d.raw_videos`', '`p.d.scored_videos`')")


BATCH = [
    {"video_id": "aaaaaaaaaa1", "title": "TOEFL speaking 🎯 " + "x" * 300, "channel_title": "Prep & Co",
     "description": None, "duration_sec": 45},
    {"video_id": "aaaaaaaaaa2", "title": 'Quotes " and \\ and\nnew line', "channel_title": "",
     "description": "d" * 400, "duration_sec": 180},
    {"video_id": "aaaaaaaaaa3", "title": "हिंदी में TOEFL", "channel_title": "C" * 100, "description": "ok", "duration_sec": 1},
    *[{"video_id": f"bbbbbbbbbb{i}", "title": f"t{i}", "channel_title": "c", "description": "", "duration_sec": 30}
      for i in range(4, 10)],
]
ANSWER = [
    {"id": "1", "score": 9, "reason": "clear tip"},
    {"id": "1", "score": 0, "reason": "duplicate: the first one counts"},
    {"id": 2, "score": "7", "reason": "number id, string score"},
    {"id": "3", "score": 6.5, "reason": "halves round up " + "r" * 300},
    {"id": "4", "score": 11, "reason": "out of range"},
    {"id": "5", "score": None, "reason": "null counts as 0 in JavaScript"},
    {"id": "6", "score": "high", "reason": "not a number"},
    {"id": "7", "score": 4},
    {"score": 8, "reason": "no id"},
    {"id": "9", "score": -0.4, "reason": "rounds to zero"},
]


@pytest.mark.parametrize("cfg", CFGS)
@pytest.mark.parametrize("last_model", [True, False])
def test_batch_sends_the_same_request_and_writes_the_same_rows(cfg, last_model):
    taste = TASTES[3]
    js = gas(f"""(() => {{
      let sent;
      geminiJson_ = o => {{ sent = o; return {{ data: {json.dumps(ANSWER)}, modelVersion: 'gemini-3.5-flash-lite' }}; }};
      const res = scoreBatch_({json.dumps(cfg)}, {{ run_id: 'r1' }}, {json.dumps(BATCH)}, 0, 'm', {json.dumps(last_model)}, {json.dumps(taste)});
      return {{ rows: res.rows, model: res.model, sent }};
    }})()""")

    class Stub:
        def json(self, **kw):
            self.sent = kw
            return {"data": ANSWER, "model_version": "gemini-3.5-flash-lite", "ms": 5}

    stub = Stub()
    py = score.score_batch(cfg, {"run_id": "r1"}, BATCH, stub, "m", last_model, taste, deadline=0)
    strip = lambda rows: [{k: v for k, v in r.items() if k != "scored_at"} for r in rows]  # noqa: E731
    assert strip(py["rows"]) == strip(js["rows"])
    assert py["model"] == js["model"]
    assert stub.sent["system"] == js["sent"]["system"]
    assert stub.sent["user"] == js["sent"]["user"]
    assert stub.sent["schema"] == js["sent"]["schema"]
    assert stub.sent["max_attempts"] == js["sent"]["maxAttempts"]
    assert [r["score"] for r in py["rows"]][:7] == [9, 7, 7, None, 0, None, 4]


def test_batch_without_model_version_uses_the_model_name():
    js = gas("""(() => { geminiJson_ = () => ({ data: [{ id: '1', score: 8, reason: 'x' }] });
      return scoreBatch_({ TOPIC: 'T' }, { run_id: 'r' }, [{ video_id: 'v', title: 't' }], 0, 'my-model', true, null).model; })()""")
    stub = type("S", (), {"json": lambda self, **kw: {"data": [{"id": "1", "score": 8, "reason": "x"}], "model_version": None}})()
    py = score.score_batch({"TOPIC": "T", "LANGUAGE_FILTER": "", "EXCLUDE_ADS": "no", "SCORING_GUIDANCE": ""},
                           {"run_id": "r"}, [{"video_id": "v", "title": "t"}], stub, "my-model", True, None, 0)
    assert py["model"] == js == "my-model"


EVENTS = [
    {"event_at": "2026-11-01T10:00:00.000Z", "video_id": "v1", "event_type": "like"},
    {"event_at": "2026-11-03T10:00:00.000Z", "video_id": "v2", "event_type": "like"},
    {"event_at": "2026-11-02T10:00:00.000Z", "video_id": "v3", "event_type": "dislike"},
    {"event_at": "2026-11-04T10:00:00.000Z", "video_id": "v1", "event_type": "unlike"},
    {"event_at": "2026-11-05T10:00:00.000Z", "video_id": "v1", "event_type": "like"},
    {"event_at": "2026-11-05T10:00:00.000Z", "video_id": "v4", "event_type": "like"},
    {"event_at": "2026-11-06T10:00:00.000Z", "video_id": "v5", "event_type": "dislike"},
    {"event_at": "2026-11-07T10:00:00.000Z", "video_id": "v5", "event_type": "undislike"},
    {"event_at": "2026-11-08T10:00:00.000Z", "video_id": "v6", "event_type": "watch"},
    {"event_at": "2026-11-09T10:00:00.000Z", "video_id": "gone", "event_type": "like"},
    *[{"event_at": f"2026-10-{d:02d}T00:00:00.000Z", "video_id": f"old{d}", "event_type": "like"} for d in range(1, 12)],
]
FEED = [{"video_id": v, "title": f"Title {v} " + "🎯" * 3, "channel_title": None if v == "v2" else f"ch {v}"}
        for v in ["v1", "v2", "v3", "v4", "v5", "v6"] + [f"old{d}" for d in range(1, 12)]]


@pytest.mark.parametrize("events", [EVENTS, EVENTS[::-1], EVENTS[8:9], []])
def test_taste_matches(events):
    js = gas(f"""(() => {{
      sheetsReadTable_ = () => {json.dumps(events)};
      feedRows_ = () => {json.dumps(FEED)};
      return tasteProfile_({{}}, {{}});
    }})()""")
    by_id = {r["video_id"]: r for r in FEED}
    py = score.taste_profile(events, lambda ids: {i: by_id[i] for i in ids if i in by_id})
    assert py == js
    if events is EVENTS:
        assert [x["title"].split()[1] for x in py["liked"]][:4] == ["v1", "v4", "v2", "old11"]
        assert len(py["liked"]) == score.TASTE_EXAMPLES


def test_sheet_serial_dates_order_like_iso_dates():
    serial = [dict(e, event_at=n) for n, e in zip([45962.4, 45964.1, 45963.0], EVENTS[:3])]
    iso = EVENTS[:3]
    assert score.viewer_marks(serial) == score.viewer_marks(iso)


@pytest.mark.parametrize("err", [
    {"details": [{"retryDelay": "17s"}]},
    {"details": [{"@type": "x"}, {"retryDelay": "1.5s"}]},
    {"details": [{"retryDelay": "300s"}]},
    {"details": []},
    {},
])
def test_retry_delay_matches(err):
    assert gemini.retry_delay_s(err, 20) * 1000 == gas(f"retryDelayMs_({json.dumps(err)}, 20000)")


@pytest.mark.parametrize("err", [
    {"details": [{"violations": [{"quotaId": "GenerateRequestsPerDayPerProjectPerModel-FreeTier"}]}]},
    {"details": [{"violations": [{"quotaId": "GenerateRequestsPerMinutePerProjectPerModel-FreeTier"}]}]},
    {"details": [{"violations": [{}]}, {}]},
    {},
])
def test_daily_quota_detection_matches(err):
    assert gemini.is_daily_quota(err) == gas(f"isDailyQuota_({json.dumps(err)})")


@pytest.mark.parametrize("body", [
    {"candidates": [{"content": {"parts": [{"text": "[{\"id\":\"1\"}]"}]}}], "modelVersion": "m-1"},
    {"candidates": [{"content": {"parts": [{"text": "[1,"}, {"text": "2]"}]}}]},
    {"candidates": [{"finishReason": "SAFETY"}]},
    {"promptFeedback": {"blockReason": "OTHER"}},
    {"candidates": [{"content": {"parts": [{"text": "not json"}]}}]},
])
def test_response_parsing_matches(body):
    js = gas(f"""(() => {{ try {{ return parseGeminiJson_({json.dumps(json.dumps(body))}); }}
      catch (e) {{ return {{ kind: e.kind, message: e.message }}; }} }})()""")
    try:
        r = gemini.parse_response(json.dumps(body))
        py = {"data": r["data"], "modelVersion": r["model_version"]}
    except gemini.GeminiError as e:
        py = {"kind": e.kind, "message": str(e)}
    assert py == js


def test_thinking_ladder_matches():
    assert gemini.THINKING_LADDER == gas("THINKING_LADDER")
