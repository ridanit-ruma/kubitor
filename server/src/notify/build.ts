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
 */
export function channelsFrom(config: NotifyConfig): ChannelBinding[] {
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
    bindings.push({
      channel: emailChannel(smtpMailer(config.smtp), config.smtp.to),
      minimumSeverity: floor,
    });
  }
  if (config.webhookUrl) {
    bindings.push({ channel: webhookChannel(config.webhookUrl), minimumSeverity: floor });
  }

  return bindings;
}
