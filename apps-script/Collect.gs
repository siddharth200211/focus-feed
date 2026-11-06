/**
 * Collect.gs — pipeline step 1.
 *
 * Runs SEARCHES_PER_DAY YouTube searches for the topic (short, embeddable videos), looks up
 * each video's duration, embeddability and stats, and appends one row per unique video to
 * raw_videos. Every run is logged in pipeline_runs. Runs daily (trigger installed by Setup)
 * or from FocusFeed → Run collect now.
 *
 * Quota: search.list = 100 units, videos.list = 1 unit per 50 videos. The run stops early
 * rather than go over the daily budget.
 */

// Topic-agnostic phrasings combined with TOPIC. Each is searched in three orders, and the
// day's searches rotate through the combinations, so results vary from day to day.
const SEARCH_MODIFIERS = [
  '', 'tips', 'tricks', 'explained', 'in 60 seconds', 'in 1 minute', 'mistakes to avoid',
  'common mistakes', 'practice', 'practice questions', 'how to', 'for beginners', 'advanced',
  'hacks', 'examples', 'quick lesson', 'must know', 'shortcuts', 'study tips', 'strategy',
  'secrets', 'cheat sheet', 'vocabulary', 'myths', 'quiz', 'tutorial', 'did you know', 'lesson',
];
const SEARCH_ORDERS = ['relevance', 'viewCount', 'date'];
const SEARCH_UNITS = 100;

/** Menu item and daily trigger. */
function runCollect() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return tell_('FocusFeed', 'Another FocusFeed job is running. Try again in a few minutes.');
  let result;
  try {
    result = collect_();
  } catch (e) {
    if (!ui_()) throw e; // trigger run: let Apps Script email the failure
    return tell_('Collect failed', ['✗ ' + e.message, '', 'The run is logged in pipeline_runs.']);
  } finally {
    lock.releaseLock();
  }
  tell_('Collect finished', collectSummary_(result));
}

function collect_() {
  const ss = getSpreadsheet_();
  const cfg = readSettings_(ss);
  const problems = validateSettings_(cfg);
  if (problems.length) throw new Error('Fix the Settings tab first: ' + problems.join(' '));

  const started = new Date();
  const run = {
    run_id: newRunId_(started), step: 'collect', started_at: started.toISOString(), finished_at: null,
    status: 'ok', rows_in: 0, rows_out: 0, quota_units: 0, message: '',
  };
  const stats = { searches: 0, unique: 0, embeddableShorts: 0, notes: [] };
  try {
    const hits = searchAll_(cfg, started, run, stats);
    const details = videoDetails_(hits.map(h => h.videoId), run);
    const rows = hits.map(h => rawRow_(cfg, run, h, details[h.videoId]));
    stats.unique = rows.length;
    stats.embeddableShorts = rows.filter(r => r.embeddable && r.duration_sec > 0 && r.duration_sec <= 180).length;
    run.rows_out = storeAppend_(cfg, 'raw_videos', rows, run.run_id);
    run.message = stats.notes.join('; ');
  } catch (e) {
    run.status = 'error';
    run.message = String(e.message).slice(0, 1000);
    throw e;
  } finally {
    run.finished_at = new Date().toISOString();
    logRun_(cfg, run);
  }
  return Object.assign(stats, { run, storage: cfg.STORAGE, unitsToday: ytUnitsUsedToday_() });
}

/** The day's searches: SEARCHES_PER_DAY (term, order) pairs, rotating through all combinations. */
function searchPlan_(cfg, now) {
  const seen = {};
  const terms = [cfg.TOPIC]
    .concat(cfg.SEARCH_TERMS)
    .concat(SEARCH_MODIFIERS.filter(Boolean).map(m => `${cfg.TOPIC} ${m}`))
    .filter(t => { const k = t.toLowerCase(); return seen[k] ? false : (seen[k] = true); });
  const combos = [];
  terms.forEach(term => SEARCH_ORDERS.forEach(order => combos.push({ term, order })));
  const n = Math.min(cfg.SEARCHES_PER_DAY, combos.length);
  const start = (Math.floor(now.getTime() / DAY_MS) * n) % combos.length;
  return Array.from({ length: n }, (_, i) => combos[(start + i) % combos.length]);
}

