import { Ban } from 'lucide-react';
import { useLingui } from '@lingui/react/macro';
import type { AppConfig } from '../../../shared/types';
import { Tooltip } from '../Tooltip';
import { CardStrip, cardStripBleedClass } from './CardStrip';

/**
 * The "Automations paused" mark's words, in one home for every place that
 * shows it: the board card's strip, the Workflows canvas card's, the Agent
 * Monitor's card strip and list slice, the monitor table's chip, and the
 * Workflows inspector. One copy of the words and the tip, in the session's
 * language, so they cannot drift. A workflow task's tip says the workflow
 * leaves it alone too, since that is what the hold is for there.
 */
export function useAutomationsPausedText(inWorkflow: boolean): { label: string; tip: string } {
  const { t } = useLingui();
  return {
    label: t`Automations paused`,
    tip: inWorkflow
      ? t`Column automations don't run for this task, and its workflow does not move it. Resume them from the card's menu.`
      : t`Column automations don't run for this task. Resume them from the card's menu.`,
  };
}

/** The Ban glyph every placement leads with. Decorative: the words beside it, or the host's label, name it. */
export function AutomationsDisabledGlyph() {
  return <Ban size={12} strokeWidth={2} className="shrink-0" aria-hidden="true" />;
}

/**
 * The strip itself, with no bleed: a host that stacks it above another strip
 * (a workflow card, the monitor card) draws one bleed wrapper around both.
 */
export function AutomationsDisabledCardStrip({ testId, inWorkflow }: { testId: string; inWorkflow: boolean }) {
  const { label, tip } = useAutomationsPausedText(inWorkflow);
  return (
    <Tooltip label={tip}>
      <CardStrip data-testid={testId}>
        <span className="inline-flex items-center gap-[5px] text-xs text-fg-muted min-w-0">
          <AutomationsDisabledGlyph />
          <span className="truncate">{label}</span>
        </span>
      </CardStrip>
    </Tooltip>
  );
}

/**
 * Across the top of an ordinary board card whose automations are paused, at
 * every density: the workflow strip's own shell, with no hue, so it competes
 * with neither the activity mark nor a workflow's color. A workflow card's host
 * stacks the bare strip over its workflow strip instead.
 */
export function AutomationsDisabledStrip({ density }: { density: AppConfig['cardDensity'] }) {
  return (
    <div className={cardStripBleedClass(density)}>
      <AutomationsDisabledCardStrip testId="task-card-automations-disabled" inWorkflow={false} />
    </div>
  );
}
