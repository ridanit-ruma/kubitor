import type { LiveHostDetail, LiveNodeMetrics } from './live-cache.js';

/** Everything the socket may carry. */
export type LiveFrame =
  | {
      topic: 'metrics.current';
      /** When the newest reading in this frame was taken. */
      sampledAt: number | null;
      /** When the server built the frame, so the client can show a real age. */
      generatedAt: number;
      nodes: LiveNodeMetrics[];
      /** Present only for the one node this client asked to watch. */
      detail?: { node: string } & LiveHostDetail;
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

export function frameMetrics(
  nodes: readonly LiveNodeMetrics[],
  generatedAt: number,
  detail?: ({ node: string } & LiveHostDetail) | null,
): FramedResult {
  const sampledAt = newestReading(nodes);

  const frame: LiveFrame = {
    topic: 'metrics.current',
    sampledAt,
    generatedAt,
    nodes: [...nodes],
    ...(detail ? { detail } : {}),
  };

  const json = JSON.stringify(frame);
  if (json.length <= MAX_FRAME_BYTES) return { json, degraded: false };

  return {
    json: JSON.stringify({ topic: 'metrics.current', generatedAt, signalOnly: true }),
    degraded: true,
  };
}

/**
 * When the newest thing in this frame was measured.
 *
 * Both sources count. The kubelet's instant alone is up to five seconds old
 * while the agent's figures beside it are one second old, and a screen that
 * keys its history on this number then advanced once every five seconds while
 * claiming to move every second.
 */
function newestReading(nodes: readonly LiveNodeMetrics[]): number | null {
  let newest: number | null = null;

  for (const node of nodes) {
    for (const at of [node.sampledAt, node.host?.sampledAt]) {
      if (at !== undefined && (newest === null || at > newest)) newest = at;
    }
  }

  return newest;
}
