import { body, type Channel, type ChannelDeps, headline, type Notification } from './channel.js';

/**
 * A channel that is one HTTP POST.
 *
 * Discord, Slack and a plain webhook differ only in the JSON they want, which
 * is why they are one function here and not three modules. Everything harder
 * than this — SMTP, push with its own protocol — earns a module of its own.
 */
function posting(
  id: string,
  title: string,
  url: string,
  shape: (notification: Notification, deps: ChannelDeps) => unknown,
): Channel {
  return {
    id,
    title,
    async send(notification, deps) {
      const response = await deps.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(shape(notification, deps)),
      });

      // Anything but success has to throw: the queue retries on a throw, and a
      // channel that returned quietly on a 429 would drop the message that
      // rate limit was asking it to send again.
      if (!response.ok) {
        throw new Error(
          `${title} answered ${response.status}: ${(await response.text()).slice(0, 200)}`,
        );
      }
    },
  };
}

/** Discord's incoming webhook. `content` is the whole of the contract. */
export function discordChannel(url: string): Channel {
  return posting('discord', 'Discord', url, (notification, deps) => ({
    content: `**${headline(notification)}**\n${body(notification, deps.baseUrl)}`,
  }));
}

/** Slack's incoming webhook, which wants the same thing in its own dialect. */
export function slackChannel(url: string): Channel {
  return posting('slack', 'Slack', url, (notification, deps) => ({
    text: `*${headline(notification)}*\n${body(notification, deps.baseUrl)}`,
  }));
}

/**
 * Telegram, which is a bot API rather than a webhook.
 *
 * The chat id is not discoverable from the token: a bot has to be spoken to
 * first, and the id comes from `getUpdates`. The docs say so where the token is
 * entered, because otherwise this is where people get stuck.
 */
export function telegramChannel(token: string, chatId: string): Channel {
  return posting(
    'telegram',
    'Telegram',
    `https://api.telegram.org/bot${token}/sendMessage`,
    (notification, deps) => ({
      chat_id: chatId,
      text: `${headline(notification)}\n${body(notification, deps.baseUrl)}`,
      disable_notification: notification.kind === 'resolved',
    }),
  );
}

/**
 * A plain webhook, for everything else.
 *
 * The whole alert, as JSON, unformatted. Anyone with a receiver of their own —
 * ntfy, Gotify, a Notion proxy, a script — starts here rather than waiting for
 * a module.
 */
export function webhookChannel(url: string): Channel {
  return posting('webhook', 'Webhook', url, (notification) => ({
    kind: notification.kind,
    alert: notification.alert,
  }));
}
