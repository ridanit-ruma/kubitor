/**
 * Parses Traefik's JSON access log.
 *
 * Field names are taken from a real Traefik 41.x log line, not from the docs:
 * `Duration` is nanoseconds, `ClientHost` is the proxy's own pod address, and
 * the caller's real address arrives in `request_Cf-Connecting-Ip` when a tunnel
 * or CDN sits in front.
 *
 * The chart only emits this when configured with a **top-level `accessLog:`
 * key**. `logs.access` looks plausible, validates, and is silently ignored —
 * which cost the previous build hours of looking for a collector bug that was
 * really a missing log.
 */
export interface AccessRow {
  at: number;
  host: string;
  method: string;
  path: string;
  status: number;
  duration_ms: number;
  client_ip: string;
  user_agent: string | null;
  route: string | null;
  service: string | null;
  bytes_out: number | null;
  attrs: Record<string, unknown>;
}

export function parseAccessLine(line: string): AccessRow | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;

  let document: Record<string, unknown>;
  try {
    document = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    // A truncated or non-JSON line is skipped. Traefik also logs plain-text
    // startup messages to the same stream.
    return null;
  }

  const host = str(document.RequestHost) ?? str(document.RequestAddr);
  const method = str(document.RequestMethod);
  const path = str(document.RequestPath);
  const status = num(document.DownstreamStatus);
  if (!host || !method || !path || status === null) return null;

  const durationNs = num(document.Duration);

  return {
    at: time(document),
    host,
    method,
    path,
    status,
    duration_ms: durationNs === null ? 0 : Math.round(durationNs / 1_000_000),
    // ClientHost is whatever connected to Traefik, which behind a tunnel is the
    // tunnel. The forwarded header is the actual caller.
    client_ip: str(document['request_Cf-Connecting-Ip']) ?? str(document.ClientHost) ?? 'unknown',
    user_agent: str(document['request_User-Agent']),
    route: str(document.RouterName),
    service: str(document.ServiceName),
    bytes_out: num(document.DownstreamContentSize),
    attrs: {
      entryPoint: str(document.entryPointName),
      scheme: str(document.RequestScheme),
      protocol: str(document.RequestProtocol),
      retries: num(document.RetryAttempts),
    },
  };
}

function time(document: Record<string, unknown>): number {
  for (const key of ['StartUTC', 'StartLocal', 'time']) {
    const value = document[key];
    if (typeof value !== 'string') continue;
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return Date.now();
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value !== '-' ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
