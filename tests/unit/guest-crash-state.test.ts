import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { guestCrashReason, isGuestCrashed, setGuestCrashChangeListener, trackGuestCrash } from '../../src/main/browser/guest-crash-state';

/** A guest double with real event wiring and no `isCrashed`, so only the tracker answers. */
function trackedGuest(id: number) {
  const events = new EventEmitter();
  const guest = {
    id,
    on: (name: string, listener: (...args: unknown[]) => void) => { events.on(name, listener); return guest; },
    once: (name: string, listener: (...args: unknown[]) => void) => { events.once(name, listener); return guest; },
    emit: (name: string, ...args: unknown[]) => events.emit(name, ...args),
  };
  trackGuestCrash(guest as never);
  return guest;
}

describe('guest crash state', () => {
  it('records why the page stopped, and reads the guest as crashed', () => {
    const guest = trackedGuest(501);
    expect(isGuestCrashed(guest as never)).toBe(false);
    guest.emit('render-process-gone', {}, { reason: 'oom', exitCode: 1 });
    expect(guestCrashReason(501)).toBe('oom');
    expect(isGuestCrashed(guest as never)).toBe(true);
  });

  it('clears on the page loading again', () => {
    const guest = trackedGuest(502);
    guest.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
    guest.emit('dom-ready');
    expect(guestCrashReason(502)).toBeNull();
    expect(isGuestCrashed(guest as never)).toBe(false);
  });

  it('forgets a guest that is destroyed', () => {
    const guest = trackedGuest(503);
    guest.emit('render-process-gone', {}, { reason: 'killed', exitCode: 1 });
    guest.emit('destroyed');
    expect(guestCrashReason(503)).toBeNull();
  });

  it('announces each change, so the stopped-page push goes out, and stays quiet when nothing changed', () => {
    const announced: number[] = [];
    setGuestCrashChangeListener(() => announced.push(announced.length));
    const guest = trackedGuest(504);
    guest.emit('dom-ready');
    expect(announced).toHaveLength(0);
    guest.emit('render-process-gone', {}, { reason: 'oom', exitCode: 1 });
    expect(announced).toHaveLength(1);
    guest.emit('dom-ready');
    expect(announced).toHaveLength(2);
    guest.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
    guest.emit('destroyed');
    expect(announced).toHaveLength(4);
    setGuestCrashChangeListener(null);
  });
});
