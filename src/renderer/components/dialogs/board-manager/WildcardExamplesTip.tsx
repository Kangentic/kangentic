import { Fragment, type ReactElement } from 'react';
import { Info } from 'lucide-react';
import { Tooltip } from '../../Tooltip';
import { TEXT_MATCH_WILDCARD_EXAMPLES } from '../../../../shared/final-line-match';

/**
 * The info icon after the Text match hint, and the rich tip it opens: what `*`
 * does, shown rather than described, on the field's own placeholder.
 *
 * A header band (icon and title over a divider) above a grid of pattern chips
 * and their rules, the rule in the body tone and its example quieter, so the
 * header, the patterns and the explanations read as three layers. The chips
 * take the field fill (`surface-control` / `edge-input`), because each one is a
 * value someone would type into that field.
 *
 * The trigger is a real button, so a keyboard user opens the tip by focus, as
 * `Tooltip` does for a pointer, and a screen reader reads the plain-text
 * version below as the button's description.
 */
export function WildcardExamplesTip(): ReactElement {
  return (
    <Tooltip
      label={wildcardExamplesText()}
      header={{ icon: <Info />, title: 'Wildcard examples' }}
      content={<WildcardExamplesGrid />}
      testId="edit-automation-wildcard-tip"
    >
      <button
        type="button"
        aria-label="Wildcard examples"
        data-testid="edit-automation-wildcard-info"
        className="inline-flex flex-shrink-0 cursor-help rounded text-fg-faint hover:text-fg-tertiary focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      >
        <Info size={13} aria-hidden="true" />
      </button>
    </Tooltip>
  );
}

/** The tip's body: each pattern chip beside its rule. */
function WildcardExamplesGrid(): ReactElement {
  return (
    <div className="grid grid-cols-[max-content_1fr] items-center gap-x-3 gap-y-2">
      {TEXT_MATCH_WILDCARD_EXAMPLES.map((example) => (
        <Fragment key={example.pattern}>
          <code className="justify-self-start whitespace-pre rounded border border-edge-input bg-surface-control px-1.5 font-mono text-xs text-fg-secondary">
            {example.pattern}
          </code>
          <span className="text-xs text-fg-tertiary">
            {example.rule}
            {example.sample !== null && <span className="text-tooltip-rich-muted">, as in {example.sample}</span>}
          </span>
        </Fragment>
      ))}
    </div>
  );
}

/** The tip as plain text, for a screen reader. */
function wildcardExamplesText(): string {
  const rows = TEXT_MATCH_WILDCARD_EXAMPLES.map((example) => `${example.pattern}: ${example.rule.toLowerCase()}`
    + (example.sample !== null ? `, as in ${example.sample}` : ''));
  return `Wildcard examples. ${rows.join('. ')}.`;
}
