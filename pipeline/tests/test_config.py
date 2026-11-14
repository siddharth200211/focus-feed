import pytest

from focusfeed import config


def test_defaults_and_env_overrides():
    cfg = config.parse({"TOPIC": "TOEFL", "BQ_DATASET": "focus_feed", "SEARCH_TERMS": "a, b\nc"},
                       env={"GCP_PROJECT_ID": "p1", "BQ_DATASET": "focus_feed_v2"})
    assert cfg["SEARCHES_PER_DAY"] == 50 and cfg["MIN_SCORE"] == 7
    assert cfg["SEARCH_TERMS"] == ["a", "b", "c"]
    assert cfg["BQ_PROJECT_ID"] == "p1" and cfg["BQ_DATASET"] == "focus_feed_v2"
    assert config.validate(cfg) == []


def test_sheet_numbers_and_blanks():
    cfg = config.parse({"TOPIC": "T", "MIN_SCORE": 8.0, "SEARCHES_PER_DAY": "", "EXCLUDE_ADS": " YES "}, env={"GCP_PROJECT_ID": "p"})
    assert cfg["MIN_SCORE"] == 8 and isinstance(cfg["MIN_SCORE"], int)
    assert cfg["SEARCHES_PER_DAY"] == 50
    assert cfg["EXCLUDE_ADS"] == "yes"


def test_validation_messages():
    cfg = config.parse({"TOPIC": "", "SEARCHES_PER_DAY": 500, "LANGUAGE_FILTER": "english", "STORAGE": "excel"}, env={})
    errors = " ".join(config.validate(cfg))
    assert "TOPIC is empty" in errors
    assert "SEARCHES_PER_DAY must be a whole number from 1 to 90" in errors
    assert 'LANGUAGE_FILTER "english" doesn\'t look right' in errors
    assert "STORAGE must be one of: sheets, bigquery" in errors
    assert "No BigQuery project" in errors


class FakeResp:
    def __init__(self, code, data):
        self.status_code, self._data = code, data

    def json(self):
        return self._data

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(self.status_code)


class FakeSession:
    def __init__(self, resp):
        self.resp, self.urls = resp, []

    def get(self, url, timeout):
        self.urls.append(url)
        return self.resp


def test_reads_the_settings_tab():
    s = FakeSession(FakeResp(200, {"values": [["TOPIC", "TOEFL"], ["MIN_SCORE", 7], ["", "ignored"], ["SEARCH_TERMS"]]}))
    raw = config.SheetSource("SHEET123", s).raw()
    assert raw == {"TOPIC": "TOEFL", "MIN_SCORE": 7, "SEARCH_TERMS": ""}
    assert "/spreadsheets/SHEET123/values/Settings!A2:B" in s.urls[0]
    assert "UNFORMATTED_VALUE" in s.urls[0]


def test_unshared_sheet_gives_a_clear_message():
    with pytest.raises(RuntimeError, match="Share it with the service account"):
        config.SheetSource("S", FakeSession(FakeResp(403, {}))).raw()


def test_reads_a_data_tab_as_rows():
    s = FakeSession(FakeResp(200, {"values": [["event_id", "event_at", "video_id", "event_type", "loaded_at"],
                                              ["e1", 45960.5, "v1", "like"], ["e2", 45961.25, "v2", "watch", ""]]}))
    rows = config.SheetSource("S", s).table("events")
    assert rows == [{"event_id": "e1", "event_at": 45960.5, "video_id": "v1", "event_type": "like", "loaded_at": None},
                    {"event_id": "e2", "event_at": 45961.25, "video_id": "v2", "event_type": "watch", "loaded_at": None}]
    assert "/values/events?valueRenderOption=UNFORMATTED_VALUE" in s.urls[0]
    assert config.SheetSource("S", FakeSession(FakeResp(400, {}))).table("nope") == []
    assert config.SheetSource("S", FakeSession(FakeResp(200, {}))).table("empty") == []
