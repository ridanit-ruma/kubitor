import { describe, expect, it } from 'vitest';
import { canonicalRequest, signingKey, signRequest, stringToSign } from './sigv4.js';

/**
 * AWS publishes a signing test suite so implementations can prove themselves
 * against the same bytes. `get-vanilla` is its simplest case, and it pins every
 * step: the canonical request, the string to sign and the final header.
 */
const VECTOR = {
  accessKey: 'AKIDEXAMPLE',
  secretKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
  service: 'service',
  at: new Date('2015-08-30T12:36:00Z'),
};

describe('canonicalRequest', () => {
  it('matches the published get-vanilla canonical request', () => {
    const canonical = canonicalRequest({
      method: 'GET',
      path: '/',
      query: '',
      headers: { host: 'example.amazonaws.com', 'x-amz-date': '20150830T123600Z' },
      payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    });

    expect(canonical.request).toBe(
      [
        'GET',
        '/',
        '',
        'host:example.amazonaws.com',
        'x-amz-date:20150830T123600Z',
        '',
        'host;x-amz-date',
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      ].join('\n'),
    );
    expect(canonical.signedHeaders).toBe('host;x-amz-date');
  });

  /** Header names are lowercased and sorted, whatever the caller passed. */
  it('normalizes and orders the headers it signs', () => {
    const canonical = canonicalRequest({
      method: 'PUT',
      path: '/bucket/key',
      query: '',
      headers: { 'X-Amz-Date': '20150830T123600Z', Host: 'h', 'Content-Type': 'text/plain' },
      payloadHash: 'abc',
    });

    expect(canonical.signedHeaders).toBe('content-type;host;x-amz-date');
  });
});

describe('stringToSign', () => {
  it('matches the published get-vanilla string to sign', () => {
    const value = stringToSign({
      at: VECTOR.at,
      region: VECTOR.region,
      service: VECTOR.service,
      canonicalRequest: [
        'GET',
        '/',
        '',
        'host:example.amazonaws.com',
        'x-amz-date:20150830T123600Z',
        '',
        'host;x-amz-date',
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      ].join('\n'),
    });

    expect(value.split('\n').slice(0, 3)).toEqual([
      'AWS4-HMAC-SHA256',
      '20150830T123600Z',
      '20150830/us-east-1/service/aws4_request',
    ]);
  });
});

describe('signingKey', () => {
  /**
   * There is no published vector for this intermediate on its own, and pasting
   * whatever the function returned would assert nothing. What matters about the
   * key is the property it exists for: it is scoped, so a signature that leaks
   * is good for one day, one region and one service. `get-vanilla` below is
   * what proves the derivation itself.
   */
  it('is scoped to the day, the region and the service', () => {
    const base = signingKey(VECTOR.secretKey, VECTOR.at, VECTOR.region, VECTOR.service);
    const nextDay = signingKey(
      VECTOR.secretKey,
      new Date('2015-08-31T12:36:00Z'),
      VECTOR.region,
      VECTOR.service,
    );
    const elsewhere = signingKey(VECTOR.secretKey, VECTOR.at, 'eu-west-1', VECTOR.service);
    const otherService = signingKey(VECTOR.secretKey, VECTOR.at, VECTOR.region, 's3');

    const keys = [base, nextDay, elsewhere, otherService].map((key) => key.toString('hex'));
    expect(new Set(keys).size).toBe(4);
    expect(base).toHaveLength(32);
  });
});

describe('signRequest', () => {
  it('produces the published get-vanilla Authorization header', () => {
    const headers = signRequest({
      method: 'GET',
      url: new URL('https://example.amazonaws.com/'),
      headers: {},
      payload: new Uint8Array(),
      ...VECTOR,
    });

    expect(headers.Authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, ' +
        'SignedHeaders=host;x-amz-date, ' +
        'Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    );
  });

  /**
   * S3 requires the payload hash as a header, not only inside the signature —
   * without it a PUT is rejected with a message that does not say so.
   */
  it('carries the payload hash S3 insists on', () => {
    const headers = signRequest({
      method: 'PUT',
      url: new URL('https://s3.example.com/bucket/key'),
      headers: {},
      payload: new TextEncoder().encode('hello'),
      ...VECTOR,
      service: 's3',
    });

    expect(headers['x-amz-content-sha256']).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
    expect(headers['x-amz-date']).toBe('20150830T123600Z');
  });

  it('signs the query string it was given', () => {
    const withQuery = signRequest({
      method: 'GET',
      url: new URL('https://s3.example.com/bucket?list-type=2&prefix=a%2Fb'),
      headers: {},
      payload: new Uint8Array(),
      ...VECTOR,
      service: 's3',
    });
    const without = signRequest({
      method: 'GET',
      url: new URL('https://s3.example.com/bucket'),
      headers: {},
      payload: new Uint8Array(),
      ...VECTOR,
      service: 's3',
    });

    expect(withQuery.Authorization).not.toBe(without.Authorization);
  });
});
