/**
 * Runs the real Apps Script files against in-memory fakes of SpreadsheetApp, BigQuery and
 * friends, so Setup can be tested without a Google account.
 *   npm test        (or: node --test tests/)
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DIR = path.join(__dirname, '..', 'apps-script');
const FILES = fs.readdirSync(DIR).filter(f => f.endsWith('.gs')).sort();
const DAY = 24 * 60 * 60 * 1000;

/* ---------- fakes ---------- */

class Range {
  constructor(sh, r, c, nr, nc) { Object.assign(this, { sh, r, c, nr, nc }); }
  setValues(v) {
    assert.equal(v.length, this.nr, 'setValues row count');
    v.forEach((row, i) => { assert.equal(row.length, this.nc, 'setValues col count'); row.forEach((x, j) => this.sh.set(this.r + i, this.c + j, x)); });
    return this;
  }
  setValue(x) { this.sh.set(this.r, this.c, x); return this; }
  getValues() { return Array.from({ length: this.nr }, (_, i) => Array.from({ length: this.nc }, (_, j) => this.sh.get(this.r + i, this.c + j))); }
  setDataValidation(v) { this.sh.validation[`${this.r},${this.c}`] = v; return this; }
  setFontWeight() { return this; } setNumberFormat() { return this; } setBackground() { return this; }
  setWrap() { return this; } setFontColor() { return this; }
}

class Sheet {
  constructor(book, name) { this.book = book; this.name = name; this.cells = {}; this.maxCols = 26; this.maxRows = 1000; this.validation = {}; }
  set(r, c, v) { if (c > this.maxCols) throw new Error(`column ${c} beyond ${this.maxCols}`); if (r > this.maxRows) throw new Error(`row ${r} beyond ${this.maxRows}`); this.cells[`${r},${c}`] = v; }
  get(r, c) { const v = this.cells[`${r},${c}`]; return v === undefined ? '' : v; }
  filled() { return Object.keys(this.cells).filter(k => this.cells[k] !== '').map(k => k.split(',').map(Number)); }
  getLastRow() { return Math.max(0, ...this.filled().map(([r]) => r)); }
  getLastColumn() { return Math.max(0, ...this.filled().map(([, c]) => c)); }
  getRange(r, c, nr = 1, nc = 1) { if (c + nc - 1 > this.maxCols) throw new Error('range beyond max columns'); return new Range(this, r, c, nr, nc); }
  getMaxColumns() { return this.maxCols; }
  getMaxRows() { return this.maxRows; }
  insertRowsAfter(after, n) { this.maxRows += n; }
  deleteRows(start, n) {
    const moved = {};
    for (const [k, v] of Object.entries(this.cells)) {
      const [r, c] = k.split(',').map(Number);
      if (r < start) moved[k] = v; else if (r >= start + n) moved[`${r - n},${c}`] = v;
    }
    this.cells = moved;
  }
  deleteColumns(start, n) { assert.ok(start > this.getLastColumn(), 'only empty columns are deleted'); this.maxCols -= n; }
  insertColumnsAfter(after, n) { this.maxCols += n; }
  setFrozenRows() { } setColumnWidth() { } activate() { }
  getName() { return this.name; }
  header() { return this.getRange(1, 1, 1, this.getLastColumn()).getValues()[0]; }
  rows() { const n = this.getLastRow(); return n < 2 ? [] : this.getRange(2, 1, n - 1, this.getLastColumn()).getValues(); }
}

function fakeBook() {
  const book = {
    order: [],
    getId: () => 'book1',
    getSheets() { return this.order.slice(); },
    getSheetByName(n) { return this.order.find(s => s.name === n) || null; },
    insertSheet(n, idx) { const s = new Sheet(this, n); if (idx === undefined) this.order.push(s); else this.order.splice(idx, 0, s); return s; },
    deleteSheet(s) { this.order.splice(this.order.indexOf(s), 1); },
    toast(msg) { this.toasts.push(msg); },
    toasts: [],
  };
  book.insertSheet('Sheet1');
  return book;
}

