import brandMarkSvg from '@kangentic/branding/assets/brandmark-mono-amber.svg?raw';

/**
 * Inline (not `<img>`) so the disc inherits `currentColor` from the surrounding text token
 * while the amber slit stays fixed - a themed lockup that reads as one unit with the wordmark
 * on every theme. Deliberate exception to the "use lucide, no inline SVGs" rule: this consumes
 * a shipped brand asset that must theme-tint and cannot be a lucide glyph (precedent:
 * command-bar/CommandTerminalIcon.tsx). The `?raw` source is a trusted build-time package asset.
 */
export function BrandMark({ className = '' }: { className?: string }) {
  return (
    <span
      className={`inline-block [&>svg]:block [&>svg]:h-full [&>svg]:w-full ${className}`}
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: brandMarkSvg }}
    />
  );
}
