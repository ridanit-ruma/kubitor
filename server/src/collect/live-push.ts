import type { LiveNodeMetrics } from './live-cache.js';

/** Everything the socket may carry. */
export type LiveFrame =
  | {
      topic: 'metrics.current';
      /** When the newest reading in this frame was taken. */
      sampledAt: number | null;
      /** When the server built the frame, so the client can show a real age. */
      generatedAt: number;
      nodes: LiveNodeMetrics[];
    }
  | { topic: 'capabilities'; generatedAt: number }
  /** The payload was too large to push; refetch over REST instead. */
  | { topic: string; generatedAt: number; signalOnly: true };

/**
 * A frame above this size is not pushed.
 *
 * One very large cluster would otherwise turn every connected socket into a
 * firehose. The client is told to refetch instead, which it can do with
 * filters and pagination that the push cannot.
 */
export const MAX_FRAME_BYTES = 64 * 1024;

export interface FramedResult {
  json: string;
  /** True when the frame was replaced by an invalidation signal. */
  degraded: boolean;
}

export function frameMetrics(nodes: readonly LiveNodeMetrics[], generatedAt: number): FramedResult {
  const sampledAt = nodes.length === 0 ? null : Math.max(...nodes.map((n) => n.sampledAt));

  const frame: LiveFrame = {
    topic: 'metrics.current',
    sampledAt,
    generatedAt,
    nodes: [...nodes],
  };

  const json = JSON.stringify(frame);
  if (json.length <= MAX_FRAME_BYTES) return { json, degraded: false };

  return {
    json: JSON.stringify({ topic: 'metrics.current', generatedAt, signalOnly: true }),
    degraded: true,
  };
}