/** BigQuery with sandbox behaviour: dataset default expiration 60 days, copied onto new tables. */
function fakeBigQuery({ sandbox = true, projects = ['my-project'] } = {}) {
  const store = { datasets: {}, tables: {}, calls: [] };
  const notFound = what => { const e = new Error(`Not found: ${what}`); e.details = { code: 404 }; return e; };
  const checkProject = p => { if (!projects.includes(p)) throw notFound(`Project ${p}`); };
  store.api = {
    Datasets: {
      get(p, d) { store.calls.push('Datasets.get'); checkProject(p); const ds = store.datasets[`${p}.${d}`]; if (!ds) throw notFound(`Dataset ${p}:${d}`); return JSON.parse(JSON.stringify(ds)); },
      insert(res, p) {
        store.calls.push('Datasets.insert'); checkProject(p);
        const ds = Object.assign({}, res, sandbox ? { defaultTableExpirationMs: String(60 * DAY), defaultPartitionExpirationMs: String(60 * DAY) } : {});
        store.datasets[`${p}.${res.datasetReference.datasetId}`] = ds; return ds;
      },
    },
    Tables: {
      get(p, d, t) { store.calls.push('Tables.get'); checkProject(p); const tb = store.tables[`${p}.${d}.${t}`]; if (!tb) throw notFound(`Table ${p}:${d}.${t}`); return JSON.parse(JSON.stringify(tb)); },
      insert(res, p, d) {
        store.calls.push('Tables.insert');
        const ds = store.datasets[`${p}.${d}`]; assert.ok(ds, 'dataset must exist before tables');
        const tb = JSON.parse(JSON.stringify(res));
        if (ds.defaultTableExpirationMs) tb.expirationTime = String(Date.now() + Number(ds.defaultTableExpirationMs));
        if (tb.timePartitioning && ds.defaultPartitionExpirationMs) tb.timePartitioning.expirationMs = ds.defaultPartitionExpirationMs;
        store.tables[`${p}.${d}.${res.tableReference.tableId}`] = tb; return JSON.parse(JSON.stringify(tb));
      },
      patch(res, p, d, t) {
        store.calls.push('Tables.patch');
        const tb = store.tables[`${p}.${d}.${t}`];
        const before = tb.schema.fields.map(f => f.name);
        assert.deepEqual(res.schema.fields.slice(0, before.length).map(f => f.name), before, 'patch keeps existing columns in order');
        res.schema.fields.slice(before.length).forEach(f => assert.equal(f.mode, 'NULLABLE', 'added columns are NULLABLE'));
        Object.assign(tb, res); return JSON.parse(JSON.stringify(tb));
      },
    },
    Jobs: {
      insert(job, p, blob) {
        store.calls.push('Jobs.insert');
        const id = job.jobReference.jobId;
        assert.match(id, /^[A-Za-z0-9_-]{1,1024}$/, 'valid job ID');
        if (store.jobs[id]) throw new Error(`Already Exists: Job ${p}:US.${id}`);
        const load = job.configuration.load;
        assert.equal(load.sourceFormat, 'NEWLINE_DELIMITED_JSON');
        assert.equal(load.writeDisposition, 'WRITE_APPEND');
        assert.ok(!job.configuration.query, 'no query/DML jobs (sandbox-safe)');
        const key = `${p}.${load.destinationTable.datasetId}.${load.destinationTable.tableId}`;
        const table = store.tables[key];
        assert.ok(table, `load target ${key} exists`);
        const rows = blob.getDataAsString().split('\n').map(l => JSON.parse(l));
        rows.forEach(r => validateRow(table, r));
        const result = store.loadError
          ? { state: 'DONE', errorResult: { message: store.loadError }, errors: [{ message: 'row 1: bad value' }] }
          : { state: 'DONE' };
        if (!store.loadError) (store.rows[load.destinationTable.tableId] = store.rows[load.destinationTable.tableId] || []).push(...rows);
        store.jobs[id] = { jobReference: { projectId: p, jobId: id, location: 'US' }, status: result, statistics: { load: { outputRows: String(rows.length) } } };
        return { jobReference: { projectId: p, jobId: id, location: 'US' }, status: { state: 'RUNNING' } };
      },
      get(p, id, opts) {
        store.calls.push('Jobs.get');
        assert.equal(opts.location, 'US', 'job looked up in its location');
        return JSON.parse(JSON.stringify(store.jobs[id]));
      },
    },
  };
  store.jobs = {};
  store.rows = {};
  return store;
}

/** What a BigQuery JSON load would reject. */
function validateRow(table, row) {
  const fields = {};
  table.schema.fields.forEach(f => { fields[f.name] = f; });
  Object.keys(row).forEach(k => assert.ok(fields[k], `unknown column ${k}`));
  Object.values(fields).forEach(f => {
    const v = row[f.name];
    if (v === null || v === undefined) { assert.notEqual(f.mode, 'REQUIRED', `${f.name} is REQUIRED`); return; }
    if (f.type === 'TIMESTAMP') assert.ok(typeof v === 'string' && !isNaN(Date.parse(v)), `${f.name} timestamp: ${v}`);
    if (f.type === 'INT64') assert.ok(Number.isInteger(v), `${f.name} integer: ${v}`);
    if (f.type === 'BOOL') assert.equal(typeof v, 'boolean', `${f.name} bool`);
    if (f.type === 'STRING') assert.equal(typeof v, 'string', `${f.name} string`);
  });
}

/**
 * YouTube with overlapping results: each search returns 50 IDs from a pool of 1,200, so
 * some videos come back from several searches. Every 13th video has vanished by the
 * details lookup; every 5th is longer than 3 minutes; every 11th isn't embeddable.
 */
