import { createElement } from 'react';
import { Bot } from 'lucide-react';
import { AGENT_MARKS } from './agent-marks';

/**
 * An agent's own mark, on its card in Settings > Accounts (task #1057).
 *
 * `.claude/rules/ui-conventions.md` exempts this file from "use lucide, no inline SVGs": a
 * vendor's mark is not something a lucide glyph can draw, and a list of logins is where a user
 * has to tell one vendor's from another's at a glance. The marks are the set kangentic.com draws
 * (`agent-marks.ts`), all in `currentColor`, so the call site supplies the tone. An agent with no
 * mark there gets the generic agent icon, never a guessed one. `label` is the agent's name; pass
 * none where the name is written beside the mark.
 */
export function AgentLogo({ agent, size = 18, label }: { agent: string; size?: number; label?: string }) {
  const mark = AGENT_MARKS[agent];
  if (!mark) return <Bot size={size} aria-hidden={label ? undefined : true} aria-label={label} />;
  return (
    <svg
      width={size}
      height={size}
      viewBox={mark.viewBox}
      {...mark.root}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {mark.shapes.map((shape, index) => createElement(shape.tag, { key: index, ...shape.attributes }))}
    </svg>
  );
}
