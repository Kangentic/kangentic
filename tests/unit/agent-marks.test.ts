import { describe, expect, it } from 'vitest';
import { AGENT_MARKS } from '../../src/renderer/components/agent-marks';

/**
 * The agent marks are copied from the site as element data. Two ways a copy goes wrong that the
 * eye catches late: a shape that lost its geometry draws a dot in the corner (the Droid mark's
 * `x1`/`y1` did, once), and a mark with its own color stops following the theme.
 */
const GEOMETRY: Record<string, readonly string[]> = {
  path: ['d'],
  rect: ['x', 'y', 'width', 'height'],
  circle: ['cx', 'cy', 'r'],
  line: ['x1', 'y1', 'x2', 'y2'],
};

describe('agent marks', () => {
  it('covers the agents the app runs', () => {
    expect(Object.keys(AGENT_MARKS).sort()).toEqual([
      'aider', 'antigravity', 'claude', 'codex', 'copilot', 'cursor', 'droid', 'gemini', 'goose', 'grok', 'kimi',
      'ollama', 'opencode', 'qwen', 'warp',
    ]);
  });

  it.each(Object.entries(AGENT_MARKS))('%s keeps every shape its geometry and paints only currentColor', (_agent, mark) => {
    expect(mark.viewBox).toMatch(/^0 0 [\d.]+ [\d.]+$/);
    expect(mark.shapes.length).toBeGreaterThan(0);
    for (const shape of mark.shapes) {
      for (const attribute of GEOMETRY[shape.tag]) {
        expect(shape.attributes[attribute], `${shape.tag} is missing ${attribute}`).toBeDefined();
      }
    }
    const paints = [mark.root, ...mark.shapes.map((shape) => shape.attributes)]
      .flatMap((attributes) => [attributes.fill, attributes.stroke])
      .filter((paint): paint is string => paint !== undefined);
    expect(paints.length).toBeGreaterThan(0);
    for (const paint of paints) expect(['currentColor', 'none']).toContain(paint);
  });
});
