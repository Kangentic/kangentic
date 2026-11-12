import { describe, expect, it } from 'vitest';
import { AGENT_MARKS } from '../../src/renderer/components/agent-marks';
import { ARTIFACT_PLATFORM_MARKS } from '../../src/renderer/components/artifact-platform-marks';
import { ARTIFACT_PLATFORMS } from '../../src/shared/artifact-platforms';

/**
 * The agent marks are copied from the site as element data, and the artifact platform marks from
 * two icon sets. Two ways a copy goes wrong that the eye catches late: a shape that lost its
 * geometry draws a dot in the corner (the Droid mark's `x1`/`y1` did, once), and a mark with its
 * own color stops following the theme.
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

  it('draws an artifact platform mark only for a platform the table lists', () => {
    // A mark keyed by an id the platform table does not have is never drawn,
    // and a renamed platform would silently lose its logo.
    const platformIds = new Set(ARTIFACT_PLATFORMS.map((platform) => platform.id));
    const strays = Object.keys(ARTIFACT_PLATFORM_MARKS).filter((id) => !platformIds.has(id));
    expect(strays).toEqual([]);
    // Not vacuous: the tools a task most often links to have one.
    for (const id of ['figma', 'miro', 'notion', 'googledocs', 'claude', 'github']) {
      expect(ARTIFACT_PLATFORM_MARKS[id], `${id} has no mark`).toBeDefined();
    }
  });

  it.each([
    ...Object.entries(AGENT_MARKS),
    ...Object.entries(ARTIFACT_PLATFORM_MARKS).map(([id, mark]) => [`platform ${id}`, mark] as const),
  ])('%s keeps every shape its geometry and paints only currentColor', (_agent, mark) => {
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
