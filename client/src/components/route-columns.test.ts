import { expect, it } from 'vitest';
import { routeColumns, routeKinds } from './route-columns';

/**
 * The screen is the same screen whichever ingress is installed. What a vendor
 * knows beyond the neutral shape deepens it; it never starts a second one.
 */
it('shows only the neutral columns where no vendor has more to say', () => {
  const columns = routeColumns(['ingress-nginx']);
  expect(columns.map((column) => column.key)).toEqual([
    'host',
    'service',
    'tls',
    'namespace',
    'integration',
  ]);
});

it("adds the vendor's own column where that vendor is feeding the facet", () => {
  const columns = routeColumns(['traefik']);

  expect(columns.map((column) => column.key)).toEqual([
    'host',
    'service',
    'tls',
    'attrs.match',
    'namespace',
    'integration',
  ]);
});

/**
 * The table is fixed-layout, so a column arriving has to be paid for by the
 * others rather than pushing the table past its width.
 */
it('narrows the neutral columns to pay for the vendor one', () => {
  const neutral = routeColumns([]);
  const withVendor = routeColumns(['traefik']);

  expect(neutral.find((column) => column.key === 'host')?.width).toBe('w-[34%]');
  expect(withVendor.find((column) => column.key === 'host')?.width).toContain('lg:w-[24%]');
});

it('offers a vendor kind only where that vendor could produce it', () => {
  expect(routeKinds([])).toEqual(['Ingress']);
  expect(routeKinds(['traefik'])).toEqual(['Ingress', 'IngressRoute']);
});
