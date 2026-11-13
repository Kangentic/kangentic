/**
 * The poster gate's two pure halves (tests/captures/helpers/frame-measure.ts and poster-gate.ts):
 * the comparison that decides whether a live frame still lays out like its poster, and the case
 * list that decides which frames the release job boots on each OS. The gate itself runs only in the
 * release workflow, so a comparison that stopped seeing a wrap, or a case list that silently lost
 * a scale or the hero, would read as a green gate with nothing checked. This pins both.
 *
 * Tier: Unit.
 */
import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { FRAME_TOLERANCES, compareFrameMeasures, countClockTexts, differsOnlyInDigits, type FrameMeasure } from '../captures/helpers/frame-measure';
import { GATE_KNOWN_DIFFERENCES, GATE_SCALES, comparePixels, gateCases, knownDifferenceSkips, posterGateSet } from '../captures/helpers/poster-gate';
import { SCENES } from '../captures/scenes';

function poster(): FrameMeasure {
  return {
    viewport: { width: 1600, height: 1000 },
    textNodes: [
      { path: 'body > div[card]', text: 'Extract auth middleware', breaks: [], lines: [{ x: 949, y: 167, width: 152, height: 18 }] },
      { path: 'body > div[preview]', text: 'Now let me get a review of my approach before writing.', breaks: [37], lines: [{ x: 936, y: 197, width: 222, height: 16 }, { x: 936, y: 213, width: 72, height: 16 }] },
    ],
    terminals: [{ session: 'sess-cw-middleware', cols: 216, rows: 14, cell: { width: 6, height: 14 }, rect: { x: 292, y: 661, width: 1296, height: 196 } }],
  };
}

