import { isIP } from 'node:net';

/**
 * The caller's address, used to key login throttling and the audit trail.
 *
 * Only the configured header is trusted, and only its first entry: everything
 * after the first hop is attacker-controlled. Anything that is not an IP
 * literal is discarded rather than stored, so a forged header cannot smuggle
 * arbitrary text into the audit log or split the throttle key.
 */
export function clientIp(
  headers: Record<string, string | string[] | undefined>,
  trustedHeader: string,
  socketAddress: string | undefined,
): string {
  const raw = headers[trustedHeader.toLowerCase()];
  const header = Array.isArray(raw) ? raw[0] : raw;

  if (header) {
    const first = header.split(',')[0]?.trim();
    if (first && isIP(first) !== 0) return first;
  }

  if (socketAddress) {
    // Express reports IPv4-mapped IPv6 for dual-stack listeners.
    const normalized = socketAddress.startsWith('::ffff:')
      ? socketAddress.slice('::ffff:'.length)
      : socketAddress;
    if (isIP(normalized) !== 0) return normalized;
  }

  return 'unknown';
}
