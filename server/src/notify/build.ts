import type { NotifyConfig } from '../config.js';
import { discordChannel, slackChannel, telegramChannel, webhookChannel } from './channels.js';
import type { ChannelBinding } from './dispatcher.js';

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
  if (config.webhookUrl) {
    bindings.push({ channel: webhookChannel(config.webhookUrl), minimumSeverity: floor });
  }

  return bindings;
}
