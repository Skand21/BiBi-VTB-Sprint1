// Imported labels and quote metadata are untrusted spreadsheet cells.
export function csvCell(value) {
  const text=String(value??'');
  const formula=/^[\s\uFEFF]*[=+@-]/u.test(text.normalize('NFKC'))||/^[\t\r\n]/u.test(text);
  return `"${(formula?"'"+text:text).replace(/"/g,'""')}"`;
}
export function serializeCSV(rows) {
  return '\uFEFF'+rows.map(row=>row.map(csvCell).join(';')).join('\r\n');
}