function fakeYouTube({ quotaOn = 0, failOn = [] } = {}) {
  const yt = { searches: [], detailCalls: [] };
  yt.api = {
    Search: {
      list(part, args) {
        yt.searches.push(args);
        const n = yt.searches.length;
        if (n === quotaOn) throw new Error('The request cannot be completed because you have exceeded your quota.');
        if (failOn.includes(n)) throw new Error('Backend Error');
        return { items: Array.from({ length: 50 }, (_, i) => {
          const id = `v${(n * 37 + i) % 1200}`;
          return { id: { kind: 'youtube#video', videoId: id }, snippet: {
            publishedAt: '2026-10-01T10:00:00Z', channelId: 'UC1', channelTitle: 'Prep &amp; Co',
            title: `Don&#39;t miss this ${id}`, description: 'desc', thumbnails: { high: { url: `https://i.ytimg.com/${id}.jpg` } } } };
        }) };
      },
    },
    Videos: {
      list(part, args) {
        const ids = args.id.split(',');
        assert.ok(ids.length <= 50, 'videos.list takes at most 50 IDs');
        yt.detailCalls.push(ids);
        return { items: ids.filter(id => Number(id.slice(1)) % 13 !== 0).map(id => {
          const k = Number(id.slice(1));
          return { id, contentDetails: { duration: k % 5 === 0 ? 'PT3M30S' : 'PT45S' },
            status: { embeddable: k % 11 !== 0 }, statistics: { viewCount: String(k * 10), likeCount: String(k) } };
        }) };
      },
    },
  };
  return yt;
}

/** Utilities.formatDate stand-in (UTC; the tests don't depend on the time zone). */
function formatUtc(d, f) {
  const x = new Date(d), p = n => String(n).padStart(2, '0');
  const parts = { yyyy: x.getUTCFullYear(), MM: p(x.getUTCMonth() + 1), dd: p(x.getUTCDate()), HH: p(x.getUTCHours()), mm: p(x.getUTCMinutes()), ss: p(x.getUTCSeconds()) };
  return f.split(/('[^']*')/).map(seg => seg.startsWith("'") ? seg.slice(1, -1) : seg.replace(/yyyy|MM|dd|HH|mm|ss/g, t => parts[t])).join('');
}

function load({ bq = fakeBigQuery(), yt = fakeYouTube(), prompts = [], fetch } = {}) {
  const book = fakeBook();
  const props = {}, triggers = [], mails = [], alerts = [], fetches = [], logs = [];
  const ui = {
    Button: { OK: 'OK', CANCEL: 'CANCEL' }, ButtonSet: { OK: 'OK', OK_CANCEL: 'OK_CANCEL' },
    createMenu() { const m = { items: [], addItem: (l, f) => (m.items.push(f), m), addSeparator: () => m, addToUi: () => { ui.menu = m.items; } }; return m; },
    alert: (title, msg) => { alerts.push({ title, msg: msg || '' }); },
    prompt: () => { const next = prompts.shift(); return { getSelectedButton: () => (next === null ? 'CANCEL' : 'OK'), getResponseText: () => next || '' }; },
  };
  const validation = () => { const b = { requireValueInList: () => b, requireNumberBetween: () => b, setAllowInvalid: () => b, setHelpText: () => b, build: () => ({}) }; return b; };
  const g = {
    console,
    SpreadsheetApp: { getActiveSpreadsheet: () => book, openById: () => book, getUi: () => ui, newDataValidation: validation },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => (k in props ? props[k] : null), getProperties: () => Object.assign({}, props), setProperty: (k, v) => { props[k] = String(v); }, deleteProperty: k => { delete props[k]; } }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() { } }) },
    Session: { getEffectiveUser: () => ({ getEmail: () => 'me@example.com' }), getScriptTimeZone: () => 'Asia/Kolkata' },
    Utilities: { formatDate: (d, tz, f) => formatUtc(d, f), newBlob: (text) => ({ text, getDataAsString: () => text }), sleep: () => { } },
    Logger: { log: m => logs.push(m) },
    MailApp: { sendEmail: (to, subject, body) => mails.push({ to, subject, body }) },
    ScriptApp: {
      getProjectTriggers: () => triggers.slice(),
      deleteTrigger: t => triggers.splice(triggers.indexOf(t), 1),
      newTrigger: fn => { const t = { fn, getHandlerFunction: () => fn }; const b = { timeBased: () => b, at: d => (t.at = d, b), everyDays: n => (t.everyDays = n, b), atHour: h => (t.atHour = h, b), create: () => (triggers.push(t), t) }; return b; },
    },
    UrlFetchApp: { fetch: (url, opts) => { fetches.push({ url, opts }); return (fetch || (() => ({ code: 200, body: '{}' })))(url, opts); } },
    YouTube: Object.assign({ I18nLanguages: { list: () => ({ items: [] }) } }, yt.api),
    BigQuery: bq.api,
  };
  g.UrlFetchApp.fetch = ((inner) => (url, opts) => { const r = inner(url, opts); return { getResponseCode: () => r.code, getContentText: () => r.body }; })(g.UrlFetchApp.fetch);
  vm.createContext(g);
  FILES.forEach(f => vm.runInContext(fs.readFileSync(path.join(DIR, f), 'utf8'), g, { filename: f }));
  // Values from the sandbox have the sandbox's Array/Object prototypes; clone them so
  // deepStrictEqual compares structure only.
  const run = expr => { const v = vm.runInContext(expr, g); return v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v; };
  const setting = key => { const sh = book.getSheetByName('Settings'); const row = sh.rows().find(r => r[0] === key); return row ? row[1] : undefined; };
  const setSetting = (key, v) => run(`writeSetting_(getSpreadsheet_(), ${JSON.stringify(key)}, ${JSON.stringify(v)})`);
  const reminders = () => triggers.filter(t => t.fn === 'sendExpiryReminder');
  return { g, run, book, bq, yt, props, triggers, reminders, mails, alerts, fetches, logs, ui, setting, setSetting, lastAlert: () => alerts[alerts.length - 1] };
}

