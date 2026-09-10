/**
 * What a secret reads as when it is set.
 *
 * `GET` never returns a secret; it returns this in place of one. `PUT` accepts
 * it back to mean "leave the stored value alone". The invariant worth holding
 * on to: the body `GET` returns is a valid `PUT` body, and sending it back
 * unchanged changes nothing. That is what lets a form save a field it was never
 * allowed to display without erasing it.
 *
 * Anything else is a new value. `null` and the empty string both clear it.
 */
export const SECRET_KEPT = '__unchanged__';

/**
 * Notification settings as the dashboard sees them.
 *
 * Every channel is present whether or not it is configured, with empty strings
 * where it is not, so the form has one shape to render and the request body has
 * one shape to validate. A channel is on when its required fields are filled.
 */
export interface NotifyView {
  minimumSeverity: 'critical' | 'warning';
  discord: { webhookUrl: string | null };
  slack: { webhookUrl: string | null };
  webhook: { url: string | null };
  telegram: { token: string | null; chatId: string };
  ntfy: { server: string; topic: string; token: string | null };
  gotify: { server: string; token: string | null };
  smtp: { url: string | null; from: string; to: string };
  /**
   * Whether `KUBITOR_SETTINGS_KEY` is set. Without it a secret cannot be
   * written, and the screen says so rather than letting somebody type a token
   * into a field that will refuse it.
   */
  canStoreSecrets: boolean;
}

export type NotifyInput = Omit<NotifyView, 'canStoreSecrets'>;

/** Backup settings as the dashboard sees them. The identity is never here. */
export interface BackupView {
  schedule: string;
  /** The public half. Empty means backups are written unencrypted. */
  ageRecipient: string;
  destination: {
    endpoint: string;
    bucket: string;
    prefix: string;
    region: string;
    /** An identifier, like a username. The secret key is the credential. */
    accessKey: string;
    secretKey: string | null;
  };
  canStoreSecrets: boolean;
}

export type BackupInput = Omit<BackupView, 'canStoreSecrets'>;