describe('compareFrameMeasures', () => {
  it('passes a frame that lays out as the poster does', () => {
    expect(compareFrameMeasures(poster(), poster())).toEqual([]);
  });

  it('passes a line box moved within the tolerances, as another OS\'s text scaler moves it', () => {
    const frame = poster();
    const line = frame.textNodes[0].lines[0];
    line.x += FRAME_TOLERANCES.x;
    line.width -= FRAME_TOLERANCES.x;
    line.y += FRAME_TOLERANCES.y;
    expect(compareFrameMeasures(poster(), frame)).toEqual([]);
  });

  it('fails a different wrap even when every line box is close', () => {
    const frame = poster();
    frame.textNodes[1].breaks = [38];
    const problems = compareFrameMeasures(poster(), frame);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/wraps at \[38\] on 2 line\(s\), the poster at \[37\] on 2/);
  });

  it('fails a line box moved past the tolerance across or down', () => {
    const across = poster();
    across.textNodes[0].lines[0].width += 1;
    expect(compareFrameMeasures(poster(), across)[0]).toMatch(/line 1 is at \(949, 167\) 153x18, the poster's at \(949, 167\) 152x18/);
    const down = poster();
    down.textNodes[0].lines[0].y += 1.5;
    expect(compareFrameMeasures(poster(), down)).toHaveLength(1);
  });

  it('fails different text and stops there, since every node after it would misalign', () => {
    const frame = poster();
    frame.textNodes[0].text = 'Extract auth middleware (2)';
    frame.textNodes[1].breaks = [1];
    const problems = compareFrameMeasures(poster(), frame);
    expect(problems).toEqual([expect.stringMatching(/text node 0 reads "Extract auth middleware \(2\)"/)]);
  });

  it('fails a terminal on another grid, and one drawn somewhere else', () => {
    const grid = poster();
    grid.terminals[0].cols = 232;
    expect(compareFrameMeasures(poster(), grid)).toEqual(['terminal sess-cw-middleware is 232 by 14, the poster\'s 216 by 14']);
    const narrow = poster();
    narrow.terminals[0].rect.width = 1210;
    expect(compareFrameMeasures(poster(), narrow)[0]).toMatch(/draws at \(292, 661\) 1210x196/);
  });

  it('reads a text that differs only in its digits as a clock: its lines are held, its width is not', () => {
    const frame = poster();
    frame.textNodes[0].text = 'Extract auth middleware';
    frame.textNodes.unshift({ path: 'body > span[clock]', text: '9:04 PM', breaks: [], lines: [{ x: 10, y: 10, width: 48, height: 16 }] });
    const reference = poster();
    reference.textNodes.unshift({ path: 'body > span[clock]', text: '8:27 PM', breaks: [], lines: [{ x: 10, y: 10, width: 44, height: 16 }] });
    expect(compareFrameMeasures(reference, frame)).toEqual([]);
    expect(countClockTexts(reference, frame)).toBe(1);
    frame.textNodes[0].lines[0].y += 2;
    expect(compareFrameMeasures(reference, frame)).toHaveLength(1);
    expect(differsOnlyInDigits('664.3k', '664.8k')).toBe(true);
    expect(differsOnlyInDigits('Opus 5', 'Opus 6 (1M)')).toBe(false);
  });

  it('holds wraps but not positions at a scale no poster was shot at', () => {
    const drifted = poster();
    drifted.textNodes[1].lines[1].y += 13;
    expect(compareFrameMeasures(poster(), drifted, { comparePositions: false })).toEqual([]);
    drifted.textNodes[1].breaks = [30];
    expect(compareFrameMeasures(poster(), drifted, { comparePositions: false })).toHaveLength(1);
  });

  it('holds a terminal\'s size but not its place at a scale no poster was shot at', () => {
    const drifted = poster();
    drifted.terminals[0].rect.y -= 1.33;
    expect(compareFrameMeasures(poster(), drifted, { comparePositions: false })).toEqual([]);
    expect(compareFrameMeasures(poster(), drifted)[0]).toMatch(/draws at/);
    drifted.terminals[0].rect.height -= 14;
    expect(compareFrameMeasures(poster(), drifted, { comparePositions: false })[0]).toMatch(/draws at/);
  });

  it('fails a frame with a terminal the poster has not', () => {
    const frame = poster();
    frame.terminals.push({ ...frame.terminals[0], session: 'another' });
    expect(compareFrameMeasures(poster(), frame)).toEqual(['2 terminal(s) on the frame, 1 on the poster']);
  });

  it('fails a frame at another viewport', () => {
    const frame = poster();
    frame.viewport = { width: 1600, height: 940 };
    expect(compareFrameMeasures(poster(), frame)).toEqual(['viewport is 1600x940, the poster\'s is 1600x1000']);
  });

  it('fails a frame with a text node the poster has not, naming the first unmatched', () => {
    const frame = poster();
    frame.textNodes.push({ path: 'body > span[extra]', text: 'Extra', breaks: [], lines: [{ x: 0, y: 0, width: 30, height: 16 }] });
    expect(compareFrameMeasures(poster(), frame)).toEqual(['2 text nodes on the poster, 3 on the frame; the first unmatched is "Extra" at body > span[extra]']);
  });

  it('fails a clock that gained a line, though its wrap offsets are not held', () => {
    const reference = poster();
    reference.textNodes[0].text = '8:27 PM';
    const frame = poster();
    frame.textNodes[0].text = '9:04 PM';
    frame.textNodes[0].lines.push({ x: 949, y: 185, width: 20, height: 18 });
    frame.textNodes[0].breaks = [5];
    expect(compareFrameMeasures(reference, frame)[0]).toMatch(/wraps at \[5\] on 2 line\(s\), the poster at \[\] on 1/);
  });

  it('reports at most twenty problems and counts the rest', () => {
    const reference: FrameMeasure = { viewport: { width: 1600, height: 1000 }, textNodes: [], terminals: [] };
    const frame: FrameMeasure = { viewport: { width: 1600, height: 1000 }, textNodes: [], terminals: [] };
    for (let index = 0; index < 25; index++) {
      reference.textNodes.push({ path: `body > p:${index + 1}`, text: `Line ${index}`, breaks: [], lines: [{ x: 0, y: index * 20, width: 40, height: 16 }] });
      frame.textNodes.push({ path: `body > p:${index + 1}`, text: `Line ${index}`, breaks: [], lines: [{ x: 0, y: index * 20 + 5, width: 40, height: 16 }] });
    }
    const problems = compareFrameMeasures(reference, frame);
    expect(problems).toHaveLength(21);
    expect(problems[20]).toBe('... and 5 more');
  });
});

describe('knownDifferenceSkips', () => {
  const at = (scale: number) => ({ scale, comparePositions: scale === 2 });

  it('holds everything for a scene with no known difference', () => {
    expect(knownDifferenceSkips(undefined, at(1.25))).toEqual({ text: false, terminals: false, pixels: false });
  });

  it('skips a fractional wrap\'s text only at a fractional scale, so 1x and 2x are held', () => {
    expect(knownDifferenceSkips('fractional-wraps', at(1)).text).toBe(false);
    expect(knownDifferenceSkips('fractional-wraps', at(1.25)).text).toBe(true);
    expect(knownDifferenceSkips('fractional-wraps', at(1.5)).text).toBe(true);
    expect(knownDifferenceSkips('fractional-wraps', at(2)).text).toBe(false);
  });

  it('skips a held terminal only off the poster\'s scale, and never its text or pixels', () => {
    expect(knownDifferenceSkips('held-terminals', at(1))).toEqual({ text: false, terminals: true, pixels: false });
    expect(knownDifferenceSkips('held-terminals', at(2))).toEqual({ text: false, terminals: false, pixels: false });
  });

  it('skips pixels for a drawing that differs, and text and pixels for text that differs', () => {
    expect(knownDifferenceSkips('pixels', at(2))).toEqual({ text: false, terminals: false, pixels: true });
    expect(knownDifferenceSkips('text', at(2))).toEqual({ text: true, terminals: false, pixels: true });
  });
});

