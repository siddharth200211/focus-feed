/**
 * SheetsStore.gs — the Lite backend: each table in Schema.gs is a tab in this spreadsheet.
 * (Read/write helpers for the pipeline arrive with the collect step; this batch only
 * creates and migrates the tabs.)
 */

/** Creates a data tab with the schema's header row, or appends columns missing from an older tab. */
function sheetsEnsureTab_(ss, tableName) {
  const columns = columnNames_(tableName);
  let sh = ss.getSheetByName(tableName);
  if (!sh) {
    sh = ss.insertSheet(tableName);
    sh.getRange(1, 1, 1, columns.length).setValues([columns]).setFontWeight('bold');
    sh.setFrozenRows(1);
    // A new tab comes with 26 columns; drop the unused ones so they don't count
    // towards the 10M-cell spreadsheet limit.
    const extra = sh.getMaxColumns() - columns.length;
    if (extra > 0) sh.deleteColumns(columns.length + 1, extra);
    return { created: true, added: [] };
  }
  const lastCol = sh.getLastColumn();
  const header = lastCol > 0
    ? sh.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h).trim())
    : [];
  const missing = columns.filter(c => header.indexOf(c) === -1);
  if (missing.length) {
    const start = header.length + 1;
    const need = start + missing.length - 1 - sh.getMaxColumns();
    if (need > 0) sh.insertColumnsAfter(sh.getMaxColumns(), need);
    sh.getRange(1, start, 1, missing.length).setValues([missing]).setFontWeight('bold');
  }
  sh.setFrozenRows(1);
  return { created: false, added: missing };
}

/** A brand-new spreadsheet starts with an empty "Sheet1"; remove it once our tabs exist. */
function sheetsRemoveEmptyDefaultTab_(ss) {
  const sh = ss.getSheetByName('Sheet1');
  if (sh && ss.getSheets().length > 1 && sh.getLastRow() === 0 && sh.getLastColumn() === 0) {
    ss.deleteSheet(sh);
  }
}

/**
 * Appends rows (objects keyed by column name) under the tab's header, matching columns by
 * name. TIMESTAMP values become real dates. Then deletes the oldest rows beyond maxRows
 * (Lite retention). Returns the number of rows appended.
 */
function sheetsAppendRows_(ss, tableName, rows, maxRows) {
  const sh = ss.getSheetByName(tableName);
  if (!sh) throw new Error(`No "${tableName}" tab. Run FocusFeed → Setup.`);
  const header = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(h => String(h).trim());
  const types = {};
  TABLES[tableName].fields.forEach(f => { types[f[0]] = f[1]; });
  const values = rows.map(r => header.map(h => {
    const v = r[h];
    if (v === undefined || v === null) return '';
    return types[h] === 'TIMESTAMP' ? new Date(v) : v;
  }));
  const start = sh.getLastRow() + 1;
  const short = start + values.length - 1 - sh.getMaxRows();
  if (short > 0) sh.insertRowsAfter(sh.getMaxRows(), short);
  sh.getRange(start, 1, values.length, header.length).setValues(values);
  const dataRows = sh.getLastRow() - 1;
  if (maxRows && dataRows > maxRows) sh.deleteRows(2, dataRows - maxRows);
  return values.length;
}
