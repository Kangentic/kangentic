import { useId, useRef, useState, useEffect, useMemo } from 'react';

const LINE_HEIGHT = 18;
const RECT_HEIGHT = 10;
const TOP_PADDING = 8;
const MAX_LINES = 80;

/** Knuth multiplicative hash for deterministic pseudo-random values per line. */
function hash(seed: number): number {
  let value = seed * 2654435761;
  value = ((value >>> 16) ^ value) * 2246822507;
  value = ((value >>> 16) ^ value) * 3266489909;
  return ((value >>> 16) ^ value) >>> 0;
}

// Pre-compute a pool of skeleton lines. We slice to the number that fits
// the container height at render time.
const linePool = Array.from({ length: MAX_LINES }, (_, index) => {
  const hashValue = hash(index + 42);
  const isBlank = (hashValue % 11) === 0; // ~9% chance of blank line

  return {
    key: index,
    width: isBlank ? 0 : 6 + (hashValue % 34),                 // 6-40%
    opacity: isBlank ? 0 : 0.25 + ((hashValue >>> 16) % 15) * 0.01, // 0.25-0.39
  };
});

interface ShimmerOverlayProps {
  label: string;
}

/** Full-size loading overlay with skeleton lines and a glowing status pill.
 *  Uses SVG with an animated linearGradient so the shimmer naturally only
 *  renders through the bar shapes. 1 SVG <animate> per overlay instead of
 *  CSS pseudo-element hacks. */
export function ShimmerOverlay({ label }: ShimmerOverlayProps) {
  const rawId = useId();
  const safeId = rawId.replace(/:/g, '');
  const gradientId = `shimmer-${safeId}`;
  const containerRef = useRef<HTMLDivElement>(null);
  const [lineCount, setLineCount] = useState(30);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    const observer = new ResizeObserver((entries) => {
      const height = entries[0].contentRect.height;
      const count = Math.min(MAX_LINES, Math.ceil((height - TOP_PADDING) / LINE_HEIGHT));
      setLineCount(count > 0 ? count : 30);
    });

    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const visibleLines = useMemo(() => linePool.slice(0, lineCount), [lineCount]);

  return (
    <div ref={containerRef} className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-surface">
      {/* SVG skeleton with animated gradient shimmer */}
      <svg
        width="100%"
        height="100%"
        className="absolute inset-0 pointer-events-none overflow-hidden"
        aria-hidden="true"
      >
        <defs>
          <linearGradient id={gradientId} x1="-1" y1="0" x2="0" y2="0">
            <stop offset="40%" stopColor="var(--kng-edge)" stopOpacity="0.3" />
            <stop offset="47%" stopColor="var(--kng-accent)" stopOpacity="0.12" />
            <stop offset="50%" stopColor="var(--kng-accent)" stopOpacity="0.18" />
            <stop offset="53%" stopColor="var(--kng-accent)" stopOpacity="0.12" />
            <stop offset="60%" stopColor="var(--kng-edge)" stopOpacity="0.3" />
            <animate attributeName="x1" values="-1;1" dur="2.5s" repeatCount="indefinite" />
            <animate attributeName="x2" values="0;2" dur="2.5s" repeatCount="indefinite" />
          </linearGradient>
        </defs>
        {visibleLines.map((line) =>
          line.width > 0 ? (
            <rect
              key={line.key}
              x="12"
              y={line.key * LINE_HEIGHT + TOP_PADDING}
              width={`${line.width}%`}
              height={RECT_HEIGHT}
              rx="4"
              fill={`url(#${gradientId})`}
              opacity={line.opacity}
            />
          ) : null,
        )}
      </svg>

      {/* Glowing pill centered above shimmer lines */}
      <div className="relative z-20 px-6 py-3 rounded-lg bg-accent/20 border border-accent/40 terminal-overlay-glow">
        <span className="text-base text-accent-fg">{label}</span>
      </div>
    </div>
  );
}
