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
 */
export function channelSource(read: () => NotifyConfig): () => readonly ChannelBinding[] {
  let seen: NotifyConfig | null = null;
  let bindings: readonly ChannelBinding[] = [];

  return () => {
    const current = read();
    if (current !== seen) {
      seen = current;
      bindings = channelsFrom(current);
    }
    return bindings;
  };
}
