'use client';

import { useEffect, useRef, useState } from 'react';
import { api, type LiveHostDetail, type LiveNodeMetrics } from './api';

export interface LiveState {
  nodes: LiveNodeMetrics[];
  /** When the newest reading was taken by its source — not when it arrived. */
  sampledAt: number | null;
  connected: boolean;
  /**
   * Per-device readings for the node this hook was asked to watch.
   *
   * Sensors, interface throughput and disk throughput belong here rather than
   * in the stored snapshot: they change every second, and reaching a screen
   * through a row rewritten every fifteen made them look frozen next to
   * figures that moved.
   */
  detail: LiveHostDetail | null;
}

interface Frame {
  topic: string;
  sampledAt?: number | null;
  generatedAt: number;
  nodes?: LiveNodeMetrics[];
  detail?: LiveHostDetail;
  signalOnly?: true;
}

/** Backs off rather than hammering a server that is restarting. */
const RECONNECT_MS = [500, 1000, 2000, 5000, 10_000];
/**
 * Fallback polling, used only while the socket is down.
 *
 * It backs off as well. A flat five-second poll that never widens turns one
 * dropped connection into hundreds of requests an hour, every one of which
 * lands in the cluster's own access log and buries the traffic worth reading.
 */
const FALLBACK_POLL_MS = [2000, 5000, 15_000];

/**
 * Live metrics over the WebSocket, with REST as the fallback.
 *
 * The socket carries the data itself rather than a "something changed" nudge,
 * so there is nothing to re-request on each tick. When a frame is too large the
 * server sends `signalOnly` instead, and this refetches over REST — where
 * filters and pagination exist.
 *
 * Everything stops while the tab is hidden. A dashboard left open on a phone
 * would otherwise poll all night for a screen nobody is looking at.
 */
export function useLiveMetrics(watch?: string): LiveState {
  const [state, setState] = useState<LiveState>({
    nodes: [],
    sampledAt: null,
    connected: false,
    detail: null,
  });
  const attempt = useRef(0);
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let pollStep = 0;
    let disposed = false;

    const refetch = async (): Promise<void> => {
      try {
        const current = await api.currentMetrics();
        if (disposed) return;
        setState((previous) => ({
          ...previous,
          nodes: current.nodes,
          sampledAt: newest(current.nodes),
          // REST carries no per-device readings. Dropping them sends the node
          // screen back to the stored snapshot, which is stale but honest.
          detail: null,
        }));
      } catch {
        // Losing one poll is not worth surfacing; the age indicator already
        // shows the reading going stale.
      }
    };

    const schedulePoll = (): void => {
      if (disposed || document.hidden) return;
      const delay = FALLBACK_POLL_MS[Math.min(pollStep, FALLBACK_POLL_MS.length - 1)] ?? 15_000;
      pollStep += 1;
      pollTimer = setTimeout(() => {
        void refetch().finally(schedulePoll);
      }, delay);
    };

    const startPolling = (): void => {
      if (pollTimer) return;
      void refetch();
      schedulePoll();
    };

    const stopPolling = (): void => {
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = undefined;
      pollStep = 0;
    };

    const connect = (): void => {
      if (disposed || document.hidden) return;

      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(`${protocol}://${window.location.host}/api/ws`);
      socketRef.current = socket;

      socket.onopen = () => {
        attempt.current = 0;
        stopPolling();
        setState((previous) => ({ ...previous, connected: true }));
      };

      socket.onmessage = (event) => {
        const frame = JSON.parse(String(event.data)) as Frame;

        // Answering in data rather than a control frame, because a proxy that
        // drops WebSocket pings would otherwise let the server conclude this
        // client is gone.
        if (frame.topic === 'ping') {
          socket?.send(JSON.stringify({ type: 'pong' }));
          return;
        }

        if (frame.topic !== 'metrics.current') return;

        if (frame.signalOnly) {
          void refetch();
          return;
        }

        setState((previous) => ({
          ...previous,
          nodes: frame.nodes ?? [],
          sampledAt: frame.sampledAt ?? null,
          connected: true,
          // A frame with no detail is one for a client watching nothing, or a
          // node whose agent has gone quiet; either way the last detail is no
          // longer current and must not stay on screen.
          detail: frame.detail ?? null,
        }));
      };

      const retry = (): void => {
        setState((previous) => ({ ...previous, connected: false }));
        startPolling();

        if (disposed || document.hidden) return;
        const delay = RECONNECT_MS[Math.min(attempt.current, RECONNECT_MS.length - 1)] ?? 10_000;
        attempt.current += 1;
        reconnectTimer = setTimeout(connect, delay);
      };

      socket.onclose = retry;
      socket.onerror = () => socket?.close();
    };

    const onVisibility = (): void => {
      if (document.hidden) {
        stopPolling();
        if (reconnectTimer) clearTimeout(reconnectTimer);
        socket?.close();
        socket = null;
        return;
      }

      // Coming back should feel instant, not like waiting out a backoff.
      attempt.current = 0;
      if (socket === null || socket.readyState === WebSocket.CLOSED) connect();
    };

    document.addEventListener('visibilitychange', onVisibility);
    connect();

    return () => {
      disposed = true;
      socketRef.current = null;
      document.removeEventListener('visibilitychange', onVisibility);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      stopPolling();
      if (socket) {
        // Detached first: `close()` fires `onclose`, which would otherwise
        // schedule a reconnect for a component that no longer exists.
        socket.onclose = null;
        socket.close();
      }
    };
  }, []);

  // Asked for on the open socket rather than at connect time, so moving
  // between nodes does not tear down and rebuild the connection. Re-sent
  // whenever the socket comes back, because the server holds this per client.
  useEffect(() => {
    const socket = socketRef.current;
    if (!state.connected || !socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: 'watch', node: watch ?? null }));
  }, [watch, state.connected]);

  return state;
}

