import { describe, it, expect } from 'vitest';
import {
  AUTOMATION_MANIFEST,
  AUTOMATION_TRIGGERS,
  RESERVED_AUTOMATION_KEYS,
  automationFieldUnavailableReason,
  isTypeOfferedOnTrigger,
} from '../../src/shared/automation-manifest';
import type { AutomationType } from '../../src/shared/types';

/**
 * Guard for the flat `kangentic.json` automation row.
 *
 * A row is written as `{ name, type, enabled, ...the type's fields }`, which
 * reads far better in a committed, reviewed file than wrapping one field in a
 * `with` object. The price of flat is that a field key can collide with a key
 * the row shape owns, and the collision is SILENT: a `webhook` adapter that
 * declared a field called `name` would quietly overwrite the automation's name
 * on every save.
 *
 * That risk grows, not shrinks, because the reserved set grows: `timeout`,
 * `retryOn` and `if` are all plausible additions. This test is what makes the
 * flat shape safe to keep.
 */
describe('automation field keys', () => {
  it('reserves every key the row shape owns, both Condition kinds included', () => {
    expect([...RESERVED_AUTOMATION_KEYS].sort()).toEqual(['condition', 'enabled', 'finalLine', 'maxRuns', 'name', 'type']);
  });

  it('never collides with a reserved row key', () => {
    for (const [type, entry] of Object.entries(AUTOMATION_MANIFEST)) {
      for (const field of entry.fields) {
        expect(
          RESERVED_AUTOMATION_KEYS as readonly string[],
          `${type}.${field.key} collides with a reserved kangentic.json row key`,
        ).not.toContain(field.key);
      }
    }
  });

  it('is unique within a type', () => {
    for (const [type, entry] of Object.entries(AUTOMATION_MANIFEST)) {
      const keys = entry.fields.map((field) => field.key);
      expect(new Set(keys).size, `${type} declares a duplicate field key`).toBe(keys.length);
    }
  });

  it('is a plain identifier, so it round-trips through JSON unquoted', () => {
    for (const [type, entry] of Object.entries(AUTOMATION_MANIFEST)) {
      for (const field of entry.fields) {
        expect(field.key, `${type}.${field.key} is not a plain key`).toMatch(/^[a-z][A-Za-z0-9]*$/);
      }
    }
  });

  it('gives a number field its unit, and nothing else a unit', () => {
    // A bare box holding "5" does not say five of what, and the reader has no
    // way to find out: the value is stored unitless and the label is the only
    // other text in the row. Every number field states its unit or this fails.
    for (const [type, entry] of Object.entries(AUTOMATION_MANIFEST)) {
      for (const field of entry.fields) {
        if (field.kind === 'number') {
          expect(field.unit, `${type}.${field.key} is a number with no unit`).toBeTruthy();
        } else {
          expect(field.unit, `${type}.${field.key} declares a unit it cannot render`).toBeUndefined();
        }
      }
    }
  });

  it('gives a select or segmented field its options, and nothing else options', () => {
    for (const [type, entry] of Object.entries(AUTOMATION_MANIFEST)) {
      for (const field of entry.fields) {
        const needsOptions = field.kind === 'select' || field.kind === 'segmented';
        if (needsOptions) {
          expect(field.options?.length, `${type}.${field.key} has no options`).toBeGreaterThan(0);
        } else {
          expect(field.options, `${type}.${field.key} declares options it cannot render`).toBeUndefined();
        }
      }
    }
  });

  it('declares a trigger it does nothing on only where the dialog can show it, with a one-line reason', () => {
    // The Edit automation dialog shows `unavailableOn` by disabling the field's
    // options, each carrying the reason as its tip, so only a segmented field
    // can render it. A trigger the type is never offered on is not a row that
    // can exist, and a reason is a hover tip, so it stays one short line.
    for (const [type, entry] of Object.entries(AUTOMATION_MANIFEST)) {
      for (const field of entry.fields) {
        if (field.unavailableOn === undefined) continue;
        const { trigger, reason } = field.unavailableOn;
        expect(field.kind, `${type}.${field.key} declares unavailability it cannot render`).toBe('segmented');
        expect(AUTOMATION_TRIGGERS as readonly string[], `${type}.${field.key} names no trigger`).toContain(trigger);
        expect(
          isTypeOfferedOnTrigger(type as AutomationType, trigger),
          `${type}.${field.key} is unavailable on a trigger ${type} is never offered on`,
        ).toBe(true);
        expect(reason.trim(), `${type}.${field.key} gives no reason`).not.toBe('');
        expect(reason, `${type}.${field.key}'s reason is not one line`).not.toMatch(/\n/);
        expect(reason.length, `${type}.${field.key}'s reason is too long for a tip`).toBeLessThan(110);
      }
    }
  });

  it("declares Send message's Delivery unavailable at a turn end, where the turn is already over", () => {
    const delivery = AUTOMATION_MANIFEST.send_message.fields.find((field) => field.key === 'mode');
    if (!delivery) throw new Error('send_message has no Delivery field');
    expect(automationFieldUnavailableReason(delivery, 'turn_end')).toBe('At a turn end the turn is over, so it sends at once.');
    expect(automationFieldUnavailableReason(delivery, 'enter')).toBeNull();
    expect(automationFieldUnavailableReason(delivery, 'exit')).toBeNull();
  });
});
