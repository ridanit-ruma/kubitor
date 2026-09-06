import { createTransport } from 'nodemailer';
import { body, type Channel, headline } from './channel.js';

/**
 * What actually puts a message on the wire.
 *
 * Injected so a test does not need an SMTP server, and so the transport is
 * built once rather than per message: reconnecting for every alert is how a
 * burst exhausts a mail server's connection limit during exactly the outage it
 * is reporting. Add `?pool=true` to the URL to keep the connection as well.
 */
export interface Mailer {
  send(message: { to: string; subject: string; text: string }): Promise<void>;
}

export interface SmtpConfig {
  /** `smtps://user:pass@smtp.example.com:465`, which carries everything. */
  url: string;
  from: string;
  to: string;
}

export function smtpMailer(config: SmtpConfig): Mailer {
  // The URL carries host, port, credentials and whether TLS is implicit.
  const transport = createTransport(config.url);

  return {
    async send(message) {
      await transport.sendMail({
        from: config.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
      });
    },
  };
}

/**
 * Email, which is the channel that reaches people who are not in a chat app.
 *
 * The subject carries the whole alert on purpose: a phone's lock screen shows
 * the subject and nothing else, and a subject of "kubitor alert" would make
 * every message look the same at the moment somebody most needs them not to.
 */
export function emailChannel(mailer: Mailer, to: string): Channel {
  return {
    id: 'email',
    title: 'Email',
    async send(notification, deps) {
      await mailer.send({
        to,
        subject: headline(notification),
        text: body(notification, deps.baseUrl),
      });
    },
  };
}
