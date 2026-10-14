import { Fragment, type ReactElement } from 'react';
import { Info } from 'lucide-react';
import { HoverTip } from '../../HoverTip';
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
 * `HoverTip` does for a pointer, and a screen reader reads the plain-text
 * version below.
 */
export function WildcardExamplesTip(): ReactElement {
  return (
    <HoverTip label={wildcardExamplesText()} content={<WildcardExamplesPanel />} testId="edit-automation-wildcard-tip" className="inline-flex">
      <button
        type="button"
        aria-label="Wildcard examples"
        data-testid="edit-automation-wildcard-info"
        className="flex flex-shrink-0 cursor-help rounded text-fg-faint hover:text-fg-tertiary focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      >
        <Info size={13} aria-hidden="true" />
      </button>
    </HoverTip>
  );
}

/** The tip's panel. Spans throughout, since `HoverTip` renders it inside a span. */
function WildcardExamplesPanel(): ReactElement {
  return (
    <span className="block">
      <span className="flex items-center gap-2 border-b border-edge bg-surface-hover/40 px-3 py-2">
        <Info size={13} className="flex-shrink-0 text-fg-muted" aria-hidden="true" />
        <span className="text-xs font-semibold text-fg">Wildcard examples</span>
      </span>
      <span className="grid grid-cols-[max-content_1fr] items-center gap-x-3 gap-y-2 px-3 py-2.5">
        {TEXT_MATCH_WILDCARD_EXAMPLES.map((example) => (
          <Fragment key={example.pattern}>
            <code className="justify-self-start whitespace-pre rounded border border-edge-input bg-surface-control px-1.5 font-mono text-xs text-fg-secondary">
              {example.pattern}
            </code>
            <span className="text-xs text-fg-tertiary">
              {example.rule}
              {example.sample !== null && <span className="text-fg-muted">, as in {example.sample}</span>}
            </span>
          </Fragment>
        ))}
      </span>
    </span>
  );
}

/** The tip as plain text, for a screen reader. */
function wildcardExamplesText(): string {
  const rows = TEXT_MATCH_WILDCARD_EXAMPLES.map((example) => `${example.pattern}: ${example.rule.toLowerCase()}`
    + (example.sample !== null ? `, as in ${example.sample}` : ''));
  return `Wildcard examples. ${rows.join('. ')}.`;
}
