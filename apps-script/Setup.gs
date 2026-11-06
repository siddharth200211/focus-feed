/**
 * Setup.gs — the FocusFeed menu.
 *
 *   FocusFeed → Setup                  Settings tab + data tabs, and BigQuery dataset/tables
 *                                      when STORAGE = bigquery. Safe to run again any time.
 *   FocusFeed → Set Gemini API key…    stores the key in Script Properties (never in the sheet)
 *   FocusFeed → Check setup            read-only health check: account, settings, APIs, tables
 */
const REMIND_DAYS_BEFORE_EXPIRY = 15; // sandbox tables live 60 days → reminder on day 45
const DAY_MS = 24 * 60 * 60 * 1000;
const GEMINI_KEY_PROP = 'GEMINI_API_KEY';

function onOpen() {
  SpreadsheetApp.getUi().createMenu('FocusFeed')
    .addItem('Setup', 'setup')
    .addItem('Set Gemini API key…', 'setGeminiApiKey')
    .addSeparator()
    .addItem('Check setup', 'checkSetup')
    .addToUi();
  try { warnIfSandboxExpiring_(); } catch (e) { /* never block the menu */ }
}

function setup() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return tell_('FocusFeed', 'Setup is already running.');
  try {
    setupInner_();
  } finally {
    lock.releaseLock();
  }
}

function setupInner_() {
  const ss = getSpreadsheet_();
  const props = PropertiesService.getScriptProperties();
  props.setProperty('SPREADSHEET_ID', ss.getId());
  const out = [];

  const settings = ensureSettingsTab_(ss);
  if (settings.created) out.push('✓ Settings tab created');
  if (settings.added.length) out.push('✓ New settings added: ' + settings.added.join(', '));

  let cfg = readSettings_(ss);
  if (!cfg.TOPIC) {
    const topic = askTopic_();
    if (!topic) {
      return tell_('Setup paused', 'FocusFeed needs a topic. Type one into TOPIC in the Settings tab (or run Setup again), then run Setup.');
    }
    writeSetting_(ss, 'TOPIC', topic);
    cfg = readSettings_(ss);
  }
  const errors = validateSettings_(cfg);
  if (errors.length) {
    ss.getSheetByName(SETTINGS_TAB).activate();
    return tell_('Fix the Settings tab, then run Setup again', errors.map(e => '• ' + e));
  }
  out.unshift(`Topic: ${cfg.TOPIC} · Storage: ${cfg.STORAGE} · Running as: ${currentUserEmail_()}`, '');

  const createdTabs = [], migratedTabs = [];
  dataTabsFor_(cfg.STORAGE).forEach(name => {
    const r = sheetsEnsureTab_(ss, name);
    if (r.created) createdTabs.push(name);
    if (r.added.length) migratedTabs.push(`${name} (+${r.added.join(', ')})`);
  });
  if (createdTabs.length) out.push('✓ Tabs created: ' + createdTabs.join(', '));
  if (migratedTabs.length) out.push('✓ Columns added: ' + migratedTabs.join('; '));
  sheetsRemoveEmptyDefaultTab_(ss);

  if (cfg.STORAGE === 'bigquery') {
    let bq;
    try {
      bq = bqSetup_(cfg);
    } catch (e) {
      return tell_('BigQuery setup failed', out.concat(['', '✗ ' + e.message, '',
        'Settings and tabs are fine; fix the BigQuery problem and run Setup again.']));
    }
    const where = `${cfg.BQ_PROJECT_ID}.${cfg.BQ_DATASET}`;
    out.push(bq.datasetCreated
      ? `✓ BigQuery dataset ${where} created (${bq.datasetLocation})`
      : `✓ BigQuery dataset ${where} found (${bq.datasetLocation})`);
    if (bq.datasetLocation && bq.datasetLocation.toLowerCase() !== cfg.BQ_LOCATION.toLowerCase()) {
      out.push(`⚠ The dataset is in ${bq.datasetLocation}, not ${cfg.BQ_LOCATION}. A dataset can't move; set BQ_LOCATION to ${bq.datasetLocation} or use a new BQ_DATASET.`);
    }
    const created = bq.tables.filter(t => t.created).map(t => t.name);
    const migrated = bq.tables.filter(t => t.added.length).map(t => `${t.name} (+${t.added.join(', ')})`);
    out.push(created.length ? '✓ Tables created: ' + created.join(', ') : '✓ All tables already exist');
    if (migrated.length) out.push('✓ Columns added: ' + migrated.join('; '));
    out.push(applyExpiryStatus_(ss, bq.expiry));
  }

  if (!props.getProperty(GEMINI_KEY_PROP)) out.push('', 'Next: FocusFeed → Set Gemini API key…');
  tell_('FocusFeed setup done', out);
}

