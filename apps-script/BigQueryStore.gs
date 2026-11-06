/**
 * BigQueryStore.gs — the BigQuery backend (STORAGE = bigquery).
 *
 * Sandbox-safe by design: tables are created through the API (no DDL needed), data will
 * only ever arrive through batch load jobs (no DML, no streaming inserts), so everything
 * works in the free BigQuery sandbox without a billing account.
 */

/** Creates the dataset and every table in Schema.gs if missing; adds new columns to old tables. */
function bqSetup_(cfg) {
  const projectId = cfg.BQ_PROJECT_ID;
  const datasetId = cfg.BQ_DATASET;
  const ds = bqEnsureDataset_(projectId, datasetId, cfg.BQ_LOCATION, cfg.TOPIC);
  const tables = Object.keys(TABLES).map(name =>
    Object.assign({ name }, bqEnsureTable_(projectId, datasetId, name)));
  return {
    datasetCreated: ds.created,
    datasetLocation: ds.dataset.location,
    tables,
    expiry: bqExpiryStatus_(ds.dataset, tables.map(t => t.table)),
  };
}

function bqEnsureDataset_(projectId, datasetId, location, topic) {
  const existing = bqGetOrNull_(() => BigQuery.Datasets.get(projectId, datasetId), projectId);
  if (existing) return { dataset: existing, created: false };
  const dataset = BigQuery.Datasets.insert({
    datasetReference: { projectId, datasetId },
    location,
    description: `FocusFeed pipeline data (raw_videos → scored_videos → feed). Topic: ${topic}`,
    labels: { app: 'focusfeed' },
  }, projectId);
  return { dataset, created: true };
}

function bqEnsureTable_(projectId, datasetId, name) {
  const def = TABLES[name];
  const existing = bqGetOrNull_(() => BigQuery.Tables.get(projectId, datasetId, name), projectId);
  if (!existing) {
    const resource = {
      tableReference: { projectId, datasetId, tableId: name },
      description: def.description,
      labels: { app: 'focusfeed' },
      schema: { fields: def.fields.map(bqField_) },
    };
    if (def.partitionField) resource.timePartitioning = { type: 'DAY', field: def.partitionField };
    if (def.clusterFields) resource.clustering = { fields: def.clusterFields };
    return { table: BigQuery.Tables.insert(resource, projectId, datasetId), created: true, added: [] };
  }
  // Additive migration: append columns that the schema has and the table doesn't.
  const current = (existing.schema && existing.schema.fields) || [];
  const have = current.map(f => String(f.name).toLowerCase());
  const missing = def.fields.filter(f => have.indexOf(f[0].toLowerCase()) === -1);
  if (!missing.length) return { table: existing, created: false, added: [] };
  const fields = current.concat(missing.map(f => Object.assign(bqField_(f), { mode: 'NULLABLE' })));
  const table = BigQuery.Tables.patch({ schema: { fields } }, projectId, datasetId, name);
  return { table, created: false, added: missing.map(f => f[0]) };
}

function bqField_(f) {
  const field = { name: f[0], type: f[1], mode: f[2] || 'NULLABLE' };
  if (f[3]) field.description = f[3];
  return field;
}

/** Runs a BigQuery get; returns null on "not found" for the dataset/table, rethrows anything else. */
function bqGetOrNull_(fn, projectId) {
  try {
    return fn();
  } catch (e) {
    const msg = String(e && e.message);
    if (/not found: project/i.test(msg)) {
      throw new Error(`BigQuery project "${projectId}" was not found, or ${currentUserEmail_()} has no access to it. ` +
        'Check BQ_PROJECT_ID, and that the project belongs to the Google account running this script.');
    }
    const code = e && e.details && e.details.code;
    if (code === 404 || /not found/i.test(msg)) return null;
    throw e;
  }
}

/**
 * Sandbox limits still in force: table expiration (whole table deleted), partition
 * expiration (old days deleted) and the dataset default (applies to new tables).
 */
function bqExpiryStatus_(dataset, tables) {
  const times = tables.map(t => Number(t.expirationTime)).filter(n => n > 0);
  const partitionLimited = tables
    .filter(t => t.timePartitioning && Number(t.timePartitioning.expirationMs) > 0)
    .map(t => t.tableReference.tableId);
  const datasetDefault = Number(dataset.defaultTableExpirationMs) > 0 ||
    Number(dataset.defaultPartitionExpirationMs) > 0;
  return {
    earliest: times.length ? new Date(Math.min.apply(null, times)) : null,
    partitionLimited,
    datasetDefault,
    clear: !times.length && !partitionLimited.length && !datasetDefault,
  };
}

/** Read-only check used by "Check setup": what exists, without creating anything. */
function bqInspect_(cfg) {
  const p = cfg.BQ_PROJECT_ID, d = cfg.BQ_DATASET;
  const dataset = bqGetOrNull_(() => BigQuery.Datasets.get(p, d), p);
  if (!dataset) return { dataset: null, missing: Object.keys(TABLES), tables: [] };
  const tables = [], missing = [];
  Object.keys(TABLES).forEach(name => {
    const t = bqGetOrNull_(() => BigQuery.Tables.get(p, d, name), p);
    if (t) tables.push(t); else missing.push(name);
  });
  return { dataset, tables, missing, expiry: bqExpiryStatus_(dataset, tables) };
}
