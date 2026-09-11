import type { NotifyInput, NotifyView } from '@kubitor/shared';
import { SECRET_KEPT } from '@kubitor/shared';

export type ChannelKey = keyof Omit<NotifyInput, 'minimumSeverity'>;

export interface ChannelField {
  /** The property inside the channel's object. */
  name: string;
  label: string;
  /** Redacted by the server, and never rendered back into a value. */
  secret: boolean;
  /** Without it the channel is off. */
  required: boolean;
  placeholder: string;
}

export interface ChannelDescriptor {
  key: ChannelKey;
  /**
   * What the server calls the channel it builds from this.
   *
   * Not always the document key: `smtp` becomes a channel called `email`. The
   * test button sends to this id, so the mapping is written down here rather
   * than guessed at the call site.
   */
  id: string;
  title: string;
  fields: readonly ChannelField[];
  /** Where somebody gets the value, shown under the card. */
  hint: string;
}

const secret = (name: string, label: string, placeholder: string): ChannelField => ({
  name,
  label,
  secret: true,
  required: true,
  placeholder,
});

const plain = (
  name: string,
  label: string,
  placeholder: string,
  required = true,
): ChannelField => ({ name, label, secret: false, required, placeholder });

export const CHANNELS: readonly ChannelDescriptor[] = [
  {
    key: 'discord',
    id: 'discord',
    title: 'Discord',
    fields: [secret('webhookUrl', 'Webhook URL', 'https://discord.com/api/webhooks/...')],
    hint: 'Channel settings → Integrations → Webhooks → New Webhook.',
  },
  {
    key: 'slack',
    id: 'slack',
    title: 'Slack',
    fields: [secret('webhookUrl', 'Webhook URL', 'https://hooks.slack.com/services/...')],
    hint: 'Create an app, turn on Incoming Webhooks, add one to a channel.',
  },
  {
    key: 'telegram',
    id: 'telegram',
    title: 'Telegram',
    fields: [
      secret('token', 'Bot token', '123456:ABC-DEF...'),
      plain('chatId', 'Chat ID', '-1001234567890'),
    ],
    hint: 'The chat ID is not in the token. Message the bot, then read getUpdates.',
  },
  {
    key: 'ntfy',
    id: 'ntfy',
    title: 'ntfy',
    fields: [
      plain('server', 'Server', 'https://ntfy.sh'),
      plain('topic', 'Topic', 'kubitor-alerts'),
      { ...secret('token', 'Access token', 'tk_...'), required: false },
    ],
    hint: 'Push without a vendor. Self-host it, or use ntfy.sh.',
  },
  {
    key: 'gotify',
    id: 'gotify',
    title: 'Gotify',
    fields: [
      plain('server', 'Server', 'https://gotify.example.com'),
      secret('token', 'Application token', 'A...'),
    ],
    hint: 'Create an application in Gotify; its token is what posts messages.',
  },
  {
    key: 'smtp',
    id: 'email',
    title: 'Email',
    fields: [
      secret('url', 'SMTP URL', 'smtps://user:pass@smtp.example.com:465'),
      plain('from', 'From', 'kubitor@example.com'),
      plain('to', 'To', 'ops@example.com'),
    ],
    hint: 'The URL carries host, port, credentials and whether TLS is implicit.',
  },
  {
    key: 'webhook',
    id: 'webhook',
    title: 'Webhook',
    fields: [secret('url', 'URL', 'https://example.com/hook')],
    hint: 'Receives the raw alert as JSON, for anything not listed above.',
  },
];

/** The editable half of what the server returned; exactly what a save sends back. */
export function toInput(view: NotifyView): NotifyInput {
  const { canStoreSecrets: _ignored, ...input } = view;
  return input;
}

/**
 * Whether a channel has enough in it to send anything.
 *
 * A secret counts as filled when it is the sentinel, because that is what a
 * stored secret looks like from here — the server never shows the value, and a
 * card that read "not configured" over a working webhook would be worse than no
 * card at all.
 */
export function isConfigured(input: NotifyInput, key: ChannelKey): boolean {
  const descriptor = CHANNELS.find((channel) => channel.key === key);
  if (!descriptor) return false;

  const values = input[key] as Record<string, string | null>;

  return descriptor.fields
    .filter((field) => field.required)
    .every((field) => {
      const value = values[field.name];
      return value !== null && value !== undefined && value !== '';
    });
}

export { SECRET_KEPT };
