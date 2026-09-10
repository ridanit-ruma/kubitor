import { describe, expect, it, vi } from 'vitest';
import {
  BACKUP_DOCUMENT,
  DEFAULT_SCHEDULE,
  EMPTY_BACKUP,
  EMPTY_NOTIFY,
  NOTIFY_DOCUMENT,
  parseBackup,
  parseNotify,
} from './documents.js';

const sealed = { cipher: 'age' as const, value: 'AAAA' };

describe('NOTIFY_DOCUMENT', () => {
  it('accepts a document with nothing configured', () => {
    expect(NOTIFY_DOCUMENT.safeParse(EMPTY_NOTIFY).success).toBe(true);
  });

  it('accepts every channel at once', () => {
    const document = {
      version: 1,
      minimumSeverity: 'critical',
      discord: { webhookUrl: sealed },
      slack: { webhookUrl: sealed },
      webhook: { url: sealed },
      telegram: { token: sealed, chatId: '12345' },
      ntfy: { server: 'https://ntfy.sh', topic: 'kubitor', token: sealed },
      gotify: { server: 'https://gotify.example.com', token: sealed },
      smtp: { url: sealed, from: 'kubitor@example.com', to: 'ops@example.com' },
    };

    expect(NOTIFY_DOCUMENT.safeParse(document).success).toBe(true);
  });

  it('refuses a half-configured Telegram, which sends nothing and says nothing', () => {
    expect(
      NOTIFY_DOCUMENT.safeParse({ ...EMPTY_NOTIFY, telegram: { token: sealed } }).success,
    ).toBe(false);
  });

  it('refuses an ntfy server that is not a URL', () => {
    const document = { ...EMPTY_NOTIFY, ntfy: { server: 'ntfy.sh', topic: 'kubitor' } };

    expect(NOTIFY_DOCUMENT.safeParse(document).success).toBe(false);
  });
});

describe('BACKUP_DOCUMENT', () => {
  it('accepts a schedule with no destination', () => {
    expect(BACKUP_DOCUMENT.safeParse(EMPTY_BACKUP).success).toBe(true);
  });

  it('defaults the schedule to the odd minute the environment used', () => {
    expect(EMPTY_BACKUP.schedule).toBe(DEFAULT_SCHEDULE);
    expect(DEFAULT_SCHEDULE).toBe('17 3 * * *');
  });

  it('accepts a complete destination', () => {
    const document = {
      version: 1,
      schedule: '17 3 * * *',
      ageRecipient: 'age1qqqq',
      destination: {
        endpoint: 'https://s3.eu-central-1.amazonaws.com',
        bucket: 'kubitor-backups',
        prefix: '',
        region: 'eu-central-1',
        accessKey: 'AKIA',
        secretKey: sealed,
      },
    };

    expect(BACKUP_DOCUMENT.safeParse(document).success).toBe(true);
  });

  it('refuses a destination with no secret key', () => {
    const document = {
      version: 1,
      schedule: '17 3 * * *',
      destination: {
        endpoint: 'https://s3.example.com',
        bucket: 'b',
        prefix: '',
        region: 'us-east-1',
        accessKey: 'AKIA',
      },
    };

    expect(BACKUP_DOCUMENT.safeParse(document).success).toBe(false);
  });
});

/**
 * The rule the ingest pipeline already follows, applied here: a bad row drops
 * that row, never the server. An operator with an unparseable document gets a
 * dashboard that starts and a log line saying so.
 */
describe('parsing a stored document', () => {
  it('returns the document when it is valid', () => {
    expect(parseNotify(EMPTY_NOTIFY)).toEqual(EMPTY_NOTIFY);
  });

  it('returns undefined rather than throwing on a document it cannot read', () => {
    expect(parseNotify({ version: 99 })).toBeUndefined();
    expect(parseBackup('not a document')).toBeUndefined();
  });

  it('says once, in the log, which document it could not read', () => {
    const log = vi.fn();

    parseNotify({ version: 99 }, log);

    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toContain('notify');
  });

  it('says nothing when there is nothing wrong', () => {
    const log = vi.fn();

    parseBackup(EMPTY_BACKUP, log);

    expect(log).not.toHaveBeenCalled();
  });
});
