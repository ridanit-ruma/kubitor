import { describe, expect, it } from 'vitest';
import { parseListing, S3Client, S3Error } from './s3.js';

const AT = new Date('2026-09-06T03:17:00Z');

const CONFIG = {
  endpoint: 'https://s3.example.com',
  bucket: 'kubitor-backups',
  prefix: 'myu/',
  accessKey: 'AKIDEXAMPLE',
  secretKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  region: 'eu-central-1',
};

function recording(response: () => Response) {
  const calls: { url: string; method: string; headers: Record<string, string> }[] = [];

  const fake: typeof globalThis.fetch = async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return response();
  };

  return { calls, client: new S3Client({ config: CONFIG, fetch: fake, now: () => AT }) };
}

const ok = () => new Response('', { status: 200 });
const okFetch: typeof globalThis.fetch = async () => ok();

describe('key', () => {
  it('puts the object under the configured prefix', () => {
    const { client } = recording(ok);
    expect(client.key('2026-09-06.db.age')).toBe('myu/2026-09-06.db.age');
  });

  it('tolerates a prefix written with or without slashes', () => {
    const client = new S3Client({
      config: { ...CONFIG, prefix: '/a/b/' },
      fetch: okFetch,
      now: () => AT,
    });
    expect(client.key('x')).toBe('a/b/x');
  });

  it('takes no prefix at all', () => {
    const client = new S3Client({
      config: { ...CONFIG, prefix: '' },
      fetch: okFetch,
      now: () => AT,
    });
    expect(client.key('x')).toBe('x');
  });
});

describe('put', () => {
  /** MinIO and Ceph RGW are reached this way, and AWS accepts it. */
  it('addresses the bucket in the path, not in the host', async () => {
    const { calls, client } = recording(ok);
    await client.put(
      client.key('backup.db'),
      new Uint8Array([1, 2, 3]),
      'application/octet-stream',
    );

    expect(calls[0]?.url).toBe('https://s3.example.com/kubitor-backups/myu/backup.db');
    expect(calls[0]?.method).toBe('PUT');
  });

  it('signs the request and carries the payload hash S3 requires', async () => {
    const { calls, client } = recording(ok);
    await client.put('k', new Uint8Array([1]), 'application/octet-stream');

    expect(calls[0]?.headers.Authorization).toContain('AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/');
    expect(calls[0]?.headers.Authorization).toContain('/eu-central-1/s3/aws4_request');
    expect(calls[0]?.headers['x-amz-content-sha256']).toHaveLength(64);
  });

  /**
   * The status alone never says why: a 403 is a wrong key, a wrong region, a
   * skewed clock or a bucket policy, and only the body distinguishes them.
   */
  it("reports the provider's own reason for a refusal", async () => {
    const { client } = recording(
      () =>
        new Response(
          '<Error><Code>SignatureDoesNotMatch</Code><Message>The request signature we calculated does not match</Message></Error>',
          { status: 403 },
        ),
    );

    await expect(client.put('k', new Uint8Array(), 'text/plain')).rejects.toThrow(
      /SignatureDoesNotMatch/,
    );
    await expect(client.put('k', new Uint8Array(), 'text/plain')).rejects.toBeInstanceOf(S3Error);
  });
});

describe('get', () => {
  it('returns the bytes it was given', async () => {
    const { client } = recording(() => new Response(new Uint8Array([7, 8, 9]), { status: 200 }));
    expect([...(await client.get('k'))]).toEqual([7, 8, 9]);
  });

  it('reports a missing object rather than an empty one', async () => {
    const { client } = recording(
      () => new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 }),
    );
    await expect(client.get('k')).rejects.toThrow(/NoSuchKey/);
  });
});

describe('list', () => {
  it('asks for the configured prefix', async () => {
    const { calls, client } = recording(() => new Response('<ListBucketResult/>', { status: 200 }));
    await client.list();

    expect(calls[0]?.url).toContain('list-type=2');
    expect(calls[0]?.url).toContain('prefix=myu%2F');
  });
});

describe('parseListing', () => {
  it('reads each object out of the response', () => {
    const listing = parseListing(`<?xml version="1.0"?>
      <ListBucketResult>
        <Contents><Key>myu/a.db.age</Key><Size>1024</Size><LastModified>2026-09-05T03:17:01.000Z</LastModified></Contents>
        <Contents><Key>myu/b.db.age</Key><Size>2048</Size><LastModified>2026-09-06T03:17:02.000Z</LastModified></Contents>
      </ListBucketResult>`);

    expect(listing).toEqual([
      { key: 'myu/a.db.age', bytes: 1024, modifiedAt: '2026-09-05T03:17:01.000Z' },
      { key: 'myu/b.db.age', bytes: 2048, modifiedAt: '2026-09-06T03:17:02.000Z' },
    ]);
  });

  it('reads an empty bucket as no objects, not as a failure', () => {
    expect(parseListing('<ListBucketResult/>')).toEqual([]);
  });
});
