/**
 * `hasPendingMessageDelivery` answers whether a column message is still
 * waiting to be pasted into a task's agent. The low-memory pause reads it to
 * skip an agent that is about to get work, so it must follow the registry
 * that `trackMessageDelivery` and `supersedeMessageDeliveries` keep: true
 * while any delivery is registered, false once each one released or was
 * superseded.
 */
import { describe, it, expect } from 'vitest';
import {
  hasPendingMessageDelivery,
  supersedeMessageDeliveries,
  trackMessageDelivery,
} from '../../src/main/automations/turn-end/turn-end-passes';

describe('hasPendingMessageDelivery', () => {
  it('is false for a task with nothing registered', () => {
    expect(hasPendingMessageDelivery('task-none')).toBe(false);
  });

  it('is true while a delivery is waiting, and false once it releases', () => {
    const release = trackMessageDelivery('task-one', new AbortController());
    expect(hasPendingMessageDelivery('task-one')).toBe(true);

    release();
    expect(hasPendingMessageDelivery('task-one')).toBe(false);
  });

  it('stays true until the last of two deliveries releases', () => {
    const releaseFirst = trackMessageDelivery('task-two', new AbortController());
    const releaseSecond = trackMessageDelivery('task-two', new AbortController());

    releaseFirst();
    expect(hasPendingMessageDelivery('task-two')).toBe(true);
    releaseSecond();
    expect(hasPendingMessageDelivery('task-two')).toBe(false);
  });

  it('is false once a move superseded the task\'s deliveries', () => {
    trackMessageDelivery('task-moved', new AbortController());

    supersedeMessageDeliveries('task-moved');

    expect(hasPendingMessageDelivery('task-moved')).toBe(false);
  });

  it('answers per task', () => {
    const release = trackMessageDelivery('task-a', new AbortController());

    expect(hasPendingMessageDelivery('task-b')).toBe(false);
    release();
  });
});
