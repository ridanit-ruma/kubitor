import { beforeEach, describe, expect, it } from 'vitest';
import { IntegrationStateRepo } from '../db/integration-state.repo.js';
import { migrateToLatest } from '../db/migrate.js';
import { describeEachDialect } from '../test/db-harness.js';
import { fakeProbes } from '../test/fake-probes.js';
import type { Detection, IntegrationModule } from './contract.js';
import { DetectionService, effectiveState } from './detection.service.js';
import { IntegrationRegistry } from './registry.js';

const NOW = 1_756_800_000_000;

function module(id: string, detect: IntegrationModule['detect']): IntegrationModule {
  return {
    id,
    title: id,
    scope: 'cluster',
    facets: ['http.access'],
    requiredRbac: [],
    detect,
    collectors: () => [],
  };
}

const present = async (): Promise<Detection> => ({
  state: 'present',
  version: '1.2.3',
  evidence: 'Deployment traefik/traefik',
});
const absent = async (): Promise<Detection> => ({ state: 'absent', evidence: 'No CRDs found' });

describeEachDialect('DetectionService', (ctx) => {
  let states: IntegrationStateRepo;

  beforeEach(async () => {
    await migrateToLatest(ctx.db, ctx.kind);
    states = new IntegrationStateRepo(ctx.db, ctx.sqlHelper);
    await ctx.db.deleteFrom('integration_state').execute();
  });

  function service(modules: IntegrationModule[], denied: string[] = []): DetectionService {
    return new DetectionService({
      registry: new IntegrationRegistry(modules),
      states,
      probes: fakeProbes({ denied }),
    });
  }

  it('records a present integration with its evidence and version', async () => {
    await service([module('traefik', present)]).runOnce(NOW);

    const stored = await states.byId('traefik');
    expect(stored?.state).toBe('present');
    expect(stored?.version).toBe('1.2.3');
    expect(stored?.evidence).toBe('Deployment traefik/traefik');
    expect(stored?.checkedAt).toBe(NOW);
  });

  it('records an absent integration with the reason it looked absent', async () => {
    await service([module('rook', absent)]).runOnce(NOW);

    const stored = await states.byId('rook');
    expect(stored?.state).toBe('absent');
    expect(stored?.evidence).toBe('No CRDs found');
    expect(stored?.version).toBeNull();
  });

  /**
   * The distinction the whole three-state design exists for: a cluster that
   * denies the probe must not be told it does not run the thing.
   */
  it('reports a denied probe as unknown, never as absent', async () => {
    const denied = module('cilium', async (context) => {
      await context.probes.hasCrd('ciliumnodes.cilium.io');
      return { state: 'present', evidence: 'unreachable' };
    });

    await service([denied], ['crds']).runOnce(NOW);

    const stored = await states.byId('cilium');
    expect(stored?.state).toBe('unknown');
    expect(stored?.unknownReason).toBe('rbac');
    expect(stored?.evidence).toContain('crds');
  });

  it('reports a thrown error as unknown and keeps probing the rest', async () => {
    const broken = module('broken', async () => {
      throw new Error('kaboom');
    });

    await service([broken, module('traefik', present)]).runOnce(NOW);

    expect((await states.byId('broken'))?.state).toBe('unknown');
    expect((await states.byId('broken'))?.unknownReason).toBe('error');
    expect((await states.byId('traefik'))?.state).toBe('present');
  });

  it('round-trips degradation reasons', async () => {
    const degraded = module('cilium', async () => ({
      state: 'present',
      evidence: 'DaemonSet kube-system/cilium',
      degraded: [{ facet: 'network.flows', reason: 'hubble-relay has no ready endpoints' }],
    }));

    await service([degraded]).runOnce(NOW);

    expect((await states.byId('cilium'))?.degraded).toEqual([
      { facet: 'network.flows', reason: 'hubble-relay has no ready endpoints' },
    ]);
  });

  it('keeps a user override across re-detection', async () => {
    const detection = service([module('traefik', present)]);
    await detection.runOnce(NOW);
    await detection.setOverride('traefik', 'force_off');

    await detection.runOnce(NOW + 1000);

    expect((await states.byId('traefik'))?.override).toBe('force_off');
  });

  it('refuses an override for an integration that does not exist', async () => {
    expect(await service([]).setOverride('nope', 'force_on')).toBe(false);
  });
});

describe('effectiveState', () => {
  it('follows detection when the override is auto', () => {
    expect(effectiveState('present', 'auto')).toBe('present');
    expect(effectiveState('absent', 'auto')).toBe('absent');
  });

  it('lets the user overrule detection in both directions', () => {
    expect(effectiveState('absent', 'force_on')).toBe('present');
    expect(effectiveState('present', 'force_off')).toBe('absent');
    expect(effectiveState('unknown', 'force_on')).toBe('present');
  });
});
