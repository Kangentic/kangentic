import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { KeyboardSensor } from '@dnd-kit/core';
import {
  INITIAL_FOCUS_ORIGIN,
  IntentKeyboardSensor,
  movesFocusByDefault,
  nextFocusOrigin,
  type FocusOriginEvent,
  type FocusOriginState,
} from '../../src/renderer/utils/intent-keyboard-sensor';

// Enforces .claude/rules/keyboard-drag-intent.md. dnd-kit's stock KeyboardSensor
// starts a drag on any Space/Enter that reaches a focused sortable, and a mouse
// press focuses every sortable here, so a pointer drag followed by Enter lifted a
// card into a DragOverlay ghost that no click or terminal keystroke could end
// (8m48s on the dogfooding board). IntentKeyboardSensor is the one keyboard
// sensor: it arms only on keyboard-placed focus and cancels when intent moves.
//
// Three things are pinned here. The scan keeps every `useSensor` site on the
// shared class. The internals pin catches a dnd-kit bump that renames the two
// private members the subclass reaches through its one cast, which would
// otherwise fail only at the first keyboard pickup in a running app. The reducer
// table covers the focus-origin rules the UI tier cannot isolate one at a time.

const REPO_ROOT = path.resolve(__dirname, '../..');
const SCAN_DIR = 'src/renderer';
const SENSOR_MODULE = 'src/renderer/utils/intent-keyboard-sensor.ts';
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);

function collectSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(fullPath));
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }
  return files;
}

function toPosix(relativePath: string): string {
  return relativePath.replace(/\\/g, '/');
}

describe('the shared keyboard sensor is the only keyboard sensor', () => {
  it('no renderer file outside the sensor module names dnd-kit KeyboardSensor', () => {
    const offenders: string[] = [];
    for (const filePath of collectSourceFiles(path.join(REPO_ROOT, SCAN_DIR))) {
      const relative = toPosix(path.relative(REPO_ROOT, filePath));
      if (relative === SENSOR_MODULE) continue;
      const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
      lines.forEach((line, index) => {
        // The identifier, not just the `useSensor(KeyboardSensor` call, so an
        // aliased import (`KeyboardSensor as Stock`) is caught at the import.
        // A comment that mentions the name by way of explanation is fine.
        const code = line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
        if (/\bKeyboardSensor\b/.test(code)) offenders.push(`${relative}:${index + 1}`);
      });
    }
    expect(
      offenders,
      'dnd-kit\'s stock KeyboardSensor arms on a mouse-focused sortable and cannot end on a click. ' +
        'Register IntentKeyboardSensor (src/renderer/utils/intent-keyboard-sensor.ts) instead. ' +
        `See .claude/rules/keyboard-drag-intent.md.\nOffenders:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('every useSensor site that sorts by keyboard registers the shared sensor (the scan is not vacuous)', () => {
    const sites = [
      'src/renderer/hooks/useBoardDragDrop.ts',
      'src/renderer/hooks/useBacklogDragDrop.ts',
      'src/renderer/components/dialogs/board-manager/ColumnRail.tsx',
      'src/renderer/components/dialogs/board-manager/AutomationsPane.tsx',
      'src/renderer/components/backlog/manage-labels/PrioritiesPopover.tsx',
      'src/renderer/components/settings/tabs/ShortcutsTab.tsx',
    ];
    for (const site of sites) {
      const source = fs.readFileSync(path.join(REPO_ROOT, site), 'utf-8');
      expect(source, `${site} must register IntentKeyboardSensor`).toMatch(/useSensor\(IntentKeyboardSensor,/);
    }
  });
});

describe('the board DragOverlay measured box is the card box', () => {
  // dnd-kit measures the overlay's FIRST CHILD (`getMeasurableNode`) for the
  // collision rect and the drop animation. A transform on that node skews both:
  // the tilt leaned the rect 1.6px left of the card, the keyboard coordinate
  // getter's "to the right of" test then admitted every same-column sibling,
  // and ArrowRight landed on the card below instead of the next column. The
  // tilt therefore lives one level down, on `.drag-overlay-tilt`.
  //
  // These two read the CSS rule and the JSX as text, so they are a tripwire for
  // the shape that shipped, not a proof: a transform that arrives through a
  // Tailwind utility class on the measured div, or from a rule elsewhere, is
  // invisible here. The guard with teeth is the UI case "ArrowRight moves a
  // keyboard drag into the next column" in board-keyboard-drag-intent.spec.ts,
  // which is red against the old geometry.
  it('.drag-overlay carries no transform and .drag-overlay-tilt carries the tilt', () => {
    const css = fs.readFileSync(path.join(REPO_ROOT, 'src/renderer/index.css'), 'utf-8');
    const overlayRule = css.match(/\.drag-overlay\s*\{([^}]*)\}/);
    const tiltRule = css.match(/\.drag-overlay-tilt\s*\{([^}]*)\}/);
    expect(overlayRule, '.drag-overlay rule').not.toBeNull();
    expect(tiltRule, '.drag-overlay-tilt rule').not.toBeNull();
    expect(overlayRule?.[1]).not.toMatch(/transform\s*:/);
    expect(tiltRule?.[1]).toMatch(/transform\s*:\s*rotate\(/);
  });

  it('KanbanBoard nests the tilt layer inside the measured overlay node', () => {
    const source = fs.readFileSync(path.join(REPO_ROOT, 'src/renderer/components/board/KanbanBoard.tsx'), 'utf-8');
    expect(source).toMatch(/className="drag-overlay">\s*<div className="drag-overlay-tilt">/);
  });
});

describe('the dnd-kit internals the subclass relies on', () => {
  it('KeyboardSensor still has detach() and one onKeyDown activator to delegate to', () => {
    const prototype = KeyboardSensor.prototype as unknown as Record<string, unknown>;
    expect(typeof prototype.detach, 'KeyboardSensor.prototype.detach').toBe('function');
    const keyDownActivators = KeyboardSensor.activators.filter((activator) => activator.eventName === 'onKeyDown');
    expect(keyDownActivators).toHaveLength(1);
  });

  it('IntentKeyboardSensor shadows only the static members it means to', () => {
    expect(IntentKeyboardSensor.activators).toHaveLength(1);
    expect(IntentKeyboardSensor.activators[0].eventName).toBe('onKeyDown');
    expect(IntentKeyboardSensor.activators[0].handler).not.toBe(KeyboardSensor.activators[0].handler);
    expect(typeof IntentKeyboardSensor.setup).toBe('function');
  });

  it('the subclass never redeclares an instance member dnd-kit assigns in its constructor', () => {
    // A subclass field of the same name runs its initializer after super() and
    // clobbers what the base constructor assigned, which would silently drop the
    // registry the cancel relies on. Class fields compile to constructor
    // assignments, so the source is the only place they are visible without a
    // DOM to construct against; a helper METHOD on the prototype is fine.
    const source = fs.readFileSync(path.join(REPO_ROOT, SENSOR_MODULE), 'utf-8');
    const classStart = source.indexOf('export class IntentKeyboardSensor');
    expect(classStart, 'the sensor module declares IntentKeyboardSensor').toBeGreaterThan(-1);
    const classBody = source.slice(classStart);
    for (const member of ['props', 'listeners', 'windowListeners', 'referenceCoordinates', 'autoScrollEnabled']) {
      expect(classBody, `IntentKeyboardSensor must not declare a \`${member}\` field`)
        .not.toMatch(new RegExp(`^\\s+(?:private |protected |public |readonly |declare )*${member}\\s*[:=]`, 'm'));
    }
    // `listeners` is assigned by dnd-kit's constructor (it needs a DOM), so the
    // UI spec's positive control and the constructor's own assertion pin it.
  });
});

