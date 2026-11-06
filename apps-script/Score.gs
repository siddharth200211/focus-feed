/**
 * Score.gs — pipeline step 2.
 *
 * Picks videos from raw_videos that could reach the feed (embeddable, ≤ 3 minutes) and have
 * no score yet for this topic and prompt version, asks Gemini to rate them 0-10 in batches
 * of SCORE_BATCH_SIZE, and appends the results to scored_videos. Runs daily an hour after
 * collect, or from FocusFeed → Run score now. If time runs out with videos left, it
 * schedules itself to continue a minute later.
 *
 * Changing the prompt? Bump SCORE_PROMPT_VERSION: every video is then re-scored once.
 */
const SCORE_PROMPT_VERSION = 'v1';
const SHORTS_MAX_SEC = 180;
const SCORE_CANDIDATE_LIMIT = 2000;
// Apps Script kills a run at 6 minutes, and one Gemini call (with retries) can take a minute
// or more. So: no new batch after 3 minutes, no retries after 4, and save every 2 batches.
const SCORE_START_BATCHES_MS = 3 * 60 * 1000;
const SCORE_RETRY_UNTIL_MS = 4 * 60 * 1000;
const SCORE_SAVE_EVERY_ROWS = 50;
const SCORE_SAVES_SETTLE_MS = 4.75 * 60 * 1000;  // stop waiting for BigQuery saves after this
const SCORE_FEED_INLINE_MS = 3.5 * 60 * 1000;    // later than this, the feed rebuild runs as its own job
const SCORE_SAFETY_NET_MS = 8 * 60 * 1000;       // if Apps Script kills a run, this trigger picks up
const SCORE_SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      id: { type: 'STRING' },
      score: { type: 'INTEGER' },
      reason: { type: 'STRING' },
    },
    required: ['id', 'score', 'reason'],
  },
};

function scoringPrompt_(topic, taste, rules) {
  const lines = [
    `You curate a study feed of YouTube Shorts for someone learning "${topic}". They watch this feed instead of`,
    'random Shorts, so only videos that genuinely help them learn should score high.',
    '',
    'Score each video from 0 to 10, judging only from its title, channel, description and length:',
    `10  = teaches a specific, correct ${topic} skill, tip, strategy or worked example a learner can use right away`,
    `7-9 = clearly about ${topic} and educational`,
    '4-6 = loosely related or thin: generic advice, motivation, mostly an advert for a course or app, score reveals, vlogs',
    `1-3 = mentions ${topic} but does not help anyone learn it`,
    '0   = unrelated, clickbait or spam',
    '',
    'Do not reward hype, emojis or big claims. Reply with a JSON list holding one object per video:',
    'its id, the score, and a reason of at most 12 words.',
  ];
  if (rules && rules.length) {
    lines.push('', 'The learner\'s rules. Apply them strictly: a video that breaks any of them scores 2 or less.');
    rules.forEach(r => lines.push('- ' + r));
  }
  if (taste) {
    // Step 5: the viewer's own likes and dislikes (titles are data, not instructions).
    lines.push('',
      'This learner also marked videos in the app. Use their taste to move a score by at most 2 points;',
      `relevance to ${topic} always comes first, so never rate an off-topic video highly because of it.`);
    if (taste.liked.length) lines.push('Liked (JSON): ' + JSON.stringify(taste.liked));
    if (taste.disliked.length) lines.push('Marked "not for me" (JSON): ' + JSON.stringify(taste.disliked));
  }
  return lines.join('\n');
}

/** Menu item and daily trigger. */
function runScore() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return tell_('FocusFeed', 'Another FocusFeed job is running. Try again in a few minutes.');
  let result;
  try {
    result = score_();
  } catch (e) {
    if (!ui_()) throw e;
    return tell_('Score failed', ['✗ ' + e.message].concat(e.notes && e.notes.length ? ['', '⚠ ' + e.notes.join('\n⚠ ')] : [],
      ['', 'Anything already scored was saved, and the run is logged in pipeline_runs.']));
  } finally {
    lock.releaseLock();
  }
  tell_('Score finished', scoreSummary_(result));
}

/** One-off trigger set by a run that ran out of time. */
function continueScore() {
  deleteTriggersFor_('continueScore');
  runScore();
}