function askTopic_() {
  const ui = ui_();
  if (!ui) return '';
  const r = ui.prompt('FocusFeed setup', 'What topic should your feed be about? (e.g. TOEFL)', ui.ButtonSet.OK_CANCEL);
  return r.getSelectedButton() === ui.Button.OK ? r.getResponseText().trim() : '';
}

/* ---------- Gemini key ---------- */

function setGeminiApiKey() {
  const ui = ui_();
  if (!ui) throw new Error('Run this from the FocusFeed menu in the spreadsheet.');
  const r = ui.prompt('Gemini API key',
    'Paste a key from aistudio.google.com/apikey (use a Cloud project with no billing, so it can never cost money).\n\n' +
    'It is saved in Script Properties — not in the sheet and not in the code. Leave the box empty and press OK to delete the saved key.',
    ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  const key = r.getResponseText().trim();
  const props = PropertiesService.getScriptProperties();
  if (!key) {
    props.deleteProperty(GEMINI_KEY_PROP);
    return tell_('FocusFeed', 'Saved Gemini key deleted.');
  }
  const model = safeSettings_().GEMINI_MODEL || 'gemini-flash-latest';
  const check = checkGeminiKey_(key, model);
  if (!check.ok) return tell_('Key not saved', `Gemini rejected that key: ${check.message}`);
  props.setProperty(GEMINI_KEY_PROP, key);
  tell_('FocusFeed', check.modelOk ? `Key saved ✓ (model ${model} is available)` : `Key saved ✓\n\n⚠ ${check.message}`);
}

/** Cheap validity check: fetches the model's metadata. Uses a header so the key never sits in a URL. */
function checkGeminiKey_(key, model) {
  const res = UrlFetchApp.fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model),
    { headers: { 'x-goog-api-key': key }, muteHttpExceptions: true });
  const code = res.getResponseCode();
  if (code === 200) return { ok: true, modelOk: true };
  let message = 'HTTP ' + code;
  try { message = JSON.parse(res.getContentText()).error.message || message; } catch (e) { /* keep HTTP code */ }
  if (code === 404) {
    return { ok: true, modelOk: false, message: `The key works, but model "${model}" was not found. Change GEMINI_MODEL in Settings.` };
  }
  return { ok: false, modelOk: false, message };
}

/* ---------- Check setup (read-only) ---------- */

function checkSetup() {
  const ss = getSpreadsheet_();
  const out = [`Running as: ${currentUserEmail_()}`,
    '(The sheet, the BigQuery project and the Gemini key should all belong to this account.)', ''];

  let cfg = null;
  if (!ss.getSheetByName(SETTINGS_TAB)) {
    out.push('✗ No Settings tab — run FocusFeed → Setup');
  } else {
    cfg = readSettings_(ss);
    const errors = validateSettings_(cfg);
    out.push(errors.length ? '✗ Settings: ' + errors.join(' ') : `✓ Settings OK (topic: ${cfg.TOPIC}, storage: ${cfg.STORAGE})`);
    const missingTabs = dataTabsFor_(cfg.STORAGE).filter(n => !ss.getSheetByName(n));
    out.push(missingTabs.length ? '✗ Missing tabs: ' + missingTabs.join(', ') + ' — run Setup' : '✓ Data tabs present');
  }

  if (cfg && cfg.STORAGE === 'bigquery' && cfg.BQ_PROJECT_ID) {
    try {
      const bq = bqInspect_(cfg);
      if (!bq.dataset) {
        out.push(`✗ BigQuery dataset ${cfg.BQ_PROJECT_ID}.${cfg.BQ_DATASET} not found — run Setup`);
      } else {
        out.push(bq.missing.length
          ? '✗ BigQuery tables missing: ' + bq.missing.join(', ') + ' — run Setup'
          : `✓ BigQuery: ${bq.tables.length} tables in ${cfg.BQ_PROJECT_ID}.${cfg.BQ_DATASET} (${bq.dataset.location})`);
        out.push(expiryLine_(bq.expiry));
      }
    } catch (e) {
      out.push('✗ BigQuery: ' + e.message);
    }
  }

  try {
    YouTube.I18nLanguages.list('snippet', { hl: 'en' }); // 1 quota unit
    out.push('✓ YouTube Data API reachable');
  } catch (e) {
    out.push('✗ YouTube Data API: ' + e.message);
  }

  const key = PropertiesService.getScriptProperties().getProperty(GEMINI_KEY_PROP);
  if (!key) {
    out.push('✗ Gemini key not set — FocusFeed → Set Gemini API key…');
  } else {
    const model = (cfg && cfg.GEMINI_MODEL) || 'gemini-flash-latest';
    const check = checkGeminiKey_(key, model);
    out.push(!check.ok ? '✗ Gemini key rejected: ' + check.message
      : check.modelOk ? `✓ Gemini key works (model ${model})` : '⚠ ' + check.message);
  }
  tell_('FocusFeed check', out);
}

