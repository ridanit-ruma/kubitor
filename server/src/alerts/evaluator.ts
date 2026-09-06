import { randomUUID } from 'node:crypto';
import type { AlertRecord, AlertsRepo } from '../db/alerts.repo.js';
import type { AlertRule, Observation, World } from './rule.js';

/**
 * What changed, which is the only thing worth telling anybody about.
 *
 * Notification happens on transitions and never on evaluations. An alert that
 * has been firing for an hour produced one `fired` an hour ago and will produce
 * one `resolved` when it clears; the fifty-nine evaluations in between produce
 * nothing, which is what separates this from a firehose.
 */
export interface Transition {
  kind: 'fired' | 'resolved';
  alert: AlertRecord;
}

export interface EvaluateInput {
  rules: readonly AlertRule[];
  world: World;
  repo: AlertsRepo;
}

/**
 * One pass over every rule, against what is open.
 *
 * The shape is a diff, not a scan: what each rule observes now is compared with
 * the alerts already open for it, and the difference moves counters. A
 * condition has to hold for `fireAfter` consecutive evaluations before it is
 * anybody's problem, and be absent for `resolveAfter` before it stops being
 * one — so a pod that restarts once, or a node that blinks during a kubelet
 * restart, never reaches a channel at all.
 */
export async function evaluate(input: EvaluateInput): Promise<Transition[]> {
  const transitions: Transition[] = [];
  const now = input.world.now;

  for (const rule of input.rules) {
    const observed = new Map<string, Observation>();
    for (const observation of rule.observe(input.world)) {
      observed.set(observation.subject, observation);
    }

    const open = await input.repo.openFor(rule.id);
    const seen = new Set<string>();

    for (const alert of open) {
      seen.add(alert.subject);
      const observation = observed.get(alert.subject);

      if (observation) {
        // Still wrong. Reset the absence counter: an alert that flickers off
        // for one evaluation has not recovered, it has flapped.
        const seenCount = alert.seenCount + 1;
        const fires = alert.state === 'pending' && seenCount >= rule.fireAfter;

        const updated = await input.repo.update(alert.id, {
          seenCount,
          missingCount: 0,
          lastSeenAt: now,
          summary: observation.summary,
          detail: observation.detail ?? null,
          attrs: observation.attrs ?? {},
          ...(fires ? { state: 'firing' as const, firedAt: now } : {}),
        });

        if (fires) transitions.push({ kind: 'fired', alert: updated });
        continue;
      }

      const missingCount = alert.missingCount + 1;
      if (missingCount < rule.resolveAfter) {
        await input.repo.update(alert.id, { missingCount });
        continue;
      }

      const resolved = await input.repo.update(alert.id, {
        missingCount,
        resolvedAt: now,
      });

      // A pending alert never fired, so it has nothing to resolve: telling
      // somebody a problem is over when they were never told it started is
      // noise dressed as courtesy.
      if (alert.state === 'firing') transitions.push({ kind: 'resolved', alert: resolved });
    }

    for (const [subject, observation] of observed) {
      if (seen.has(subject)) continue;

      const fires = rule.fireAfter <= 1;
      const created = await input.repo.create({
        id: randomUUID(),
        rule: rule.id,
        subject,
        severity: rule.severity,
        summary: observation.summary,
        detail: observation.detail ?? null,
        state: fires ? 'firing' : 'pending',
        seenCount: 1,
        missingCount: 0,
        firstSeenAt: now,
        lastSeenAt: now,
        firedAt: fires ? now : null,
        attrs: observation.attrs ?? {},
      });

      if (fires) transitions.push({ kind: 'fired', alert: created });
    }
  }

  return transitions;
}