describe('comparePixels', () => {
  function png(width: number, height: number, paint: (x: number, y: number) => [number, number, number]): Buffer {
    const image = new PNG({ width, height });
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const [red, green, blue] = paint(x, y);
        const index = (y * width + x) * 4;
        image.data[index] = red;
        image.data[index + 1] = green;
        image.data[index + 2] = blue;
        image.data[index + 3] = 255;
      }
    }
    return PNG.sync.write(image);
  }
  const flat = png(32, 32, () => [40, 40, 40]);

  it('counts nothing between a frame and an identical poster', () => {
    expect(comparePixels(flat, flat)).toEqual({ differing: 0, total: 1024, sizeMismatch: null });
  });

  it('counts a block that changed, which is not antialiasing', () => {
    const changed = png(32, 32, (x, y) => (x >= 8 && x < 16 && y >= 8 && y < 16 ? [240, 240, 240] : [40, 40, 40]));
    expect(comparePixels(flat, changed).differing).toBeGreaterThan(0);
  });

  it('names a size mismatch instead of counting pixels', () => {
    expect(comparePixels(flat, png(16, 32, () => [40, 40, 40])).sizeMismatch).toBe('the frame is 16x32, the poster 32x32');
  });
});

describe('gateCases', () => {
  const cases = gateCases(posterGateSet(['board', 'new-task'], { width: 1600, height: 1000 }));

  it('boots every scene at every scale a visitor has, in rust, and in every poster theme at the poster\'s scale', () => {
    expect(GATE_SCALES).toEqual([1, 1.25, 1.5, 2]);
    const board = cases.filter((gateCase) => gateCase.scene === 'board' && gateCase.viewport.height === 1000);
    expect(board.map((gateCase) => `${gateCase.theme} ${gateCase.scale}`)).toEqual(['rust 1', 'rust 1.25', 'rust 1.5', 'clay 2', 'rust 2']);
    expect(board.every((gateCase) => gateCase.layoutFile === `scenes/board.${gateCase.theme}.frame.layout.json`)).toBe(true);
  });

  it('holds line positions only at a scale a poster was shot at', () => {
    expect(cases.filter((gateCase) => gateCase.comparePositions).map((gateCase) => gateCase.title)).toEqual([
      'board clay 2x', 'board rust 2x', 'new-task clay 2x', 'new-task rust 2x',
      'hero rust 1x still', 'hero rust 1x loop', 'hero rust 2x still', 'hero rust 2x loop',
    ]);
  });

  it('names only scenes the registry has as known differences, each with its reason', () => {
    for (const [scene, known] of Object.entries(GATE_KNOWN_DIFFERENCES)) {
      expect(SCENES[scene], scene).toBeDefined();
      expect(known.reason.length).toBeGreaterThan(20);
    }
  });

  it('compares pixels only where a poster exists at that scale', () => {
    const withPixels = cases.filter((gateCase) => gateCase.posterFile !== null).map((gateCase) => gateCase.title);
    expect(withPixels).toEqual([
      'board clay 2x', 'board rust 2x', 'new-task clay 2x', 'new-task rust 2x',
      'hero rust 1x still', 'hero rust 2x still',
    ]);
  });

  it('boots the hero as a still and as the site boots it, looping, at every scale, against the nearest still', () => {
    const hero = cases.filter((gateCase) => gateCase.viewport.height === 940);
    expect(hero).toHaveLength(GATE_SCALES.length * 2);
    expect(hero.filter((gateCase) => gateCase.motion === 'loop').every((gateCase) => gateCase.posterFile === null)).toBe(true);
    const at = (scale: number) => hero.find((gateCase) => gateCase.scale === scale && gateCase.motion === 'loop');
    expect(at(1.25)?.layoutFile).toBe('hero/hero.rust.1x.layout.json');
    expect(at(2)?.layoutFile).toBe('hero/hero.rust.2x.layout.json');
  });
});
