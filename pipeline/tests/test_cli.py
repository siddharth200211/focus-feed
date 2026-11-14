"""python -m focusfeed: wiring of each command, with the sheet, BigQuery and Gemini faked."""
import pytest

import focusfeed.__main__ as cli
from focusfeed import gemini as gemini_mod
from test_score import FakeGemini, ScoreStore


class Sheet:
    def __init__(self, settings):
        self.settings = settings

    def raw(self):
        return self.settings

    def table(self, tab):
        assert tab == "events"
        return [{"event_at": 45960.5, "video_id": "v0000000001", "event_type": "like"}]


class Store(ScoreStore):
    def __init__(self):
        super().__init__(30, titles=["v0000000001"])
        self.seeded_from = None

    def ensure(self):
        return []

    def seed_from(self, source):
        self.seeded_from = source
        return [f"raw_videos: copied 10 rows from {source}"]


@pytest.fixture
def env(monkeypatch):
    monkeypatch.setenv("GCP_PROJECT_ID", "my-project")
    monkeypatch.setenv("BQ_DATASET", "focus_feed_v2")
    monkeypatch.setenv("GEMINI_API_KEY", "k")
    store = Store()
    settings = {"TOPIC": "TOEFL", "BQ_DATASET": "focus_feed", "GEMINI_MODEL": "main", "GEMINI_FALLBACK_MODELS": "none"}
    monkeypatch.setattr(cli, "open_sheet", lambda: Sheet(settings))
    monkeypatch.setattr(cli, "make_store", lambda cfg: store)
    gem = FakeGemini()
    monkeypatch.setattr(gemini_mod, "Gemini", lambda key: gem)
    return store, gem, settings


def test_score_command(env, capsys):
    store, gem, _ = env
    assert cli.main(["score"]) == 0
    out = capsys.readouterr().out
    assert "Scored 30 videos in 2 Gemini calls (main-001)" in out
    assert "liked v0000000001" in gem.calls[0]["system"], "taste comes from the events tab"
    assert len(store.rows["scored_videos"]) == 30


def test_seed_copies_from_the_settings_dataset_by_default(env, capsys):
    store, _, _ = env
    assert cli.main(["seed"]) == 0
    assert store.seeded_from == "focus_feed" and "copied 10 rows from focus_feed" in capsys.readouterr().out
    cli.main(["seed", "--from", "other"])
    assert store.seeded_from == "other"


def test_bad_settings_stop_before_any_work(env):
    _, gem, settings = env
    settings["MIN_SCORE"] = 42
    with pytest.raises(SystemExit, match="MIN_SCORE must be a whole number"):
        cli.main(["score"])
    assert gem.calls == []


@pytest.mark.parametrize("command", ["collect", "score", "build", "adopt"])
def test_phase_1_dataset_is_off_limits_until_pipeline_is_github(env, monkeypatch, command):
    store, gem, settings = env
    monkeypatch.setenv("BQ_DATASET", "focus_feed")  # the Apps Script's dataset
    with pytest.raises(SystemExit, match="Set PIPELINE to github and run FocusFeed → Setup first"):
        cli.main([command])
    assert gem.calls == [] and store.rows == {}


def test_after_the_switch_the_pipeline_runs_in_phase_1s_dataset(env, monkeypatch, capsys):
    store, gem, settings = env
    monkeypatch.setenv("BQ_DATASET", "focus_feed")
    settings["PIPELINE"] = "github"
    assert cli.main(["score"]) == 0
    assert len(store.rows["scored_videos"]) == 30


def test_adopt_copies_from_the_side_by_side_dataset_by_default(env, capsys):
    store, _, settings = env
    store.adopted = []
    store.adopt_from = lambda source: store.adopted.append(source) or [f"raw_videos: 5 Phase 2 rows copied from {source}"]
    settings["PIPELINE"] = "github"
    cli.main(["adopt"])
    assert store.adopted == ["focus_feed_v2_v2"], "<BQ_DATASET>_v2 (BQ_DATASET is focus_feed_v2 in this fixture)"
    cli.main(["adopt", "--from", "focus_feed_v2"])
    assert store.adopted[-1] == "focus_feed_v2"
