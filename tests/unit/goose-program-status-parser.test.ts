/**
 * Goose's OSC 7501 program status (#452), read for the waits on the user. The
 * sequences below are built the way Goose's own `encode`
 * (`crates/goose-cli/src/session/program_status.rs`) builds them, including its
 * test's case: `state=blocked:kind=permission:app=goose:msg=<base64>`, ended by
 * ST (`ESC \`).
 */
import { describe, it, expect } from 'vitest';
import { GooseProgramStatusParser } from '../../src/main/agent/adapters/goose/program-status-parser';
import { GooseAdapter } from '../../src/main/agent/adapters/goose';
import { ActivityEngine } from '../../src/main/activity-engine/engine';
import { EventType, IdleReason, PromptReason } from '../../src/shared/types';
import type { SessionEvent } from '../../src/shared/types';

function status(body: string, terminator = '\x1b\\'): string {
  return `\x1b]7501;${body}${terminator}`;
}
const message = Buffer.from('run  ]0;x  shell').toString('base64');

function eventsOf(parser: GooseProgramStatusParser, ...chunks: string[]): SessionEvent[] {
  return chunks.flatMap((chunk) => parser.parseTelemetry(chunk)?.events ?? []);
}

describe('GooseProgramStatusParser', () => {
  it('reports a blocked permission as an approval wait', () => {
    const events = eventsOf(new GooseProgramStatusParser(), status(`state=blocked:kind=permission:app=goose:msg=${message}`));
    expect(events).toEqual([{ ts: expect.any(Number), type: EventType.Idle, detail: IdleReason.Permission, waitKind: 'approval' }]);
  });

  it('reports a blocked question as a question wait', () => {
    const events = eventsOf(new GooseProgramStatusParser(), status('state=blocked:kind=question:app=goose'));
    expect(events).toEqual([{ ts: expect.any(Number), type: EventType.Idle, detail: IdleReason.Permission, waitKind: 'question' }]);
  });

  it('leaves a blocked status with no kind unknown', () => {
    const [event] = eventsOf(new GooseProgramStatusParser(), status('state=blocked:app=goose'));
    expect(event).toMatchObject({ type: EventType.Idle, detail: IdleReason.Permission });
    expect('waitKind' in event).toBe(false);
  });

  it('ends a wait with the tracker\'s own resume event when Goose goes back to work', () => {
    const parser = new GooseProgramStatusParser();
    const events = eventsOf(parser, status('state=blocked:kind=question:app=goose'), 'some output', status('state=working:app=goose'));
    expect(events.map((event) => event.type)).toEqual([EventType.Idle, EventType.Prompt]);
    expect(events[1].detail).toBe(PromptReason.PtyActivity);
  });

  it('ends a wait that settles without work as an interrupt, never a plain idle a turn end would read', () => {
    for (const settled of ['idle', 'done', 'error', 'clear']) {
      const events = eventsOf(new GooseProgramStatusParser(), status('state=blocked:kind=permission:app=goose'), status(`state=${settled}:app=goose`));
      expect(events.map((event) => event.type)).toEqual([EventType.Idle, EventType.Interrupted]);
    }
  });

  it('reports nothing for status changes outside a wait', () => {
    const parser = new GooseProgramStatusParser();
    expect(eventsOf(parser, status('state=working:app=goose'), status('state=idle:app=goose'), status('state=done:app=goose'))).toEqual([]);
    expect(parser.parseTelemetry('plain output with no escape')).toBeNull();
    expect(parser.parseTelemetry('\x1b[32mcolored\x1b[0m')).toBeNull();
  });

  it('reads a sequence split across chunks, the prefix and the body both', () => {
    const whole = status(`state=blocked:kind=question:app=goose:msg=${message}`);
    for (const cut of [1, 3, 8, 20, whole.length - 1]) {
      const events = eventsOf(new GooseProgramStatusParser(), `before ${whole.slice(0, cut)}`, `${whole.slice(cut)} after`);
      expect(events, `cut at ${cut}`).toHaveLength(1);
      expect(events[0]).toMatchObject({ waitKind: 'question' });
    }
  });

  it('accepts a BEL terminator too, and several sequences in one chunk', () => {
    const events = eventsOf(new GooseProgramStatusParser(),
      `${status('state=blocked:kind=permission:app=goose', '\x07')}x${status('state=working:app=goose', '\x07')}`);
    expect(events.map((event) => event.type)).toEqual([EventType.Idle, EventType.Prompt]);
  });

  it('drops an unterminated sequence longer than any Goose writes, instead of buffering forever', () => {
    const parser = new GooseProgramStatusParser();
    eventsOf(parser, `\x1b]7501;state=blocked:msg=${'A'.repeat(5000)}`);
    expect(eventsOf(parser, status('state=blocked:kind=question:app=goose'))).toHaveLength(1);
  });

  it('is the adapter\'s stream parser, with activity kept on the PTY tracker', () => {
    const adapter = new GooseAdapter();
    expect(adapter.runtime.activity.kind).toBe('pty');
    expect(adapter.runtime.streamOutput?.createParser()).toBeInstanceOf(GooseProgramStatusParser);
  });

  it('drives the engine to a wait and back, and an ended wait fires no turn end', () => {
    const turnEnds: number[] = [];
    const engine = new ActivityEngine(
      { onActivityChange() { /* unused */ }, onTurnEnded() { turnEnds.push(1); } },
      { idleStabilityWindowMs: 0 },
    );
    engine.initSession('goose');
    const parser = new GooseProgramStatusParser();
    const feed = (chunk: string): void => { for (const event of eventsOf(parser, chunk)) engine.processEvent('goose', event); };

    engine.forceThinking('goose');
    feed(status('state=blocked:kind=question:app=goose'));
    expect(engine.getState('goose')?.activity).toBe('permission');
    expect(engine.getState('goose')?.permissionWaitKind).toBe('question');

    feed(status('state=working:app=goose'));
    expect(engine.getState('goose')?.activity).toBe('thinking');

    feed(status('state=blocked:kind=permission:app=goose'));
    feed(status('state=idle:app=goose'));
    expect(engine.getState('goose')?.activity).toBe('idle');
    expect(turnEnds).toEqual([]);
    engine.dispose();
  });
});
