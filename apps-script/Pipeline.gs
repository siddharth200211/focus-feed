/**
 * Pipeline.gs — plumbing shared by every pipeline step: run IDs, writing rows to whichever
 * storage is configured, the pipeline_runs log, and the YouTube quota budget.
 */
const YT_DAILY_QUOTA = 10000;   // free YouTube Data API units per day (resets at midnight Pacific)
const YT_RESERVE = 300;         // never plan to spend the last few hundred units
const STEP_TIME_BUDGET_MS = 4.5 * 60 * 1000; // Apps Script stops a run at 6 minutes

/** e.g. 20261106T174512_k3f9 — sortable, unique, and safe inside a BigQuery job ID. */
function newRunId_(now) {
  const stamp = Utilities.formatDate(now || new Date(), 'UTC', "yyyyMMdd'T'HHmmss");
  return `${stamp}_${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Appends rows (objects keyed by column name) to a table in the configured storage.
 * BigQuery: one batch load job (sandbox-safe). Sheets: append to the tab, then prune.
 * Returns the number of rows written.
 */
function storeAppend_(cfg, tableName, rows, runId, opts) {
  if (!rows.length) return 0;
  if (cfg.STORAGE === 'bigquery' && opts && opts.wait === false) {
    // Fire-and-forget: submit the load and carry on; the caller can check opts.jobs later.
    const ref = bqStartLoad_(cfg, tableName, rows, runId);
    if (opts.jobs) opts.jobs.push(ref);
    return rows.length;
  }
  if (cfg.STORAGE === 'bigquery') return bqLoadRows_(cfg, tableName, rows, runId);
  return sheetsAppendRows_(getSpreadsheet_(), tableName, rows, cfg.LITE_MAX_ROWS);
}

/** Writes one pipeline_runs row. Never throws: a logging failure must not hide the real result. */
function logRun_(cfg, run) {
  try {
    storeAppend_(cfg, 'pipeline_runs', [run], `${run.run_id}_${run.step}`, { wait: false }); // don't spend run time waiting
  } catch (e) {
    console.error(`Could not log run ${run.run_id}: ${e.message}`);
  }
  PropertiesService.getScriptProperties().setProperty(`LAST_RUN_${run.step.toUpperCase()}`, JSON.stringify({
    at: run.finished_at, status: run.status, rows: run.rows_out, units: run.quota_units, message: run.message,
  }));
}

function lastRun_(step) {
  try {
    return JSON.parse(PropertiesService.getScriptProperties().getProperty(`LAST_RUN_${step.toUpperCase()}`));
  } catch (e) {
    return null;
  }
}

/* ---------- YouTube quota budget (tracked per Pacific-time day, like Google does) ---------- */

function ytQuotaKey_() {
  return 'YT_UNITS_' + Utilities.formatDate(new Date(), 'America/Los_Angeles', 'yyyyMMdd');
}

function ytUnitsUsedToday_() {
  return Number(PropertiesService.getScriptProperties().getProperty(ytQuotaKey_())) || 0;
}

function ytCanSpend_(units) {
  return ytUnitsUsedToday_() + units <= YT_DAILY_QUOTA - YT_RESERVE;
}

function ytSpend_(units) {
  const props = PropertiesService.getScriptProperties();
  const key = ytQuotaKey_();
  props.setProperty(key, String((Number(props.getProperty(key)) || 0) + units));
  Object.keys(props.getProperties())
    .filter(k => k.indexOf('YT_UNITS_') === 0 && k !== key)
    .forEach(k => props.deleteProperty(k)); // old days
}

/**
 * True when Phase 2 (GitHub Actions) runs the pipeline (PIPELINE = github), so this script must
 * not collect, score or rebuild the feed as well. Tells the user when they clicked the menu.
 */
function runsInGithub_(step) {
  const cfg = safeSettings_();
  if (cfg.PIPELINE !== 'github') return false;
  tell_('FocusFeed', [`${step} runs in GitHub Actions now (PIPELINE = github in Settings), so nothing ran here.`,
    'Run it from GitHub → Actions → Pipeline → Run workflow, or set PIPELINE back to apps_script and run Setup.']);
  return true;
}