/* ---------- tests ---------- */

test('schema and settings are internally consistent', () => {
  const { run } = load();
  const tables = run('TABLES');
  const types = new Set(['STRING', 'INT64', 'BOOL', 'TIMESTAMP', 'FLOAT64', 'DATE', 'JSON']);
  for (const [name, t] of Object.entries(tables)) {
    const names = t.fields.map(f => f[0]);
    assert.equal(new Set(names).size, names.length, `${name}: duplicate columns`);
    t.fields.forEach(f => { assert.ok(types.has(f[1]), `${name}.${f[0]} type ${f[1]}`); assert.ok(['REQUIRED', 'NULLABLE'].includes(f[2])); });
    if (t.partitionField) {
      const pf = t.fields.find(f => f[0] === t.partitionField);
      assert.ok(pf && pf[1] === 'TIMESTAMP', `${name}: partition field must be a TIMESTAMP column`);
    }
    (t.clusterFields || []).forEach(c => assert.ok(names.includes(c), `${name}: cluster field ${c} missing`));
    assert.ok(t.fields.length <= 26, `${name}: fits a default sheet`);
  }
  const keys = run('SETTINGS').map(s => s.key);
  assert.equal(new Set(keys).size, keys.length, 'duplicate setting keys');
  const defaults = run('(() => { const c = {}; SETTINGS.forEach(s => c[s.key] = coerceSetting_(s, s.def)); c.TOPIC = "TOEFL"; return validateSettings_(c); })()');
  assert.deepEqual(defaults, [], 'defaults (plus a topic) are valid');
});

test('manifest: advanced services, scopes and an anonymous web app', () => {
  const m = JSON.parse(fs.readFileSync(path.join(DIR, 'appsscript.json'), 'utf8'));
  assert.equal(m.runtimeVersion, 'V8');
  const ids = m.dependencies.enabledAdvancedServices.map(s => s.serviceId).sort();
  assert.deepEqual(ids, ['bigquery', 'youtube']);
  assert.deepEqual(m.webapp, { executeAs: 'USER_DEPLOYING', access: 'ANYONE_ANONYMOUS' });
  ['bigquery', 'youtube.readonly', 'script.container.ui', 'script.external_request', 'script.scriptapp', 'script.send_mail', 'spreadsheets']
    .forEach(s => assert.ok(m.oauthScopes.includes('https://www.googleapis.com/auth/' + s), 'scope ' + s));
});

test('onOpen adds the FocusFeed menu', () => {
  const env = load();
  env.run('onOpen()');
  assert.deepEqual(env.ui.menu, ['setup', 'setGeminiApiKey', 'runCollect', 'checkSetup']);
});

test('first Setup (sheets): asks for the topic, builds Settings + data tabs, removes empty Sheet1', () => {
  const env = load({ prompts: ['TOEFL'] });
  env.run('setup()');
  assert.equal(env.setting('TOPIC'), 'TOEFL');
  assert.equal(env.setting('STORAGE'), 'sheets');
  assert.equal(env.book.getSheets()[0].name, 'Settings', 'Settings is the first tab');
  assert.deepEqual(env.book.getSheets().map(s => s.name).sort(), ['Settings', 'events', 'feed', 'pipeline_runs', 'raw_videos', 'scored_videos']);
  const tables = env.run('TABLES');
  for (const name of Object.keys(tables)) {
    assert.deepEqual(env.book.getSheetByName(name).header(), tables[name].fields.map(f => f[0]));
    assert.equal(env.book.getSheetByName(name).getMaxColumns(), tables[name].fields.length, 'unused columns trimmed');
  }
  assert.equal(env.bq.calls.length, 0, 'no BigQuery calls in sheets mode');
  assert.equal(env.props.SPREADSHEET_ID, 'book1');
  assert.match(env.lastAlert().msg, /Topic: TOEFL · Storage: sheets/);
  assert.match(env.lastAlert().msg, /Set Gemini API key/);
});

test('Setup is idempotent and never overwrites values', () => {
  const env = load({ prompts: ['TOEFL'] });
  env.run('setup()');
  env.setSetting('MIN_SCORE', 8);
  env.book.getSheetByName('raw_videos').getRange(2, 1, 1, 2).setValues([['run1', '2026-11-06']]);
  const before = env.book.getSheets().map(s => s.name);
  env.run('setup()');
  assert.deepEqual(env.book.getSheets().map(s => s.name), before);
  assert.equal(env.setting('MIN_SCORE'), 8);
  assert.equal(env.setting('TOPIC'), 'TOEFL');
  assert.equal(env.book.getSheetByName('raw_videos').get(2, 1), 'run1', 'data untouched');
  assert.equal(env.book.getSheetByName('Settings').rows().length, env.run('SETTINGS.length'), 'no duplicate setting rows');
  assert.doesNotMatch(env.lastAlert().msg, /created/);
});

