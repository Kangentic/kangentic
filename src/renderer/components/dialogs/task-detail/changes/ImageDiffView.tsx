import { useState, type CSSProperties, type ReactNode } from 'react';
import { Blend, ChevronsLeftRight, Columns2, ImageOff, Loader2, Rows2, ScanSearch, SquareSplitHorizontal } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { formatBytes } from '../../../../lib/format-bytes';
import { IMAGE_PREVIEW_MAX_BYTES } from '../../../../../shared/image-preview';
import type { DiffImageContent, DiffImageSide } from './diff-content';
import { PIXEL_DIFF_COLOR_CSS, usePixelDiff, type DecodedImageSide, type PixelDiffState } from './pixel-diff-client';

/**
 * The Changes panel's image view: before and after images in place of a text
 * diff, for raster images and for an SVG's preview. Rendered inside DiffViewer
 * so the in-app panel and the per-file pop-out share it.
 *
 * Layout, top to bottom: the stage (images only, nothing written over them
 * except the Slider's two labels), a fixed info bar of tiles (sizes,
 * dimensions, the Diff mode's changed-pixel share), the Overlay opacity
 * slider while that mode is on, and the mode row. The info bar sits in the
 * same place in every mode so its numbers never move while stepping files.
 *
 * The root is a named container (`image-diff`). Below 300px, the width a
 * dragged-narrow pane reaches before its 240px floor, the mode row drops to
 * icons (each keeps its name in `aria-label` and `title`) and the tiles stack
 * one per line, so no value clips.
 */

export type ImageCompareMode = 'side-by-side' | 'slider' | 'overlay' | 'diff';

interface ImageDiffViewProps {
  image: DiffImageContent;
  /** The diff's split/inline toggle: Side by side lays the images out left/right, or stacks them. */
  layout: 'split' | 'inline';
  mode: ImageCompareMode;
  onModeChange: (mode: ImageCompareMode) => void;
  /** Vector images (SVG) scale up to fill the pane; raster images never draw past their natural size. */
  scalable: boolean;
}

interface ModeOption {
  value: ImageCompareMode;
  label: string;
  title: string;
  icon: LucideIcon;
}

function modeOptions(layout: 'split' | 'inline'): ModeOption[] {
  return [
    layout === 'inline'
      ? { value: 'side-by-side', label: 'Stacked', title: 'Stacked', icon: Rows2 }
      : { value: 'side-by-side', label: 'Side by side', title: 'Side by side', icon: Columns2 },
    { value: 'slider', label: 'Slider', title: 'Slider: drag to reveal the new image', icon: SquareSplitHorizontal },
    { value: 'overlay', label: 'Overlay', title: 'Overlay: fade between the two images', icon: Blend },
    { value: 'diff', label: 'Diff', title: 'Diff: highlight the pixels that changed', icon: ScanSearch },
  ];
}

const PLACEHOLDER_TEXT: Record<Exclude<DiffImageSide['kind'], 'image'>, string> = {
  'too-large': 'Too large to preview',
  'lfs-pointer': 'Git LFS pointer',
  undecodable: 'Not image data',
  unreadable: 'Could not read',
};

/**
 * Fills tiles a step lighter than the pane (depth lifts, never recesses), with
 * no border. Stacked (narrow), a tile sizes to its content (`flex-none`): with
 * `flex-1`'s zero basis and `overflow-hidden`, a pane narrower than one line
 * clipped the wrapped size pill instead of growing the tile. Side by side
 * (wide), tiles share the row.
 */
const TILE_CLASS = 'flex min-w-0 flex-none flex-wrap items-center gap-x-2 gap-y-0.5 overflow-hidden whitespace-nowrap rounded bg-surface-hover/50 px-2 py-1 text-xs @[300px]/image-diff:flex-1 @[300px]/image-diff:py-1.5';

/**
 * Fit an image of `width` x `height` inside the nearest size container (the
 * `@container-size` box around it) with CSS alone: the width is the
 * smallest of the box's width, the width the box's height allows at this
 * aspect ratio, and (for raster) the natural width.
 */
