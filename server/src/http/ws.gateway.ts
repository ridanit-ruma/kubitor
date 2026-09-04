import type { IncomingMessage, Server } from 'node:http';
import type { Logger } from '@nestjs/common';
import { type WebSocket, WebSocketServer } from 'ws';
import type { AuthService } from '../auth/auth.service.js';
import { verifySessionToken } from '../auth/tokens.js';
import type { LiveCache } from '../collect/live-cache.js';
import { frameMetrics } from '../collect/live-push.js';
import { readSessionCookie } from './cookies.js';

/** The dashboard's promise: values move once a second. */
export const PUSH_INTERVAL_MS = 1000;
const HEARTBEAT_INTERVAL_MS = 30_000;
/** A cap so one client cannot exhaust the server's sockets. */
const MAX_CONNECTIONS = 200;
/** Nothing the client sends is large; anything bigger is not a real client. */
const MAX_PAYLOAD_BYTES = 64 * 1024;

interface Client {
  socket: WebSocket;
  sessionId: string;
  alive: boolean;
  /**
   * The one node this client is looking at, if any.
   *
   * A node screen shows sensors, interface rates and disk throughput, all of
   * which move every second. Broadcasting every machine's devices to every open
   * tab would scale with nodes times tabs, so a client asks for the one it is
   * showing and gets that node's detail alone.
   */
  watching: string | null;
}

export interface LiveGatewayDeps {
  auth: AuthService;
  cache: LiveCache;
  sessionSecret: string;
  logger: Pick<Logger, 'warn'>;
  now(): number;
}

/**
 * Pushes live values to the browser once a second.
 *
 * Because a frame carries data rather than a mere "something changed" signal,
 * the session is revalidated on **every** push. Checking only at connect time,
 * or on a periodic sweep, would keep feeding cluster data to a session that has
 * been logged out or whose password was just reset.
 */
export class LiveGateway {
  readonly #deps: LiveGatewayDeps;
  readonly #clients = new Set<Client>();
  #server?: WebSocketServer;
  #pushTimer?: NodeJS.Timeout;
  #heartbeatTimer?: NodeJS.Timeout;

  constructor(deps: LiveGatewayDeps) {
    this.#deps = deps;
  }

  attach(httpServer: Server): void {
    this.#server = new WebSocketServer({
      server: httpServer,
      path: '/api/ws',
      maxPayload: MAX_PAYLOAD_BYTES,
    });

    this.#server.on('connection', (socket, request) => {
      void this.#onConnection(socket, request);
    });

    this.#pushTimer = setInterval(() => void this.#push(), PUSH_INTERVAL_MS);
    this.#pushTimer.unref();

    this.#heartbeatTimer = setInterval(() => this.#heartbeat(), HEARTBEAT_INTERVAL_MS);
    this.#heartbeatTimer.unref();
  }

  async #onConnection(socket: WebSocket, request: IncomingMessage): Promise<void> {
    if (this.#clients.size >= MAX_CONNECTIONS) {
      socket.close(1013, 'Too many connections');
      return;
    }

    const token = readSessionCookie(request.headers.cookie);
    const claims = token ? await verifySessionToken(token, this.#deps.sessionSecret) : null;
    if (!claims) {
      socket.close(4401, 'Unauthorized');
      return;
    }

    const validated = await this.#deps.auth.validate(claims.sid, this.#deps.now());
    if (!validated) {
      socket.close(4401, 'Unauthorized');
      return;
    }

    const client: Client = { socket, sessionId: claims.sid, alive: true, watching: null };
    this.#clients.add(client);

    socket.on('pong', () => {
      client.alive = true;
    });
    socket.on('message', (raw) => {
      const text = String(raw);
      // The client answers the application-level ping below.
      if (text.includes('pong')) {
        client.alive = true;
        return;
      }

      // The only thing a client may ask for: which node's devices to include.
      // Anything else is ignored — this socket is otherwise one-directional.
      const asked = watchRequest(text);
      if (asked !== undefined) client.watching = asked;
    });
    socket.on('close', () => this.#clients.delete(client));
    socket.on('error', () => this.#clients.delete(client));
  }

  async #push(): Promise<void> {
    if (this.#clients.size === 0) return;

    const now = this.#deps.now();
    const nodes = this.#deps.cache.current(now);
    const shared = frameMetrics(nodes, now);
    // Watchers of the same node share one serialization, so a room full of
    // tabs on one machine costs what a single tab costs.
    const byNode = new Map<string, string>();

    for (const client of [...this.#clients]) {
      // Re-checked per push, not per connection: this frame carries data.
      const session = await this.#deps.auth.validate(client.sessionId, now);
      if (!session) {
        client.socket.close(4401, 'Session ended');
        this.#clients.delete(client);
        continue;
      }

      if (client.socket.readyState !== client.socket.OPEN) continue;

      const watching = client.watching;
      if (watching === null) {
        client.socket.send(shared.json);
        continue;
      }

      let json = byNode.get(watching);
      if (json === undefined) {
        const detail = this.#deps.cache.detailFor(watching, now);
        json = frameMetrics(nodes, now, detail ? { node: watching, ...detail } : null).json;
        byNode.set(watching, json);
      }
      client.socket.send(json);
    }
  }

  /**
   * Two pings, deliberately.
   *
   * A protocol-level ping is the correct mechanism, but some proxies — a
   * Cloudflare tunnel among them — do not forward WebSocket control frames, and
   * a connection that is healthy end-to-end then gets terminated here for not
   * answering. The JSON ping travels as ordinary data and always arrives.
   */
  #heartbeat(): void {
    for (const client of [...this.#clients]) {
      if (!client.alive) {
        client.socket.terminate();
        this.#clients.delete(client);
        continue;
      }

      client.alive = false;
      client.socket.ping();
      if (client.socket.readyState === client.socket.OPEN) {
        client.socket.send(JSON.stringify({ topic: 'ping', generatedAt: this.#deps.now() }));
      }
    }
  }

  get connectionCount(): number {
    return this.#clients.size;
  }

  async close(): Promise<void> {
    if (this.#pushTimer) clearInterval(this.#pushTimer);
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
    for (const client of this.#clients) client.socket.terminate();
    this.#clients.clear();
    await new Promise<void>((resolve) => {
      if (!this.#server) return resolve();
      this.#server.close(() => resolve());
    });
  }
}

/**
 * A watch request, or undefined for anything else the client sent.
 *
 * Returns null for a client that asked to stop watching, which is how a node
 * screen releases its node when the reader navigates away.
 */
function watchRequest(text: string): string | null | undefined {
  if (!text.includes('watch')) return undefined;

  try {
    const message = JSON.parse(text) as { type?: unknown; node?: unknown };
    if (message.type !== 'watch') return undefined;
    if (typeof message.node === 'string' && message.node.length <= 253) return message.node;
    return message.node === null ? null : undefined;
  } catch {
    return undefined;
  }
}
