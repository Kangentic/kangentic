import { useLayoutEffect, useRef, useState, type RefObject } from 'react';

/**
 * What a board card's count chip ("3 artifacts") shows, widest first:
 *
 * - `full`: the word and the chevron.
 * - `word`: the word; the chevron gave way to it.
 * - `number-chevron`: the number and the chevron, once the word does not fit.
 * - `number`: the number alone, at the Fill floor beside a PR pill.
 *
 * The number always shows. The chevron, the one sign that the chip opens a
 * menu, comes back beside the number whenever the two fit.
 *
 * The chip's children hide through `group-data-[count-step=...]/count`
 * variants in `ArtifactsChip.tsx`, which Tailwind needs as literal class text.
 * They must name the same steps as `countStepShowsWord` and
 * `countStepShowsChevron` below.
 */
export type ArtifactCountStep = 'full' | 'word' | 'number-chevron' | 'number';

const COUNT_STEPS: readonly ArtifactCountStep[] = ['full', 'word', 'number-chevron', 'number'];

/** The chip's own attribute; its children's `group-data-[count-step=...]` variants read it. */
const COUNT_STEP_ATTRIBUTE = 'countStep';

/** Whether the chip shows the count's word ("3 artifacts") at `step`, and not the bare number. */
export function countStepShowsWord(step: ArtifactCountStep): boolean {
  return step === 'full' || step === 'word';
}

/** Whether the chip shows its chevron at `step`. */
export function countStepShowsChevron(step: ArtifactCountStep): boolean {
  return step === 'full' || step === 'number-chevron';
}

/**
 * The widest step whose measured width fits `available`, or `number` when none
 * does. Half a pixel of slack absorbs sub-pixel rounding between the two reads.
 */
export function chooseArtifactCountStep(
  widths: Readonly<Record<ArtifactCountStep, number>>,
  available: number,
): ArtifactCountStep {
  return COUNT_STEPS.find((candidate) => widths[candidate] <= available + 0.5) ?? 'number';
}

/** Each step's width at its content's own size, for one label. */
export interface StepWidths {
  countLabel: string;
  widths: Record<ArtifactCountStep, number>;
}

/**
 * Whether the widths in hand cannot serve `countLabel`: none yet, a different
 * label ("3 artifacts" became "2 artifacts", or the language changed), or a
 * chip first measured while hidden, whose widths all read zero.
 */
export function needsStepMeasure(measured: StepWidths | null, countLabel: string): boolean {
  return !measured || measured.countLabel !== countLabel || measured.widths.full === 0;
}

/**
 * Each step's width with nothing cut off: the chip set to that step and to an
 * unshrinkable `max-content` for the read, all inside one layout with no paint
 * between, then put back. Zero for a chip that is not laid out (a hidden card).
 */
function measureStepWidths(chip: HTMLElement, countLabel: string): StepWidths {
  const widths = { full: 0, word: 0, 'number-chevron': 0, number: 0 };
  const previousWidth = chip.style.width;
  const previousShrink = chip.style.flexShrink;
  // Put back as React last wrote it, since React writes it only when the step changes.
  const previousStep = chip.dataset[COUNT_STEP_ATTRIBUTE];
  // The chip is a flex item that may shrink, which would clamp `max-content` back to its slot.
  chip.style.flexShrink = '0';
  chip.style.width = 'max-content';
  for (const step of COUNT_STEPS) {
    chip.dataset[COUNT_STEP_ATTRIBUTE] = step;
    widths[step] = chip.getBoundingClientRect().width;
  }
  chip.style.width = previousWidth;
  chip.style.flexShrink = previousShrink;
  if (previousStep === undefined) delete chip.dataset[COUNT_STEP_ATTRIBUTE];
  else chip.dataset[COUNT_STEP_ATTRIBUTE] = previousStep;
  return { countLabel, widths };
}

/**
 * Picks the count chip's step by measuring, as `toolbar-collapse.ts` and
 * `Tabs.tsx` pick theirs: how wide the word is depends on the language, so a
 * fixed width tuned on "artifacts" cut a longer word mid-word.
 *
 * Each step's width is measured once per label (`measureStepWidths`). A resize
 * then only compares the chip's width with those numbers and keeps the first
 * step that fits, so a column's width animation or a window drag reads one
 * width per frame and writes nothing. The chip's width comes from its slot on
 * the card (the row, or half of it), never its content, so a step change cannot
 * resize the chip and loop the observer.
 *
 * The first step is picked inside the layout effect, so React renders it before
 * the chip's first paint. A resize after that picks from the observer, whose
 * update React may render a frame later; the word's `truncate` covers that
 * frame. `enabled` is false for a one-artifact chip, whose name simply cuts off.
 */
export function useArtifactCountStep(
  chipRef: RefObject<HTMLElement | null>,
  countLabel: string,
  enabled: boolean,
): ArtifactCountStep {
  const [step, setStep] = useState<ArtifactCountStep>('full');
  const measuredRef = useRef<StepWidths | null>(null);

  useLayoutEffect(() => {
    const chip = chipRef.current;
    if (!enabled || !chip) return;

    let disposed = false;
    const update = (): void => {
      const available = chip.getBoundingClientRect().width;
      if (available === 0) return;
      let measured = measuredRef.current;
      if (!measured || needsStepMeasure(measured, countLabel)) {
        measured = measureStepWidths(chip, countLabel);
        measuredRef.current = measured;
      }
      setStep(chooseArtifactCountStep(measured.widths, available));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(chip);
    // Widths read before a font finished loading are a fallback font's, as
    // `useLaneWidthMotion` knows for the lane headers. Once the fonts are in,
    // the widths just read are already the real ones.
    if (document.fonts && document.fonts.status !== 'loaded') {
      void document.fonts.ready.then(() => {
        if (disposed) return;
        measuredRef.current = null;
        update();
      });
    }
    return () => {
      disposed = true;
      observer.disconnect();
    };
  }, [chipRef, countLabel, enabled]);

  return step;
}
