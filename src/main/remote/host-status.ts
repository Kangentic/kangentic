import type { SshHostConnectionState } from '../../shared/types';

/**
 * Where each SSH host's connection stands, for the settings row and a project's chip (#913).
 *
 * A link reports `connecting`, `connected`, `reconnecting` and `stopped`. A link that keeps retrying for
 * a while is a host the user should hear about, so this book also promotes a connection that has not
 * come up within `unreachableAfterMs` to `unreachable`, keeping the link's own words as the reason. The
 * link goes on retrying underneath and a later `connected` clears it. A setup step that failed (the
 * host's program could not be installed, ssh refused) sets `unreachable` directly with that error.
 *
 * "Unreachable" is not "gone": every agent on the host keeps running, and the chip says so by showing
 * the state, never by removing anything.
 */

export interface HostConnectionStatus {
  state: SshHostConnectionState;
  detail: string | null;
  /** UTC ISO time the state last changed. */
  since: string;
}

export interface HostStatusBookOptions {
  /** How long a connection may stay down before it reads as unreachable. */
  unreachableAfterMs?: number;
  now?: () => number;
  /** Called after any change, with the host that changed. */
  onChange?: (hostId: string) => void;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

const DEFAULT_UNREACHABLE_AFTER_MS = 20_000;

export class HostStatusBook {
  private readonly statuses = new Map<string, HostConnectionStatus>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly unreachableAfterMs: number;
  private readonly now: () => number;
  private readonly setTimer: NonNullable<HostStatusBookOptions['setTimer']>;
  private readonly clearTimer: NonNullable<HostStatusBookOptions['clearTimer']>;

  constructor(private readonly options: HostStatusBookOptions = {}) {
    this.unreachableAfterMs = options.unreachableAfterMs ?? DEFAULT_UNREACHABLE_AFTER_MS;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((callback, delayMs) => {
      const timer = setTimeout(callback, delayMs);
      timer.unref?.();
      return timer;
    });
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
  }

  get(hostId: string): HostConnectionStatus | undefined {
    return this.statuses.get(hostId);
  }

  /** Record a state. `detail` is the reason in ssh's or the helper's own words, or null. */
  set(hostId: string, state: SshHostConnectionState, detail: string | null = null): void {
    const previous = this.statuses.get(hostId);
    const stateChanged = previous?.state !== state;
    if (!stateChanged && previous?.detail === detail) return;
    this.statuses.set(hostId, {
      state,
      detail,
      since: stateChanged || !previous ? new Date(this.now()).toISOString() : previous.since,
    });
    this.updateTimer(hostId, state);
    this.options.onChange?.(hostId);
  }

  /** Forget a host that was removed. */
  remove(hostId: string): void {
    this.cancelTimer(hostId);
    this.statuses.delete(hostId);
  }

  dispose(): void {
    for (const hostId of [...this.timers.keys()]) this.cancelTimer(hostId);
    this.statuses.clear();
  }

  private updateTimer(hostId: string, state: SshHostConnectionState): void {
    const waiting = state === 'connecting' || state === 'reconnecting';
    if (!waiting) {
      this.cancelTimer(hostId);
      return;
    }
    // One timer per outage: a link that flips between connecting and reconnecting is still the same outage.
    if (this.timers.has(hostId)) return;
    this.timers.set(hostId, this.setTimer(() => {
      this.timers.delete(hostId);
      const current = this.statuses.get(hostId);
      if (current && (current.state === 'connecting' || current.state === 'reconnecting')) {
        this.set(hostId, 'unreachable', current.detail ?? 'The connection has not come up.');
      }
    }, this.unreachableAfterMs));
  }

  private cancelTimer(hostId: string): void {
    const timer = this.timers.get(hostId);
    if (timer) this.clearTimer(timer);
    this.timers.delete(hostId);
  }
}
