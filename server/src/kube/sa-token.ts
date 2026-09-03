import { readFile } from 'node:fs/promises';
import { request } from 'node:https';
import { createLocalJWKSet, type JSONWebKeySet, jwtVerify } from 'jose';

/** What a projected pod token proves about its bearer. */
export interface PodIdentity {
  node: string;
  namespace: string;
  serviceAccount: string;
  podName: string | null;
}

const SA_ROOT = '/var/run/secrets/kubernetes.io/serviceaccount';
/** A key set is refetched no more often than this, even on repeated misses. */
const REFRESH_INTERVAL_MS = 60_000;

export interface VerifierDeps {
  /** Returns the cluster's JSON Web Key Set. */
  jwks(): Promise<JSONWebKeySet>;
  /** The audience the DaemonSet requests. A token for anything else is refused. */
  audience: string;
  /**
   * The identity allowed to report host metrics.
   *
   * Necessary, not decorative: any pod may ask the API server for a token with
   * any audience, so verifying the signature and audience alone would let any
   * workload in the cluster write telemetry for the node it happens to sit on.
   * Pinning the namespace and service account narrows that to the DaemonSet.
   */
  namespace: string;
  serviceAccount: string;
  now(): number;
}

/**
 * Establishes which node an agent is, without a secret anyone had to deliver.
 *
 * The kubelet projects a token that the API server signed and that names the
 * node the pod is running on. Verifying it offline against the cluster's public
 * keys gives per-node identity with nothing to distribute, store or rotate — and
 * a compromised node still cannot report as another node, because it cannot
 * mint a token naming one.
 *
 * Verification is offline on purpose. `TokenReview` would answer the same
 * question but needs a `create` verb, and kubitor's cluster role is read-only.
 */
export class ServiceAccountVerifier {
  readonly #deps: VerifierDeps;
  #keys: JSONWebKeySet | null = null;
  #fetchedAt = 0;
  #inFlight: Promise<void> | null = null;

  constructor(deps: VerifierDeps) {
    this.#deps = deps;
  }

  async verify(token: string): Promise<PodIdentity | null> {
    const identity = await this.#tryVerify(token);
    if (identity) return identity;

    // A failure may only mean the signing key rotated, so refresh once and
    // retry. The interval stops a stream of bad tokens from becoming a stream
    // of requests to the API server.
    if (this.#deps.now() - this.#fetchedAt < REFRESH_INTERVAL_MS) return null;

    await this.#refresh();
    return this.#tryVerify(token);
  }

  async #tryVerify(token: string): Promise<PodIdentity | null> {
    if (!this.#keys) {
      await this.#refresh();
      if (!this.#keys) return null;
    }

    try {
      const { payload } = await jwtVerify(token, createLocalJWKSet(this.#keys), {
        audience: this.#deps.audience,
      });

      const identity = identityFrom(payload);
      if (!identity) return null;
      if (identity.namespace !== this.#deps.namespace) return null;
      if (identity.serviceAccount !== this.#deps.serviceAccount) return null;

      return identity;
    } catch {
      return null;
    }
  }

  async #refresh(): Promise<void> {
    // Concurrent agents must not each trigger their own fetch.
    this.#inFlight ??= (async () => {
      try {
        this.#keys = await this.#deps.jwks();
        this.#fetchedAt = this.#deps.now();
      } catch {
        // Leave the previous keys in place: stale keys still verify tokens the
        // API server signed before it rotated them.
      } finally {
        this.#inFlight = null;
      }
    })();

    await this.#inFlight;
  }
}

/**
 * The node claim is what makes this worth doing.
 *
 * `kubernetes.io.node.name` is present from Kubernetes 1.33 onward. A token
 * without it proves a service account but not a machine, and is refused —
 * accepting it would let any pod using that account report for any node.
 */
export function identityFrom(payload: Record<string, unknown>): PodIdentity | null {
  const kubernetes = payload['kubernetes.io'];
  if (typeof kubernetes !== 'object' || kubernetes === null) return null;

  const claims = kubernetes as {
    node?: { name?: unknown };
    namespace?: unknown;
    pod?: { name?: unknown };
    serviceaccount?: { name?: unknown };
  };

  const node = claims.node?.name;
  const namespace = claims.namespace;
  const serviceAccount = claims.serviceaccount?.name;

  if (typeof node !== 'string' || node.length === 0) return null;
  if (typeof namespace !== 'string' || typeof serviceAccount !== 'string') return null;

  return {
    node,
    namespace,
    serviceAccount,
    podName: typeof claims.pod?.name === 'string' ? claims.pod.name : null,
  };
}

/** The namespace this pod runs in, which is where its agents are expected. */
export async function ownNamespace(root = SA_ROOT): Promise<string | null> {
  try {
    const namespace = (await readFile(`${root}/namespace`, 'utf8')).trim();
    return namespace.length > 0 ? namespace : null;
  } catch {
    return null;
  }
}

/**
 * Reads the cluster's key set from inside a pod.
 *
 * Goes to `node:https` directly rather than through `fetch` so the cluster CA
 * can be supplied for this one request without touching the process-wide trust
 * store.
 */
export function clusterJwksReader(root = SA_ROOT): () => Promise<JSONWebKeySet> {
  return async () => {
    const [token, ca] = await Promise.all([
      readFile(`${root}/token`, 'utf8'),
      readFile(`${root}/ca.crt`),
    ]);

    return await new Promise<JSONWebKeySet>((resolve, reject) => {
      const call = request(
        {
          host: 'kubernetes.default.svc',
          path: '/openid/v1/jwks',
          method: 'GET',
          ca,
          headers: { authorization: `Bearer ${token.trim()}` },
        },
        (response) => {
          let body = '';
          response.on('data', (chunk) => {
            body += chunk;
          });
          response.on('end', () => {
            if (response.statusCode !== 200) {
              reject(new Error(`jwks responded ${response.statusCode}`));
              return;
            }
            try {
              resolve(JSON.parse(body) as JSONWebKeySet);
            } catch (error) {
              reject(error instanceof Error ? error : new Error(String(error)));
            }
          });
        },
      );

      call.on('error', reject);
      call.end();
    });
  };
}
