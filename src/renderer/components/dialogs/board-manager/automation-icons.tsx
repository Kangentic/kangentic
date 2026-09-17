import { createElement } from 'react';
import type { ReactElement } from 'react';
import { Bell, Bot, MessageSquare, SquareTerminal, Webhook, Zap, type LucideIcon } from 'lucide-react';
import type { LucideProps } from 'lucide-react';

/**
 * Resolve an automation type's kebab-case icon NAME to a lucide component.
 *
 * The manifest carries a name rather than a component because it is imported by
 * the main process, where JSX cannot go. This is the same split
 * `utils/swimlane-icons.tsx` already uses for the column icons persisted in the
 * database.
 *
 * A name with no entry falls back to `Zap`, the automations mark itself, so a
 * type added without touching this map renders as a generic automation instead
 * of a hole.
 */
const ICONS: Record<string, LucideIcon> = {
  'message-square': MessageSquare,
  'square-terminal': SquareTerminal,
  webhook: Webhook,
  bell: Bell,
  bot: Bot,
  zap: Zap,
};

/**
 * Render an automation type's icon by name.
 *
 * The lookup lives in one component and goes through `createElement` on
 * purpose: React's compiler rules read `const Icon = lookup(name)` followed by
 * `<Icon />` as a component created during render, which they forbid. The map
 * holds module-level lucide components, so the identity is in fact stable,
 * but the rule cannot see through the call. See `RegistryIcon` in
 * `utils/swimlane-icons.tsx`, which is the same shape for column icons.
 */
export function AutomationIcon({ name, ...iconProps }: { name: string } & LucideProps): ReactElement {
  return createElement(ICONS[name] ?? Zap, iconProps);
}
