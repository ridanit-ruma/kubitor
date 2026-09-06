import { createHash, createHmac } from 'node:crypto';

const ALGORITHM = 'AWS4-HMAC-SHA256';

/**
 * Request signing for S3, implemented rather than depended on.
 *
 * kubitor uses three S3 verbs. Taking `@aws-sdk/client-s3` for three verbs
 * means a cloud SDK, its transitive tree and its release cadence inside a
 * monitoring tool's image. SigV4 is a fully specified procedure with published
 * test vectors, which is what the tests beside this file check against — so
 * "we implemented it ourselves" is a claim with evidence rather than a hope.
 */
export interface SignInput {
  method: string;
  url: URL;
  headers: Record<string, string>;
  payload: Uint8Array;
  accessKey: string;
  secretKey: string;
  region: string;
  service: string;
  at: Date;
}

export function sha256Hex(payload: Uint8Array | string): string {
  return createHash('sha256').update(payload).digest('hex');
}

/** `20150830T123600Z`, which is the only date format any of this accepts. */
export function amzDate(at: Date): string {
  return `${at.toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`;
}

export function amzDay(at: Date): string {
  return amzDate(at).slice(0, 8);
}

export function canonicalRequest(input: {
  method: string;
  path: string;
  query: string;
  headers: Record<string, string>;
  payloadHash: string;
}): { request: string; signedHeaders: string } {
  // Names lowercased, values trimmed, sorted by name: the server rebuilds this
  // string from what it received, so any disagreement is a 403 with no clue.
  const entries = Object.entries(input.headers)
    .map(([name, value]) => [name.toLowerCase(), value.trim()] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const signedHeaders = entries.map(([name]) => name).join(';');

  return {
    request: [
      input.method,
      input.path,
      input.query,
      ...entries.map(([name, value]) => `${name}:${value}`),
      '',
      signedHeaders,
      input.payloadHash,
    ].join('\n'),
    signedHeaders,
  };
}

export function stringToSign(input: {
  at: Date;
  region: string;
  service: string;
  canonicalRequest: string;
}): string {
  return [
    ALGORITHM,
    amzDate(input.at),
    `${amzDay(input.at)}/${input.region}/${input.service}/aws4_request`,
    sha256Hex(input.canonicalRequest),
  ].join('\n');
}

/** The date-, region- and service-scoped key, so a leaked signature is narrow. */
export function signingKey(secretKey: string, at: Date, region: string, service: string): Buffer {
  const hmac = (key: Buffer | string, value: string): Buffer =>
    createHmac('sha256', key).update(value).digest();

  return hmac(hmac(hmac(hmac(`AWS4${secretKey}`, amzDay(at)), region), service), 'aws4_request');
}

/**
 * The headers a signed request needs, including the ones that are signed.
 *
 * `x-amz-content-sha256` is not optional for S3: the hash travels in the
 * signature *and* in a header, and omitting the header fails with a message
 * that does not mention it.
 */
export function signRequest(input: SignInput): Record<string, string> {
  const payloadHash = sha256Hex(input.payload);

  const headers: Record<string, string> = {
    ...input.headers,
    host: input.url.host,
    'x-amz-date': amzDate(input.at),
  };
  if (input.service === 's3') headers['x-amz-content-sha256'] = payloadHash;

  const canonical = canonicalRequest({
    method: input.method,
    path: input.url.pathname,
    query: canonicalQuery(input.url),
    headers,
    payloadHash,
  });

  const signature = createHmac(
    'sha256',
    signingKey(input.secretKey, input.at, input.region, input.service),
  )
    .update(
      stringToSign({
        at: input.at,
        region: input.region,
        service: input.service,
        canonicalRequest: canonical.request,
      }),
    )
    .digest('hex');

  const scope = `${amzDay(input.at)}/${input.region}/${input.service}/aws4_request`;

  return {
    ...headers,
    Authorization:
      `${ALGORITHM} Credential=${input.accessKey}/${scope}, ` +
      `SignedHeaders=${canonical.signedHeaders}, Signature=${signature}`,
  };
}

/** Parameters sorted by name, each encoded the way the signature expects. */
function canonicalQuery(url: URL): string {
  return [...url.searchParams.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `${encodeRfc3986(name)}=${encodeRfc3986(value)}`)
    .join('&');
}

/** `encodeURIComponent` leaves characters AWS wants encoded. */
function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
