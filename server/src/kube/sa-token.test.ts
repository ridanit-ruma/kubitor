import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { identityFrom, ServiceAccountVerifier } from './sa-token.js';

const ISSUER = 'https://kubernetes.default.svc.cluster.local';
const AUDIENCE = 'kubitor';

describe('identityFrom', () => {
  const claims = (overrides: Record<string, unknown> = {}) => ({
    'kubernetes.io': {
      namespace: 'kubitor',
      node: { name: 'calder', uid: 'node-uid' },
      pod: { name: 'kubitor-agent-abcde', uid: 'pod-uid' },
      serviceaccount: { name: 'kubitor-agent', uid: 'sa-uid' },
      ...overrides,
    },
  });

  it('reads the node the API server named', () => {
    expect(identityFrom(claims())?.node).toBe('calder');
  });

  /**
   * The whole security property. A token that proves a service account but not
   * a machine would let any pod using that account report for any node, which
   * is exactly the forgery per-node credentials exist to prevent.
   */
  it('refuses a token with no node claim', () => {
    expect(identityFrom(claims({ node: undefined }))).toBeNull();
  });

  it('refuses a token whose node claim is not a name', () => {
    expect(identityFrom(claims({ node: { uid: 'only-a-uid' } }))).toBeNull();
    expect(identityFrom(claims({ node: { name: '' } }))).toBeNull();
  });

  it('refuses a payload with no Kubernetes claims at all', () => {
    expect(identityFrom({ sub: 'someone' })).toBeNull();
  });
});

describe('ServiceAccountVerifier', () => {
  let sign: (claims: Record<string, unknown>, audience?: string) => Promise<string>;
  let jwks: () => Promise<{ keys: unknown[] }>;
  let otherKeySign: (claims: Record<string, unknown>) => Promise<string>;

  beforeAll(async () => {
    const cluster = await generateKeyPair('RS256');
    const impostor = await generateKeyPair('RS256');

    const publicJwk = { ...(await exportJWK(cluster.publicKey)), alg: 'RS256', use: 'sig' };
    jwks = async () => ({ keys: [publicJwk] });

    sign = (claims, audience = AUDIENCE) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256' })
        .setIssuer(ISSUER)
        .setAudience(audience)
        .setIssuedAt()
        .setExpirationTime('10m')
        .sign(cluster.privateKey);

    otherKeySign = (claims) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256' })
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setIssuedAt()
        .setExpirationTime('10m')
        .sign(impostor.privateKey);
  });

  const podClaims = (node: string, overrides: Record<string, unknown> = {}) => ({
    'kubernetes.io': {
      namespace: 'kubitor',
      node: { name: node },
      pod: { name: `kubitor-agent-${node}` },
      serviceaccount: { name: 'kubitor-agent' },
      ...overrides,
    },
  });

  function verifier(overrides: Partial<{ jwks: () => Promise<unknown>; now(): number }> = {}) {
    return new ServiceAccountVerifier({
      jwks: (overrides.jwks ?? jwks) as never,
      audience: AUDIENCE,
      namespace: 'kubitor',
      serviceAccount: 'kubitor-agent',
      now: overrides.now ?? (() => Date.now()),
    });
  }

  it('accepts a token the cluster signed and reports its node', async () => {
    const identity = await verifier().verify(await sign(podClaims('calder')));
    expect(identity?.node).toBe('calder');
    expect(identity?.serviceAccount).toBe('kubitor-agent');
  });

  it('refuses a token signed by anyone else', async () => {
    expect(await verifier().verify(await otherKeySign(podClaims('calder')))).toBeNull();
  });

  /**
   * The DaemonSet asks for an audience of `kubitor`. Accepting a token minted
   * for the API server would let any pod's default token write telemetry.
   */
  it('refuses a token minted for another audience', async () => {
    const wrongAudience = await sign(podClaims('calder'), 'https://kubernetes.default.svc');
    expect(await verifier().verify(wrongAudience)).toBeNull();
  });

  /**
   * Any pod may ask the API server for a token with any audience, so a valid
   * signature and audience alone would let any workload in the cluster write
   * telemetry for whichever node it happens to be scheduled on.
   */
  it('refuses a token from another service account', async () => {
    const other = await sign(podClaims('calder', { serviceaccount: { name: 'default' } }));
    expect(await verifier().verify(other)).toBeNull();
  });

  it('refuses a token from another namespace', async () => {
    const other = await sign(podClaims('calder', { namespace: 'default' }));
    expect(await verifier().verify(other)).toBeNull();
  });

  it('refuses a token with no node claim even when the signature is good', async () => {
    const noNode = await sign({ 'kubernetes.io': { namespace: 'kubitor' } });
    expect(await verifier().verify(noNode)).toBeNull();
  });

  it('refuses something that is not a token at all', async () => {
    expect(await verifier().verify('not-a-jwt')).toBeNull();
  });

  it('keeps working when the key set cannot be fetched', async () => {
    const failing = verifier({ jwks: () => Promise.reject(new Error('unreachable')) });
    expect(await failing.verify(await sign(podClaims('calder')))).toBeNull();
  });

  it('does not refetch the key set for every bad token', async () => {
    const fetched = vi.fn(jwks);
    // A stream of invalid tokens must not become a stream of requests to the
    // API server: that would turn a bad agent into a denial of service.
    const subject = verifier({ jwks: fetched as never, now: () => 1_000_000 });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await subject.verify('not-a-jwt');
    }

    expect(fetched.mock.calls.length).toBeLessThanOrEqual(2);
  });
});
