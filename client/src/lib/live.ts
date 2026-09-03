'use client';

import { useEffect, useRef, useState } from 'react';
import { api, type LiveNodeMetrics } from './api';

export interface LiveState {
  nodes: LiveNodeMetrics[];
  /** When the newest reading was taken by the kubelet — not when it arrived. */
  sampledAt: number | null;
  connected: boolean;
}

interface Frame {
  topic: string;
  sampledAt?: number | null;
  generatedAt: number;
  nodes?: LiveNodeMetrics[];
  signalOnly?: true;
}

/** Backs off rather than hammering a server that is restarting. */
const RECONNECT_MS = [1000, 2000, 5000, 10_000];
/** Used only while the socket is down. */
const FALLBACK_POLL_MS = 5000;

/**
 * Live metrics over the WebSocket, with REST as the fallback.
 *
 * The socket carries the data itself rather than a "something changed" nudge,
 * so there is nothing to re-request on each tick. When a frame is too large the
 * server sends `signalOnly` instead, and this refetches over REST — where
 * filters and pagination exist.
 */
export function useLiveMetrics(): LiveState {
  const [state, setState] = useState<LiveState>({
    nodes: [],
    sampledAt: null,
    connected: false,
  });
  const attempt = useRef(0);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    let disposed = false;

    const refetch = async (): Promise<void> => {
      try {
        const current = await api.currentMetrics();
        if (disposed) return;
        setState((previous) => ({
          ...previous,
          nodes: current.nodes,
          sampledAt: newest(current.nodes),
        }));
      } catch {
        // Losing one poll is not worth surfacing; the age indicator already
        // shows the reading going stale.
      }
    };

    const startPolling = (): void => {
      if (pollTimer) return;
      void refetch();
      pollTimer = setInterval(() => void refetch(), FALLBACK_POLL_MS);
    };

    const stopPolling = (): void => {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = undefined;
    };

    const connect = (): void => {
      if (disposed) return;

      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(`${protocol}://${window.location.host}/api/ws`);

      socket.onopen = () => {
        attempt.current = 0;
        stopPolling();
        setState((previous) => ({ ...previous, connected: true }));
      };

      socket.onmessage = (event) => {
        const frame = JSON.parse(String(event.data)) as Frame;
        if (frame.topic !== 'metrics.current') return;

        if (frame.signalOnly) {
          void refetch();
          return;
        }

        setState({
          nodes: frame.nodes ?? [],
          sampledAt: frame.sampledAt ?? null,
          connected: true,
        });
      };

      const retry = (): void => {
        setState((previous) => ({ ...previous, connected: false }));
        startPolling();

        if (disposed) return;
        const delay = RECONNECT_MS[Math.min(attempt.current, RECONNECT_MS.length - 1)] ?? 10_000;
        attempt.current += 1;
        reconnectTimer = setTimeout(connect, delay);
      };

      socket.onclose = retry;
      socket.onerror = () => socket?.close();
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      stopPolling();
      socket?.close();
    };
  }, []);

  return state;
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
