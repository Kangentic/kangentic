import { describe, it, expect } from 'vitest';
import { AUTOMATION_MANIFEST, RESERVED_AUTOMATION_KEYS } from '../../src/shared/automation-manifest';

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
});