test('Setup adds settings and columns missing from older versions', () => {
  const env = load({ prompts: ['TOEFL'] });
  env.run('setup()');
  const raw = env.book.getSheetByName('raw_videos');
  const lastCol = raw.getLastColumn();
  raw.set(1, lastCol, ''); // pretend thumbnail_url didn't exist yet
  const settings = env.book.getSheetByName('Settings');
  const row = settings.rows().findIndex(r => r[0] === 'FEED_PAGE_SIZE') + 2;
  [1, 2, 3].forEach(c => settings.set(row, c, 'zz_old')); // a stale row stands in for the missing key
  env.run('setup()');
  assert.equal(raw.header().at(-1), 'thumbnail_url');
  assert.equal(env.setting('FEED_PAGE_SIZE'), 50);
  assert.match(env.lastAlert().msg, /New settings added: FEED_PAGE_SIZE/);
  assert.match(env.lastAlert().msg, /Columns added: raw_videos \(\+thumbnail_url\)/);
});

test('cancelling the topic prompt stops Setup without creating data tabs', () => {
  const env = load({ prompts: [null] });
  env.run('setup()');
  assert.ok(env.book.getSheetByName('Settings'));
  assert.equal(env.book.getSheetByName('raw_videos'), null);
  assert.match(env.lastAlert().title, /paused/);
});

test('invalid settings are reported and nothing else is built', () => {
  const env = load({ prompts: ['TOEFL'] });
  env.run('ensureSettingsTab_(getSpreadsheet_())');
  env.setSetting('TOPIC', 'TOEFL');
  env.setSetting('STORAGE', 'bigquery');
  env.setSetting('SEARCHES_PER_DAY', 500);
  env.run('setup()');
  const msg = env.lastAlert().msg;
  assert.match(msg, /BQ_PROJECT_ID is empty/);
  assert.match(msg, /SEARCHES_PER_DAY must be a whole number from 1 to 90/);
  assert.equal(env.bq.calls.length, 0);
  assert.equal(env.book.getSheetByName('events'), null);
});

function bigQueryEnv(opts) {
  const env = load(Object.assign({ prompts: [] }, opts));
  env.run('ensureSettingsTab_(getSpreadsheet_())');
  env.setSetting('TOPIC', 'TOEFL');
  env.setSetting('STORAGE', 'bigquery');
  env.setSetting('BQ_PROJECT_ID', 'my-project');
  return env;
}

test('Setup (bigquery): dataset + partitioned tables, events landing tab, day-45 reminder', () => {
  const env = bigQueryEnv();
  env.run('setup()');
  const tables = env.run('TABLES');
  assert.ok(env.bq.datasets['my-project.focus_feed']);
  assert.equal(env.bq.datasets['my-project.focus_feed'].location, 'US');
  for (const [name, def] of Object.entries(tables)) {
    const t = env.bq.tables[`my-project.focus_feed.${name}`];
    assert.ok(t, `table ${name}`);
    assert.deepEqual(t.schema.fields.map(f => f.name), def.fields.map(f => f[0]));
    if (def.partitionField) assert.equal(t.timePartitioning.field, def.partitionField);
    else assert.equal(t.timePartitioning, undefined);
  }
  assert.deepEqual(env.book.getSheets().map(s => s.name).sort(), ['Settings', 'events'], 'only the events landing tab in the sheet');
  assert.equal(env.reminders().length, 1);
  const daysAhead = (env.reminders()[0].at - Date.now()) / DAY;
  assert.ok(daysAhead > 44.9 && daysAhead < 45.1, `reminder ~45 days out, got ${daysAhead}`);
  assert.match(String(env.setting('BQ_SANDBOX_EXPIRY')), /^\d{4}-\d{2}-\d{2} \(reminder email \d{4}-\d{2}-\d{2}\)$/);
  assert.match(env.lastAlert().msg, /dataset my-project\.focus_feed created/);
  assert.match(env.lastAlert().msg, /reminder email on/);
});

test('Setup (bigquery) re-run: no duplicates, one reminder, additive column migration', () => {
  const env = bigQueryEnv();
  env.run('setup()');
  const feed = env.bq.tables['my-project.focus_feed.feed'];
  // Pretend an older version had no "topic" column (REQUIRED in the schema): it can only
  // be added to an existing table as NULLABLE, at the end.
  feed.schema.fields = feed.schema.fields.filter(f => f.name !== 'topic');
  const inserts = env.bq.calls.filter(c => c.endsWith('.insert')).length;
  env.run('setup()');
  assert.equal(env.bq.calls.filter(c => c.endsWith('.insert')).length, inserts, 'nothing inserted twice');
  assert.equal(env.reminders().length, 1, 'reminder replaced, not duplicated');
  assert.deepEqual(JSON.parse(JSON.stringify(feed.schema.fields.at(-1))), { name: 'topic', type: 'STRING', mode: 'NULLABLE' });
  assert.match(env.lastAlert().msg, /All tables already exist/);
  assert.match(env.lastAlert().msg, /Columns added: feed \(\+topic\)/);
});

test('after billing + removed expirations, Setup clears the reminder', () => {
  const env = bigQueryEnv();
  env.run('setup()');
  const ds = env.bq.datasets['my-project.focus_feed'];
  delete ds.defaultTableExpirationMs; delete ds.defaultPartitionExpirationMs;
  Object.values(env.bq.tables).forEach(t => { delete t.expirationTime; if (t.timePartitioning) delete t.timePartitioning.expirationMs; });
  env.run('setup()');
  assert.equal(env.reminders().length, 0);
  assert.equal(env.props.BQ_EARLIEST_EXPIRY, undefined);
  assert.equal(env.setting('BQ_SANDBOX_EXPIRY'), 'none');
  assert.match(env.lastAlert().msg, /No sandbox expirations/);
});

