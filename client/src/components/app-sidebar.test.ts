import type { NavEntry } from '@kubitor/shared';
import { describe, expect, it } from 'vitest';
import { activeHref } from './app-sidebar';

const NAV: NavEntry[] = [
  { id: 'overview', title: 'Overview', category: 'overview', href: '/' },
  {
    id: 'nodes',
    title: 'Nodes',
    category: 'infrastructure',
    href: '/nodes',
    alsoMatches: '/hosts',
  },
  { id: 'integrations', title: 'Integrations', category: 'settings', href: '/settings' },
  { id: 'accounts', title: 'Accounts', category: 'settings', href: '/settings/accounts' },
];

const HOSTS: NavEntry = { id: 'hosts', title: 'Hosts', category: 'hosts', href: '/hosts' };

describe('activeHref', () => {
  it('lights the overview only on the overview', () => {
    expect(activeHref(NAV, '/')).toBe('/');
    expect(activeHref(NAV, '/nodes')).toBe('/nodes');
  });

  /**
   * `/settings/accounts` starts with `/settings`, and a plain prefix test lit
   * both rows at once.
   */
  it('lights the longest match, not every prefix', () => {
    expect(activeHref(NAV, '/settings/accounts')).toBe('/settings/accounts');
  });

  it('requires a match to end at a path segment', () => {
    expect(activeHref(NAV, '/nodesomething')).toBeNull();
  });

  /**
   * The machine page lives under `/hosts` whether or not the machine is a node,
   * and the Hosts entry only exists once one is outside the cluster. Without
   * the alias a node's own page lit nothing at all.
   */
  it('lights Nodes on a machine page while there is no Hosts screen', () => {
    expect(activeHref(NAV, '/hosts/ken')).toBe('/nodes');
  });

  /** A claim on borrowed ground never outbids the entry that lives there. */
  it('lights Hosts on a machine page once the Hosts screen exists', () => {
    expect(activeHref([...NAV, HOSTS], '/hosts/buildbox')).toBe('/hosts');
    expect(activeHref([...NAV, HOSTS], '/nodes')).toBe('/nodes');
  });
});
