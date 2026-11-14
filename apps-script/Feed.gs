/**
 * Feed.gs — pipeline step 3 (build the feed) and step 4 (serve it to the web app).
 *
 * Build: the latest score for each video (this topic and prompt version) joined to its latest
 * raw row; keeps videos scoring ≥ MIN_SCORE that are embeddable and ≤ 3 minutes. BigQuery:
 * a query job that overwrites `feed` (not DML, so sandbox-safe). Sheets: rewrites the tab.
 * Runs after every score run, or from FocusFeed → Build feed now.
 *
 * Serve: doGet() returns the swipe page (Index.html). The page calls getFeedPage() for 50
 * videos at a time and logEvents() for what was watched, skipped, liked or disliked.
 * A disliked video never comes back; liked videos come first when replaying the feed.
 */
const FEED_SEEN_DAYS = 14;
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const EVENT_TYPES = ['watch', 'skip', 'error', 'like', 'unlike', 'dislike', 'undislike'];

/* ---------- step 3: build ---------- */

function runBuildFeed() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return tell_('FocusFeed', 'Another FocusFeed job is running. Try again in a few minutes.');
  let run;
  try {
    run = buildFeed_();
  } catch (e) {
    if (!ui_()) throw e;
    return tell_('Feed build failed', ['✗ ' + e.message]);
  } finally {
    lock.releaseLock();
  }
  tell_('Feed built', [`✓ ${run.rows_out} videos in the feed`, `Run ID: ${run.run_id}`]);
}

/** One-off trigger set by a score run that was short on time. */
function continueBuildFeed() {
  deleteTriggersFor_('continueBuildFeed');
  runBuildFeed();
}

function buildFeed_(cfg, deadlineMs) {
  const ss = getSpreadsheet_();
  cfg = cfg || readSettings_(ss);
  const started = new Date();
  const run = {
    run_id: newRunId_(started), step: 'build_feed', started_at: started.toISOString(), finished_at: null,
    status: 'ok', rows_in: 0, rows_out: 0, quota_units: 0, message: '',
  };
  try {
    if (cfg.STORAGE === 'bigquery') {
      const t = name => `\`${cfg.BQ_PROJECT_ID}.${cfg.BQ_DATASET}.${name}\``;
      run.rows_out = bqQueryToTable_(cfg, buildFeedSql_(t('raw_videos'), t('scored_videos')), {
        topic: cfg.TOPIC, prompt_version: promptVersion_(cfg), min_score: cfg.MIN_SCORE, max_duration: SHORTS_MAX_SEC,
        min_published: minPublished_(cfg), language: cfg.LANGUAGE_FILTER,
      }, 'feed', deadlineMs);
    } else {
      const rows = buildFeedRows_(cfg, sheetsReadTable_(ss, 'raw_videos'), sheetsReadTable_(ss, 'scored_videos'), started);
      run.rows_out = sheetsReplaceRows_(ss, 'feed', rows);
    }
  } catch (e) {
    run.status = 'error';
    run.message = String(e.message).slice(0, 1000);
    throw e;
  } finally {
    run.finished_at = new Date().toISOString();
    logRun_(cfg, run);
  }
  return run;
}

function buildFeedSql_(rawTable, scoredTable) {
  return `-- focusfeed: build feed
WITH latest_score AS (
  SELECT video_id, score, reason
  FROM (
    SELECT video_id, score, reason,
      ROW_NUMBER() OVER (PARTITION BY video_id ORDER BY scored_at DESC) AS rn
    FROM ${scoredTable}
    WHERE topic = @topic AND prompt_version = @prompt_version AND score IS NOT NULL
  )
  WHERE rn = 1
),
latest_raw AS (
  SELECT video_id, title, channel_title, duration_sec, published_at, embeddable, language, first_seen_at
  FROM (
    SELECT video_id, title, channel_title, duration_sec, published_at, embeddable, language,
      MIN(collected_at) OVER (PARTITION BY video_id) AS first_seen_at,
      ROW_NUMBER() OVER (PARTITION BY video_id ORDER BY collected_at DESC) AS rn
    FROM ${rawTable}
    WHERE topic = @topic
  )
  WHERE rn = 1
)
SELECT r.video_id, @topic AS topic, r.title, r.channel_title, r.duration_sec, r.published_at,
  s.score, s.reason, r.first_seen_at, CURRENT_TIMESTAMP() AS built_at
FROM latest_raw AS r
JOIN latest_score AS s USING (video_id)
WHERE s.score >= @min_score
  AND r.embeddable
  AND r.duration_sec BETWEEN 1 AND @max_duration
  AND (r.published_at IS NULL OR r.published_at >= TIMESTAMP(@min_published))
  AND (@language = '' OR r.language IS NULL OR STARTS_WITH(LOWER(r.language), @language))`;
}

