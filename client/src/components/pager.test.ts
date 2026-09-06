import { describe, expect, it } from 'vitest';
import { GAP, pageItems, parsePage } from './pager';

describe('pageItems', () => {
  it('lists every page while they all fit', () => {
    expect(pageItems(1, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('keeps the first and last page reachable in one click', () => {
    const items = pageItems(20, 40);

    expect(items[0]).toBe(1);
    expect(items.at(-1)).toBe(40);
    expect(items).toContain(20);
  });

  it('breaks the run where pages are hidden', () => {
    expect(pageItems(20, 40)).toEqual([1, GAP, 18, 19, 20, 21, 22, GAP, 40]);
  });

  /**
   * A gap standing for a single page is a click that saves nothing and a
   * number the reader could have had instead.
   */
  it('shows the hidden page rather than a gap that hides one', () => {
    expect(pageItems(5, 8)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(pageItems(1, 8)).toEqual([1, 2, 3, 4, 5, GAP, 8]);
  });

  /** The window keeps its width at the ends instead of collapsing against them. */
  it('slides the window rather than shrinking it', () => {
    const window = (page: number) =>
      pageItems(page, 40).filter((item) => item !== GAP && item !== 1 && item !== 40);

    expect(window(1)).toEqual([2, 3, 4, 5]);
    expect(window(20)).toEqual([18, 19, 20, 21, 22]);
    expect(window(40)).toEqual([36, 37, 38, 39]);
  });

  it('ends on the last page rather than past it', () => {
    expect(pageItems(40, 40)).toEqual([1, GAP, 36, 37, 38, 39, 40]);
  });
});

describe('parsePage', () => {
  it('takes a page inside the range', () => {
    expect(parsePage(' 12 ', 40)).toBe(12);
  });

  it('refuses what is not a page', () => {
    expect(parsePage('0', 40)).toBeNull();
    expect(parsePage('41', 40)).toBeNull();
    expect(parsePage('2.5', 40)).toBeNull();
    expect(parsePage('', 40)).toBeNull();
    expect(parsePage('last', 40)).toBeNull();
  });
});
