import { createElement } from 'react';
import type { ReactElement } from 'react';
import {
  Bell,
  Bot,
  Clock,
  Columns3Cog,
  CornerDownLeft,
  MessageSquare,
  Repeat,
  SquareArrowRight,
  SquareTerminal,
  TextSearch,
  Webhook,
  type LucideIcon,
} from 'lucide-react';
import type { LucideProps } from 'lucide-react';
import type { AutomationRowMark, AutomationRowMarkKind } from '../../../../shared/automation-describe';
import { Tooltip } from '../../Tooltip';

/**
 * Resolve an automation type's kebab-case icon NAME to a lucide component.
 *
 * The manifest carries a name rather than a component because it is imported by
 * the main process, where JSX cannot go. This is the same split
 * `utils/swimlane-icons.tsx` already uses for the column icons persisted in the
 * database.
 *
 * A name with no entry falls back to `Columns3Cog`, the automations mark itself,
 * so a type added without touching this map renders as a generic automation
 * instead of a hole. The bolt is not an automations mark: it is the Edit
 * automation dialog's Trigger card.
 */
const ICONS: Record<string, LucideIcon> = {
  'message-square': MessageSquare,
  'square-terminal': SquareTerminal,
  webhook: Webhook,
  bell: Bell,
  'square-arrow-right': SquareArrowRight,
  bot: Bot,
  // Field options name their icons the same way. Send message's Delivery: Run
  // immediately types the message and presses Enter at once, so it takes the
  // Enter key glyph; Wait for current turn takes the clock its row mark uses.
  'corner-down-left': CornerDownLeft,
  clock: Clock,
};

/**
 * Render an automation type's icon by name.
 *
 * Same shape as `RegistryIcon` in `utils/swimlane-icons.tsx`, and for the same
 * reason: see that JSDoc for why the lookup goes through `createElement` in one
 * place instead of `const Icon = lookup(name)` at each call site.
 */
export function AutomationIcon({ name, ...iconProps }: { name: string } & LucideProps): ReactElement {
  return createElement(ICONS[name] ?? Columns3Cog, iconProps);
}

/**
 * Each mark's icon, by kind. A `Record`, so a new kind fails to compile until it
 * has one. Elements rather than components, so a row renders them without
 * creating a component during render. The message mark is the Send message
 * type's own bubble: a Move to column row with a Message carries one.
 *
 * A Condition marks with its kind's own icon, the one its option carries in
 * the Edit automation dialog: the robot for an Agent evaluation, the text
 * search for a Text match. The funnel stays on the dialog's Condition card.
 */
const MARK_ICONS: Record<AutomationRowMarkKind, ReactElement> = {
  condition: <Bot size={12} />,
  'text-match': <TextSearch size={12} />,
  frequency: <Repeat size={12} />,
  delivery: <Clock size={12} />,
  message: <MessageSquare size={12} />,
};

/**
 * The marks after a row's name (`describeAutomationMarks`): every option that
 * is on, in the editor's card order, one tone for all of them, each tip naming
 * its card and value. Shared by the column panel's rows and the Add automation
 * picker's copy rows, so a row reads the same in both. The marks never shrink,
 * so a long name truncates before they do. The tip keeps a multi-line value's
 * line breaks; the name it repeats is the mark's `aria-label`.
 */
export function AutomationMarks({ marks }: { marks: readonly AutomationRowMark[] }): ReactElement {
  return (
    <>
      {marks.map((mark) => (
        <Tooltip key={mark.kind} label={mark.label}>
          <span
            data-testid={`column-automation-${mark.kind}-mark`}
            role="img"
            aria-label={mark.label}
            className="flex shrink-0 items-center gap-0.5 text-fg-muted"
          >
            {MARK_ICONS[mark.kind]}
            {mark.count !== undefined && (
              <span data-testid="column-automation-frequency-count" className="text-xs tabular-nums">
                {mark.count}
              </span>
            )}
          </span>
        </Tooltip>
      ))}
    </>
  );
}
