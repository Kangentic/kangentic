import { Ban } from 'lucide-react';
import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import type { AppConfig } from '../../../shared/types';
import { Tooltip } from '../Tooltip';
import { CardStrip, cardStripBleedClass } from './CardStrip';

/**
 * The "Automations disabled" mark, in one home for every place that shows it:
 * the board card's strip, the Agent Monitor's card strip and list slice, and the
 * monitor table's chip. One copy of the words and the tip, so they cannot drift.
 * Functions rather than constants, so each read takes the session's catalog.
 */
export function automationsDisabledLabel(): string {
  return i18n._(msg`Automations disabled`);
}

export function automationsDisabledTip(): string {
  return i18n._(msg`Column automations don't run for this task. Enable them from the card's menu.`);
}

/** The Ban glyph every placement leads with. Decorative: the words beside it, or the host's label, name it. */
export function AutomationsDisabledGlyph() {
  return <Ban size={12} strokeWidth={2} className="shrink-0" aria-hidden="true" />;
}

/**
 * The strip itself, with no bleed: a host that stacks it above another strip
 * (the monitor card) draws one bleed wrapper around both.
 */
export function AutomationsDisabledCardStrip({ testId }: { testId: string }) {
  return (
    <Tooltip label={automationsDisabledTip()}>
      <CardStrip data-testid={testId}>
        <span className="inline-flex items-center gap-[5px] text-xs text-fg-muted min-w-0">
          <AutomationsDisabledGlyph />
          <span className="truncate">{automationsDisabledLabel()}</span>
        </span>
      </CardStrip>
    </Tooltip>
  );
}

/**
 * Across the top of a board card whose column automations are disabled, at
 * every density: the workflow strip's own shell, with no hue, so it competes with
 * neither the activity mark nor a workflow's color. A workflow task never wears
 * it: its workflow's Pause is what holds it.
 */
export function AutomationsDisabledStrip({ density }: { density: AppConfig['cardDensity'] }) {
  return (
    <div className={cardStripBleedClass(density)}>
      <AutomationsDisabledCardStrip testId="task-card-automations-disabled" />
    </div>
  );
}
