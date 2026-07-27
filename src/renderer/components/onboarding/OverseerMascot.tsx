import { useEffect, useRef, useState } from 'react';
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

/** Which frames each sequence needs mounted, per animations.json. */
const SEQUENCE_FRAMES: Record<OverseerSequence, string[]> = {
  none: ['rest'],
  'wave-once': ['rest', 'wave'],
  'blink-loop': ['rest', 'blink'],
};

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
 * timings a consumer imports.
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
  const mountedFrames = [...new Set([
    ...SEQUENCE_FRAMES[sequence],
    ...(intro ? SEQUENCE_FRAMES[intro] : []),
  ])];

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
