/**
 * Characters that make a spreadsheet treat a cell as a formula.
 *
 * A path like `=cmd|'/c calc'!A1` recorded from a real request would otherwise
 * execute when someone opens the export. Prefixing with an apostrophe keeps the
 * text intact and inert.
 */
const FORMULA_LEADERS = ['=', '+', '-', '@', '\t', '\r'];

export function csvCell(value: unknown): string {
  const text = stringify(value);
  const guarded = FORMULA_LEADERS.some((leader) => text.startsWith(leader)) ? `'${text}` : text;

  return /["\n\r,]/.test(guarded) ? `"${guarded.replaceAll('"', '""')}"` : guarded;
}

export function csvRow(values: readonly unknown[]): string {
  return values.map(csvCell).join(',');
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
