import {
  EventType,
  IdleReason,
  PromptReason,
  type PermissionWaitKind,
  type SessionEvent,
  type SessionUsage,
  type StreamOutputParser,
} from '../../../../shared/types';

/**
 * Goose's program status escape (#452): from 1.56 its CLI writes an OSC 7501
 * sequence to the terminal at each change of state, which is the one signal
 * Goose gives that it waits on the user. Read from Goose's own source
 * (`crates/goose-cli/src/session/program_status.rs`):
 *
 *   ESC ] 7501 ; state=<state>[:kind=permission|question]:app=goose[:msg=<base64>] ESC \
 *
 * `state` is idle, working, done, error, blocked or clear; `kind` rides only on
 * `blocked`. Goose writes it only when stdout is a terminal and
 * `GOOSE_CLI_PROGRAM_STATUS` is not turned off.
 *
 * This parser reports only the waits. Goose's activity otherwise stays on the
 * PTY tracker, whose silence timer leaves a waiting session alone (it fires
 * only while the session is thinking), so the wait holds until Goose says it
 * moved on:
 * - `blocked`: the permission wait, of the kind Goose names (`permission` is
 *   an approval). A wait with no kind is left unknown.
 * - `working` after a wait: the synthetic resume event the PTY tracker itself
 *   writes (`prompt`, `PromptReason.PtyActivity`), which clears the wait.
 * - `idle`, `done`, `error` or `clear` after a wait: `interrupted`, which
 *   clears it and settles the session idle at once. Never a plain `idle`,
 *   which the engine reads as the agent's own turn end and which would run the
 *   column's turn-end automations for an agent that reports none.
 * Every other sequence writes nothing.
 */

/** The sequence's opening; a chunk can end anywhere inside one. */
const OSC_PROGRAM_STATUS_PREFIX = '\x1b]7501;';

/**
 * Longest unterminated sequence kept across chunks. Goose caps `msg` at 2048
 * bytes before base64 (about 2732 characters), plus the fields before it.
 */
const MAX_CARRY = 4096;

/** The kind Goose's `kind` field names, as Kangentic's wait kind. */
const WAIT_KIND_BY_GOOSE_KIND: Record<string, PermissionWaitKind> = {
  question: 'question',
  permission: 'approval',
};

/** States that end a wait without Goose saying it went back to work. */
const SETTLED_STATES = new Set(['idle', 'done', 'error', 'clear']);

/** The `key=value` fields of one sequence's body (`state=blocked:kind=question:...`). */
function fieldsOf(body: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const field of body.split(':')) {
    const separator = field.indexOf('=');
    if (separator > 0) fields.set(field.slice(0, separator), field.slice(separator + 1));
  }
  return fields;
}

export class GooseProgramStatusParser implements StreamOutputParser {
  /** An unterminated sequence carried into the next chunk, or ''. */
  private carry = '';
  /** Whether the last status Goose reported was `blocked`. */
  private waiting = false;

  parseTelemetry(data: string): { usage?: Partial<SessionUsage>; events?: SessionEvent[] } | null {
    // Cheap path: with nothing carried, a chunk with no ESC holds no sequence or part of one.
    if (!this.carry && !data.includes('\x1b')) return null;
    let text = this.carry + data;
    this.carry = '';
    const events: SessionEvent[] = [];
    const now = Date.now();

    let start = text.indexOf(OSC_PROGRAM_STATUS_PREFIX);
    while (start >= 0) {
      const bodyStart = start + OSC_PROGRAM_STATUS_PREFIX.length;
      const stringTerminator = text.indexOf('\x1b\\', bodyStart);
      const bell = text.indexOf('\x07', bodyStart);
      const end = stringTerminator < 0 ? bell : (bell < 0 ? stringTerminator : Math.min(stringTerminator, bell));
      if (end < 0) {
        const pending = text.slice(start);
        this.carry = pending.length > MAX_CARRY ? '' : pending;
        break;
      }
      const event = this.eventFor(fieldsOf(text.slice(bodyStart, end)), now);
      if (event) events.push(event);
      text = text.slice(end + (end === stringTerminator ? 2 : 1));
      start = text.indexOf(OSC_PROGRAM_STATUS_PREFIX);
    }

    // A chunk can end partway through the prefix itself (`ESC ]75`): keep that tail too.
    if (!this.carry) {
      const tailStart = text.lastIndexOf('\x1b');
      if (tailStart >= 0 && OSC_PROGRAM_STATUS_PREFIX.startsWith(text.slice(tailStart))) {
        this.carry = text.slice(tailStart);
      }
    }
    return events.length > 0 ? { events } : null;
  }

  private eventFor(fields: Map<string, string>, now: number): SessionEvent | null {
    const state = fields.get('state');
    if (state === 'blocked') {
      this.waiting = true;
      const waitKind = WAIT_KIND_BY_GOOSE_KIND[fields.get('kind') ?? ''];
      return { ts: now, type: EventType.Idle, detail: IdleReason.Permission, ...(waitKind ? { waitKind } : {}) };
    }
    if (!this.waiting) return null;
    if (state === 'working') {
      this.waiting = false;
      return { ts: now, type: EventType.Prompt, detail: PromptReason.PtyActivity };
    }
    if (state && SETTLED_STATES.has(state)) {
      this.waiting = false;
      return { ts: now, type: EventType.Interrupted };
    }
    return null;
  }
}
