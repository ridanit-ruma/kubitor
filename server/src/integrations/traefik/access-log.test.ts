import { describe, expect, it } from 'vitest';
import { parseAccessLine } from './access-log.js';

/** Captured verbatim from Traefik 41.x running behind a Cloudflare tunnel. */
const REAL_LINE = JSON.stringify({
  ClientAddr: '10.244.0.223:46700',
  ClientHost: '10.244.0.223',
  DownstreamContentSize: 4521,
  DownstreamStatus: 200,
  Duration: 6_479_116,
  KubernetesIngressName: 'kubitor',
  RequestAddr: 'kubitor.myuyayam.dev',
  RequestHost: 'kubitor.myuyayam.dev',
  RequestMethod: 'GET',
  RequestPath: '/_next/static/chunks/app/login/page.js',
  RequestProtocol: 'HTTP/1.1',
  RequestScheme: 'http',
  RetryAttempts: 0,
  RouterName: 'kubitor-kubitor-kubitor-myuyayam-dev@kubernetes',
  ServiceName: 'kubitor-kubitor-client-3000@kubernetes',
  StartUTC: '2026-09-03T04:18:47.74852693Z',
  entryPointName: 'web',
  level: 'info',
  'request_Cf-Connecting-Ip': '2001:2d8:6bb4:8c60:610f:c320:d925:f5bd',
  'request_User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) Chrome/152.0.0.0',
  time: '2026-09-03T04:18:47Z',
});

describe('parseAccessLine', () => {
  it('reads a real Traefik access line', () => {
    const row = parseAccessLine(REAL_LINE);

    expect(row?.host).toBe('kubitor.myuyayam.dev');
    expect(row?.method).toBe('GET');
    expect(row?.path).toBe('/_next/static/chunks/app/login/page.js');
    expect(row?.status).toBe(200);
    expect(row?.bytes_out).toBe(4521);
    expect(row?.route).toBe('kubitor-kubitor-kubitor-myuyayam-dev@kubernetes');
  });

  it('converts the nanosecond duration to milliseconds', () => {
    expect(parseAccessLine(REAL_LINE)?.duration_ms).toBe(6);
  });

  it('uses the kubelet-independent start time, not the moment it was read', () => {
    expect(parseAccessLine(REAL_LINE)?.at).toBe(Date.parse('2026-09-03T04:18:47.74852693Z'));
  });

  /**
   * `ClientHost` behind a tunnel is the tunnel's own pod address, which would
   * make every request in the cluster look like it came from one machine.
   */
  it('prefers the forwarded address over the proxy pod address', () => {
    expect(parseAccessLine(REAL_LINE)?.client_ip).toBe('2001:2d8:6bb4:8c60:610f:c320:d925:f5bd');
  });

  it('falls back to the connecting address when nothing was forwarded', () => {
    const direct = JSON.parse(REAL_LINE);
    delete direct['request_Cf-Connecting-Ip'];

    expect(parseAccessLine(JSON.stringify(direct))?.client_ip).toBe('10.244.0.223');
  });

  it('skips a plain-text line rather than throwing', () => {
    expect(parseAccessLine('time="2026-09-03" level=info msg="Configuration loaded"')).toBeNull();
  });

  it('skips a truncated line', () => {
    expect(parseAccessLine(REAL_LINE.slice(0, 120))).toBeNull();
  });

  it('skips a line missing the fields a request is made of', () => {
    expect(parseAccessLine(JSON.stringify({ level: 'info', msg: 'hello' }))).toBeNull();
  });

  it('skips an empty line', () => {
    expect(parseAccessLine('')).toBeNull();
    expect(parseAccessLine('   ')).toBeNull();
  });

  it('treats Traefik’s "-" placeholder as absent', () => {
    const anonymous = { ...JSON.parse(REAL_LINE), RouterName: '-', 'request_User-Agent': '-' };

    const row = parseAccessLine(JSON.stringify(anonymous));
    expect(row?.route).toBeNull();
    expect(row?.user_agent).toBeNull();
  });

  /** Scanner traffic is the norm on any public host; it must parse, not crash. */
  it('parses a scanner probe for a dotfile', () => {
    const probe = {
      ...JSON.parse(REAL_LINE),
      RequestPath: '/.env',
      DownstreamStatus: 404,
      RouterName: undefined,
    };

    const row = parseAccessLine(JSON.stringify(probe));
    expect(row?.path).toBe('/.env');
    expect(row?.status).toBe(404);
  });
});
