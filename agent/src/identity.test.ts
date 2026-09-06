import { describe, expect, it } from 'vitest';
import { hostNameFrom } from './identity.js';

describe('hostNameFrom', () => {
  it('prefers the host name, which is what a machine outside a cluster has', () => {
    expect(hostNameFrom({ KUBITOR_HOST_NAME: 'buildbox' }, 'localhost')).toBe('buildbox');
  });

  /** An existing DaemonSet sets only the old variable and must keep working. */
  it('still accepts the node name', () => {
    expect(hostNameFrom({ KUBITOR_NODE_NAME: 'ken' }, 'localhost')).toBe('ken');
  });

  it('lets the host name win when both are set', () => {
    expect(hostNameFrom({ KUBITOR_HOST_NAME: 'buildbox', KUBITOR_NODE_NAME: 'ken' }, 'x')).toBe(
      'buildbox',
    );
  });

  it('falls back to what the machine calls itself', () => {
    expect(hostNameFrom({}, 'localhost')).toBe('localhost');
  });
});