test('table expiry removed but partition expiry left: warns instead of going quiet', () => {
  const env = bigQueryEnv();
  env.run('setup()');
  Object.values(env.bq.tables).forEach(t => { delete t.expirationTime; });
  env.run('setup()');
  assert.equal(env.reminders().length, 0);
  assert.match(env.lastAlert().msg, /still remove partition expiration on raw_videos/);
});

test('billing-enabled project (no sandbox): no reminder at all', () => {
  const env = bigQueryEnv({ bq: fakeBigQuery({ sandbox: false }) });
  env.run('setup()');
  assert.equal(env.reminders().length, 0);
  assert.equal(env.setting('BQ_SANDBOX_EXPIRY'), 'none');
});

test('wrong project or account: a readable error, Settings/tabs kept', () => {
  const env = bigQueryEnv({ bq: fakeBigQuery({ projects: ['someone-else'] }) });
  env.run('setup()');
  assert.equal(env.lastAlert().title, 'BigQuery setup failed');
  assert.match(env.lastAlert().msg, /"my-project" was not found, or me@example\.com has no access/);
  assert.ok(env.book.getSheetByName('events'));
});

test('existing dataset in another location is flagged', () => {
  const env = bigQueryEnv();
  env.bq.api.Datasets.insert({ datasetReference: { projectId: 'my-project', datasetId: 'focus_feed' }, location: 'asia-south1' }, 'my-project');
  env.run('setup()');
  assert.match(env.lastAlert().msg, /dataset is in asia-south1, not US/);
});

test('sendExpiryReminder emails once and removes its trigger', () => {
  const env = bigQueryEnv();
  env.run('setup()');
  env.run('sendExpiryReminder()');
  assert.equal(env.mails.length, 1);
  assert.equal(env.mails[0].to, 'me@example.com');
  assert.match(env.mails[0].subject, /BigQuery sandbox tables are deleted on \d{4}-\d{2}-\d{2}/);
  assert.match(env.mails[0].body, /my-project\.focus_feed/);
  assert.equal(env.reminders().length, 0);
});

test('onOpen toast appears only inside the last 15 days', () => {
  const env = bigQueryEnv();
  env.run('setup()');
  env.run('onOpen()');
  assert.equal(env.book.toasts.length, 0);
  env.props.BQ_EARLIEST_EXPIRY = String(Date.now() + 10 * DAY);
  env.run('onOpen()');
  assert.equal(env.book.toasts.length, 1);
});

test('Gemini key: validated with a header (never in the URL), stored only in Script Properties', () => {
  const env = load({ prompts: ['TOEFL', 'AIza-good-key'] });
  env.run('setup()');
  env.run('setGeminiApiKey()');
  assert.equal(env.props.GEMINI_API_KEY, 'AIza-good-key');
  const call = env.fetches.at(-1);
  assert.match(call.url, /\/v1beta\/models\/gemini-flash-latest$/);
  assert.doesNotMatch(call.url, /AIza/);
  assert.equal(call.opts.headers['x-goog-api-key'], 'AIza-good-key');
  const everyCell = env.book.getSheets().flatMap(s => Object.values(s.cells)).join('|');
  assert.doesNotMatch(everyCell, /AIza/);
});

test('Gemini key: a rejected key is not saved; an empty answer deletes the saved key', () => {
  const env = load({
    prompts: ['TOEFL', 'bad-key', ''],
    fetch: (url, opts) => opts.headers['x-goog-api-key'] === 'bad-key'
      ? { code: 400, body: JSON.stringify({ error: { message: 'API key not valid.' } }) }
      : { code: 200, body: '{}' },
  });
  env.run('setup()');
  env.props.GEMINI_API_KEY = 'old';
  env.run('setGeminiApiKey()');
  assert.equal(env.props.GEMINI_API_KEY, 'old');
  assert.match(env.lastAlert().msg, /API key not valid/);
  env.run('setGeminiApiKey()');
  assert.equal(env.props.GEMINI_API_KEY, undefined);
});

test('checkSetup reports account, settings, BigQuery, YouTube and Gemini', () => {
  const env = bigQueryEnv();
  env.run('setup()');
  env.props.GEMINI_API_KEY = 'k';
  env.run('checkSetup()');
  const msg = env.lastAlert().msg;
  assert.match(msg, /Running as: me@example\.com/);
  assert.match(msg, /✓ Settings OK \(topic: TOEFL, storage: bigquery\)/);
  assert.match(msg, /✓ BigQuery: 5 tables in my-project\.focus_feed/);
  assert.match(msg, /⚠ Sandbox: tables are deleted on/);
  assert.match(msg, /✓ YouTube Data API reachable/);
  assert.match(msg, /✓ Gemini key works/);
});

