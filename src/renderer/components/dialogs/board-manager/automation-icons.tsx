import { Bell, Bot, MessageSquare, SquareTerminal, Webhook, Zap, type LucideIcon } from 'lucide-react';

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

export function automationIcon(name: string): LucideIcon {
  return ICONS[name] ?? Zap;
}