function fittedSize(width: number, height: number, scalable: boolean): CSSProperties {
  const widthLimits = scalable ? '100cqw' : `${width}px, 100cqw`;
  return { aspectRatio: `${width} / ${height}`, width: `min(${widthLimits}, calc(100cqh * ${width / height}))` };
}

function sizeOf(side: DiffImageSide | null): number | null {
  if (side === null || side.kind === 'unreadable') return null;
  return side.size;
}

export function ImageDiffView({ image, layout, mode, onModeChange, scalable }: ImageDiffViewProps) {
  const { original, modified } = image;
  const hasBothSides = original !== null && modified !== null;
  const decodedOriginal = original?.kind === 'image' ? original : null;
  const decodedModified = modified?.kind === 'image' ? modified : null;
  // Slider, Overlay and Diff draw both images on one canvas, so they need both decoded.
  const comparable = decodedOriginal !== null && decodedModified !== null;
  const effectiveMode: ImageCompareMode = comparable ? mode : 'side-by-side';
  const [sliderPosition, setSliderPosition] = useState(50);
  const [overlayOpacity, setOverlayOpacity] = useState(50);
  const pixelDiff = usePixelDiff(decodedOriginal, decodedModified, effectiveMode === 'diff', scalable);

  const presentSides = [original, modified].filter((side): side is DiffImageSide => side !== null);
  const everySideTooLarge = presentSides.length > 0 && presentSides.every((side) => side.kind === 'too-large');
  const showModeRow = hasBothSides && (decodedOriginal !== null || decodedModified !== null);

  let stage: ReactNode;
  if (everySideTooLarge) {
    stage = (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center" data-testid="diff-image-too-large">
        <ImageOff size={22} className="text-fg-disabled" aria-hidden="true" />
        <span className="text-sm text-fg-muted">Too large to preview</span>
        <span className="text-xs text-fg-faint">Previews stop at {formatBytes(IMAGE_PREVIEW_MAX_BYTES)} per image</span>
      </div>
    );
  } else if (!hasBothSides) {
    const onlySide = original ?? modified;
    stage = onlySide ? <ImageBox side={onlySide} alt="Image preview" scalable={scalable} testId="diff-image-single" /> : null;
  } else if (effectiveMode === 'side-by-side' || decodedOriginal === null || decodedModified === null) {
    // With both images decoded, each side draws inside the same frame (the
    // larger width by the larger height), pinned top-left, so both share one
    // scale and their tops line up: a regenerated screenshot that grew 40px
    // shows the growth at the bottom instead of floating one image lower.
    const sharedFrame = decodedOriginal !== null && decodedModified !== null
      ? { width: Math.max(decodedOriginal.width, decodedModified.width), height: Math.max(decodedOriginal.height, decodedModified.height) }
      : undefined;
    stage = (
      <div className={`flex min-h-0 min-w-0 flex-1 gap-3 ${layout === 'inline' ? 'flex-col' : 'flex-row'}`}>
        <ImageBox side={original} alt="Before" scalable={scalable} frame={sharedFrame} testId="diff-image-before" />
        <ImageBox side={modified} alt="After" scalable={scalable} frame={sharedFrame} testId="diff-image-after" />
      </div>
    );
  } else {
    stage = (
      <CompositeStage
        before={decodedOriginal}
        after={decodedModified}
        mode={effectiveMode}
        scalable={scalable}
        sliderPosition={sliderPosition}
        onSliderPositionChange={setSliderPosition}
        overlayOpacity={overlayOpacity}
        pixelDiff={pixelDiff}
      />
    );
  }

  return (
    <div className="@container/image-diff flex h-full flex-col" data-testid="diff-image-view" data-mode={effectiveMode}>
      <div className="flex min-h-0 flex-1 select-none p-3" data-testid="diff-image-stage">
        {stage}
      </div>
      <ImageInfoBar original={original} modified={modified} pixelDiff={effectiveMode === 'diff' ? pixelDiff : null} />
      {effectiveMode === 'overlay' && (
        <div className="flex flex-shrink-0 items-center gap-2 px-3 pb-2 text-xs text-fg-tertiary">
          <span>Before</span>
          <input
            type="range"
            min={0}
            max={100}
            value={overlayOpacity}
            onChange={(event) => setOverlayOpacity(Number(event.target.value))}
            aria-label="After image opacity"
            data-testid="diff-image-overlay-opacity"
            className="h-1.5 min-w-0 flex-1 cursor-pointer accent-[var(--kng-accent)]"
          />
          <span>After</span>
        </div>
      )}
      {showModeRow && (
        <div className="flex-shrink-0 px-2 pb-1.5">
          <div
            role="radiogroup"
            aria-label="Image comparison"
            data-testid="diff-image-modes"
            className="flex gap-0.5 rounded border border-edge-input bg-surface-hover p-0.5"
          >
            {modeOptions(layout).map((option) => {
              const active = effectiveMode === option.value;
              const disabled = option.value !== 'side-by-side' && !comparable;
              const Icon = option.icon;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  aria-label={option.label}
                  title={option.title}
                  disabled={disabled}
                  onClick={() => onModeChange(option.value)}
                  data-testid={`diff-image-mode-${option.value}`}
                  className={`flex flex-1 flex-col items-center justify-center gap-0.5 rounded px-0.5 py-1.5 text-[11px] transition-colors disabled:cursor-default disabled:opacity-40 @[300px]/image-diff:py-1 ${
                    active
                      ? 'bg-accent-emphasis font-medium text-accent-on'
                      : 'text-fg-muted enabled:hover:bg-surface-raised/60 enabled:hover:text-fg'
                  }`}
                >
                  <Icon size={16} aria-hidden="true" />
                  <span className="hidden whitespace-nowrap @[300px]/image-diff:block">{option.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

interface ImageBoxProps {
  side: DiffImageSide;
  alt: string;
  scalable: boolean;
  /** A frame shared with the other side; the image draws top-left inside it at the frame's scale. */
  frame?: { width: number; height: number };
  testId: string;
}

function ImageBox({ side, alt, scalable, frame, testId }: ImageBoxProps) {
  let content: ReactNode;
  if (side.kind === 'image' && frame) {
    content = (
      <div className="relative" style={fittedSize(frame.width, frame.height, scalable)}>
        <img
          src={side.dataUrl}
          alt={alt}
          draggable={false}
          className="image-diff-checkerboard absolute left-0 top-0 block"
          style={{ width: `${(side.width / frame.width) * 100}%` }}
        />
      </div>
    );
  } else if (side.kind === 'image') {
    content = (
      <img
        src={side.dataUrl}
        alt={alt}
        draggable={false}
        className="image-diff-checkerboard block"
        style={fittedSize(side.width, side.height, scalable)}
      />
    );
  }
  return (
    <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center @container-size" data-testid={testId}>
      {side.kind === 'image' ? content : (
        <div
          className="flex h-full max-h-56 w-full max-w-40 flex-col items-center justify-center gap-1.5 rounded border border-dashed border-edge-input p-2 text-center"
          data-testid="diff-image-placeholder"
          data-reason={side.kind}
        >
          <ImageOff size={18} className="text-fg-disabled" aria-hidden="true" />
          <span className="text-xs text-fg-muted">{PLACEHOLDER_TEXT[side.kind]}</span>
        </div>
      )}
    </div>
  );
}

interface CompositeStageProps {
  before: DecodedImageSide;
  after: DecodedImageSide;
  mode: Exclude<ImageCompareMode, 'side-by-side'>;
  scalable: boolean;
  sliderPosition: number;
  onSliderPositionChange: (position: number) => void;
  overlayOpacity: number;
  pixelDiff: PixelDiffState;
}

/**
 * Slider, Overlay and Diff share one box sized to fit both images. Each image
 * keeps its natural size relative to the other and is pinned top-left, so a
 * pixel in one sits exactly over the same pixel in the other even when the
 * dimensions changed.
 */
function CompositeStage({ before, after, mode, scalable, sliderPosition, onSliderPositionChange, overlayOpacity, pixelDiff }: CompositeStageProps) {
  const width = Math.max(before.width, after.width);
  const height = Math.max(before.height, after.height);
  const layerWidth = (side: DecodedImageSide) => `${(side.width / width) * 100}%`;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center @container-size">
      <div className="relative" style={fittedSize(width, height, scalable)} data-testid="diff-image-composite">
        {mode === 'diff' ? (
          <>
            <img
              src={after.dataUrl}
              alt="After, faded"
              draggable={false}
              className="absolute left-0 top-0 block opacity-30 grayscale"
              style={{ width: layerWidth(after) }}
            />
            {pixelDiff.status === 'done' && (
              <img
                src={pixelDiff.maskUrl}
                alt="Changed pixels"
                draggable={false}
                className="absolute inset-0 block h-full w-full"
                data-testid="diff-image-diff-mask"
              />
            )}
            {pixelDiff.status === 'pending' && (
              <div className="absolute inset-0 flex items-center justify-center">
                <Loader2 size={20} className="animate-spin text-fg-muted" aria-label="Comparing pixels" />
              </div>
            )}
          </>
        ) : (
          <>
            <img
              src={before.dataUrl}
              alt="Before"
              draggable={false}
              className="image-diff-checkerboard absolute left-0 top-0 block"
              style={{ width: layerWidth(before) }}
            />
            <div
              className="absolute inset-0"
              style={mode === 'slider' ? { clipPath: `inset(0 0 0 ${sliderPosition}%)` } : { opacity: overlayOpacity / 100 }}
              data-testid="diff-image-after-layer"
            >
              <img
                src={after.dataUrl}
                alt="After"
                draggable={false}
                // Slider shows the new image as it is, transparency included; an
                // overlaid checkerboard would wash out the Overlay blend.
                className={`absolute left-0 top-0 block ${mode === 'slider' ? 'image-diff-checkerboard' : ''}`}
                style={{ width: layerWidth(after) }}
              />
            </div>
          </>
        )}
        {mode === 'slider' && (
          <>
            {/* A transparent range input over the whole image: dragging anywhere
                moves the split, and the arrow keys move it from the keyboard.
                It comes first so the handle below can show its keyboard focus
                through `peer`; everything drawn after it ignores the pointer. */}
            <input
              type="range"
              min={0}
              max={100}
              step={0.5}
              value={sliderPosition}
              onChange={(event) => onSliderPositionChange(Number(event.target.value))}
              aria-label="Slider position"
              data-testid="diff-image-slider"
              className="peer absolute inset-0 h-full w-full cursor-ew-resize appearance-none bg-transparent opacity-0"
            />
            {/* Fixed dark chips, not theme tokens: they sit on arbitrary image
                pixels in every theme, so only a constant scrim keeps them legible. */}
            <span className="pointer-events-none absolute left-1.5 top-1.5 rounded bg-black/60 px-1.5 text-[11px] text-white">Before</span>
            <span className="pointer-events-none absolute right-1.5 top-1.5 rounded bg-black/60 px-1.5 text-[11px] text-white">After</span>
            <div className="pointer-events-none absolute bottom-0 top-0 w-0.5 -translate-x-1/2 bg-fg" style={{ left: `${sliderPosition}%` }} />
            <div
              className="pointer-events-none absolute top-1/2 flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-fg text-surface shadow peer-focus-visible:ring-2 peer-focus-visible:ring-accent"
              style={{ left: `${sliderPosition}%` }}
            >
              <ChevronsLeftRight size={14} aria-hidden="true" />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ImageInfoBar({ original, modified, pixelDiff }: { original: DiffImageSide | null; modified: DiffImageSide | null; pixelDiff: PixelDiffState | null }) {
  const hasBothSides = original !== null && modified !== null;
  const dimensionsChanged = original?.kind === 'image' && modified?.kind === 'image'
    && (original.width !== modified.width || original.height !== modified.height);
  const originalSize = sizeOf(original);
  const modifiedSize = sizeOf(modified);
  const sizeDelta = originalSize !== null && modifiedSize !== null && originalSize !== modifiedSize
    ? modifiedSize - originalSize
    : null;

  return (
    <div className="flex flex-shrink-0 flex-col gap-1 px-2 pb-2" data-testid="diff-image-info">
      <div className="flex flex-col gap-1 @[300px]/image-diff:flex-row @[300px]/image-diff:gap-1.5">
        {original && <InfoTile side={original} label={hasBothSides ? 'Before' : null} testId="diff-image-info-before" />}
        {modified && (
          <InfoTile
            side={modified}
            label={hasBothSides ? 'After' : null}
            sizeDelta={sizeDelta}
            dimensionsChanged={dimensionsChanged}
            testId="diff-image-info-after"
          />
        )}
      </div>
      {pixelDiff && <PixelDiffTile state={pixelDiff} />}
    </div>
  );
}

interface InfoTileProps {
  side: DiffImageSide;
  label: string | null;
  sizeDelta?: number | null;
  dimensionsChanged?: boolean;
  testId: string;
}

/**
 * One side's facts. Wide, two lines: the label (and size change) over the
 * values. Narrow, one line: label, values, then the size change at the far
 * edge. The same children reflow by `order` and a forced line break, so the
 * DOM and its test ids never change with the width.
 */
function InfoTile({ side, label, sizeDelta = null, dimensionsChanged = false, testId }: InfoTileProps) {
  const dimensions = side.kind === 'image' ? `${side.width} x ${side.height}` : null;
  const size = side.kind === 'unreadable' ? null : formatBytes(side.size);
  const deltaText = sizeDelta === null ? null : `${sizeDelta > 0 ? '+' : '-'}${formatBytes(Math.abs(sizeDelta))}`;
  const summary = [label, dimensions, size ?? 'not readable'].filter((part) => part !== null).join(', ');

  return (
    <div className={TILE_CLASS} title={summary} data-testid={testId}>
      {label && <span className="order-1 font-medium text-fg-tertiary">{label}</span>}
      <span className="order-2 flex min-w-0 gap-2 @[300px]/image-diff:order-3 @[300px]/image-diff:basis-full">
        {dimensions && (
          <span className={dimensionsChanged ? 'text-modified' : 'text-fg-secondary'} data-testid={`${testId}-dimensions`}>
            {dimensions}
          </span>
        )}
        <span className="text-fg-muted" data-testid={`${testId}-size`}>{size ?? 'Not readable'}</span>
      </span>
      {deltaText && (
        <span
          className="order-3 ml-auto rounded-full bg-modified/15 px-1.5 text-[11px] text-modified @[300px]/image-diff:order-2"
          data-testid="diff-image-size-delta"
        >
          {deltaText}
        </span>
      )}
    </div>
  );
}

function PixelDiffTile({ state }: { state: PixelDiffState }) {
  let text = 'Comparing pixels';
  let title: string | undefined;
  if (state.status === 'done') {
    const percent = (state.changedPixels / state.totalPixels) * 100;
    if (state.changedPixels === 0) text = 'No pixel changes';
    else if (percent < 0.1) text = 'Under 0.1% of pixels changed';
    else text = `${percent.toFixed(1)}% of pixels changed`;
    title = `${state.changedPixels.toLocaleString()} of ${state.totalPixels.toLocaleString()} pixels differ`;
  } else if (state.status === 'failed') {
    text = 'Could not compare pixels';
  }

  return (
    <div className={TILE_CLASS} title={title} data-testid="diff-image-pixel-stat" data-status={state.status}>
      <span className="h-2 w-2 flex-shrink-0 rounded-sm" style={{ backgroundColor: PIXEL_DIFF_COLOR_CSS }} aria-hidden="true" />
      <span className="text-fg-secondary">{text}</span>
    </div>
  );
}
