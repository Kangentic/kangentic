import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { KEYBOARD_SENSOR_OPTIONS, POINTER_SENSOR_OPTIONS } from '../../src/renderer/utils/dnd-sensor-options';

// dnd-kit memoizes `useSensor` on the options object's identity. An inline literal is a
// new object on every render, so every render of a DndContext owner built new sensors,
// new activators and a new internal context, and every useSortable under it re-rendered
// past React.memo. On the board that was every card and column on every board reload
// (378 components, 25 to 29 ms in dev, for one agent's update to one task). See
// src/renderer/utils/dnd-sensor-options.ts.

const REPO_ROOT = path.resolve(__dirname, '../..');
const SCAN_DIR = path.join(REPO_ROOT, 'src', 'renderer');

function collectSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectSourceFiles(fullPath));
    else if (/\.tsx?$/.test(entry.name)) files.push(fullPath);
  }
  return files;
}

describe('dnd-kit sensor options are module constants', () => {
  it('no useSensor call passes an inline object or array literal', () => {
    const offenders: string[] = [];
    let sensorCalls = 0;
    for (const filePath of collectSourceFiles(SCAN_DIR)) {
      const source = fs.readFileSync(filePath, 'utf-8');
      for (const match of source.matchAll(/useSensor\(\s*\w+\s*(,\s*([\s\S]))?/g)) {
        sensorCalls += 1;
        const firstOptionCharacter = match[2];
        if (firstOptionCharacter === '{' || firstOptionCharacter === '[') {
          const line = source.slice(0, match.index).split('\n').length;
          offenders.push(`${path.relative(REPO_ROOT, filePath).replace(/\\/g, '/')}:${line}`);
        }
      }
    }
    // The renderer registers sensors at seven sites, most with two sensors; a scan that
    // finds none has stopped matching, not proven anything.
    expect(sensorCalls).toBeGreaterThanOrEqual(10);
    expect(
      offenders,
      'Pass a module constant (src/renderer/utils/dnd-sensor-options.ts), not an inline literal: ' +
        `an inline literal rebuilds the sensors on every render.\nOffenders:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('the shared options keep the values the sites used', () => {
    expect(POINTER_SENSOR_OPTIONS).toEqual({ activationConstraint: { distance: 5 } });
    expect(KEYBOARD_SENSOR_OPTIONS.coordinateGetter).toBe(sortableKeyboardCoordinates);
  });
});
