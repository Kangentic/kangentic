import { useEffect, useRef, useState } from 'react';
import animations from '@kangentic/branding/assets/mascot/animations.json';
import overseerRestUrl from '@kangentic/branding/assets/mascot/overseer.svg?url';
import overseerBlinkUrl from '@kangentic/branding/assets/mascot/overseer-blink.svg?url';
import overseerWaveUrl from '@kangentic/branding/assets/mascot/overseer-wave.svg?url';
import '@kangentic/branding/assets/mascot/animations.css';

export type OverseerSequence = 'none' | 'wave-once' | 'blink-loop';

/** Frame -> asset URL. Keys match animations.json's frame names and the
 *  shipped CSS's `.overseer-frame--<key>` classes. Only the frames the
 *  supported sequences actually use are imported. */
const FRAME_URLS: Record<string, string> = {
  rest: overseerRestUrl,
  blink: overseerBlinkUrl,
  wave: overseerWaveUrl,
};

/**
 * The frame KEYS this component can render. Exported for `tests/unit/branding-assets.test.ts`,
 * read from the real map rather than a hand-copied twin (as `ActivityMark`'s mark list is).
 *
 * `mountFramesFor` silently DROPS a name with no `FRAME_URLS` entry, so a branding release that
 * renamed a key while shipping the same file (`rest` -> `idle`, still `overseer.svg`) would filter
 * every frame out and render an empty div. That test's file-name check cannot see a key rename,
 * because the file it looks for is still imported; comparing key sets can.
 */
export const RENDERABLE_FRAME_KEYS = Object.keys(FRAME_URLS);

/**
 * The shipped contract, re-declared so the wide inferred JSON type is not indexed directly.
 *
 * `sequences` is PARTIAL on purpose, for the same reason `ActivityMark`'s `marks` is: this is
 * package data crossing the TypeScript boundary, so a total `Record` would be a claim the type
 * system cannot check. A branding release that renamed a sequence would still typecheck, and the
 * `?? []` below is the runtime floor. `tests/unit/branding-assets.test.ts` fails CI on that drift.
 *
 * Exported because `mountFramesFor` takes it as a parameter, so the tests can build fabricated
 * contracts for the drift cases the installed package never produces.
 */
export interface MascotAnimations {
  restFrame: string;
  sequences: Partial<Record<OverseerSequence, { mountFrames?: string[] }>>;
}

const CONTRACT = animations as unknown as MascotAnimations;

/**
 * Every frame div the given sequences need MOUNTED, read from the package's `mountFrames`.
 *
 * `mountFrames` is not `clip`: `clip` is what to PLAY, `mountFrames` is what to MOUNT. A sequence
 * rests on `restFrame` when it ends and under reduced motion even when its clip never names that
 * frame, so deriving the set from the clip mounts too little. Upstream's own example: `running-loop`
 * plays step-a and step-b but mounts step-a, step-b and rest, and mounting only the played pair
 * renders nothing at all once motion is off.
 *
 * `restFrame` is unioned in unconditionally rather than trusted to appear in every sequence's
 * `mountFrames`, because the base `.overseer-frame--rest { visibility: visible }` rule needs that
 * div to exist for the mascot to render at all.
 *
 * Names with no `FRAME_URLS` entry are dropped: this component imports only the frames its three
 * supported sequences use, so an upstream addition must not render `<img src={undefined}>`.
 *
 * Takes the contract as a parameter rather than closing over `CONTRACT` so the three drift branches
 * above (rest unioned in, unknown name dropped, sequence absent) can be pinned against fabricated
 * contracts in `tests/unit/overseer-mascot-frames.test.ts`. None of them fires against the
 * installed package, so without that they would read as untested defensive code.
 */
export function mountFramesFor(contract: MascotAnimations, sequences: OverseerSequence[]): string[] {
  const frameKeys = new Set<string>([contract.restFrame]);
  for (const sequenceKey of sequences) {
    for (const frameKey of contract.sequences[sequenceKey]?.mountFrames ?? []) {
      frameKeys.add(frameKey);
    }
  }
  return [...frameKeys].filter((frameKey) => frameKey in FRAME_URLS);
}

export interface OverseerMascotProps {
  /** Integer multiple of the 18x12 pixel grid. Width-only; height derives
   *  from the shipped CSS's aspect-ratio. Fractional scaling blurs the pixels. */
  scale: 2 | 3 | 4 | 5 | 6 | 7 | 8;
  /** The sequence the mascot settles into and stays on. */
  sequence?: OverseerSequence;
  /** Optional one-shot played once on mount before settling into `sequence`
   *  (e.g. wave hello, then blink forever). */
  intro?: OverseerSequence;
  className?: string;
}

/**
 * Renders the Overseer mascot via the shipped @kangentic/branding animation
 * contract (assets/mascot/animations.css + animations.json). No hand-written
 * keyframes or durations - pixel-art-conventions.md forbids re-authoring the
 * timings a consumer imports - and no hand-written frame list either: the mount
 * set comes from each sequence's `mountFrames` (see `mountFramesFor`).
 *
 * The intro -> sequence handoff is driven by `animationend`, never a timer, so
 * the one-shot's duration stays owned by the package. Per motion-craft, JS here
 * only swaps a class; it never animates anything itself.
 *
 * Timing/reduced-motion notes:
 * - `prefers-reduced-motion` sets `animation: none`, so no `animationend` ever
 *   fires and the mascot simply rests on the canonical frame - the correct
 *   resting rendering, reached by doing nothing.
 * - The app's own "Animations" off toggle (`.no-motion`) zeroes
 *   animation-duration instead, so the intro ends immediately and the idle
 *   sequence also runs at 0s. Both rest on the canonical frame because the
 *   shipped CSS emits no `animation-fill-mode`.
 * - At most one Overseer per view (sprite-drafting convention).
 */
export function OverseerMascot({ scale, sequence = 'none', intro, className = '' }: OverseerMascotProps) {
  const [introPlaying, setIntroPlaying] = useState(intro !== undefined);
  const introDoneRef = useRef(false);

  // Replay the intro if the caller swaps it (also resets on remount).
  useEffect(() => {
    introDoneRef.current = false;
    setIntroPlaying(intro !== undefined);
  }, [intro]);

  const activeSequence = introPlaying && intro ? intro : sequence;

  // Mount the union of both sequences' frames so the handoff never remounts an
  // <img> mid-animation. A frame the active sequence does not name simply keeps
  // the base `.overseer-frame` visibility:hidden.
  const mountedFrames = mountFramesFor(CONTRACT, intro ? [sequence, intro] : [sequence]);

  const sequenceClass = activeSequence === 'none' ? '' : `overseer--${activeSequence}`;

  return (
    <div
      className={`overseer ${sequenceClass} ${className}`}
      role="img"
      aria-label="Pixel-art Kangentic mascot"
      style={{ width: scale * 18 }}
      onAnimationEnd={() => {
        // wave-once animates both its rest and wave tracks, so two events land;
        // the ref makes the handoff idempotent.
        if (introDoneRef.current) return;
        introDoneRef.current = true;
        setIntroPlaying(false);
      }}
    >
      {mountedFrames.map((frameKey) => (
        <img
          key={frameKey}
          src={FRAME_URLS[frameKey]}
          alt=""
          aria-hidden="true"
          draggable={false}
          className={`overseer-frame overseer-frame--${frameKey} block w-full h-full`}
        />
      ))}
    </div>
  );
}
