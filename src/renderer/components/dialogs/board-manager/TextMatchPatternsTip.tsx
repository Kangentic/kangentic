import { Fragment, type ReactElement, type ReactNode } from 'react';
import { CaseSensitive, Info, List } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { Tooltip } from '../../Tooltip';
import { translateText } from '../../../i18n/translate';
import { TEXT_MATCH_EXAMPLES } from '../../../../shared/final-line-match';

/**
 * The info icon after the Text match hint, and the rich tip it opens
 * (#1072 canvas, board 20B): when the line is read, the Rules (`*`, `!`, any
 * case, one per line), then the Examples (`TEXT_MATCH_EXAMPLES`), built on
 * the field's own placeholder. Every line stays on one line.
 *
 * The rule keys and the pattern chips take the field fill (`surface-control` /
 * `edge-input`), because each one is something typed into that field. An
 * example with several patterns draws each as its own chip, side by side, so
 * every example is one row: a stacked box per example read as too busy.
 *
 * The trigger is a real button, so a keyboard user opens the tip by focus, as
 * `Tooltip` does for a pointer, and a screen reader reads the plain-text
 * version below as the button's description.
 */
export function TextMatchPatternsTip(): ReactElement {
  const { t } = useLingui();
  // The tip as plain text, for a screen reader: the lead, each rule, then each
  // example as its patterns and what they keep.
  const examples = TEXT_MATCH_EXAMPLES.map((example) => {
    const patterns = example.patterns.join(t`, then `);
    const rule = translateText(example.rule);
    return t`${patterns}: ${rule}.`;
  }).join(' ');
  const plain = [
    t`Read once each time the agent ends its turn, from its final message.`,
    t`*: any text. Use it anywhere. Without one, a pattern must match the whole line.`,
    t`! at the very start: not. The row runs only when the last line does not match.`,
    t`Any case. Punctuation is ignored too.`,
    t`One pattern per line. Runs on any plain line, never on a ! line.`,
    t`Examples: ${examples}`,
  ].join(' ');
  return (
    <Tooltip
      label={t`Patterns. ${plain}`}
      header={{ icon: <Info />, title: t`Patterns` }}
      content={<PatternsTipBody />}
      testId="edit-automation-patterns-tip"
    >
      <button
        type="button"
        aria-label={t`Patterns`}
        data-testid="edit-automation-patterns-info"
        className="inline-flex flex-shrink-0 cursor-help rounded text-fg-faint hover:text-fg-tertiary focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      >
        <Info size={13} aria-hidden="true" />
      </button>
    </Tooltip>
  );
}

const KEY_CLASS = 'flex h-5 min-w-5 items-center justify-center justify-self-start rounded border border-edge-input bg-surface-control px-1 font-mono text-[13px] font-bold text-fg';
const CHIP_CLASS = 'justify-self-start whitespace-pre rounded border border-edge-input bg-surface-control px-1.5 font-mono text-xs text-fg-secondary';
const SECTION_LABEL_CLASS = 'text-[11px] font-semibold uppercase tracking-wide text-tooltip-rich-muted';

/** The tip's body: the lead line, the Rules, then the Examples. */
function PatternsTipBody(): ReactElement {
  return (
    <div className="flex flex-col gap-3 whitespace-nowrap text-xs">
      <p data-testid="edit-automation-patterns-lead" className="text-fg-tertiary">
        <Trans>Read once each time the agent ends its turn, from its final message.</Trans>
      </p>
      <section className="flex flex-col gap-1.5" data-testid="edit-automation-patterns-rules">
        <span className={SECTION_LABEL_CLASS}><Trans>Rules</Trans></span>
        <div className="grid grid-cols-[max-content_max-content] items-center gap-x-3 gap-y-1.5">
          <RuleRow symbol={<span className={KEY_CLASS}>*</span>}>
            <Trans><b className="font-semibold text-fg-secondary">Any text.</b> Use it anywhere. Without one, a pattern must match the whole line.</Trans>
          </RuleRow>
          <RuleRow symbol={<span className={KEY_CLASS}>!</span>}>
            <Trans><b className="font-semibold text-fg-secondary">Not.</b> At the very start, the row runs only when the last line does not match.</Trans>
          </RuleRow>
          <RuleRow symbol={<span className={KEY_CLASS}><CaseSensitive size={14} aria-hidden="true" /></span>}>
            <Trans><b className="font-semibold text-fg-secondary">Any case.</b> Punctuation is ignored too, so "READY for review." matches.</Trans>
          </RuleRow>
          <RuleRow symbol={<span className={KEY_CLASS}><List size={14} aria-hidden="true" /></span>}>
            <Trans><b className="font-semibold text-fg-secondary">One per line.</b> Runs on any plain line, never on a ! line.</Trans>
          </RuleRow>
        </div>
      </section>
      <section className="flex flex-col gap-1.5" data-testid="edit-automation-patterns-examples">
        <span className={SECTION_LABEL_CLASS}><Trans>Examples</Trans></span>
        <div className="grid grid-cols-[max-content_max-content] items-center gap-x-3 gap-y-2">
          {TEXT_MATCH_EXAMPLES.map((example) => (
            <Fragment key={example.patterns.join('\n')}>
              {/* Each pattern its own chip, side by side, so every example is one row. */}
              <span className="flex items-center gap-1 justify-self-start">
                {example.patterns.map((pattern) => (
                  <code key={pattern} className={CHIP_CLASS}>{pattern}</code>
                ))}
              </span>
              <span className="text-fg-tertiary">{translateText(example.rule)}</span>
            </Fragment>
          ))}
        </div>
      </section>
    </div>
  );
}

/** One rule: its key, then what it does. */
function RuleRow({ symbol, children }: { symbol: ReactNode; children: ReactNode }): ReactElement {
  return (
    <>
      {symbol}
      <span className="text-fg-tertiary">{children}</span>
    </>
  );
}
