import type { NotifyConfig } from '../config.js';
import { channelsFrom } from './build.js';
import type { ChannelBinding } from './dispatcher.js';

/**
 * The channels a live configuration names, rebuilt only when it changes.
 *
 * Compared by reference rather than by value, and deliberately: `SettingsService`
 * replaces the whole configuration object on every write, so identity is an
 * exact answer to "has anything changed" that costs nothing, where a deep
 * comparison would cost something on every dispatch and still be a guess.
 *
 * The rebuild matters because `channelsFrom` builds an SMTP transport, which is
 * a connection, not a value.
 *
 * A rebuild that throws keeps the bindings that were working and is retried on
 * the next call. What must not happen is the version this replaces: marking the
 * configuration as seen *before* building from it meant the first caller ate
 * the failure and every later one was served the pre-edit bindings for the life
 * of the process, with the dashboard showing the new settings and nothing
 * reporting the difference.
 */
export function channelSource(
  read: () => NotifyConfig,
  log?: (message: string) => void,
): () => readonly ChannelBinding[] {
  let seen: NotifyConfig | null = null;
  let reported: NotifyConfig | null = null;
  let bindings: readonly ChannelBinding[] = [];

  return () => {
    const current = read();
    if (current === seen) return bindings;

    try {
      bindings = channelsFrom(current, log);
      seen = current;
    } catch (error) {
      // `seen` is deliberately not advanced, so the next call tries again.
      // Logged once per configuration rather than per call, because the callers
      // here are a ten-second drain and every alert transition.
      if (current !== reported) {
        reported = current;
        log?.(
          `The notification channels could not be rebuilt; the previous ones are still in use: ${String(error)}`,
        );
      }
    }

    return bindings;
  };
}