test('an empty, hand-made Settings tab still gets its header and rows', () => {
  const env = load({ prompts: ['TOEFL'] });
  env.book.insertSheet('Settings');
  env.run('setup()');
  const sh = env.book.getSheetByName('Settings');
  assert.deepEqual(sh.header(), ['Key', 'Value', 'Notes']);
  assert.equal(env.setting('TOPIC'), 'TOEFL');
});

/* ---------- Collect (pipeline step 1) ---------- */

test('Setup schedules one daily collect at COLLECT_HOUR, and re-running keeps it at one', () => {
  const env = load({ prompts: ['TOEFL'] });
  env.run('setup()');
  env.setSetting('COLLECT_HOUR', 6);
  env.run('setup()');
  const daily = env.triggers.filter(t => t.fn === 'runCollect');
  assert.equal(daily.length, 1);
  assert.equal(daily[0].everyDays, 1);
  assert.equal(daily[0].atHour, 6);
  assert.match(env.lastAlert().msg, /Daily collect scheduled daily around 6:00/);
});

test('search plan: SEARCHES_PER_DAY distinct searches that rotate day to day', () => {
  const env = load();
  const cfg = '({ TOPIC: "TOEFL", SEARCH_TERMS: ["TOEFL speaking template"], SEARCHES_PER_DAY: 50 })';
  const day1 = env.run(`searchPlan_(${cfg}, new Date('2026-11-07T08:00:00Z'))`);
  const day2 = env.run(`searchPlan_(${cfg}, new Date('2026-11-08T08:00:00Z'))`);
  const key = s => `${s.term}|${s.order}`;
  assert.equal(day1.length, 50);
  assert.equal(new Set(day1.map(key)).size, 50, 'no repeated search in a day');
  assert.notDeepEqual(day1.map(key), day2.map(key), 'next day searches differ');
  const all = env.run(`searchPlan_(${cfg.replace('50', '90')}, new Date('2026-11-07T08:00:00Z'))`).concat(day1);
  assert.ok(all.some(s => s.term === 'TOEFL speaking template'), 'own SEARCH_TERMS are used');
  assert.ok(day1.every(s => /^TOEFL/.test(s.term)));
});

test('ISO durations and HTML entities', () => {
  const env = load();
  assert.equal(env.run('parseIsoDuration_("PT45S")'), 45);
  assert.equal(env.run('parseIsoDuration_("PT1M5S")'), 65);
  assert.equal(env.run('parseIsoDuration_("PT1H2M3S")'), 3723);
  assert.equal(env.run('parseIsoDuration_("P0D")'), 0);
  assert.equal(env.run('parseIsoDuration_("junk")'), null);
  assert.equal(env.run('decodeEntities_("Don&#39;t &amp; &quot;win&quot;")'), 'Don\'t & "win"');
});

function collectEnv(opts = {}) {
  const env = bigQueryEnv(opts);
  env.run('setup()');
  return env;
}

