"""FocusFeed Phase 2: the collect and score steps as Python jobs that write to BigQuery.

The Apps Script project (Phase 1) keeps the web app, the Settings tab and the events tab.
Everything here mirrors its logic exactly (checked by tests/test_parity.py), so both phases
produce the same rows and the same scoring versions.
"""
__version__ = "2.0.0"
