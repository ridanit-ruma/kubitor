export interface SendResult {
  /** Whether the buffer should move past these rows. */
  advance: boolean;
  status: number | null;
}

/**
 * Decides what to do with a batch given the server's answer.
 *
 * The rule, and the reason this is a separate tested function: **advance on
 * 4xx**. A client that only advances on success wedges permanently the first
 * time the server refuses a row, and anyone able to make one row malformed can
 * silence that node forever. Only 429, 5xx and network failures are worth
 * retrying — they are the ones that will succeed later.
 */
export function decideRetry(status: number | null): SendResult {
  if (status === null) return { advance: false, status };
  if (status === 429) return { advance: false, status };
  if (status >= 500) return { advance: false, status };
  return { advance: true, status };
}

/**
 * How the sender obtains its credential.
 *
 * A function rather than a string because a projected service-account token is
 * rotated on disk by the kubelet; an agent that read it once would start
 * failing with 401s some hours after it started.
 */
export type TokenSource = string | (() => Promise<string | null>);

export interface SenderOptions {
  endpoint: string;
  token: TokenSource;
  /** Rows kept while the server is unreachable, oldest dropped first. */
  maxBuffered: number;
  fetchImpl?: typeof fetch;
}

export class Sender {
  readonly #options: SenderOptions;
  readonly #buffer: Record<string, unknown>[] = [];
  readonly #fetch: typeof fetch;

  constructor(options: SenderOptions) {
    this.#options = options;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  enqueue(row: Record<string, unknown>): void {
    this.#buffer.push(row);
    // A node that cannot reach the server must not grow until it is killed.
    while (this.#buffer.length > this.#options.maxBuffered) this.#buffer.shift();
  }

  get pending(): number {
    return this.#buffer.length;
  }

  async #token(): Promise<string | null> {
    const source = this.#options.token;
    return typeof source === 'string' ? source : await source();
  }

  async flush(): Promise<SendResult> {
    if (this.#buffer.length === 0) return { advance: true, status: null };

    const rows = [...this.#buffer];
    let status: number | null = null;

    const token = await this.#token();
    // No credential is a condition that resolves itself once the token is
    // mounted, so the rows are held rather than dropped.
    if (token === null) return { advance: false, status: null };

    try {
      const response = await this.#fetch(this.#options.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ rows }),
      });
      status = response.status;
    } catch {
      status = null;
    }

    const result = decideRetry(status);
    if (result.advance) this.#buffer.splice(0, rows.length);
    return result;
  }
}