describe('focus-origin reducer', () => {
  const card = { name: 'card' };
  const terminal = { name: 'terminal' };

  function run(events: FocusOriginEvent[], from: FocusOriginState = INITIAL_FOCUS_ORIGIN): FocusOriginState {
    return events.reduce(nextFocusOrigin, from);
  }

  it('only Tab and the arrow keys move focus by default', () => {
    expect(movesFocusByDefault('Tab')).toBe(true);
    expect(movesFocusByDefault('ArrowDown')).toBe(true);
    expect(movesFocusByDefault('Enter')).toBe(false);
    expect(movesFocusByDefault(' ')).toBe(false);
    expect(movesFocusByDefault('Escape')).toBe(false);
  });

  it('a focus that lands during a Tab is keyboard-placed', () => {
    const state = run([{ type: 'keydown', key: 'Tab' }, { type: 'focusin', target: card }]);
    expect(state.keyboardFocused).toBe(card);
  });

  it('a focus that lands after Enter is a script restore, not keyboard-placed', () => {
    // BaseDialog's trapFocus hands focus back to the opener when Enter confirms
    // the dialog. The card must not be armed by that.
    const state = run([{ type: 'keydown', key: 'Enter' }, { type: 'focusin', target: card }]);
    expect(state.keyboardFocused).toBeNull();
    expect(state.keyboardMovePending).toBe(false);
  });

  it('a focus that lands after the pending window expired is not keyboard-placed', () => {
    const state = run([
      { type: 'keydown', key: 'Tab' },
      { type: 'pending-expired' },
      { type: 'focusin', target: card },
    ]);
    expect(state.keyboardFocused).toBeNull();
  });

  it('a pointer press revokes keyboard-placed focus, even with no focusin after it', () => {
    // A press on the already-focused card fires no focusin, so this is the only
    // place that press can be recorded.
    const armed = run([{ type: 'keydown', key: 'Tab' }, { type: 'focusin', target: card }]);
    expect(run([{ type: 'pointerdown' }], armed).keyboardFocused).toBeNull();
  });

  it('a focus that moves elsewhere with nothing pending clears the classification', () => {
    const armed = run([{ type: 'keydown', key: 'Tab' }, { type: 'focusin', target: card }, { type: 'pending-expired' }]);
    expect(run([{ type: 'focusin', target: terminal }], armed).keyboardFocused).toBeNull();
  });

  it('a re-fired focusin on the same element keeps a keyboard-placed focus (alt-tab back)', () => {
    const armed = run([{ type: 'keydown', key: 'Tab' }, { type: 'focusin', target: card }, { type: 'pending-expired' }]);
    expect(run([{ type: 'focusin', target: card }], armed).keyboardFocused).toBe(card);
  });

  it('a mouse-placed focus followed by keys that do not move focus stays mouse-placed', () => {
    const state = run([
      { type: 'pointerdown' },
      { type: 'focusin', target: card },
      { type: 'keydown', key: ' ' },
      { type: 'keydown', key: 'Enter' },
    ]);
    expect(state.keyboardFocused).toBeNull();
  });
});
