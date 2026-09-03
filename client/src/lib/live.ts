'use client';

import { useEffect, useRef, useState } from 'react';
import { api, type LiveNodeMetrics } from './api';

export interface LiveState {
  nodes: LiveNodeMetrics[];
  /** When the newest reading was taken by its source — not when it arrived. */
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

        setState({
          nodes: frame.nodes ?? [],
          sampledAt: frame.sampledAt ?? null,
          connected: true,
        });
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
