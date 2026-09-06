import { Controller, Get, Inject, Optional, Query, UseGuards } from '@nestjs/common';
import type { AlertsService } from '../alerts/service.js';
import type { AlertRecord } from '../db/alerts.repo.js';
import type { NotificationsRepo, QueuedNotification } from '../db/notifications.repo.js';
import type { Dispatcher } from '../notify/dispatcher.js';
import { ALERTS_SERVICE, DISPATCHER, NOTIFICATIONS_REPO } from '../tokens.js';
import { PasswordFreshGuard } from './password-fresh.guard.js';
import { SessionGuard } from './session.guard.js';

export interface AlertsPage {
  firing: AlertRecord[];
  recent: AlertRecord[];
  /**
   * Whether anything is being told, and whether it is getting through.
   *
   * On the same screen as the alerts because the failure worth catching is
   * silent: notifications configured, a webhook rotated, and messages piling up
   * unsent while everybody assumes they would have heard.
   */
  delivery: { configured: boolean; pending: number; recent: QueuedNotification[] };
}

@Controller('api/alerts')
@UseGuards(SessionGuard, PasswordFreshGuard)
export class AlertsController {
  readonly #alerts: AlertsService | null;
  readonly #notifications: NotificationsRepo | null;
  readonly #dispatcher: Dispatcher | null;

  constructor(
    @Optional() @Inject(ALERTS_SERVICE) alerts: AlertsService | null,
    @Optional() @Inject(NOTIFICATIONS_REPO) notifications: NotificationsRepo | null,
    @Optional() @Inject(DISPATCHER) dispatcher: Dispatcher | null,
  ) {
    this.#alerts = alerts ?? null;
    this.#notifications = notifications ?? null;
    this.#dispatcher = dispatcher ?? null;
  }

  /**
   * What is wrong now, and what has been wrong lately.
   *
   * Both in one response because they are one screen: an operator looking at a
   * firing alert almost always wants to know whether it has happened before.
   */
  @Get()
  async list(@Query('history') history?: string): Promise<AlertsPage> {
    const configured = this.#dispatcher?.configured ?? false;
    if (!this.#alerts) {
      return { firing: [], recent: [], delivery: { configured, pending: 0, recent: [] } };
    }

    const limit = Math.min(Math.max(Number(history) || 100, 1), 500);
    const [firing, recent, pending, sent] = await Promise.all([
      this.#alerts.firing(),
      this.#alerts.recent(limit),
      this.#notifications?.pendingCount() ?? Promise.resolve(0),
      this.#notifications?.recent(20) ?? Promise.resolve([]),
    ]);

    return { firing, recent, delivery: { configured, pending, recent: sent } };
  }
}
