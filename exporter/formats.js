/**
 * Serialisers. Every format is deterministic: UTF-8 without a byte-order mark, LF line endings, columns in table order, rows in
 * primary-key order (decided by the caller), dates as YYYY-MM-DD, timestamps as ISO-8601 UTC with milliseconds.
 */

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(columns, rows) {
  const lines = [columns.map(csvCell).join(',')];
  for (const row of rows) lines.push(columns.map((c) => csvCell(row[c])).join(','));
  return `${lines.join('\n')}\n`;
}

/** JSON: an array of objects whose keys follow the table's column order. JSON columns arrive already parsed. */
function toJson(columns, rows) {
  const ordered = rows.map((row) => Object.fromEntries(columns.map((c) => [c, row[c] === undefined ? null : row[c]])));
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/** A SQL literal. `type` is the PostgreSQL data type of the column. */
function sqlLiteral(value, type) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  const quoted = `'${text.replace(/'/g, "''")}'`;
  return type === 'jsonb' || type === 'json' ? `${quoted}::${type}` : quoted;
}

function insertStatements(table, columns, types, rows, batch = 200) {
  const list = columns.map((c) => `"${c}"`).join(', ');
  const out = [];
  for (let i = 0; i < rows.length; i += batch) {
    const values = rows.slice(i, i + batch).map((row) => `(${columns.map((c, k) => sqlLiteral(row[c], types[k])).join(', ')})`);
    out.push(`INSERT INTO "${table}" (${list}) VALUES\n${values.join(',\n')};`);
  }
  return out;
}

module.exports = { toCsv, toJson, sqlLiteral, insertStatements, csvCell };
