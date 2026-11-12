import { createElement, type ReactNode } from 'react';
import { Bot, Link2 } from 'lucide-react';
import { AGENT_MARKS, type VendorMark } from './agent-marks';
import { ARTIFACT_PLATFORM_MARKS } from './artifact-platform-marks';

/**
 * A vendor's own mark: an agent's on its card in Settings > Accounts (task #1057), and a tool's
 * beside an artifact that lives there (task #1056).
 *
 * `.claude/rules/ui-conventions.md` exempts this file from "use lucide, no inline SVGs": a
 * vendor's mark is not something a lucide glyph can draw, and a list of logins or of links is
 * where a user has to tell one vendor's from another's at a glance. The marks are element data
 * (`agent-marks.ts`, `artifact-platform-marks.ts`), all in `currentColor`, so the call site
 * supplies the tone. A vendor with no mark gets a generic lucide icon, never a guessed one.
 * `label` is the vendor's name; pass none where the name is written beside the mark.
 */
function VendorMarkSvg({ mark, size, label, fallback }: {
  mark: VendorMark | undefined;
  size: number;
  label?: string;
  fallback: ReactNode;
}) {
  if (!mark) return fallback;
  return (
    <svg
      width={size}
      height={size}
      viewBox={mark.viewBox}
      {...mark.root}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className="flex-shrink-0"
    >
      {mark.shapes.map((shape, index) => createElement(shape.tag, { key: index, ...shape.attributes }))}
    </svg>
  );
}

/** An agent's mark, keyed by adapter name. The generic agent icon for an agent with none. */
export function AgentLogo({ agent, size = 18, label }: { agent: string; size?: number; label?: string }) {
  return (
    <VendorMarkSvg
      mark={AGENT_MARKS[agent]}
      size={size}
      label={label}
      fallback={<Bot size={size} aria-hidden={label ? undefined : true} aria-label={label} />}
    />
  );
}

/**
 * The mark of the tool an artifact lives in, keyed by its platform id
 * (`src/shared/artifact-platforms.ts`). The plain link icon for a link Kangentic does not
 * recognise, and for a platform with no mark yet.
 */
export function ArtifactPlatformLogo({ platformId, size = 14, label }: { platformId: string | null; size?: number; label?: string }) {
  return (
    <VendorMarkSvg
      mark={platformId ? ARTIFACT_PLATFORM_MARKS[platformId] : undefined}
      size={size}
      label={label}
      fallback={<Link2 size={size} className="flex-shrink-0" aria-hidden={label ? undefined : true} aria-label={label} />}
    />
  );
}
