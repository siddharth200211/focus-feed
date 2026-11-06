/**
 * Config.gs — the Settings tab.
 *
 * Every setting lives in the "Settings" tab (Key | Value | Notes) so the feed can be
 * changed without touching code. Secrets never go there: the Gemini API key lives in
 * Script Properties (FocusFeed → Set Gemini API key…).
 */
const SETTINGS_TAB = 'Settings';

const SETTINGS = [
  { key: 'TOPIC', def: '', type: 'string', required: true,
    note: 'The one topic your feed is about, e.g. TOEFL. Setup asks for it on the first run.' },
  { key: 'SEARCH_TERMS', def: '', type: 'list',
    note: 'Optional. Extra search phrases, comma-separated (e.g. "TOEFL speaking, TOEFL vocabulary"). Blank = searches are built from TOPIC.' },
  { key: 'SEARCH_LANGUAGE', def: 'en', type: 'string', pattern: /^[a-z]{2}(-[A-Za-z]{2,4})?$/,
    note: 'Language code for YouTube search results (e.g. en, hi).' },
  { key: 'SEARCHES_PER_DAY', def: 50, type: 'int', min: 1, max: 90,
    note: 'Each search costs 100 of the 10,000 free YouTube API units a day. 90 is the ceiling, leaving room for video-detail lookups.' },
  { key: 'COLLECT_HOUR', def: 14, type: 'int', min: 0, max: 23,
    note: 'Hour of the day (script time zone) for the daily collect run. YouTube quota resets at midnight Pacific time (about 13:30 in India), so 14 starts each run with a full day of quota. Run Setup after changing.' },
  { key: 'MIN_SCORE', def: 7, type: 'int', min: 0, max: 10,
    note: 'Gemini scores every video 0-10 for how well it fits TOPIC. Only videos at or above this reach the feed.' },
  { key: 'MAX_VIDEO_AGE_DAYS', def: 0, type: 'int', min: 0, max: 3650,
    note: 'Only videos published in the last N days (730 = 2 years). 0 = any age. Also narrows the YouTube searches.' },
  { key: 'LANGUAGE_FILTER', def: '', type: 'string', pattern: /^([a-z]{2})?$/,
    note: 'Two-letter code, e.g. en: only videos in that language (YouTube\'s audio language where known; Gemini checks the rest). Blank = any language.' },
  { key: 'EXCLUDE_ADS', def: 'yes', type: 'enum', options: ['yes', 'no'],
    note: 'yes = videos that mainly advertise a course, coaching, app, book or discount score 2 or less, so they never reach the feed.' },
  { key: 'SCORING_GUIDANCE', def: '', type: 'string', maxLength: 2000,
    note: 'Your own rules for Gemini in plain words, e.g. "Only the new TOEFL format from January 2026…". Changing this, LANGUAGE_FILTER or EXCLUDE_ADS re-scores every video once.' },
  { key: 'SCORE_BATCH_SIZE', def: 25, type: 'int', min: 1, max: 50,
    note: 'Videos sent to Gemini in one call.' },
  { key: 'GEMINI_MODEL', def: 'gemini-flash-latest', type: 'string',
    note: 'Gemini model used for scoring. The default alias follows the newest Flash model; put a specific model name here to pin one.' },
  { key: 'GEMINI_FALLBACK_MODELS', def: 'gemini-flash-lite-latest', type: 'list',
    note: 'Tried in order when GEMINI_MODEL is overloaded, rate-limited, out of daily quota or not found (free-tier limits are per model). Comma-separated; "none" turns fallback off. Check setup shows which names work.' },
  { key: 'FEED_PAGE_SIZE', def: 50, type: 'int', min: 10, max: 200,
    note: 'How many videos the web app loads at a time.' },
  { key: 'STORAGE', def: 'sheets', type: 'enum', options: ['sheets', 'bigquery'],
    note: 'sheets = Lite: everything stays in this spreadsheet, nothing else to set up. bigquery = pipeline tables in BigQuery (the free sandbox is enough). Run Setup again after changing this.' },
  { key: 'LITE_MAX_ROWS', def: 100000, type: 'int', min: 1000, max: 500000,
    note: 'sheets storage only: oldest rows in each data tab are deleted beyond this, so the file stays under the 10M-cell limit.' },
  { key: 'BQ_PROJECT_ID', def: '', type: 'string',
    note: 'bigquery storage only: your Google Cloud project ID (the ID, not the display name). It must belong to the Google account that runs this script.' },
  { key: 'BQ_DATASET', def: 'focus_feed', type: 'string', pattern: /^[A-Za-z0-9_]{1,1024}$/,
    note: 'bigquery storage only: dataset name. Setup creates it if it does not exist.' },
  { key: 'BQ_LOCATION', def: 'US', type: 'string',
    note: 'bigquery storage only: where the dataset is created (e.g. US, EU, asia-south1). Cannot be changed once the dataset exists.' },
  { key: 'BQ_SANDBOX_EXPIRY', def: '', type: 'string', readOnly: true,
    note: 'Filled in by Setup, do not edit. BigQuery sandbox tables are deleted 60 days after creation: enable billing and remove the expirations before this date. You get a reminder email 15 days before.' },
];

const BQ_PROJECT_PATTERN = /^([a-z0-9.-]+:)?[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

/** The bound spreadsheet; falls back to the ID saved by Setup (web app and trigger runs). */
function getSpreadsheet_() {
  let active = null;
  try { active = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) { /* no container in this context */ }
  if (active) return active;
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!id) throw new Error('Open the FocusFeed sheet and run FocusFeed → Setup first.');
  return SpreadsheetApp.openById(id);
}

