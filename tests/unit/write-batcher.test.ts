import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createWriteBatcher } from '../../src/renderer/utils/write-batcher';
import { isMouseReport, mouseWheelLane } from '../../src/renderer/utils/repaint-nudge';

/** Wait for all pending microtasks to drain. */
const drainMicrotasks = () => new Promise<void>((resolve) => queueMicrotask(resolve));

describe('createWriteBatcher', () => {
  it('coalesces a synchronous burst into a single write with concatenated payload', async () => {
    const write = vi.fn<[string], void>();
    const batcher = createWriteBatcher(write);

    batcher.schedule('h');
    batcher.schedule('e');
    batcher.schedule('l');
    batcher.schedule('l');
    batcher.schedule('o');

    expect(write).not.toHaveBeenCalled();

    await drainMicrotasks();

    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith('hello');
  });

  it('skips the join step when only one chunk was queued', async () => {
    const write = vi.fn<[string], void>();
    const batcher = createWriteBatcher(write);

    batcher.schedule('x');
    await drainMicrotasks();

    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith('x');
  });

  it('emits one write per microtask burst (two bursts -> two writes)', async () => {
    const write = vi.fn<[string], void>();
    const batcher = createWriteBatcher(write);

    batcher.schedule('a');
    batcher.schedule('b');
    await drainMicrotasks();

    batcher.schedule('c');
    batcher.schedule('d');
    await drainMicrotasks();

    expect(write.mock.calls).toEqual([['ab'], ['cd']]);
  });

  it('flush() drains pending data synchronously without waiting for the microtask', () => {
    const write = vi.fn<[string], void>();
    const batcher = createWriteBatcher(write);

    batcher.schedule('pending');
    expect(write).not.toHaveBeenCalled();

    batcher.flush();
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith('pending');
  });

  it('flush() is a no-op when queue is empty', () => {
    const write = vi.fn<[string], void>();
    const batcher = createWriteBatcher(write);

    batcher.flush();
    batcher.flush();

    expect(write).not.toHaveBeenCalled();
  });

  it('an already-scheduled microtask still flushes (no double-write) after manual flush', async () => {
    const write = vi.fn<[string], void>();
    const batcher = createWriteBatcher(write);

    batcher.schedule('foo');
    batcher.flush();

    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith('foo');

    await drainMicrotasks();

    // The scheduled microtask fires but finds an empty queue, so no second write.
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('preserves chunk order across the concatenated payload', async () => {
    const write = vi.fn<[string], void>();
    const batcher = createWriteBatcher(write);

    batcher.schedule('first\r\n');
    batcher.schedule('second\r\n');
    batcher.schedule('third');

    await drainMicrotasks();

    expect(write).toHaveBeenCalledWith('first\r\nsecond\r\nthird');
  });

  // writePaced exists because chunk boundaries are event boundaries to a
  // fullscreen TUI, and a pipe preserves neither: coalesced or read-coalesced
  // wheel reports become one multi-line jump whose differential frame
  // intermittently mis-assembles. Each report must be its own write AND the
  // writes must be paced to a physical-wheel cadence, in arrival order with
  // everything else. (Ack-clocking to the consumer's answers was tried and
  // reverted: it capped scrolling at the TUI's own ~10Hz idle frame clock.)
  describe('writePaced', () => {
    const PACE_MS = 16;

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('writes the first report immediately as its own payload', () => {
      const write = vi.fn<[string], void>();
      const batcher = createWriteBatcher(write, PACE_MS);

      batcher.writePaced('\x1b[<64;10;5M');
      expect(write).toHaveBeenCalledTimes(1);
      expect(write).toHaveBeenCalledWith('\x1b[<64;10;5M');
    });

    it('a synchronous burst drains one report per pace interval, never joined', () => {
      const write = vi.fn<[string], void>();
      const batcher = createWriteBatcher(write, PACE_MS);

      batcher.writePaced('r1');
      batcher.writePaced('r2');
      batcher.writePaced('r3');
      expect(write.mock.calls).toEqual([['r1']]);

      vi.advanceTimersByTime(PACE_MS);
      expect(write.mock.calls).toEqual([['r1'], ['r2']]);

      vi.advanceTimersByTime(PACE_MS);
      expect(write.mock.calls).toEqual([['r1'], ['r2'], ['r3']]);
    });

    it('reports arriving slower than the pace write immediately', () => {
      const write = vi.fn<[string], void>();
      const batcher = createWriteBatcher(write, PACE_MS);

      batcher.writePaced('r1');
      vi.advanceTimersByTime(PACE_MS * 2);
      batcher.writePaced('r2');

      expect(write.mock.calls).toEqual([['r1'], ['r2']]);
    });

    it('typed bytes already queued drain before a paced report (arrival order holds)', async () => {
      const write = vi.fn<[string], void>();
      const batcher = createWriteBatcher(write, PACE_MS);

      batcher.schedule('typed');
      batcher.writePaced('\x1b[<64;10;5M');

      expect(write.mock.calls).toEqual([['typed'], ['\x1b[<64;10;5M']]);

      // schedule('typed') left a microtask queued that these synchronous
      // assertions never let fire (fake timers do not fake microtasks).
      // Draining it for real is a double-write guard: it proves the pending
      // microtask finds an already-empty queue rather than re-writing 'typed'.
      await drainMicrotasks();
      expect(write.mock.calls).toEqual([['typed'], ['\x1b[<64;10;5M']]);
    });

    it('typed bytes arriving during a paced wait stay ordered behind the pending report', () => {
      const write = vi.fn<[string], void>();
      const batcher = createWriteBatcher(write, PACE_MS);

      batcher.writePaced('r1');
      batcher.writePaced('r2');
      batcher.schedule('a');
      expect(write.mock.calls).toEqual([['r1']]);

      vi.advanceTimersByTime(PACE_MS);
      expect(write.mock.calls).toEqual([['r1'], ['r2'], ['a']]);
    });

    it('a writePaced/schedule/writePaced interleave keeps strict arrival order', () => {
      const write = vi.fn<[string], void>();
      const batcher = createWriteBatcher(write, PACE_MS);

      batcher.writePaced('r1');
      batcher.schedule('a');
      batcher.writePaced('r2');

      // r1 writes immediately (nothing paced ahead of it). writePaced('r2')
      // drains synchronously, which flushes the already-queued batched 'a'
      // first - r2 itself is still under the pace floor r1 set, so it stays
      // queued rather than writing here too.
      expect(write.mock.calls).toEqual([['r1'], ['a']]);

      vi.advanceTimersByTime(PACE_MS);
      expect(write.mock.calls).toEqual([['r1'], ['a'], ['r2']]);
    });

    it('flush drops pending paced reports but keeps batched bytes', async () => {
      // Pending reports at teardown are scroll intents for a dying view, and
      // writing them joined would recreate the exact coalesced chunk this
      // path exists to prevent.
      const write = vi.fn<[string], void>();
      const batcher = createWriteBatcher(write, PACE_MS);

      batcher.writePaced('r1');
      batcher.writePaced('r2');
      batcher.schedule('typed');
      batcher.flush();

      expect(write.mock.calls).toEqual([['r1'], ['typed']]);

      vi.advanceTimersByTime(PACE_MS * 4);
      expect(write.mock.calls).toEqual([['r1'], ['typed']]);

      // schedule('typed') queued a microtask before flush() ran. Draining it
      // for real is a double-write guard: it proves flush() already emptied
      // the queue, rather than leaving 'typed' to be re-written once the
      // microtask fires.
      await drainMicrotasks();
      expect(write.mock.calls).toEqual([['r1'], ['typed']]);
    });

    it('clamps the pace wait against a backward wall-clock jump (NTP, sleep/resume skew)', () => {
      // Without the `Math.min(..., paceMs)` clamp, `lastPacedWriteAt + paceMs
      // - Date.now()` can come out far larger than paceMs once the clock has
      // jumped backward, scheduling one long stall instead of the intended
      // per-report floor.
      const write = vi.fn<[string], void>();
      const batcher = createWriteBatcher(write, PACE_MS);
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

      batcher.writePaced('r1'); // writes immediately; sets lastPacedWriteAt
      const baseTime = Date.now();

      // Simulate an NTP-style correction: the wall clock jumps backward by
      // many pace intervals' worth of time.
      vi.setSystemTime(baseTime - PACE_MS * 20);

      batcher.writePaced('r2');

      const scheduledDelay = setTimeoutSpy.mock.calls.at(-1)?.[1];
      expect(scheduledDelay).toBe(PACE_MS);
    });

    it('a synchronous drain that finds an already-due paced head clears the still-pending timer instead of leaving it stale', () => {
      // The head's own paceTimer is scheduled by the first writePaced('r2')
      // call below. A second, independent writePaced call can reach drain()
      // synchronously once real elapsed time has already cleared that head's
      // deadline but before the timer's OWN callback has run - the timer
      // bookkeeping must clear the stale reference right there, not leave it
      // dangling once the head it was scheduled for has already been consumed.
      const write = vi.fn<[string], void>();
      const batcher = createWriteBatcher(write, PACE_MS);
      const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

      batcher.writePaced('r1'); // writes immediately, no timer touched
      batcher.writePaced('r2'); // under the pace floor: schedules a paceTimer
      expect(clearTimeoutSpy).not.toHaveBeenCalled();

      // The wall clock reaches r2's deadline without that scheduled timer's
      // own callback having run yet.
      vi.setSystemTime(Date.now() + PACE_MS);

      // This call reaches drain() synchronously and finds r2 already due.
      batcher.writePaced('r3');

      // r2 wrote through this synchronous path, not the (now-stale) timer's
      // own callback, and the stale reference was cleared exactly once.
      expect(write.mock.calls).toEqual([['r1'], ['r2']]);
      expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);

      // r3 still gets its own fresh pace-floor timer - the clear did not also
      // skip scheduling the next one.
      vi.advanceTimersByTime(PACE_MS);
      expect(write.mock.calls).toEqual([['r1'], ['r2'], ['r3']]);
    });
  });

  // Lanes bound the paced queue. A high-resolution wheel emits reports faster
  // than the pace floor drains them, so without a cap the queue keeps feeding
  // scroll commands after the hand stops, and its depth scales with wheel
  // resolution rather than requested travel. A lane marks same-direction
  // wheel reports as interchangeable intent: pending same-lane depth is
  // capped (drop the INCOMING arrival), and an arrival removes pending items
  // in its declared supersede target (a same-axis reversal makes them stale).
  // Laneless paced items (clicks, releases, motion) are exempt from both: a
  // dropped release would stick a button.
  describe('writePaced lanes (cap + reversal supersede)', () => {
    const PACE_MS = 16;
    const LANE_CAP = 3;
    const wheelDown = { laneKey: 'wheel:65', supersedesLaneKey: 'wheel:64' };
    const wheelUp = { laneKey: 'wheel:64', supersedesLaneKey: 'wheel:65' };
    const wheelLeft = { laneKey: 'wheel:66', supersedesLaneKey: 'wheel:67' };

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('drops same-lane arrivals beyond the pending cap (drop-incoming: earliest survivors write)', () => {
      const write = vi.fn<[string], void>();
      const batcher = createWriteBatcher(write, PACE_MS, LANE_CAP);

      batcher.writePaced('r1', wheelDown); // writes immediately, not pending
      batcher.writePaced('r2', wheelDown);
      batcher.writePaced('r3', wheelDown);
      batcher.writePaced('r4', wheelDown); // pending depth now at the cap
      batcher.writePaced('r5', wheelDown); // dropped
      batcher.writePaced('r6', wheelDown); // dropped

      expect(write.mock.calls).toEqual([['r1']]);

      // The exact survivor list pins drop-incoming: drop-oldest would have
      // written r4..r6 instead.
      vi.advanceTimersByTime(PACE_MS * 10);
      expect(write.mock.calls).toEqual([['r1'], ['r2'], ['r3'], ['r4']]);
    });

    it('the default lane cap of 8 applies when maxPacedLaneDepth is not passed to the factory', () => {
      // Every cap test above injects LANE_CAP (3) as the third factory arg,
      // and none of them sends more than 3 same-lane reports, so deleting
      // the production default (MOUSE_WHEEL_LANE_MAX_DEPTH = 8) would leave
      // maxPacedLaneDepth undefined - where `count >= undefined` is always
      // false and the cap silently never fires - and this whole suite would
      // still pass. This test omits the factory arg entirely, pinning that
      // the default itself, not just an explicitly-injected cap, bounds the
      // queue in production.
      const write = vi.fn<[string], void>();
      const batcher = createWriteBatcher(write, PACE_MS);

      for (let index = 1; index <= 10; index += 1) {
        batcher.writePaced(`r${index}`, wheelDown);
      }

      // r1 writes immediately (nothing pending ahead of it, never counted).
      // r2..r9 each see a pending same-lane depth below the default cap (0
      // through 7) and are accepted; r10 is the first arrival to see depth 8
      // and is dropped.
      expect(write.mock.calls).toEqual([['r1']]);

      vi.advanceTimersByTime(PACE_MS * 20);
      expect(write.mock.calls).toEqual([
        ['r1'],
        ['r2'],
        ['r3'],
        ['r4'],
        ['r5'],
        ['r6'],
        ['r7'],
        ['r8'],
        ['r9'],
      ]);
    });

    it('a drained slot readmits the next same-lane arrival', () => {
      const write = vi.fn<[string], void>();
      const batcher = createWriteBatcher(write, PACE_MS, LANE_CAP);

      batcher.writePaced('r1', wheelDown);
      batcher.writePaced('r2', wheelDown);
      batcher.writePaced('r3', wheelDown);
      batcher.writePaced('r4', wheelDown);
      batcher.writePaced('r5', wheelDown); // dropped at the cap, and stays dropped

      vi.advanceTimersByTime(PACE_MS); // r2 writes, freeing one slot
      batcher.writePaced('r6', wheelDown); // readmitted into the freed slot

      vi.advanceTimersByTime(PACE_MS * 10);
      expect(write.mock.calls).toEqual([['r1'], ['r2'], ['r3'], ['r4'], ['r6']]);
    });

    it('a cap-drop disturbs neither the pace floor nor the pending timer', () => {
      const write = vi.fn<[string], void>();
      const batcher = createWriteBatcher(write, PACE_MS, LANE_CAP);
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

      batcher.writePaced('r1', wheelDown); // immediate, sets the floor
      batcher.writePaced('r2', wheelDown); // schedules the one pace timer
      batcher.writePaced('r3', wheelDown);
      batcher.writePaced('r4', wheelDown);
      batcher.writePaced('r5', wheelDown); // dropped

      // Only r2's arrival scheduled a timer; the later arrivals (dropped one
      // included) found it pending and left it alone.
      expect(setTimeoutSpy).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(PACE_MS - 1);
      expect(write.mock.calls).toEqual([['r1']]);
      vi.advanceTimersByTime(1);
      expect(write.mock.calls).toEqual([['r1'], ['r2']]);
    });

    it('a cap-drop still calls drain() synchronously, delivering an already-due pending head', () => {
      // Mirrors the vi.setSystemTime technique used above for the
      // already-due head (the writePaced describe's "a synchronous drain
      // that finds an already-due paced head..." test). In every other cap
      // test in this file the head is not yet due at drop time, so the drop
      // path's drain() call (write-batcher.ts, the cap branch) is a no-op
      // either way - deleting that call would still pass the whole suite.
      // This test forces the head to be due, via a system-time jump, before
      // the scheduled paceTimer's own callback has run, then drops an
      // arrival at the cap. drain() firing on the drop path is the only
      // thing that can deliver the due head at this point: without it, r2
      // would sit pending until the fake timer is advanced, which is what
      // makes asserting synchronously here mutation-detectable.
      const write = vi.fn<[string], void>();
      const batcher = createWriteBatcher(write, PACE_MS, LANE_CAP);

      batcher.writePaced('r1', wheelDown); // immediate, sets the floor
      batcher.writePaced('r2', wheelDown); // pending; schedules the pace timer
      batcher.writePaced('r3', wheelDown); // pending
      batcher.writePaced('r4', wheelDown); // pending depth now at the cap

      // The wall clock reaches r2's deadline without that scheduled timer's
      // own callback having run yet.
      vi.setSystemTime(Date.now() + PACE_MS);

      batcher.writePaced('r5', wheelDown); // cap-dropped: pending depth is 3

      // Asserted BEFORE any vi.advanceTimersByTime: the dropped arrival's
      // own drain() call is what delivered the due head synchronously.
      expect(write.mock.calls).toEqual([['r1'], ['r2']]);

      vi.advanceTimersByTime(PACE_MS * 5);
      expect(write.mock.calls).toEqual([['r1'], ['r2'], ['r3'], ['r4']]);
      expect(write.mock.calls.flat()).not.toContain('r5');
    });

    it('laneless paced items are never capped', () => {
      const write = vi.fn<[string], void>();
      const batcher = createWriteBatcher(write, PACE_MS, LANE_CAP);

      for (const payload of ['k1', 'k2', 'k3', 'k4', 'k5', 'k6']) {
        batcher.writePaced(payload);
      }

      vi.advanceTimersByTime(PACE_MS * 10);
      expect(write.mock.calls).toEqual([['k1'], ['k2'], ['k3'], ['k4'], ['k5'], ['k6']]);
    });

    it('laneless paced items do not count toward a lane\'s pending depth', () => {
      const write = vi.fn<[string], void>();
      const batcher = createWriteBatcher(write, PACE_MS, LANE_CAP);

      batcher.writePaced('down1', wheelDown); // immediate
      batcher.writePaced('click1'); // keyless, pending
      batcher.writePaced('click2'); // keyless, pending
      batcher.writePaced('down2', wheelDown); // lane depth 0: accepted
      batcher.writePaced('down3', wheelDown); // lane depth 1: accepted
      batcher.writePaced('down4', wheelDown); // lane depth 2: accepted
      batcher.writePaced('down5', wheelDown); // lane depth at cap: dropped

      vi.advanceTimersByTime(PACE_MS * 10);
      expect(write.mock.calls).toEqual([
        ['down1'],
        ['click1'],
        ['click2'],
        ['down2'],
        ['down3'],
        ['down4'],
      ]);
    });

    it('supersede removes only the declared target lane; laneless and cross-axis items survive in order', () => {
      const write = vi.fn<[string], void>();
      const batcher = createWriteBatcher(write, PACE_MS, LANE_CAP);

      batcher.writePaced('down1', wheelDown); // immediate
      batcher.writePaced('down2', wheelDown); // pending, removed by the reversal
      batcher.writePaced('click'); // keyless: survives
      batcher.writePaced('left1', wheelLeft); // cross-axis lane: survives
      batcher.writePaced('down3', wheelDown); // pending, removed by the reversal
      batcher.writePaced('up1', wheelUp); // the reversal

      vi.advanceTimersByTime(PACE_MS * 10);
      expect(write.mock.calls).toEqual([['down1'], ['click'], ['left1'], ['up1']]);
    });

    it('supersede under a pending timer: the exposed unpaced run writes now, the reused timer delivers the survivor', async () => {
      const write = vi.fn<[string], void>();
      const batcher = createWriteBatcher(write, PACE_MS, LANE_CAP);
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
      const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

      batcher.writePaced('down1', wheelDown); // immediate; sets the floor
      batcher.writePaced('down2', wheelDown); // schedules the pace timer for the head
      batcher.schedule('typed'); // unpaced, queued behind down2
      batcher.writePaced('up1', wheelUp); // removes down2; queue is now [typed, up1]

      // The drain inside writePaced wrote the exposed unpaced run immediately
      // (arrival order for typed bytes), while up1 stays under down1's floor.
      expect(write.mock.calls).toEqual([['down1'], ['typed']]);

      // The pending timer's deadline is the global pace floor, not a property
      // of the removed head, so the supersede neither cleared nor replaced it.
      expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
      expect(clearTimeoutSpy).not.toHaveBeenCalled();

      vi.advanceTimersByTime(PACE_MS);
      expect(write.mock.calls).toEqual([['down1'], ['typed'], ['up1']]);

      // schedule('typed') queued a microtask that these synchronous
      // assertions never let fire. Draining it for real proves it finds an
      // already-empty queue rather than re-writing 'typed'.
      await drainMicrotasks();
      expect(write.mock.calls).toEqual([['down1'], ['typed'], ['up1']]);
    });

    it('flush still drops pending laned reports along with laneless ones', () => {
      const write = vi.fn<[string], void>();
      const batcher = createWriteBatcher(write, PACE_MS, LANE_CAP);

      batcher.writePaced('down1', wheelDown);
      batcher.writePaced('down2', wheelDown);
      // Laneless paced item, pending behind down2. The title claims
      // laneless coverage, but until this line the body only ever queued a
      // laned pending item plus an unpaced schedule() item - it never
      // proved a PACED laneless item is dropped by flush too.
      batcher.writePaced('release1');
      batcher.schedule('typed');
      batcher.flush();

      expect(write.mock.calls).toEqual([['down1'], ['typed']]);
      // release1 was pending and laneless: flush drops it exactly like the
      // laned down2, not merely omits it from the exact-array check above.
      expect(write.mock.calls.flat()).not.toContain('release1');

      vi.advanceTimersByTime(PACE_MS * 4);
      expect(write.mock.calls).toEqual([['down1'], ['typed']]);
      expect(write.mock.calls.flat()).not.toContain('release1');
    });

    it('flush empties a saturated lane so the next burst is not permanently capped', () => {
      // Lane depth is recomputed by re-scanning `queue` on every arrival, so
      // flush()'s queue.length = 0 already empties the pool as a side effect
      // today. That is exactly the property a later perf pass (a persistent
      // Map<laneKey, count> incremented on push / decremented on drain,
      // instead of a per-arrival recount) would be tempted to change - and
      // could easily forget to also clear on flush, leaving the lane
      // permanently saturated for the rest of the batcher's lifetime. No
      // existing test drives writePaced after a flush that left a lane at
      // the cap, so that regression would pass the whole suite silently.
      const write = vi.fn<[string], void>();
      const batcher = createWriteBatcher(write, PACE_MS, LANE_CAP);

      batcher.writePaced('d1', wheelDown); // immediate
      batcher.writePaced('d2', wheelDown); // pending
      batcher.writePaced('d3', wheelDown); // pending, lane now at the cap
      batcher.writePaced('d4', wheelDown); // dropped
      batcher.flush(); // drops d2 and d3 unwritten; lane pool must empty too

      expect(write.mock.calls).toEqual([['d1']]);

      // lastPacedWriteAt survives flush (it is not queue state), so the next
      // arrival must still clear the pace floor before it writes immediately.
      vi.advanceTimersByTime(PACE_MS);

      batcher.writePaced('e1', wheelDown); // immediate: the pace floor cleared
      batcher.writePaced('e2', wheelDown); // pending
      batcher.writePaced('e3', wheelDown); // pending
      batcher.writePaced('e4', wheelDown); // pending, lane at the cap again
      batcher.writePaced('e5', wheelDown); // dropped: proves the cap still works post-flush

      vi.advanceTimersByTime(PACE_MS * 10);
      expect(write.mock.calls).toEqual([['d1'], ['e1'], ['e2'], ['e3'], ['e4']]);
      expect(write.mock.calls.flat()).not.toContain('e5');
    });
  });

  // Nothing today fails if useTerminal.ts's onData routing line is deleted or
  // inverted: repaint-nudge.test.ts only pins isMouseReport's return value in
  // isolation, and every test above only drives writePaced/schedule directly.
  // This block closes that gap in two halves, the same split as
  // repaint-nudge.test.ts's 'isUserInputData wired into createRepaintNudge':
  // a tripwire that pins the SOURCE TEXT of the routing line (a copy of the
  // expression living only in this test file cannot detect a change to the
  // real one), and a harness that reproduces that same expression against a
  // real createWriteBatcher to pin its SEMANTICS. Neither half alone is the
  // pin - the tripwire cannot see a wiring bug in the expression it does not
  // parse, and the harness's own copy of the expression cannot see a change
  // to the source.
  describe('isMouseReport routing wired into createWriteBatcher (useTerminal.ts onData)', () => {
    it('useTerminal.ts onData routes isMouseReport(data) to writePaced and everything else to schedule', () => {
      const useTerminalPath = path.resolve(__dirname, '../../src/renderer/hooks/useTerminal.ts');
      const source = fs.readFileSync(useTerminalPath, 'utf-8');

      // Two independent regexes rather than one exact literal, so this survives
      // a benign reformat (e.g. the single-statement if/else growing braces)
      // without going soft on the thing that actually matters: which branch
      // each call sits in. Each still requires the literal call to sit right
      // after its guard, so a deletion or an inversion of the routing fails
      // both - there is no other isMouseReport(data)/batcher.schedule(data)
      // pairing anywhere else in this file for either to accidentally match.
      const mouseReportRoutesToWritePaced =
        /if\s*\(\s*isMouseReport\(data\)\s*\)\s*\{?\s*batcher\.writePaced\(data,\s*mouseWheelLane\(data\)\)/;
      const elseRoutesToSchedule = /else\s*\{?\s*batcher\.schedule\(data\)/;

      expect(source).toMatch(mouseReportRoutesToWritePaced);
      expect(source).toMatch(elseRoutesToSchedule);
    });

    describe('routing semantics against a real batcher', () => {
      const PACE_MS = 16;

      beforeEach(() => {
        vi.useFakeTimers();
      });

      afterEach(() => {
        vi.useRealTimers();
      });

      // Reproduces the routing expression pinned by the tripwire above, so
      // the assertions below are checking what that exact expression DOES,
      // not just that its text is present.
      const routeOnData = (batcher: ReturnType<typeof createWriteBatcher>, data: string): void => {
        if (isMouseReport(data)) batcher.writePaced(data, mouseWheelLane(data));
        else batcher.schedule(data);
      };

      it('routes a single SGR wheel report through writePaced: written synchronously, un-joined', () => {
        const write = vi.fn<[string], void>();
        const batcher = createWriteBatcher(write, PACE_MS);

        routeOnData(batcher, '\x1b[<64;10;5M');

        // writePaced drains synchronously; schedule would need a microtask.
        // Asserting before any await is what would catch an inversion (mouse
        // report routed to schedule instead): that variant leaves write
        // uncalled at this point.
        expect(write).toHaveBeenCalledTimes(1);
        expect(write).toHaveBeenCalledWith('\x1b[<64;10;5M');
      });

      it('routes typed bytes through schedule: not written until the microtask drains', async () => {
        const write = vi.fn<[string], void>();
        const batcher = createWriteBatcher(write, PACE_MS);

        routeOnData(batcher, 'a');

        // schedule() never writes synchronously. If routing were inverted
        // (typed bytes -> writePaced), write would already have been called
        // by this point.
        expect(write).not.toHaveBeenCalled();

        await drainMicrotasks();

        expect(write).toHaveBeenCalledTimes(1);
        expect(write).toHaveBeenCalledWith('a');
      });

      it('an SGR report and a typed byte in the same burst land as two separate writes, in arrival order', async () => {
        const write = vi.fn<[string], void>();
        const batcher = createWriteBatcher(write, PACE_MS);

        routeOnData(batcher, '\x1b[<64;10;5M');
        routeOnData(batcher, 'a');

        // The mouse report drains synchronously (writePaced); the typed byte
        // is still sitting in schedule's microtask queue. An inverted routing
        // (mouse report -> schedule) would leave write uncalled here instead.
        expect(write.mock.calls).toEqual([['\x1b[<64;10;5M']]);

        await drainMicrotasks();

        // And it must never have joined into one payload - that would mean
        // the report went through schedule too.
        expect(write.mock.calls).toEqual([['\x1b[<64;10;5M'], ['a']]);
      });

      it('a wheel reversal supersedes the pending opposite-direction report end-to-end', () => {
        const write = vi.fn<[string], void>();
        const batcher = createWriteBatcher(write, PACE_MS);

        routeOnData(batcher, '\x1b[<65;10;5M'); // wheel down: immediate
        routeOnData(batcher, '\x1b[<65;10;5M'); // wheel down: queued under the floor
        routeOnData(batcher, '\x1b[<64;10;5M'); // wheel up: supersedes the pending down

        expect(write.mock.calls).toEqual([['\x1b[<65;10;5M']]);

        // The queued down report never writes; the reversal is what drains.
        vi.advanceTimersByTime(PACE_MS * 4);
        expect(write.mock.calls).toEqual([['\x1b[<65;10;5M'], ['\x1b[<64;10;5M']]);
      });
    });
  });
});
