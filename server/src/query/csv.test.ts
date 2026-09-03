import { describe, expect, it } from 'vitest';
import { csvCell, csvRow } from './csv.js';

describe('csvCell', () => {
  it('passes ordinary text through', () => {
    expect(csvCell('kubitor')).toBe('kubitor');
    expect(csvCell(200)).toBe('200');
  });

  it('writes an empty cell for nothing', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });

  it('quotes a value containing a comma, quote or newline', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line\nbreak')).toBe('"line\nbreak"');
  });

  /**
   * Request paths are attacker-controlled and land in exports. Without this a
   * recorded path could execute when the spreadsheet is opened.
   */
  it('neutralizes a value a spreadsheet would treat as a formula', () => {
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('+cmd')).toBe("'+cmd");
    expect(csvCell('-2')).toBe("'-2");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    // A leading tab is neutralized but needs no quoting: it is not one of the
    // characters that would break the CSV structure itself.
    expect(csvCell('\ttab')).toBe("'\ttab");
  });

  it('neutralizes and then quotes a formula that also needs quoting', () => {
    expect(csvCell('=cmd|"/c calc"!A1')).toBe('"\'=cmd|""/c calc""!A1"');
  });

  it('serializes an object rather than printing [object Object]', () => {
    expect(csvCell({ a: 1 })).toBe('"{""a"":1}"');
  });
});

describe('csvRow', () => {
  it('joins cells with commas', () => {
    expect(csvRow(['a', 1, null])).toBe('a,1,');
  });
});