/** Runs the searches; returns unique hits in first-seen order. */
function searchAll_(cfg, started, run, stats) {
  const seen = {};
  const hits = [];
  let failures = 0;
  for (const s of searchPlan_(cfg, started)) {
    if (Date.now() - started.getTime() > STEP_TIME_BUDGET_MS) { stats.notes.push('stopped early: time limit'); break; }
    if (!ytCanSpend_(SEARCH_UNITS + 1)) { stats.notes.push('stopped early: daily YouTube quota budget reached'); break; }
    let res;
    try {
      ytSpend_(SEARCH_UNITS);
      run.quota_units += SEARCH_UNITS;
      res = YouTube.Search.list('snippet', {
        q: `${s.term} #shorts`,
        type: 'video',
        videoDuration: 'short',       // under 4 minutes; the feed later keeps ≤ 3 min
        videoEmbeddable: 'true',
        order: s.order,
        relevanceLanguage: cfg.SEARCH_LANGUAGE,
        safeSearch: 'moderate',
        maxResults: 50,
      });
    } catch (e) {
      if (/quota/i.test(e.message)) { stats.notes.push('stopped: YouTube says the daily quota is used up'); break; }
      failures++;
      stats.notes.push(`search "${s.term}" failed: ${e.message}`);
      if (failures >= 3) throw new Error('YouTube search failed 3 times: ' + e.message);
      continue;
    }
    stats.searches++;
    run.rows_in++;
    (res.items || []).forEach(item => {
      const videoId = item.id && item.id.videoId;
      if (!videoId || seen[videoId]) return;
      seen[videoId] = true;
      hits.push({ videoId, term: s.term, snippet: item.snippet || {} });
    });
  }
  return hits;
}

/** videos.list in chunks of 50 (1 unit each): duration, embeddable, view and like counts. */
function videoDetails_(ids, run) {
  const out = {};
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    ytSpend_(1);
    run.quota_units += 1;
    const res = YouTube.Videos.list('contentDetails,status,statistics', { id: chunk.join(','), maxResults: 50 });
    (res.items || []).forEach(v => {
      out[v.id] = {
        duration_sec: parseIsoDuration_(v.contentDetails && v.contentDetails.duration),
        embeddable: !!(v.status && v.status.embeddable),
        view_count: v.statistics && v.statistics.viewCount !== undefined ? Number(v.statistics.viewCount) : null,
        like_count: v.statistics && v.statistics.likeCount !== undefined ? Number(v.statistics.likeCount) : null,
      };
    });
  }
  return out;
}

function rawRow_(cfg, run, hit, d) {
  const sn = hit.snippet;
  const thumbs = sn.thumbnails || {};
  const thumb = thumbs.high || thumbs.medium || thumbs.default || {};
  d = d || {}; // video vanished between search and lookup
  return {
    run_id: run.run_id,
    collected_at: run.started_at,
    topic: cfg.TOPIC,
    search_term: hit.term,
    video_id: hit.videoId,
    title: decodeEntities_(sn.title || ''),
    description: decodeEntities_(sn.description || ''),
    channel_id: sn.channelId || null,
    channel_title: decodeEntities_(sn.channelTitle || ''),
    published_at: sn.publishedAt || null,
    duration_sec: d.duration_sec === undefined ? null : d.duration_sec,
    embeddable: d.embeddable === undefined ? null : d.embeddable,
    view_count: d.view_count === undefined ? null : d.view_count,
    like_count: d.like_count === undefined ? null : d.like_count,
    thumbnail_url: thumb.url || null,
  };
}

/** "PT1M5S" → 65. Returns null if it can't be parsed. */
function parseIsoDuration_(s) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(s || ''));
  if (!m) return null;
  return (Number(m[1]) || 0) * 86400 + (Number(m[2]) || 0) * 3600 + (Number(m[3]) || 0) * 60 + (Number(m[4]) || 0);
}

/** Search snippets come HTML-escaped ("Don&#39;t"). */
function decodeEntities_(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function collectSummary_(r) {
  const n = x => Number(x).toLocaleString('en-US');
  const where = r.storage === 'bigquery' ? 'BigQuery raw_videos' : 'the raw_videos tab';
  const lines = [
    `✓ ${r.searches} searches → ${n(r.unique)} unique videos (${n(r.embeddableShorts)} embeddable, ≤ 3 min)`,
    `✓ ${n(r.run.rows_out)} rows written to ${where}`,
    `YouTube units: ${n(r.run.quota_units)} this run, ${n(r.unitsToday)} of ${n(YT_DAILY_QUOTA)} today (resets at midnight Pacific)`,
    `Run ID: ${r.run.run_id}`,
  ];
  if (r.notes.length) lines.push('', '⚠ ' + r.notes.join('\n⚠ '));
  return lines;
}
