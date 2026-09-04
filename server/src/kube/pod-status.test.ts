import { describe, expect, it } from 'vitest';
import { waitingReason } from './client.js';

/**
 * The container states a pod carries while it is not working.
 *
 * `phase` cannot answer this: a crash loop, a missing image and a pod waiting
 * on a volume are all `Pending`, and the operator's next step differs for each.
 */
describe('waitingReason', () => {
  it('reports what the waiting container is waiting for', () => {
    const reason = waitingReason('Pending', [
      { state: { waiting: { reason: 'CrashLoopBackOff' } } },
    ]);
    expect(reason).toBe('CrashLoopBackOff');
  });

  it('says nothing about a pod whose containers are all running', () => {
    expect(waitingReason('Running', [{ state: {} }, { state: {} }])).toBeNull();
  });

  /** A job that finished did what it was asked; that is not a fault. */
  it('says nothing about a pod that completed', () => {
    expect(
      waitingReason('Succeeded', [{ state: { terminated: { reason: 'Completed' } } }]),
    ).toBeNull();
  });

  it('reports a container that died for a reason of its own', () => {
    expect(waitingReason('Running', [{ state: { terminated: { reason: 'OOMKilled' } } }])).toBe(
      'OOMKilled',
    );
  });

  /** An init container finishing cleanly inside a running pod is not news. */
  it('ignores a container that terminated cleanly', () => {
    expect(
      waitingReason('Running', [{ state: { terminated: { reason: 'Completed' } } }, { state: {} }]),
    ).toBeNull();
  });

  /** A pod broken twice is still one thing to go and look at. */
  it('names the first reason rather than every one of them', () => {
    const reason = waitingReason('Pending', [
      { state: { waiting: { reason: 'ImagePullBackOff' } } },
      { state: { waiting: { reason: 'CreateContainerConfigError' } } },
    ]);
    expect(reason).toBe('ImagePullBackOff');
  });

  it('has nothing to say about a pod with no container statuses yet', () => {
    expect(waitingReason('Pending', [])).toBeNull();
  });

  /**
   * A pod the scheduler could not place has no containers to ask, and `Pending`
   * alone is the answer that sends an operator to `kubectl describe`.
   */
  it('reports why a pod could not be scheduled', () => {
    const reason = waitingReason(
      'Pending',
      [],
      [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable' }],
    );
    expect(reason).toBe('Unschedulable');
  });

  /** Waiting one's turn is not a fault, and the scheduler names no reason for it. */
  it('says nothing about a pod that is merely waiting to be placed', () => {
    expect(waitingReason('Pending', [], [{ type: 'PodScheduled', status: 'False' }])).toBeNull();
  });

  it('prefers what a container says over what the scheduler said', () => {
    const reason = waitingReason(
      'Pending',
      [{ state: { waiting: { reason: 'ContainerCreating' } } }],
      [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable' }],
    );
    expect(reason).toBe('ContainerCreating');
  });
});
