/**
 * CSV writer for the report exports.
 *
 *   - UTF-8 with a byte-order mark, so Excel opens accented and non-Latin text correctly.
 *   - RFC 4180 quoting; CRLF line endings.
 *   - Spreadsheet formula protection: a cell that starts with = + - @ (or a tab / carriage return) is prefixed with an
 *     apostrophe so Excel and Sheets show it as text instead of running it.
 */
const BOM = '﻿';

function formatCell(value) {
  if (value === null || value === undefined) return '';
  let text;
  if (value instanceof Date) text = value.toISOString();
  else if (typeof value === 'object') text = JSON.stringify(value);
  else text = String(value);
  // Negative numbers are legitimate numbers: only text that merely looks like a formula is neutralised.
  if (typeof value !== 'number' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** @param {string[]} columns header names  @param {Array<Array<*>>} rows */
function toCsv(columns, rows) {
  const lines = [columns.map(formatCell).join(','), ...rows.map((row) => row.map(formatCell).join(','))];
  return `${BOM}${lines.join('\r\n')}\r\n`;
}

module.exports = { toCsv, formatCell, BOM };
