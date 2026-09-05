import { describe, expect, it } from 'vitest';
import { decodeRouteId, encodeRouteId } from './route-id';

const KEY = {
  kind: 'IngressRoute',
  namespace: 'kubitor',
  name: 'kubitor',
  host: 'kubitor.example.com',
  path: '/api',
};

describe('route identity', () => {
  it('survives a round trip', () => {
    expect(decodeRouteId(encodeRouteId(KEY))).toEqual(KEY);
  });

  /** Hosts and paths carry the characters a URL segment cares about. */
  it('survives a path with slashes and a query-like tail', () => {
    const awkward = { ...KEY, path: '/a/b?c=d&e=f', host: 'a.b-c.example' };
    expect(decodeRouteId(encodeRouteId(awkward))).toEqual(awkward);
  });

  it('survives a non-ASCII host', () => {
    const unicode = { ...KEY, host: '한글.example' };
    expect(decodeRouteId(encodeRouteId(unicode))).toEqual(unicode);
  });

  it('refuses a link it cannot read rather than inventing a route', () => {
    expect(decodeRouteId('not-base64!!')).toBeNull();
    expect(decodeRouteId(encodeRouteId(KEY).slice(0, 6))).toBeNull();
  });
});
