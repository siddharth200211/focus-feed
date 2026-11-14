"""Side-by-side check before switching over: Phase 1's feed (Apps Script) against Phase 2's (dbt).

Both phases start from the same history (seed), run the same searches and score with the same
rules, so their feeds should be nearly the same. They can't be identical: each phase asks Gemini
separately about new videos, and a score of 6 in one and 7 in the other moves a video across
MIN_SCORE. The score-agreement numbers show how often that happens.
"""
from __future__ import annotations

from .rules import prompt_version

FEEDS_SQL = """-- focusfeed: compare feeds
WITH v1 AS (SELECT video_id, title, score FROM {v1} WHERE topic = @topic),
     v2 AS (SELECT video_id, title, score FROM {v2} WHERE topic = @topic)
SELECT
  COUNTIF(v1.video_id IS NOT NULL AND v2.video_id IS NOT NULL) AS in_both,
  COUNTIF(v2.video_id IS NULL) AS only_v1,
  COUNTIF(v1.video_id IS NULL) AS only_v2,
  COUNTIF(v1.score = v2.score) AS same_score,
  ARRAY_AGG(IF(v2.video_id IS NULL, STRUCT(v1.video_id AS video_id, v1.title AS title, v1.score AS score), NULL)
            IGNORE NULLS ORDER BY v1.score DESC LIMIT 5) AS sample_only_v1,
  ARRAY_AGG(IF(v1.video_id IS NULL, STRUCT(v2.video_id AS video_id, v2.title AS title, v2.score AS score), NULL)
            IGNORE NULLS ORDER BY v2.score DESC LIMIT 5) AS sample_only_v2
FROM v1 FULL OUTER JOIN v2 USING (video_id)"""

# Videos that both phases scored on their own: Phase 1 rows (Apps Script) from its dataset,
# Phase 2 rows from this one ("py-" run IDs; the seeded Phase 1 rows are left out).
AGREEMENT_SQL = """-- focusfeed: score agreement
WITH v1 AS (
  SELECT video_id, ARRAY_AGG(score ORDER BY scored_at DESC LIMIT 1)[OFFSET(0)] AS score
  FROM {v1} WHERE topic = @topic AND prompt_version = @prompt_version AND score IS NOT NULL
    AND NOT STARTS_WITH(run_id, 'py-')
  GROUP BY video_id),
v2 AS (
  SELECT video_id, ARRAY_AGG(score ORDER BY scored_at DESC LIMIT 1)[OFFSET(0)] AS score
  FROM {v2} WHERE topic = @topic AND prompt_version = @prompt_version AND score IS NOT NULL
    AND STARTS_WITH(run_id, 'py-')
  GROUP BY video_id)
SELECT
  COUNT(*) AS scored_by_both,
  COUNTIF(v1.score = v2.score) AS same,
  COUNTIF(ABS(v1.score - v2.score) <= 1) AS within_one,
  COUNTIF((v1.score >= @min_score) != (v2.score >= @min_score)) AS cross_min_score
FROM v1 JOIN v2 USING (video_id)"""


def compare(cfg: dict, store, v1_dataset: str) -> list[str]:
    if v1_dataset == cfg["BQ_DATASET"]:
        raise ValueError(f"Both sides are {v1_dataset}: set BQ_DATASET to the Phase 2 dataset to compare.")
    t = lambda ds, name: f"`{cfg['BQ_PROJECT_ID']}.{ds}.{name}`"  # noqa: E731
    f = store.query(FEEDS_SQL.format(v1=t(v1_dataset, "feed"), v2=t(cfg["BQ_DATASET"], "feed")),
                    {"topic": cfg["TOPIC"]})[0]
    a = store.query(AGREEMENT_SQL.format(v1=t(v1_dataset, "scored_videos"), v2=t(cfg["BQ_DATASET"], "scored_videos")),
                    {"topic": cfg["TOPIC"], "prompt_version": prompt_version(cfg), "min_score": cfg["MIN_SCORE"]})[0]
    v1n, v2n = f["in_both"] + f["only_v1"], f["in_both"] + f["only_v2"]
    pct = lambda x, n: f"{100 * x / n:.0f}%" if n else "–"  # noqa: E731
    lines = [
        f"Feeds: Phase 1 ({v1_dataset}) {v1n:,} videos · Phase 2 ({cfg['BQ_DATASET']}) {v2n:,} videos",
        f"  in both: {f['in_both']:,} ({pct(f['in_both'], max(v1n, v2n))} of the larger) · "
        f"only Phase 1: {f['only_v1']:,} · only Phase 2: {f['only_v2']:,}",
        f"  same score where in both: {pct(f['same_score'], f['in_both'])}",
    ]
    for side, key in (("only in Phase 1", "sample_only_v1"), ("only in Phase 2", "sample_only_v2")):
        for x in f[key] or []:
            lines.append(f"  {side}: {x['video_id']} ({x['score']}) {str(x['title'] or '')[:70]}")
    n = a["scored_by_both"]
    lines += [
        f"Scored separately by both phases: {n:,} videos",
        f"  same score: {pct(a['same'], n)} · within 1 point: {pct(a['within_one'], n)} · "
        f"on different sides of MIN_SCORE ({cfg['MIN_SCORE']}): {a['cross_min_score']:,}",
    ]
    return lines
