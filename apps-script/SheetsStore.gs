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