/** The same logic in JavaScript, for sheets storage. */
function buildFeedRows_(cfg, raw, scored, now) {
  const latestScore = {};
  scored.filter(s => s.topic === cfg.TOPIC && s.prompt_version === promptVersion_(cfg) && s.score !== null && s.score !== '')
    .forEach(s => {
      const cur = latestScore[s.video_id];
      if (!cur || s.scored_at > cur.scored_at) latestScore[s.video_id] = s;
    });
  const latestRaw = {};
  const firstSeen = {};
  raw.filter(r => r.topic === cfg.TOPIC).forEach(r => {
    const cur = latestRaw[r.video_id];
    if (!cur || r.collected_at > cur.collected_at) latestRaw[r.video_id] = r;
    if (!firstSeen[r.video_id] || r.collected_at < firstSeen[r.video_id]) firstSeen[r.video_id] = r.collected_at;
  });
  return Object.keys(latestScore)
    .map(id => ({ s: latestScore[id], r: latestRaw[id] }))
    .filter(x => x.r && Number(x.s.score) >= cfg.MIN_SCORE && x.r.embeddable === true &&
      x.r.duration_sec >= 1 && x.r.duration_sec <= SHORTS_MAX_SEC && passesDataRules_(cfg, x.r))
    .map(x => ({
      video_id: x.r.video_id, topic: cfg.TOPIC, title: x.r.title, channel_title: x.r.channel_title,
      duration_sec: x.r.duration_sec, published_at: x.r.published_at, score: Number(x.s.score), reason: x.s.reason,
      first_seen_at: firstSeen[x.r.video_id], built_at: now.toISOString(),
    }));
}

/* ---------- step 4: serve ---------- */

// The app icon (browser tab and Android "Add to Home screen"). It lives in the public repo;
// set APP_ICON_URL in Settings to use your own PNG (square, 512×512 works best).
const APP_ICON_DEFAULT = 'https://raw.githubusercontent.com/siddharth200211/focus-feed/main/assets/icon-512.png';
// The only meta tags Apps Script allows (others are rejected).
const ALLOWED_META_TAGS = ['apple-mobile-web-app-capable', 'google-site-verification', 'mobile-web-app-capable', 'viewport'];

function doGet() {
  let icon = APP_ICON_DEFAULT;
  try { icon = readSettings_(getSpreadsheet_()).APP_ICON_URL || APP_ICON_DEFAULT; } catch (e) { /* settings unreadable: keep default */ }
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('FocusFeed')
    .setFaviconUrl(icon)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .addMetaTag('mobile-web-app-capable', 'yes')        // home-screen launch without the browser bar
    .addMetaTag('apple-mobile-web-app-capable', 'yes');
}

/**
 * Called by the page: the next videos, best first (ties shuffled per session), skipping what
 * this session already loaded, anything disliked, and (unless includeSeen) what was watched or
 * skipped in the last 14 days. With includeSeen, liked videos come first.
 * req = { exclude: [videoId…], seed: string, includeSeen: boolean }
 */
