import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  mountFramesFor,
  RENDERABLE_FRAME_KEYS,
  type MascotAnimations,
} from '../../src/renderer/components/onboarding/OverseerMascot';

// `mountFramesFor` decides which frame divs the mascot mounts, reading @kangentic/branding's
// `animations.json` rather than a hand-written list. Its three drift branches - rest unioned in,
// an unknown name dropped, a sequence missing entirely - are the whole point of reading the
// package instead of hardcoding, and NONE of them fires against the installed contract:
// all three supported sequences already list `rest` in their own `mountFrames`, name only frames
// the component imports, and exist. Delete any one branch and every other test in the repo stays
// green. So they are pinned here, against fabricated contracts.
//
// `tests/unit/branding-assets.test.ts` is the complementary half: it checks the INSTALLED package
// still matches what the component consumes. This file checks the derivation itself.

const REPO_ROOT = path.resolve(__dirname, '../..');
const MASCOT_JSON = path.join(
  REPO_ROOT, 'node_modules', '@kangentic', 'branding', 'assets', 'mascot', 'animations.json',
);

describe('mountFramesFor', () => {
  it('unions the contract restFrame in even when a sequence does not name it', () => {
    // The base `.overseer-frame--rest { visibility: visible }` rule needs that div to exist for
    // the mascot to render at all - a sequence rests there when it ends and under reduced motion.
    // `running-loop` is the shipped precedent for a clip that never plays rest.
    const contract: MascotAnimations = {
      restFrame: 'rest',
      sequences: { 'blink-loop': { mountFrames: ['blink'] } },
    };
    expect(mountFramesFor(contract, ['blink-loop'])).toEqual(['rest', 'blink']);
  });

  it('drops a frame name the component has no asset import for', () => {
    // The component imports only the three frames its supported sequences use. An upstream release
    // that added `look` to blink-loop's mountFrames must not render `<img src={undefined}>`.
    const contract: MascotAnimations = {
      restFrame: 'rest',
      sequences: { 'blink-loop': { mountFrames: ['blink', 'look', 'step-a'] } },
    };
    expect(mountFramesFor(contract, ['blink-loop'])).toEqual(['rest', 'blink']);
    expect(RENDERABLE_FRAME_KEYS).not.toContain('look');
  });

  it('falls back to the rest frame alone when the contract has no such sequence', () => {
    // This is why `branding-assets.test.ts` deliberately does not require the degenerate 'none'
    // entry: upstream dropping it degrades to resting, which is the correct rendering for it.
    const contract: MascotAnimations = { restFrame: 'rest', sequences: {} };
    expect(mountFramesFor(contract, ['none'])).toEqual(['rest']);
    expect(mountFramesFor(contract, ['blink-loop', 'wave-once'])).toEqual(['rest']);
  });

  it('unions both sequences for the intro handoff, rest first, without duplicating a shared frame', () => {
    // DOM order matters: the frames are absolutely stacked, and the handoff must not remount an
    // <img> mid-animation, so the union is mounted once for both sequences.
    const contract: MascotAnimations = {
      restFrame: 'rest',
      sequences: {
        'blink-loop': { mountFrames: ['rest', 'blink'] },
        'wave-once': { mountFrames: ['rest', 'wave'] },
      },
    };
    expect(mountFramesFor(contract, ['blink-loop', 'wave-once'])).toEqual(['rest', 'blink', 'wave']);
  });

  it('derives the shipped welcome-hero mount set from the installed package', () => {
    // The end-to-end case: the real installed contract, the real call the WelcomeScreen makes
    // (sequence 'blink-loop' with a 'wave-once' intro). Pins that reading the package still
    // produces exactly the set the hand-written map used to.
    const contract: MascotAnimations = JSON.parse(fs.readFileSync(MASCOT_JSON, 'utf-8'));
    expect(mountFramesFor(contract, ['none'])).toEqual(['rest']);
    expect(mountFramesFor(contract, ['blink-loop', 'wave-once'])).toEqual(['rest', 'blink', 'wave']);
  });
});