test('collect (bigquery): 50 searches, unique rows batch-loaded into raw_videos, run logged', () => {
  const env = collectEnv();
  env.run('runCollect()');
  const rows = env.bq.rows.raw_videos;
  assert.equal(env.yt.searches.length, 50);
  assert.ok(rows.length > 500, `got ${rows.length} rows`);
  assert.equal(new Set(rows.map(r => r.video_id)).size, rows.length, 'one row per video per run');
  const r = rows.find(x => x.video_id === 'v38');
  assert.equal(r.title, "Don't miss this v38");
  assert.equal(r.channel_title, 'Prep & Co');
  assert.equal(r.duration_sec, 45);
  assert.equal(r.view_count, 380);
  assert.equal(r.topic, 'TOEFL');
  const gone = rows.find(x => Number(x.video_id.slice(1)) % 13 === 0);
  assert.equal(gone.duration_sec, null, 'vanished video kept with null details');
  // every search asked for short, embeddable videos and was tagged for Shorts
  env.yt.searches.forEach(a => { assert.equal(a.videoDuration, 'short'); assert.equal(a.videoEmbeddable, 'true'); assert.match(a.q, /#shorts$/); assert.equal(a.maxResults, 50); });
  // details looked up 50 at a time
  assert.equal(env.yt.detailCalls.length, Math.ceil(rows.length / 50));
  // run log
  const log = env.bq.rows.pipeline_runs;
  assert.equal(log.length, 1);
  assert.equal(log[0].step, 'collect');
  assert.equal(log[0].status, 'ok');
  assert.equal(log[0].rows_in, 50);
  assert.equal(log[0].rows_out, rows.length);
  assert.equal(log[0].quota_units, 50 * 100 + env.yt.detailCalls.length);
  assert.equal(log[0].run_id, rows[0].run_id);
  // quota bookkeeping and summary
  const units = Object.entries(env.props).find(([k]) => k.startsWith('YT_UNITS_'));
  assert.equal(Number(units[1]), log[0].quota_units);
  assert.match(env.lastAlert().title, /Collect finished/);
  assert.match(env.lastAlert().msg, /50 searches → [\d,]+ unique videos/);
  assert.match(env.lastAlert().msg, /rows written to BigQuery raw_videos/);
  assert.ok(env.bq.calls.every(c => !/query/i.test(c)), 'no query jobs');
});

test('collect: the daily budget stops a second run early instead of exceeding the quota', () => {
  const env = collectEnv();
  env.run('runCollect()');
  const first = env.yt.searches.length;
  env.run('runCollect()');
  const second = env.yt.searches.length - first;
  assert.equal(first, 50);
  assert.ok(second > 0 && second < 50, `second run made ${second} searches`);
  const used = Number(Object.entries(env.props).find(([k]) => k.startsWith('YT_UNITS_'))[1]);
  assert.ok(used <= 10000 - 300, `stayed within budget: ${used}`);
  assert.match(env.lastAlert().msg, /stopped early: daily YouTube quota budget reached/);
  assert.equal(env.bq.rows.pipeline_runs.length, 2);
});

test('collect: YouTube quota error stops searching but keeps what was found', () => {
  const env = collectEnv({ yt: fakeYouTube({ quotaOn: 6 }) });
  env.run('runCollect()');
  assert.equal(env.yt.searches.length, 6);
  assert.ok(env.bq.rows.raw_videos.length > 0);
  assert.equal(env.bq.rows.pipeline_runs[0].status, 'ok');
  assert.equal(env.bq.rows.pipeline_runs[0].rows_in, 5);
  assert.match(env.lastAlert().msg, /quota is used up/);
});

test('collect: a few failed searches are skipped; three failures abort and are logged', () => {
  const ok = collectEnv({ yt: fakeYouTube({ failOn: [3] }) });
  ok.run('runCollect()');
  assert.equal(ok.bq.rows.pipeline_runs[0].rows_in, 49);
  assert.match(ok.lastAlert().msg, /failed: Backend Error/);

  const bad = collectEnv({ yt: fakeYouTube({ failOn: [2, 4, 6] }) });
  bad.run('runCollect()');
  assert.equal(bad.lastAlert().title, 'Collect failed');
  assert.equal(bad.bq.rows.raw_videos, undefined, 'nothing half-loaded');
  assert.equal(bad.bq.rows.pipeline_runs[0].status, 'error');
});

test('collect: a failed load job is reported with BigQuery\'s message and logged as an error', () => {
  const env = collectEnv();
  env.bq.loadError = 'Invalid timestamp';
  env.run('runCollect()');
  assert.equal(env.lastAlert().title, 'Collect failed');
  assert.match(env.lastAlert().msg, /Loading raw_videos failed: Invalid timestamp — row 1: bad value/);
  assert.equal(env.run('lastRun_("collect").status'), 'error');
});

test('collect from a trigger rethrows errors so Apps Script emails them', () => {
  const env = collectEnv();
  env.bq.loadError = 'boom';
  env.g.SpreadsheetApp.getUi = () => { throw new Error('Cannot call SpreadsheetApp.getUi() from this context.'); };
  assert.throws(() => env.run('runCollect()'), /Loading raw_videos failed: boom/);
});

test('collect (sheets): rows appended under the header with real dates, oldest pruned past LITE_MAX_ROWS', () => {
  const env = load({ prompts: ['TOEFL'] });
  env.run('setup()');
  env.setSetting('LITE_MAX_ROWS', 1500);
  env.run('runCollect()');
  const raw = env.book.getSheetByName('raw_videos');
  const header = raw.header();
  const firstRun = raw.rows();
  assert.ok(firstRun.length > 1000 && firstRun.length < 1500, `first run: ${firstRun.length} rows`);
  assert.ok(firstRun[0][header.indexOf('collected_at')] instanceof Date || Object.prototype.toString.call(firstRun[0][header.indexOf('collected_at')]) === '[object Date]');
  assert.equal(env.book.getSheetByName('pipeline_runs').rows().length, 1);
  env.props[Object.keys(env.props).find(k => k.startsWith('YT_UNITS_'))] = '0'; // pretend it's a new quota day
  env.run('runCollect()');
  const after = raw.rows();
  assert.equal(after.length, 1500, 'capped at LITE_MAX_ROWS');
  const runIds = new Set(after.map(r => r[header.indexOf('run_id')]));
  assert.equal(runIds.size, 2);
  const runs = env.book.getSheetByName('pipeline_runs').rows();
  assert.equal(after.at(-1)[header.indexOf('run_id')], runs.at(-1)[0], 'newest rows are at the bottom');
  const kept = after.filter(r => r[header.indexOf('run_id')] === firstRun[0][header.indexOf('run_id')]).length;
  const vid = header.indexOf('video_id');
  assert.deepEqual(after.slice(0, kept).map(r => r[vid]), firstRun.slice(-kept).map(r => r[vid]), 'the oldest rows were the ones deleted');
  const runsHeader = env.book.getSheetByName('pipeline_runs').header();
  assert.equal(after.length - kept, runs.at(-1)[runsHeader.indexOf('rows_out')], 'every row of the newest run is kept');
  assert.ok(kept < firstRun.length, 'some first-run rows were pruned');
});

test('checkSetup shows the schedule, last collect and units used today', () => {
  const env = collectEnv();
  env.run('runCollect()');
  env.run('checkSetup()');
  const msg = env.lastAlert().msg;
  assert.match(msg, /✓ Daily collect scheduled \(around 14:00\)/);
  assert.match(msg, /✓ Last collect: .* UTC, ok, \d+ rows/);
  assert.match(msg, /YouTube units used today: \d+ of 10000/);
});