function getFeedPage(req) {
  req = req || {};
  const ss = getSpreadsheet_();
  const cfg = readSettings_(ss);
  const limit = Math.max(10, Math.min(200, cfg.FEED_PAGE_SIZE || 50));
  const seed = String(req.seed || 'seed').replace(/[^A-Za-z0-9]/g, '').slice(0, 24) || 'seed';
  const signals = viewerSignals_(ss);
  const all = feedRows_(cfg, ss);
  const affinity = channelAffinity_(all, signals); // step 5: channels you like rank higher
  const skip = {}, liked = {};
  cleanIds_(req.exclude).slice(0, 5000).concat(signals.disliked, req.includeSeen ? [] : signals.seen)
    .forEach(id => { skip[id] = true; });
  signals.liked.forEach(id => { liked[id] = true; });
  const rank = v => Number(v.score) + (affinity[v.channel_title] || 0);
  const page = all
    .filter(v => !skip[v.video_id])
    .sort((a, b) => (req.includeSeen ? (liked[b.video_id] ? 1 : 0) - (liked[a.video_id] ? 1 : 0) : 0) ||
      (rank(b) - rank(a)) || (hashStr_(a.video_id + seed) - hashStr_(b.video_id + seed)))
    .slice(0, limit);
  return {
    topic: cfg.TOPIC,
    more: page.length === limit,
    videos: page.map(v => ({
      id: v.video_id, title: v.title || '', channel: v.channel_title || '',
      seconds: Number(v.duration_sec) || 0, score: Number(v.score), reason: v.reason || '',
      liked: !!liked[v.video_id], boosted: (affinity[v.channel_title] || 0) > 0,
    })),
  };
}

/** Every feed video for the topic. The feed is small (hundreds to a few thousand rows), so ranking happens here. */
function feedRows_(cfg, ss) {
  if (cfg.STORAGE === 'bigquery') {
    return bqQuery_(cfg, `-- focusfeed: feed rows
SELECT video_id, title, channel_title, duration_sec, score, reason
FROM \`${cfg.BQ_PROJECT_ID}.${cfg.BQ_DATASET}.feed\`
WHERE topic = @topic
LIMIT 5000`, { topic: cfg.TOPIC });
  }
  return sheetsReadTable_(ss || getSpreadsheet_(), 'feed').filter(v => v.topic === cfg.TOPIC);
}

/** Called by the page with a batch of { video_id, event_type, watch_ms, position, session_id, at }. */
function logEvents(events) {
  if (!Array.isArray(events) || !events.length) return 0;
  const ss = getSpreadsheet_();
  const cfg = readSettings_(ss);
  const now = Date.now();
  const rows = events.slice(0, 100).map(e => {
    if (!e || !VIDEO_ID_PATTERN.test(String(e.video_id)) || EVENT_TYPES.indexOf(e.event_type) === -1) return null;
    const at = Date.parse(e.at);
    return {
      event_id: Utilities.getUuid(),
      event_at: new Date(Math.abs(at - now) < DAY_MS ? at : now),
      session_id: /^[A-Za-z0-9]{6,40}$/.test(String(e.session_id)) ? String(e.session_id) : null,
      video_id: String(e.video_id),
      event_type: e.event_type,
      watch_ms: clampInt_(e.watch_ms, 0, 60 * 60 * 1000),
      position: clampInt_(e.position, 0, 100000),
      topic: cfg.TOPIC,
      loaded_at: null,
    };
  }).filter(Boolean);
  if (rows.length) sheetsAppendRowsAtomic_(ss, 'events', rows, cfg.LITE_MAX_ROWS);
  return rows.length;
}

function cleanIds_(ids) {
  return Array.isArray(ids) ? ids.map(String).filter(id => VIDEO_ID_PATTERN.test(id)) : [];
}

function clampInt_(v, lo, hi) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : null;
}

function hashStr_(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Menu: shows the web app link (after the first deployment). */
function openFeed() {
  let url = null;
  try { url = ScriptApp.getService().getUrl(); } catch (e) { /* not deployed */ }
  if (!url) {
    return tell_('Deploy the web app first', [
      'In the Apps Script editor: Deploy → New deployment → type Web app.',
      'Execute as: Me · Who has access: Anyone → Deploy.',
      'Then run FocusFeed → Open feed again.',
    ]);
  }
  const safe = url.replace(/[<>"']/g, '');
  SpreadsheetApp.getUi().showModalDialog(HtmlService.createHtmlOutput(
    `<div style="font:14px system-ui,sans-serif"><p><a href="${safe}" target="_blank" style="font-weight:600">Open FocusFeed ↗</a></p>` +
    `<p style="color:#5f6368;word-break:break-all">${safe}</p><p style="color:#5f6368">Open this link on your phone too: no login needed.</p></div>`)
    .setWidth(380).setHeight(170), 'FocusFeed');
}
