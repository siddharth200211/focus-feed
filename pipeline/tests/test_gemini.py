"""Gemini client: headers, thinking ladder, retries and error kinds, against a fake HTTP session."""
import json

import pytest

from focusfeed.gemini import Gemini, GeminiError

OK = {"candidates": [{"content": {"parts": [{"text": '[{"id":"1","score":9,"reason":"r"}]'}]}}], "modelVersion": "gemini-3.5-flash-lite"}


def resp(code, body):
    return type("R", (), {"status_code": code, "text": json.dumps(body)})()


def err(code, message, details=()):
    return resp(code, {"error": {"code": code, "message": message, "details": list(details)}})


class Session:
    def __init__(self, *responses):
        self.responses, self.posts, self.gets = list(responses), [], []

    def post(self, url, headers, data, timeout):
        self.posts.append({"url": url, "headers": headers, "body": json.loads(data)})
        return self.responses.pop(0)

    def get(self, url, headers, timeout):
        self.gets.append(url)
        return self.responses.pop(0)


class Clock:
    def __init__(self):
        self.t, self.slept = 0.0, []

    def __call__(self):
        return self.t

    def sleep(self, s):
        self.slept.append(s)
        self.t += s


def client(*responses, key="AIza-secret"):
    c = Clock()
    s = Session(*responses)
    return Gemini(key, session=s, sleep=c.sleep, clock=c), s, c


def call(g, **kw):
    return g.json(model=kw.pop("model", "gemini-flash-lite-latest"), system="sys", user="[]",
                  schema={"type": "ARRAY"}, deadline=kw.pop("deadline", 600), **kw)


def test_success_sends_the_key_in_a_header_and_asks_for_minimal_thinking():
    g, s, _ = client(resp(200, OK))
    out = call(g)
    assert out["data"][0]["score"] == 9 and out["model_version"] == "gemini-3.5-flash-lite"
    p = s.posts[0]
    assert p["url"].endswith("/models/gemini-flash-lite-latest:generateContent") and "AIza" not in p["url"]
    assert p["headers"]["x-goog-api-key"] == "AIza-secret"
    cfg = p["body"]["generationConfig"]
    assert cfg["thinkingConfig"] == {"thinkingLevel": "minimal"} and cfg["temperature"] == 0
    assert cfg["responseMimeType"] == "application/json" and p["body"]["systemInstruction"]["parts"][0]["text"] == "sys"


def test_rejected_thinking_setting_steps_down_the_ladder_and_is_remembered():
    bad = err(400, "Thinking level is not supported for this model.")
    g, s, c = client(bad, bad, resp(200, OK), resp(200, OK))
    call(g, model="gemini-2.5-flash")
    assert [p["body"]["generationConfig"].get("thinkingConfig") for p in s.posts] == [
        {"thinkingLevel": "minimal"}, {"thinkingLevel": "low"}, {"thinkingBudget": 0}]
    call(g, model="gemini-2.5-flash")
    assert s.posts[3]["body"]["generationConfig"]["thinkingConfig"] == {"thinkingBudget": 0}
    assert c.slept == []


def test_no_thinking_setting_at_all_when_every_step_is_rejected():
    bad = err(400, "thinking is not supported")
    g, s, _ = client(bad, bad, bad, resp(200, OK))
    call(g, model="old")
    assert "thinkingConfig" not in s.posts[3]["body"]["generationConfig"]


def test_daily_quota_is_reported_at_once():
    g, s, c = client(err(429, "Quota exceeded", [{"violations": [{"quotaId": "GenerateRequestsPerDayPerProjectPerModel-FreeTier"}]}]))
    with pytest.raises(GeminiError) as e:
        call(g)
    assert e.value.kind == "daily_quota" and len(s.posts) == 1 and c.slept == []


def test_rate_limit_waits_as_long_as_gemini_asks():
    g, s, c = client(err(429, "slow down", [{"retryDelay": "3s"}]), resp(200, OK))
    call(g)
    assert c.slept == [3.5] and len(s.posts) == 2


def test_overload_backs_off_then_gives_up():
    g, s, c = client(*[err(503, "The model is overloaded.")] * 4)
    with pytest.raises(GeminiError) as e:
        call(g, max_attempts=4)
    assert e.value.kind == "server" and str(e.value) == "The model is overloaded."
    assert c.slept == [5, 10, 20] and len(s.posts) == 4


def test_fewer_attempts_when_another_model_can_take_over():
    g, s, c = client(*[err(429, "slow down")] * 2)
    with pytest.raises(GeminiError) as e:
        call(g, max_attempts=2)
    assert e.value.kind == "rate_limit" and c.slept == [20]


def test_no_wait_past_the_deadline():
    g, s, c = client(err(503, "busy"))
    with pytest.raises(GeminiError, match="busy"):
        call(g, deadline=3)
    assert c.slept == []


@pytest.mark.parametrize("code,kind", [(404, "not_found"), (400, "request"), (403, "request")])
def test_other_errors(code, kind):
    g, _, _ = client(err(code, "nope"))
    with pytest.raises(GeminiError) as e:
        call(g)
    assert e.value.kind == kind


def test_non_json_error_body():
    g, _, _ = client(type("R", (), {"status_code": 502, "text": "<html>Bad Gateway</html>"})(), resp(200, OK))
    assert call(g)["data"]


def test_missing_key():
    g, s, _ = client(key="")
    with pytest.raises(GeminiError, match="GEMINI_API_KEY") as e:
        call(g)
    assert e.value.kind == "request" and s.posts == []


def test_model_status_for_check():
    g, s, _ = client(resp(200, {"name": "models/x"}), resp(404, {}), err(403, "API key not valid"))
    assert [g.model_status("a"), g.model_status("b"), g.model_status("c")] == ["ok", "not found", "API key not valid"]
    assert all("AIza" not in u for u in s.gets)
    assert Gemini("").model_status("a") == "no GEMINI_API_KEY"
