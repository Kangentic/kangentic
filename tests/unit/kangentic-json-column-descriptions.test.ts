/**
 * The workflow planner and kangentic_list_columns print each column's
 * description as its purpose. A column committed without one gives the planner
 * nothing to route by, so every team-shared column must carry a real sentence.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('kangentic.json column descriptions', () => {
  it('gives every column a non-empty description', () => {
    const config = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../kangentic.json'), 'utf8')) as {
      columns: Array<{ name: string; description?: string }>;
    };
    expect(config.columns.length).toBeGreaterThan(0);
    const missing = config.columns
      .filter((column) => typeof column.description !== 'string' || column.description.trim() === '')
      .map((column) => column.name);
    expect(missing).toEqual([]);
  });
});