/** One node's live reading, kept so a chart can show what just happened. */
export interface LiveSample {
  /**
   * Which of the two measurements this is.
   *
   * A chart drawn from stored agent readings must not be continued with the
   * kubelet's, or the line steps at the seam for a reason no machine caused.
   */
  source: 'host' | 'kubelet';
  at: number;
  cpuPercent: number | null;
  memoryBytes: number | null;
  netRxBytesPerSecond: number | null;
  netTxBytesPerSecond: number | null;
}

/**
 * A rolling tail of what the socket has delivered for one node.
 *
 * The database keeps one reading every fifteen seconds and the chart refetches
 * it every thirty, so a chart drawn from history alone sits still for half a
 * minute at a time while the figures above it move every second. This holds the
 * readings that have arrived since, so the right-hand edge of every chart is
 * the same number as the card above it.
 *
 * It lives only as long as the page: nothing here is a substitute for stored
 * history, and a reload starts it empty.
 */
export function useLiveHistory(
  live: LiveState,
  node: string,
  windowMs = 20 * 60_000,
): LiveSample[] {
  const [track, setTrack] = useState<{ node: string; samples: LiveSample[] }>({
    node,
    samples: [],
  });

  const current = live.nodes.find((entry) => entry.node === node) ?? null;

  useEffect(() => {
    if (!current) return;

    setTrack((previous) => {
      // A node the reader navigated away from must not leave its tail behind.
      const samples = previous.node === node ? previous.samples : [];
      const reading = sampleOf(current);
      if (samples.at(-1)?.at === reading.at)
        return previous.node === node ? previous : { node, samples };

      const cutoff = reading.at - windowMs;
      const kept = samples.filter((sample) => sample.at > cutoff);
      return { node, samples: [...kept, reading] };
    });
  }, [current, node, windowMs]);

  return track.node === node ? track.samples : [];
}

/** The whole cluster at one instant, for a chart that spans it. */
export interface ClusterSample {
  at: number;
  rxBytesPerSecond: number | null;
  txBytesPerSecond: number | null;
}

/**
 * A rolling tail of the cluster's throughput.
 *
 * The same idea as the per-node tail, summed: the overview has no stored series
 * of its own, and a figure with no history behind it cannot say whether what it
 * shows is normal. Lives only as long as the page.
 */
export function useClusterHistory(live: LiveState, windowMs = 15 * 60_000): ClusterSample[] {
  const [samples, setSamples] = useState<ClusterSample[]>([]);
  const { nodes, sampledAt } = live;

  useEffect(() => {
    if (nodes.length === 0 || sampledAt === null) return;

    setSamples((previous) => {
      if (previous.at(-1)?.at === sampledAt) return previous;

      const reading: ClusterSample = {
        at: sampledAt,
        rxBytesPerSecond: total(nodes.map((node) => rateOf(node, 'rx'))),
        txBytesPerSecond: total(nodes.map((node) => rateOf(node, 'tx'))),
      };

      const cutoff = sampledAt - windowMs;
      return [...previous.filter((sample) => sample.at > cutoff), reading];
    });
  }, [nodes, sampledAt, windowMs]);

  return samples;
}

/** The agent's own measurement where it runs, the kubelet's derived rate where it does not. */
function rateOf(node: LiveNodeMetrics, direction: 'rx' | 'tx'): number | null {
  return direction === 'rx'
    ? (node.host?.netRxBytesPerSecond ?? node.netRxBytesPerSecond)
    : (node.host?.netTxBytesPerSecond ?? node.netTxBytesPerSecond);
}

/** Null unless something answered: a sum of nothing is not zero. */
function total(values: readonly (number | null)[]): number | null {
  const usable = values.filter((value): value is number => value !== null);
  return usable.length === 0 ? null : usable.reduce((sum, value) => sum + value, 0);
}

/**
 * The agent's figures where it runs, the kubelet's where it does not.
 *
 * Whichever source answers, every value in one sample comes from it, so a chart
 * never steps because two measurements of the same thing disagree.
 */
function sampleOf(node: LiveNodeMetrics): LiveSample {
  const host = node.host;
  if (host) {
    return {
      source: 'host',
      at: host.sampledAt,
      cpuPercent: host.cpuPercent,
      memoryBytes: host.memUsedBytes,
      netRxBytesPerSecond: host.netRxBytesPerSecond,
      netTxBytesPerSecond: host.netTxBytesPerSecond,
    };
  }

  return {
    source: 'kubelet',
    at: node.sampledAt,
    cpuPercent: node.cpuPercent,
    memoryBytes: node.memoryBytes,
    netRxBytesPerSecond: node.netRxBytesPerSecond,
    netTxBytesPerSecond: node.netTxBytesPerSecond,
  };
}

function newest(nodes: readonly LiveNodeMetrics[]): number | null {
  return nodes.length === 0 ? null : Math.max(...nodes.map((node) => node.sampledAt));
}

/** A clock that ticks so ages stay honest without any data arriving. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);

  return now;
}