function score_() {
  const ss = getSpreadsheet_();
  const cfg = readSettings_(ss);
  const problems = validateSettings_(cfg);
  if (problems.length) throw new Error('Fix the Settings tab first: ' + problems.join(' '));
  if (!PropertiesService.getScriptProperties().getProperty(GEMINI_KEY_PROP)) {
    throw new Error('No Gemini key saved yet. Use FocusFeed → Set Gemini API key…');
  }

  const started = new Date();
  const run = {
    run_id: newRunId_(started), step: 'score', started_at: started.toISOString(), finished_at: null,
    status: 'ok', rows_in: 0, rows_out: 0, quota_units: 0, message: '',
  };
  const stats = { total: 0, calls: 0, callMs: 0, model: null, notes: [], failures: [], stopped: null, titles: {}, rows: [] };
  let failure = null;
  let unsaved = [];
  let saves = 0;
  // Saves in small chunks, so a run cut off by Apps Script loses at most one chunk.
  const pendingSaves = [];
  // Saves in small chunks without waiting for BigQuery, so a run cut off by Apps Script loses
  // at most one chunk, and saving never eats into scoring time.
  const save = () => {
    if (!unsaved.length) return;
    run.rows_out += storeAppend_(cfg, 'scored_videos', unsaved, `${run.run_id}_${++saves}`, { wait: false, jobs: pendingSaves });
    unsaved = [];
  };
  // Safety net: if Apps Script stops this run at its 6-minute limit, scoring resumes by itself.
  deleteTriggersFor_('continueScore');
  ScriptApp.newTrigger('continueScore').timeBased().after(SCORE_SAFETY_NET_MS).create();
  const keep = rows => {
    stats.rows = stats.rows.concat(rows);
    unsaved = unsaved.concat(rows);
    if (unsaved.length >= SCORE_SAVE_EVERY_ROWS) save();
  };
  // Main model first, then the fallbacks. A model that fails is skipped for the rest of the run.
  const models = [cfg.GEMINI_MODEL].concat(cfg.GEMINI_FALLBACK_MODELS)
    .filter((m, i, all) => m && m.toLowerCase() !== 'none' && all.indexOf(m) === i);
  let current = 0;
  stats.modelsUsed = [];
  try {
    const cands = scoreCandidates_(cfg);
    const taste = cands.rows.length ? tasteProfile_(cfg, ss) : null;
    const version = promptVersion_(cfg);
    const props = PropertiesService.getScriptProperties();
    const lastVersion = props.getProperty('LAST_PROMPT_VERSION');
    if (lastVersion && lastVersion !== version) stats.notes.push(`new scoring rules (version ${version}): every video is re-scored once`);
    props.setProperty('LAST_PROMPT_VERSION', version);
    if (taste) stats.notes.push(`taste: ${taste.liked.length} liked, ${taste.disliked.length} disliked examples in the prompt`);
    stats.total = cands.total;
    cands.rows.forEach(v => { stats.titles[v.video_id] = v.title; });
    const stopStarting = started.getTime() + SCORE_START_BATCHES_MS;
    const deadline = started.getTime() + SCORE_RETRY_UNTIL_MS;
    for (let i = 0; i < cands.rows.length; i += cfg.SCORE_BATCH_SIZE) {
      if (Date.now() > stopStarting) { stats.notes.push('paused to stay inside the Apps Script time limit'); break; }
      const batch = cands.rows.slice(i, i + cfg.SCORE_BATCH_SIZE);
      run.rows_in += batch.length;
      try {
        const lastModel = current === models.length - 1;
        const res = scoreBatch_(cfg, run, batch, deadline, models[current], lastModel, taste);
        stats.calls++;
        stats.callMs += res.ms;
        run.quota_units++;
        stats.model = res.model;
        if (stats.modelsUsed.indexOf(res.model) === -1) stats.modelsUsed.push(res.model);
        keep(res.rows);
      } catch (e) {
        const why = { server: 'overloaded', rate_limit: 'rate-limited', daily_quota: 'out of daily quota', not_found: 'not found' }[e.kind];
        if (why) {
          stats.failures.push(e.kind);
          run.rows_in -= batch.length;
          const detail = `${models[current]} ${why} (${String(e.message).slice(0, 120)})`;
          if (current < models.length - 1) {
            stats.notes.push(`${detail}; switched to ${models[current + 1]}`);
            current++;
            i -= cfg.SCORE_BATCH_SIZE; // same batch again with the next model
            continue;
          }
          stats.notes.push(detail);
          // No model left. Only a configuration problem if no model exists at all.
          const real = stats.failures.filter(k => k !== 'not_found');
          if (!real.length) {
            throw new Error(`None of the Gemini models exist (${models.join(', ')}). Fix GEMINI_MODEL / GEMINI_FALLBACK_MODELS in Settings.`);
          }
          stats.stopped = real.every(k => k === 'daily_quota') ? 'quota' : 'busy';
          stats.notes.push(stats.stopped === 'quota'
            ? 'every Gemini model is out of daily quota; the rest is scored on the next run'
            : 'no Gemini model is available right now; stopping for now');
          break;
        }
        if (e.kind === 'output') {
          // Unusable answer for this batch: record it so these videos aren't retried forever.
          stats.calls++;
          run.quota_units++;
          keep(batch.map(v => scoreRow_(cfg, run, v.video_id, null, 'no usable score: ' + e.message, cfg.GEMINI_MODEL)));
          stats.notes.push(`one batch got no usable answer (${e.message})`);
          continue;
        }
        run.rows_in -= batch.length;
        throw e; // bad key or bad request: nothing later will work either
      }
    }
  } catch (e) {
    failure = e;
  }
  // Save the rest, even if the run failed part-way, then check that every save landed.
  try {
    save();
  } catch (e) {
    failure = failure || e;
  }
  if (pendingSaves.length) {
    let failedRows = 0, stillRunning = 0;
    pendingSaves.forEach(ref => {
      const res = bqWaitJob_(cfg, ref, started.getTime() + SCORE_SAVES_SETTLE_MS);
      if (!res.done) stillRunning += ref.rows;
      else if (res.error) { failedRows += ref.rows; stats.notes.push(`a save failed (${res.error}); those videos are re-scored next run`); }
    });
    run.rows_out -= failedRows;
    if (stillRunning) stats.notes.push(`${stillRunning} scores are still being saved by BigQuery`);
  }
  run.status = failure ? 'error' : 'ok';
  stats.avgSec = stats.calls ? Math.round(stats.callMs / stats.calls / 1000) : 0;
  if (stats.calls) stats.notes.push(`avg ${stats.avgSec}s per Gemini call`);
  run.message = (failure ? failure.message + (stats.notes.length ? '; ' : '') : '') + stats.notes.join('; ');
  run.message = run.message.slice(0, 1000);
  run.finished_at = new Date().toISOString();
  logRun_(cfg, run);
  if (failure) {
    deleteTriggersFor_('continueScore'); // the run ended on its own: no safety net needed
    failure.notes = stats.notes.filter(x => !/^avg /.test(x));
    throw failure;
  }

  stats.left = Math.max(0, stats.total - stats.rows.length);
  scheduleScoreContinuation_(stats);
  if (stats.rows.length) {
    if (Date.now() - started.getTime() > SCORE_FEED_INLINE_MS) {
      // Not enough time left in this run: rebuild the feed as its own job in a minute.
      deleteTriggersFor_('continueBuildFeed');
      ScriptApp.newTrigger('continueBuildFeed').timeBased().after(60 * 1000).create();
      stats.feedLater = true;
    } else {
      try {
        stats.feedSize = buildFeed_(cfg, started.getTime() + 5.5 * 60 * 1000).rows_out; // step 3 right after new scores
      } catch (e) {
        stats.notes.push('feed rebuild failed: ' + e.message);
      }
    }
  }
  return Object.assign(stats, { run, storage: cfg.STORAGE, minScore: cfg.MIN_SCORE });
}