/**
 * Creates the Settings tab, or adds any keys missing from an older one.
 * Never overwrites a value that is already there.
 */
function ensureSettingsTab_(ss) {
  let sh = ss.getSheetByName(SETTINGS_TAB);
  const created = !sh;
  if (created) sh = ss.insertSheet(SETTINGS_TAB, 0);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, 3).setValues([['Key', 'Value', 'Notes']]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.setColumnWidth(1, 170);
    sh.setColumnWidth(2, 240);
    sh.setColumnWidth(3, 620);
  }
  const lastRow = sh.getLastRow();
  const existing = lastRow > 1
    ? sh.getRange(2, 1, lastRow - 1, 1).getValues().map(r => String(r[0]).trim())
    : [];
  const missing = SETTINGS.filter(s => existing.indexOf(s.key) === -1);
  if (missing.length) {
    const start = Math.max(lastRow, 1) + 1;
    sh.getRange(start, 1, missing.length, 3)
      .setValues(missing.map(s => [s.key, s.def, s.note]));
    missing.forEach((s, i) => styleSettingRow_(sh, start + i, s));
  }
  return { created, added: created ? [] : missing.map(s => s.key) };
}

function styleSettingRow_(sh, row, s) {
  const value = sh.getRange(row, 2);
  if (s.type === 'enum') {
    value.setDataValidation(SpreadsheetApp.newDataValidation()
      .requireValueInList(s.options, true).setAllowInvalid(false).build());
  } else if (s.type === 'int') {
    value.setDataValidation(SpreadsheetApp.newDataValidation()
      .requireNumberBetween(s.min, s.max).setAllowInvalid(false)
      .setHelpText(`Whole number from ${s.min} to ${s.max}`).build());
  } else {
    value.setNumberFormat('@'); // keep codes like "en" or project IDs as plain text
  }
  if (s.readOnly) value.setBackground('#f1f3f4');
  sh.getRange(row, 3).setWrap(true).setFontColor('#5f6368');
}

/** Reads the Settings tab into a typed object; blanks fall back to defaults. */
function readSettings_(ss) {
  const sh = (ss || getSpreadsheet_()).getSheetByName(SETTINGS_TAB);
  if (!sh) throw new Error('No Settings tab yet. Run FocusFeed → Setup first.');
  const raw = {};
  const lastRow = sh.getLastRow();
  if (lastRow > 1) {
    sh.getRange(2, 1, lastRow - 1, 2).getValues().forEach(r => {
      const k = String(r[0]).trim();
      if (k) raw[k] = r[1];
    });
  }
  const cfg = {};
  SETTINGS.forEach(s => {
    const v = raw[s.key];
    const blank = v === undefined || v === null || String(v).trim() === '';
    cfg[s.key] = coerceSetting_(s, blank ? s.def : v);
  });
  return cfg;
}

function coerceSetting_(s, v) {
  switch (s.type) {
    case 'int': return typeof v === 'number' ? v : Number(String(v).trim());
    case 'enum': return String(v).trim().toLowerCase();
    case 'list': return String(v).split(/[,\n]/).map(x => x.trim()).filter(Boolean);
    default: return String(v).trim();
  }
}

/** Returns a list of human-readable problems; empty means the settings are usable. */
function validateSettings_(cfg) {
  const errors = [];
  SETTINGS.forEach(s => {
    const v = cfg[s.key];
    if (s.required && !v) errors.push(`${s.key} is empty.`);
    if (s.type === 'int' && (!Number.isInteger(v) || v < s.min || v > s.max)) {
      errors.push(`${s.key} must be a whole number from ${s.min} to ${s.max}.`);
    }
    if (s.type === 'enum' && s.options.indexOf(v) === -1) {
      errors.push(`${s.key} must be one of: ${s.options.join(', ')}.`);
    }
    if (s.pattern && v && !s.pattern.test(v)) errors.push(`${s.key} "${v}" doesn't look right.`);
    if (s.maxLength && v && String(v).length > s.maxLength) errors.push(`${s.key} is longer than ${s.maxLength} characters.`);
  });
  if (cfg.STORAGE === 'bigquery') {
    if (!cfg.BQ_PROJECT_ID) {
      errors.push('BQ_PROJECT_ID is empty (needed because STORAGE is bigquery).');
    } else if (!BQ_PROJECT_PATTERN.test(cfg.BQ_PROJECT_ID)) {
      errors.push(`BQ_PROJECT_ID "${cfg.BQ_PROJECT_ID}" is not a valid project ID (lowercase letters, digits and hyphens).`);
    }
    if (!cfg.BQ_LOCATION) errors.push('BQ_LOCATION is empty.');
  }
  return errors;
}

/** Writes one value into the Settings tab (used by Setup for TOPIC and BQ_SANDBOX_EXPIRY). */
function writeSetting_(ss, key, value) {
  const sh = ss.getSheetByName(SETTINGS_TAB);
  const lastRow = sh.getLastRow();
  const keys = lastRow > 1 ? sh.getRange(2, 1, lastRow - 1, 1).getValues() : [];
  for (let i = 0; i < keys.length; i++) {
    if (String(keys[i][0]).trim() === key) {
      sh.getRange(i + 2, 2).setValue(value);
      return;
    }
  }
  throw new Error(`Setting ${key} not found in the Settings tab.`);
}