/* ---------- BigQuery sandbox expiry reminder ---------- */

/** Schedules (or clears) the day-45 reminder from the tables' real expiration times. */
function applyExpiryStatus_(ss, expiry) {
  const props = PropertiesService.getScriptProperties();
  deleteTriggersFor_('sendExpiryReminder');
  if (!expiry.earliest) {
    props.deleteProperty('BQ_EARLIEST_EXPIRY');
    writeSetting_(ss, 'BQ_SANDBOX_EXPIRY', expiry.clear ? 'none' : 'tables kept, but old partitions still expire');
    return expiryLine_(expiry);
  }
  const remindAt = new Date(expiry.earliest.getTime() - REMIND_DAYS_BEFORE_EXPIRY * DAY_MS);
  props.setProperty('BQ_EARLIEST_EXPIRY', String(expiry.earliest.getTime()));
  const due = remindAt <= new Date();
  if (!due) ScriptApp.newTrigger('sendExpiryReminder').timeBased().at(remindAt).create();
  writeSetting_(ss, 'BQ_SANDBOX_EXPIRY',
    `${fmtDate_(expiry.earliest)} (reminder email ${due ? 'overdue' : fmtDate_(remindAt)})`);
  return expiryLine_(expiry) + (due ? '' : ` — reminder email on ${fmtDate_(remindAt)}`);
}

function expiryLine_(expiry) {
  if (expiry.clear) return '✓ No sandbox expirations: data is kept';
  if (expiry.earliest) {
    const days = Math.ceil((expiry.earliest.getTime() - Date.now()) / DAY_MS);
    return `⚠ Sandbox: tables are deleted on ${fmtDate_(expiry.earliest)} (${days} days). Enable billing and remove expirations before then.`;
  }
  const parts = [];
  if (expiry.partitionLimited.length) parts.push('partition expiration on ' + expiry.partitionLimited.join(', '));
  if (expiry.datasetDefault) parts.push('the dataset default expiration');
  return '⚠ Tables no longer expire, but still remove ' + parts.join(' and ') + '.';
}

/** Time-driven, fires once ~15 days before the earliest table expiry. */
function sendExpiryReminder() {
  deleteTriggersFor_('sendExpiryReminder');
  const expiryMs = Number(PropertiesService.getScriptProperties().getProperty('BQ_EARLIEST_EXPIRY'));
  if (!expiryMs) return;
  const cfg = safeSettings_();
  const where = `${cfg.BQ_PROJECT_ID || 'your project'}.${cfg.BQ_DATASET || 'focus_feed'}`;
  const when = fmtDate_(new Date(expiryMs));
  MailApp.sendEmail(currentUserEmail_(), `FocusFeed: BigQuery sandbox tables are deleted on ${when}`, [
    `Your FocusFeed tables in ${where} are in the BigQuery sandbox and will be deleted on ${when}.`,
    '',
    'To keep them:',
    `1. Enable billing on project ${cfg.BQ_PROJECT_ID || ''} (console.cloud.google.com/billing). Staying inside the BigQuery free tier still costs nothing.`,
    '2. Remove the sandbox expirations: the dataset default table expiration, and each table\'s expiration and partition expiration.',
    '   Guide: https://cloud.google.com/bigquery/docs/sandbox',
    '3. Open the FocusFeed sheet and run FocusFeed → Setup. It re-reads the tables and stops reminding you once nothing expires.',
  ].join('\n'));
}

function warnIfSandboxExpiring_() {
  const expiryMs = Number(PropertiesService.getScriptProperties().getProperty('BQ_EARLIEST_EXPIRY'));
  if (!expiryMs || Date.now() < expiryMs - REMIND_DAYS_BEFORE_EXPIRY * DAY_MS) return;
  SpreadsheetApp.getActiveSpreadsheet().toast(
    `BigQuery sandbox tables are deleted on ${fmtDate_(new Date(expiryMs))}. Enable billing, remove the expirations, then run Setup.`,
    'FocusFeed', 20);
}

/* ---------- small helpers ---------- */

function ui_() {
  try { return SpreadsheetApp.getUi(); } catch (e) { return null; } // null when run from the editor or a trigger
}

function tell_(title, lines) {
  const msg = [].concat(lines).join('\n');
  const ui = ui_();
  if (ui) ui.alert(title, msg, ui.ButtonSet.OK);
  else Logger.log(`${title}\n${msg}`);
}

function safeSettings_() {
  try { return readSettings_(getSpreadsheet_()); } catch (e) { return {}; }
}

function currentUserEmail_() {
  try { return Session.getEffectiveUser().getEmail() || 'unknown account'; } catch (e) { return 'unknown account'; }
}

function deleteTriggersFor_(handler) {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === handler)
    .forEach(t => ScriptApp.deleteTrigger(t));
}

function fmtDate_(d) {
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}