/**
 * Videos left over? Continue in a minute if this run made progress. If Gemini was overloaded
 * and nothing got scored, try again in 10 minutes, at most SCORE_IDLE_RETRY_MAX times in a
 * row (after that the daily run picks them up). A used-up daily quota never continues.
 */
const SCORE_IDLE_RETRY_MAX = 3;
function scheduleScoreContinuation_(stats) {
  const props = PropertiesService.getScriptProperties();
  const progress = stats.rows.length > 0;
  let minutes = 0;
  if (progress || !stats.left) props.deleteProperty('SCORE_IDLE_RETRIES');
  if (stats.left && stats.stopped !== 'quota') {
    if (progress) {
      minutes = 1;
    } else if (stats.stopped === 'busy') {
      const tries = Number(props.getProperty('SCORE_IDLE_RETRIES')) || 0;
      if (tries < SCORE_IDLE_RETRY_MAX) {
        props.setProperty('SCORE_IDLE_RETRIES', String(tries + 1));
        stats.retryAttempt = tries + 1;
        minutes = 10;
      }
    }
  }
  stats.continuing = minutes > 0;
  stats.continueInMin = minutes;
  deleteTriggersFor_('continueScore');
  if (minutes) ScriptApp.newTrigger('continueScore').timeBased().after(minutes * 60 * 1000).create();
}

