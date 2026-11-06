/**
 * Learn.gs — pipeline step 5: what the viewer does shapes what they see next.
 *
 *  1. Channel boost   likes and longer watches lift a channel in the feed; dislikes and
 *                     quick skips lower it (applied on every page load, no AI calls).
 *  2. Taste in scoring  new videos are scored with a few liked / disliked titles in the
 *                     Gemini prompt, so the score itself learns the viewer's taste.
 *  3. Nightly load    with BigQuery storage, new rows of the events tab are batch-loaded
 *                     into the events table every night (sandbox-safe), and marked loaded.
 */
const TASTE_EXAMPLES = 8;            // liked / disliked titles shown to Gemini
const CHANNEL_BOOST_MAX = 2;         // a channel can move a video at most ±2 score points
const EVENTS_LOAD_HOUR = 2;          // nightly load, script time zone

/**
 * Everything the viewer told us, from the events tab:
 *  seen      watched or skipped in the last FEED_SEEN_DAYS days
 *  liked / disliked   latest like/unlike and dislike/undislike per video (newest first)
 *  watches / skips    counts per video
 */
function viewerSignals_(ss) {
  const since = Date.now() - FEED_SEEN_DAYS * DAY_MS;
  const seen = {}, like = {}, dislike = {}, watches = {}, skips = {}, lastAt = {};
  sheetsReadTable_(ss, 'events')
    .sort((a, b) => Date.parse(a.event_at) - Date.parse(b.event_at))
    .forEach(e => {
      const t = e.event_type, id = e.video_id, at = Date.parse(e.event_at);
      if ((t === 'watch' || t === 'skip') && at >= since) seen[id] = true;
      if (t === 'watch') watches[id] = (watches[id] || 0) + 1;
      if (t === 'skip') skips[id] = (skips[id] || 0) + 1;
      if (t === 'like' || t === 'unlike') { like[id] = t === 'like'; lastAt[id] = at; }
      if (t === 'dislike' || t === 'undislike') { dislike[id] = t === 'dislike'; lastAt[id] = at; }
    });
  const on = m => Object.keys(m).filter(k => m[k] === true).sort((a, b) => lastAt[b] - lastAt[a]);
  return { seen: Object.keys(seen), liked: on(like), disliked: on(dislike), watches, skips };
}

/**
 * Per-channel boost from the viewer's behaviour on that channel's videos:
 * like +1, dislike −1.5, each watch +0.3 and each quick skip −0.2 (both capped at 3 per
 * video), clamped to ±CHANNEL_BOOST_MAX so relevance (the Gemini score) still leads.
 */
function channelAffinity_(feedRows, signals) {
  const channelOf = {};
  feedRows.forEach(v => { channelOf[v.video_id] = v.channel_title; });
  const raw = {};
  const add = (id, x) => { const c = channelOf[id]; if (c) raw[c] = (raw[c] || 0) + x; };
  signals.liked.forEach(id => add(id, 1));
  signals.disliked.forEach(id => add(id, -1.5));
  Object.keys(signals.watches).forEach(id => add(id, 0.3 * Math.min(signals.watches[id], 3)));
  Object.keys(signals.skips).forEach(id => add(id, -0.2 * Math.min(signals.skips[id], 3)));
  const out = {};
  Object.keys(raw).forEach(c => { out[c] = Math.max(-CHANNEL_BOOST_MAX, Math.min(CHANNEL_BOOST_MAX, Math.round(raw[c] * 10) / 10)); });
  return out;
}

/** The newest liked and disliked videos (title + channel) for the scoring prompt. */
function tasteProfile_(cfg, ss) {
  const signals = viewerSignals_(ss);
  if (!signals.liked.length && !signals.disliked.length) return null;
  const byId = {};
  feedRows_(cfg, ss).forEach(v => { byId[v.video_id] = v; });
  const pick = ids => ids.filter(id => byId[id]).slice(0, TASTE_EXAMPLES)
    .map(id => ({ title: String(byId[id].title).slice(0, 120), channel: String(byId[id].channel_title || '').slice(0, 60) }));
  const taste = { liked: pick(signals.liked), disliked: pick(signals.disliked) };
  return taste.liked.length || taste.disliked.length ? taste : null;
}

/* ---------- 3. nightly events load (BigQuery storage) ---------- */

function runLoadEvents() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return tell_('FocusFeed', 'Another FocusFeed job is running. Try again in a few minutes.');
  let run;
  try {
    run = loadEvents_();
  } catch (e) {
    if (!ui_()) throw e;
    return tell_('Events load failed', ['✗ ' + e.message]);
  } finally {
    lock.releaseLock();
  }
  tell_('Events loaded', [run.message || `✓ ${run.rows_out} new events loaded into BigQuery events`, `Run ID: ${run.run_id}`]);
}

/**
 * Loads events-tab rows that have no loaded_at yet with one batch load job, then stamps
 * them. The tab stays the source for the live feed; BigQuery keeps the full history.
 * If stamping ever failed after a load, a rerun could load rows twice: event_id is unique
 * per event, so deduplicate on it when querying.
 */
function loadEvents_() {
  const ss = getSpreadsheet_();
  const cfg = readSettings_(ss);
  const started = new Date();
  const run = {
    run_id: newRunId_(started), step: 'load_events', started_at: started.toISOString(), finished_at: null,
    status: 'ok', rows_in: 0, rows_out: 0, quota_units: 0, message: '',
  };
  if (cfg.STORAGE !== 'bigquery') {
    run.message = 'Nothing to do: with sheets storage the events tab is the events table.';
    return run;
  }
  try {
    const sh = ss.getSheetByName('events');
    const last = sh ? sh.getLastRow() : 0;
    if (last < 2) {
      run.message = 'No events yet.';
    } else {
      const values = sh.getRange(1, 1, last, sh.getLastColumn()).getValues();
      const header = values.shift().map(h => String(h).trim());
      const col = name => header.indexOf(name);
      const loadedCol = col('loaded_at');
      if (loadedCol === -1) throw new Error('The events tab has no loaded_at column. Run FocusFeed → Setup.');
      const types = {};
      TABLES.events.fields.forEach(f => { types[f[0]] = f[1]; });
      const stamp = new Date();
      const pending = [];
      values.forEach((row, i) => {
        if (row[loadedCol] !== '' && row[loadedCol] !== null) return;
        const o = {};
        TABLES.events.fields.forEach(f => {
          const v = col(f[0]) === -1 ? '' : row[col(f[0])];
          if (v === '' || v === null) o[f[0]] = null;
          else if (types[f[0]] === 'TIMESTAMP') o[f[0]] = new Date(v).toISOString();
          else if (types[f[0]] === 'INT64') o[f[0]] = Math.round(Number(v));
          else o[f[0]] = String(v);
        });
        o.loaded_at = stamp.toISOString();
        if (o.event_id && o.event_at && o.video_id && o.event_type) pending.push({ i, o });
      });
      run.rows_in = pending.length;
      if (pending.length) {
        run.rows_out = bqLoadRows_(cfg, 'events', pending.map(p => p.o), run.run_id);
        const marks = values.map(r => [r[loadedCol]]);
        pending.forEach(p => { marks[p.i] = [stamp]; });
        sh.getRange(2, loadedCol + 1, marks.length, 1).setValues(marks);
      } else {
        run.message = 'No new events since the last load.';
      }
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
