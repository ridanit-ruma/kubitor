import { signRequest } from './sigv4.js';

export interface S3Config {
  /** `https://s3.eu-central-1.amazonaws.com`, or a MinIO or Ceph RGW address. */
  endpoint: string;
  bucket: string;
  prefix: string;
  accessKey: string;
  secretKey: string;
  /** Providers without regions accept `us-east-1`; the signature needs one. */
  region: string;
}

export interface S3Deps {
  config: S3Config;
  fetch: typeof globalThis.fetch;
  now(): Date;
}

export interface StoredObject {
  key: string;
  bytes: number;
  modifiedAt: string;
}

/**
 * An S3 error carries its reason in the body and nowhere else.
 *
 * The status alone is famously unhelpful — a 403 is a wrong key, a wrong
 * region, a clock skew or a bucket policy, and only the body says which.
 */
export class S3Error extends Error {
  readonly status: number;

  constructor(status: number, body: string) {
    super(`S3 answered ${status}: ${summarize(body)}`);
    this.name = 'S3Error';
    this.status = status;
  }
}

function summarize(body: string): string {
  const code = /<Code>([^<]+)<\/Code>/.exec(body)?.[1];
  const message = /<Message>([^<]+)<\/Message>/.exec(body)?.[1];
  if (code) return message ? `${code} — ${message}` : code;
  return body.slice(0, 200) || 'no body';
}

/**
 * The three verbs a backup needs, over path-style addressing.
 *
 * Path-style rather than virtual-host style because MinIO and Ceph RGW are
 * usually reached that way and AWS accepts it, so one code path serves every
 * provider an operator is likely to point this at.
 */
export class S3Client {
  readonly #deps: S3Deps;

  constructor(deps: S3Deps) {
    this.#deps = deps;
  }

  /** The full key for a name under the configured prefix. */
  key(name: string): string {
    const prefix = this.#deps.config.prefix.replace(/^\/+|\/+$/g, '');
    return prefix === '' ? name : `${prefix}/${name}`;
  }

  async put(key: string, body: Uint8Array, contentType: string): Promise<void> {
    const response = await this.#send('PUT', key, '', body, {
      'content-type': contentType,
      'content-length': String(body.byteLength),
    });
    if (!response.ok) throw new S3Error(response.status, await response.text());
  }

  async get(key: string): Promise<Uint8Array> {
    const response = await this.#send('GET', key, '', new Uint8Array(), {});
    if (!response.ok) throw new S3Error(response.status, await response.text());
    return new Uint8Array(await response.arrayBuffer());
  }

  async list(limit = 100): Promise<StoredObject[]> {
    const query = new URLSearchParams({
      'list-type': '2',
      prefix: this.key(''),
      'max-keys': String(limit),
    });

    const response = await this.#send('GET', '', query.toString(), new Uint8Array(), {});
    if (!response.ok) throw new S3Error(response.status, await response.text());

    return parseListing(await response.text());
  }

  async #send(
    method: string,
    key: string,
    query: string,
    body: Uint8Array,
    headers: Record<string, string>,
  ): Promise<Response> {
    const { config } = this.#deps;
    const base = config.endpoint.replace(/\/+$/, '');
    const path = key === '' ? `/${config.bucket}` : `/${config.bucket}/${key}`;
    const url = new URL(`${base}${path}${query === '' ? '' : `?${query}`}`);

    const signed = signRequest({
      method,
      url,
      headers,
      payload: body,
      accessKey: config.accessKey,
      secretKey: config.secretKey,
      region: config.region,
      service: 's3',
      at: this.#deps.now(),
    });

    return this.#deps.fetch(url, {
      method,
      headers: signed,
      ...(method === 'PUT' ? { body } : {}),
    });
  }
}

/** Enough of ListObjectsV2's XML to show a history. Not a general parser. */
export function parseListing(xml: string): StoredObject[] {
  return [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map((match) => {
    const entry = match[1] ?? '';
    return {
      key: /<Key>([^<]*)<\/Key>/.exec(entry)?.[1] ?? '',
      bytes: Number(/<Size>(\d+)<\/Size>/.exec(entry)?.[1] ?? 0),
      modifiedAt: /<LastModified>([^<]*)<\/LastModified>/.exec(entry)?.[1] ?? '',
    };
  });
}