/** Candidates: newest first, at most SCORE_CANDIDATE_LIMIT, plus how many exist in total. */
function scoreCandidates_(cfg) {
  if (cfg.STORAGE === 'bigquery') {
    const t = name => `\`${cfg.BQ_PROJECT_ID}.${cfg.BQ_DATASET}.${name}\``;
    const rows = bqQuery_(cfg, scoreCandidatesSql_(t('raw_videos'), t('scored_videos')), {
      topic: cfg.TOPIC, prompt_version: promptVersion_(cfg), max_duration: SHORTS_MAX_SEC, max_rows: SCORE_CANDIDATE_LIMIT,
      min_published: minPublished_(cfg), language: cfg.LANGUAGE_FILTER,
    });
    return { rows, total: rows.length ? rows[0].total_candidates : 0 };
  }
  const ss = getSpreadsheet_();
  const done = {};
  sheetsReadTable_(ss, 'scored_videos')
    .filter(s => s.topic === cfg.TOPIC && s.prompt_version === promptVersion_(cfg))
    .forEach(s => { done[s.video_id] = true; });
  const latest = {};
  sheetsReadTable_(ss, 'raw_videos').filter(r => r.topic === cfg.TOPIC).forEach(r => {
    const cur = latest[r.video_id];
    if (!cur || r.collected_at > cur.collected_at) latest[r.video_id] = r;
  });
  const all = Object.keys(latest).map(k => latest[k])
    .filter(r => r.embeddable === true && r.duration_sec >= 1 && r.duration_sec <= SHORTS_MAX_SEC && !done[r.video_id] && passesDataRules_(cfg, r))
    .sort((a, b) => (a.collected_at < b.collected_at ? 1 : a.collected_at > b.collected_at ? -1 : 0));
  return { rows: all.slice(0, SCORE_CANDIDATE_LIMIT), total: all.length };
}

/** Latest raw row per video → feed-eligible → not yet scored with this prompt version. */
function scoreCandidatesSql_(rawTable, scoredTable) {
  return `-- focusfeed: score candidates
SELECT video_id, title, description, channel_title, duration_sec, collected_at,
  COUNT(*) OVER () AS total_candidates
FROM (
  SELECT video_id, title, description, channel_title, duration_sec, embeddable, collected_at, published_at, language,
    ROW_NUMBER() OVER (PARTITION BY video_id ORDER BY collected_at DESC) AS rn
  FROM ${rawTable}
  WHERE topic = @topic
)
WHERE rn = 1
  AND embeddable
  AND duration_sec BETWEEN 1 AND @max_duration
  AND (published_at IS NULL OR published_at >= TIMESTAMP(@min_published))
  AND (@language = '' OR language IS NULL OR STARTS_WITH(LOWER(language), @language))
  AND video_id NOT IN (
    SELECT video_id FROM ${scoredTable}
    WHERE topic = @topic AND prompt_version = @prompt_version
  )
ORDER BY collected_at DESC, video_id
LIMIT @max_rows`;
}

/** One Gemini call for up to SCORE_BATCH_SIZE videos. Short numeric IDs keep the model from mangling YouTube IDs. */
function scoreBatch_(cfg, run, batch, deadline, model, lastModel, taste) {
  const cut = (s, n) => String(s || '').slice(0, n);
  const items = batch.map((v, i) => ({
    id: String(i + 1),
    title: cut(v.title, 200),
    channel: cut(v.channel_title, 80),
    description: cut(v.description, 300),
    seconds: v.duration_sec,
  }));
  const res = geminiJson_({
    model,
    // With another model to fall back to, don't sit out rate limits: hand over at once.
    maxAttempts: lastModel ? 4 : 2,
    quickSwitch: !lastModel,
    system: scoringPrompt_(cfg.TOPIC, taste, scoringRules_(cfg)),
    user: JSON.stringify(items),
    schema: SCORE_SCHEMA,
    deadline,
    noThinking: true,
  });
  if (!Array.isArray(res.data)) throw geminiError_('output', 'expected a JSON list');
  const byId = {};
  res.data.forEach(x => { if (x && x.id !== undefined && !byId[String(x.id)]) byId[String(x.id)] = x; });
  const usedModel = res.modelVersion || model;
  const rows = batch.map((v, i) => {
    const x = byId[String(i + 1)];
    const s = x ? Math.round(Number(x.score)) : NaN;
    return Number.isFinite(s) && s >= 0 && s <= 10
      ? scoreRow_(cfg, run, v.video_id, s, cut(x.reason, 200), usedModel)
      : scoreRow_(cfg, run, v.video_id, null, 'model skipped this video', usedModel);
  });
  return { rows, model: usedModel, ms: res.ms || 0 };
}

