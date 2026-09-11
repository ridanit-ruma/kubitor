import type { NotifyConfig } from '../config.js';
import {
  discordChannel,
  gotifyChannel,
  ntfyChannel,
  slackChannel,
  telegramChannel,
  webhookChannel,
} from './channels.js';
import type { ChannelBinding } from './dispatcher.js';
import { emailChannel, smtpMailer } from './email.js';

/**
 * The channels a configuration names, in the order they were added.
 *
 * Returning an empty list is the normal case: notification is off until
 * somebody gives it somewhere to send, and a dispatcher with no channels
 * queues nothing rather than accumulating messages nobody will ever read.
 *
 * One channel that cannot be built drops that channel and nothing else — the
 * rule the ingest pipeline lives by, and the one `resolve.ts`'s `opener()`
 * already applies per field. A stored value that only nodemailer objects to
 * must not be able to take the other six channels, or the boot that reads
 * them, down with it.
 */
export function channelsFrom(
  config: NotifyConfig,
  log?: (message: string) => void,
): ChannelBinding[] {
  const bindings: ChannelBinding[] = [];
  const floor = config.minimumSeverity;

  if (config.discordWebhook) {
    bindings.push({ channel: discordChannel(config.discordWebhook), minimumSeverity: floor });
  }
  if (config.slackWebhook) {
    bindings.push({ channel: slackChannel(config.slackWebhook), minimumSeverity: floor });
  }
  if (config.telegram) {
    bindings.push({
      channel: telegramChannel(config.telegram.token, config.telegram.chatId),
      minimumSeverity: floor,
    });
  }
  if (config.ntfy) {
    bindings.push({
      channel: ntfyChannel(config.ntfy.server, config.ntfy.topic, config.ntfy.token),
      minimumSeverity: floor,
    });
  }
  if (config.gotify) {
    bindings.push({
      channel: gotifyChannel(config.gotify.server, config.gotify.token),
      minimumSeverity: floor,
    });
  }
  if (config.smtp) {
    // The transport is built here, once, rather than per message: reconnecting
    // for every alert is how a burst exhausts a mail server during exactly the
    // outage it is reporting.
    //
    // It is also the one channel whose construction can throw. `createTransport`
    // rejects anything that is not `smtp:` or `smtps:` — a URL saved before this
    // was validated, or seeded from an environment that never was, reaches here
    // as a `TypeError`. Dropping the channel and saying so is the answer; the
    // alternative already cost a boot loop nothing in the dashboard could fix.
    try {
      bindings.push({
        channel: emailChannel(smtpMailer(config.smtp), config.smtp.to),
        minimumSeverity: floor,
      });
    } catch (error) {
      log?.(
        `The email channel could not be built and is being ignored; check smtp.url under Settings: ${String(error)}`,
      );
    }
  }
  if (config.webhookUrl) {
    bindings.push({ channel: webhookChannel(config.webhookUrl), minimumSeverity: floor });
  }

  return bindings;
}