function scoreRow_(cfg, run, videoId, score, reason, model) {
  return {
    run_id: run.run_id,
    scored_at: new Date().toISOString(),
    topic: cfg.TOPIC,
    video_id: videoId,
    score,
    reason,
    model,
    prompt_version: promptVersion_(cfg),
  };
}

function scoreSummary_(r) {
  const n = x => Number(x).toLocaleString('en-US');
  if (!r.total) return ['Nothing new to score. Run collect first, or wait for the next daily run.'];
  if (!r.rows.length) {
    const lines = [`Nothing scored yet: ${n(r.total)} videos are waiting.`];
    if (r.continuing) lines.push(`FocusFeed will try again by itself in ${r.continueInMin} minutes (attempt ${r.retryAttempt} of ${SCORE_IDLE_RETRY_MAX}). You can close this.`);
    else lines.push('Try FocusFeed → Run score now later; the daily score run will also pick them up.');
    if (r.notes.length) lines.push('', '⚠ ' + r.notes.join('\n⚠ '));
    return lines.concat([`Run ID: ${r.run.run_id}`]);
  }
  const scored = r.rows.filter(x => x.score !== null);
  const band = (lo, hi) => scored.filter(x => x.score >= lo && x.score <= hi).length;
  const where = r.storage === 'bigquery' ? 'BigQuery scored_videos' : 'the scored_videos tab';
  const lines = [
    `✓ Scored ${n(scored.length)} videos in ${r.calls} Gemini calls (${r.modelsUsed.length ? r.modelsUsed.join(', ') : 'Gemini'})`,
    `✓ ${n(scored.filter(x => x.score >= r.minScore).length)} scored ${r.minScore} or more (MIN_SCORE): these can reach the feed`,
    `Spread: 0–3: ${n(band(0, 3))} · 4–6: ${n(band(4, 6))} · 7–8: ${n(band(7, 8))} · 9–10: ${n(band(9, 10))}`,
    `✓ ${n(r.run.rows_out)} rows written to ${where}`,
  ];
  if (r.feedSize !== undefined) lines.push(`✓ Feed rebuilt: ${n(r.feedSize)} videos ready to watch`);
  if (r.feedLater) lines.push('✓ Feed rebuild starts in about a minute');
  const sorted = scored.slice().sort((a, b) => b.score - a.score);
  const show = x => `"${String(r.titles[x.video_id] || x.video_id).slice(0, 70)}" — ${x.score}: ${x.reason}`;
  if (sorted.length) lines.push('', 'Top: ' + show(sorted[0]));
  if (sorted.length > 1) lines.push('Lowest: ' + show(sorted[sorted.length - 1]));
  const skipped = r.rows.length - scored.length;
  if (skipped) lines.push(`(${skipped} videos got no usable score and won't be retried)`);
  if (r.left) lines.push('', r.continuing ? `${n(r.left)} left: continuing automatically in about ${r.continueInMin === 1 ? 'a minute' : r.continueInMin + ' minutes'}.` : `${n(r.left)} left for the next run.`);
  const warnings = r.notes.filter(x => !/^(avg |taste: )/.test(x));
  const tasteNote = r.notes.find(x => /^taste: /.test(x));
  if (tasteNote) lines.push('✓ Your likes shaped these scores (' + tasteNote.replace('taste: ', '') + ')');
  if (warnings.length) lines.push('⚠ ' + warnings.join('\n⚠ '));
  lines.push(`Speed: ${r.avgSec}s per Gemini call · Run ID: ${r.run.run_id}`);
  return lines;
}
