import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Funnel, Repeat, Zap } from 'lucide-react';
import { i18n } from '@lingui/core';
import { plural } from '@lingui/core/macro';
import { msg } from '@lingui/core/runtime-macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { translateText } from '../../../i18n/translate';
import { cachePerCatalog, cachePerCatalogBy } from '../../../i18n/catalog-cache';
import {
  AUTOMATION_MANIFEST,
  AUTOMATION_TRIGGER_LABELS,
  AUTOMATION_TRIGGERS,
  EXIT_GROUP_BUDGET_MS,
  automationFieldUnavailableReason,
  canTriggerRun,
  isTypeOfferedOnTrigger,
  stableAutomationTypes,
} from '../../../../shared/automation-manifest';
import type { AutomationField } from '../../../../shared/automation-manifest';
import { normalizeTaskFilter } from '../../../../shared/automation-filter';
import type { AutomationTrigger, AutomationType, Swimlane } from '../../../../shared/types';
import { BaseDialog, DialogFooterActions } from '../BaseDialog';
import { Select, ToggleSwitch } from '../../settings/shared';
import { InfoTip } from '../../settings/settings-card';
import { FIELD_CONTROL_CLASS } from '../../Field';
import { SETTING_DESCRIPTION_CLASS, SETTING_LABEL_CLASS } from '../../SettingText';
import { SegmentedControl, type SegmentedControlOption } from '../../SegmentedControl';
import { NumberStepper } from '../../NumberStepper';
import { OptionalTag } from '../../OptionalTag';
import { AutomationTypePicker } from './AutomationTypePicker';
import { ColumnPicker, type ColumnPickerChoice } from '../../ColumnPicker';
import { AutomationIcon } from './automation-icons';
import { ConditionList, linesFromDraft, type AutomationTemplatePickerProps, type ConditionLines } from './ConditionList';
import { TemplateTextField, type TemplateTextFieldInsert } from '../../TemplateTextField';
import {
  draftConditionKinds,
  findNameConflict,
  formatHeaderLines,
  parseHeaderLines,
  spliceAtRange,
  type AutomationDraft,
} from './automation-drafts';

export type { AutomationTemplatePickerProps };

/**
 * The ONE place an automation is edited: a Name, then one section for each
 * part of the rule, Trigger, Action, Condition and Frequency, as a
 * one-column accordion with one section open at a time (#872, canvas board
 * F1b). A closed Trigger or Action shows its value; Condition and Frequency
 * keep their switch and a static description, since the switch says whether
 * each is on and opening the section shows what it holds.
 *
 * Everything type-specific is rendered from the manifest, so a new automation
 * type needs no change here at all.
 */

/**
 * The types that can outlast the exit budget, and so are worth warning about.
 *
 * A notify is instant and a message is bounded by the scheduler's own ladder, so
 * neither of those can meaningfully hit the cap. Naming the two that can keeps
 * the line off three quarters of the rows that would never see it fire.
 */
const SLOW_TYPES = new Set<AutomationType>(['run_script', 'webhook']);

/** How tall a growing prose field may get before it scrolls. */
const PROSE_MAX_ROWS = 8;

/** The accordion's sections, in the order the dialog stacks them. */
type SectionId = 'trigger' | 'action' | 'condition' | 'frequency';

/**
 * Cached until the catalog changes, not an inline literal: `SegmentedControl`
 * keys its measuring effect on `options`, and this dialog re-renders on every
 * keystroke in Name or any text field, so a fresh array per render would tear
 * down and rebuild the control's ResizeObserver (and force a synchronous layout
 * read) per character.
 *
 * Built at render rather than at module load: the trigger labels are read from
 * the shared manifest, which holds them as text to translate, and a read at
 * module load would freeze them in English.
 */
const allTriggerOptions = cachePerCatalog((): SegmentedControlOption<AutomationTrigger>[] => AUTOMATION_TRIGGERS.map((trigger) => ({
  value: trigger,
  label: translateText(AUTOMATION_TRIGGER_LABELS[trigger]),
  testId: `edit-automation-trigger-${trigger}`,
})));

/**
 * The trigger options with each blocked one disabled, keyed by the reasons (a
 * JSON array, one entry per trigger, null where it is fine), so the same array
 * comes back while nothing that decides them changes. Mirrors
 * `WorktreePlacementControl`'s blocked options, and for the same reason: a fresh
 * array would defeat the memo on the control.
 */
const blockedTriggerOptions = cachePerCatalogBy((reasonsKey: string): SegmentedControlOption<AutomationTrigger>[] => {
  const reasons = JSON.parse(reasonsKey) as Array<string | null>;
  return allTriggerOptions().map((option, index) => {
    const reason = reasons[index];
    return reason === null || reason === undefined ? option : { ...option, disabled: true, disabledReason: reason };
  });
});

/** The triggers this type can take in this column, each disabled one carrying its reason as the hover tip. */
function triggerOptionsFor(
  type: AutomationType,
  column: Swimlane,
  reportsTurnEnd: boolean | undefined,
): SegmentedControlOption<AutomationTrigger>[] {
  const reasons = triggerReasons(type, column, reportsTurnEnd);
  if (reasons.every((reason) => reason === null)) return allTriggerOptions();
  return blockedTriggerOptions(JSON.stringify(reasons));
}

/** Why each trigger is unavailable for this type in this column, or null where it is fine. */
function triggerReasons(type: AutomationType, column: Swimlane, reportsTurnEnd: boolean | undefined): Array<string | null> {
  const facts = { autoSpawn: column.auto_spawn, role: column.role, reportsTurnEnd };
  const columnName = column.name;
  return AUTOMATION_TRIGGERS.map((trigger) => {
    const group = canTriggerRun(facts, trigger);
    if (!group.ok) return trigger === 'enter' ? i18n._(msg`Nothing runs when a task enters ${{ columnName }}.`) : translateText(group.reason);
    if (!isTypeOfferedOnTrigger(type, trigger)) {
      const typeReason = AUTOMATION_MANIFEST[type].triggerUnavailableReason;
      return typeReason ? translateText(typeReason) : i18n._(msg`Not offered on this trigger.`);
    }
    return null;
  });
}

/**
 * A segmented field's options, built from its manifest declaration: each
 * option's label, test id and icon (resolved by name, as a type's icon is). On
 * a trigger where the field does nothing (`unavailableOn`), every option is
 * disabled with the reason as its hover tip, as the Trigger's blocked options
 * are, and the stored value is left alone, so moving the row back to a trigger
 * where it applies keeps what was chosen.
 *
 * Cached per field and reason, so the same array comes back while neither
 * changes: the ResizeObserver reason `allTriggerOptions` is cached for.
 * Manifest fields are module constants, so the field object is a stable key.
 */
const segmentedOptionsCache = new WeakMap<AutomationField, Map<string, SegmentedControlOption<string>[]>>();
function segmentedOptionsFor(field: AutomationField, unavailableReason: string | null): SegmentedControlOption<string>[] {
  let byReason = segmentedOptionsCache.get(field);
  if (!byReason) {
    byReason = new Map();
    segmentedOptionsCache.set(field, byReason);
  }
  // A reason is never empty (the reserved-keys test), so '' can stand for none.
  const cacheKey = unavailableReason ?? '';
  const cached = byReason.get(cacheKey);
  if (cached) return cached;
  const built = (field.options ?? []).map((option): SegmentedControlOption<string> => ({
    value: option.value,
    label: translateText(option.label),
    testId: option.testId,
    ...(option.icon ? { icon: <AutomationIcon name={option.icon} size={14} /> } : {}),
    ...(unavailableReason !== null ? { disabled: true, disabledReason: unavailableReason } : {}),
  }));
  byReason.set(cacheKey, built);
  return built;
}

/**
 * The saved row's Condition from the dialog's list: the Task lines into
 * `filter`, a Text match line into `final_line` (its kind deciding whose
 * message it reads), an Evaluation line into `condition`. Off, or with no
 * lines, the row runs for every task. Values of lines not on the list stay in
 * the dialog, so removing a line and adding it back before Done loses nothing.
 */
export function applyConditionLines(draft: AutomationDraft, lines: ConditionLines, on: boolean): AutomationDraft {
  const has = (kind: ConditionLines['kinds'][number]): boolean => on && lines.kinds.includes(kind);
  const textKind = has('prompt') ? 'prompt' : has('reply') ? 'reply' : null;
  return {
    ...draft,
    filter: normalizeTaskFilter({
      priorities: has('priority') ? lines.priorities : [],
      labels: has('labels') ? lines.labels : [],
    }),
    final_line: textKind !== null ? lines.textMatch : null,
    text_match_source: textKind === 'prompt' ? 'user' : textKind === 'reply' ? 'agent' : draft.text_match_source,
    condition: has('evaluation') ? lines.evaluation : null,
  };
}

export interface EditAutomationDialogProps {
  draft: AutomationDraft;
  column: Swimlane;
  /** Whether the column's agent reports a turn end. Undefined while unknown. */
  reportsTurnEnd?: boolean;
  /**
   * Whether the column's agent reports the messages a person sends it, which
   * Prompt reads. Undefined while unknown, which offers it.
   */
  reportsUserMessages?: boolean;
  /**
   * The board's other columns in board order, for a Column field, valued by
   * NAME: the Board Manager's drafts, so a column added, recolored or given a
   * new icon in this unsaved session shows its own glyph.
   */
  columns: ColumnPickerChoice[];
  /**
   * Whether the Automation agent is set up (Settings > Workflows). Until it
   * is, an Evaluation line shows the setup box in place of its field.
   */
  automationAgentReady: boolean;
  /** Open Settings at the Automation agent, from an Evaluation line's Set up. */
  onOpenAutomationSettings: () => void;
  isNew: boolean;
  /** The column's other rows, for the uniqueness check. */
  takenNames: string[];
  /**
   * The template-variable inserter, passed as a COMPONENT so it stays in one
   * place. A component rather than a render prop: the inserter callback reads
   * the field's refs when clicked, and the compiler rules cannot tell a
   * render-prop call from a render-time read, whereas a JSX prop is understood
   * as deferred.
   */
  templatePicker: React.ComponentType<AutomationTemplatePickerProps>;
  onDone: (draft: AutomationDraft) => void;
  onCancel: () => void;
}

export function EditAutomationDialog(props: EditAutomationDialogProps) {
  const { t } = useLingui();
  // A LOCAL copy: Done applies it to the board draft, Cancel discards it. That
  // is what makes the dialog safe to experiment in.
  const [local, setLocal] = useState<AutomationDraft>(props.draft);
  // The Condition's lines and every kind's value, kept while a line is
  // removed or the switch is off, so either undone before Done loses nothing.
  const [conditionLines, setConditionLines] = useState<ConditionLines>(() => linesFromDraft(props.draft));
  // Read off the lines' first state, so the draft is read once.
  const [conditionOn, setConditionOnState] = useState<boolean>(() => conditionLines.kinds.length > 0);
  const [maxRunsDraft, setMaxRunsDraft] = useState<number>(props.draft.max_runs ?? 1);
  const [openSection, setOpenSection] = useState<SectionId>('action');
  const nameRef = useRef<HTMLInputElement | null>(null);

  const entry = AUTOMATION_MANIFEST[local.type];
  const conflict = findNameConflict(
    props.takenNames.map((name, index) => ({ id: `taken:${index}`, name })),
    local.name,
  );
  const nameEmpty = local.name.trim() === '';
  const blocked = nameEmpty || conflict !== null;

  const triggerOptions = useMemo(
    () => triggerOptionsFor(local.type, props.column, props.reportsTurnEnd),
    [local.type, props.column, props.reportsTurnEnd],
  );

  const setConfigValue = (key: string, value: unknown): void => {
    setLocal((current) => ({ ...current, config: { ...current.config, [key]: value } }));
  };

  // A type the current trigger cannot run moves the row to the first trigger
  // that both offers the type and runs in this column (Move to column to On
  // agent turn end), so the dialog never holds a rule the engine would refuse.
  // The Type picker lists only types with such a trigger (`typeOptions`).
  const changeType = (type: AutomationType): void => {
    setLocal((current) => {
      const reasons = triggerReasons(type, props.column, props.reportsTurnEnd);
      if (reasons[AUTOMATION_TRIGGERS.indexOf(current.trigger)] === null) return { ...current, type };
      const runnable = AUTOMATION_TRIGGERS.find((_trigger, index) => reasons[index] === null);
      const offered = runnable ?? AUTOMATION_TRIGGERS.find((trigger) => isTypeOfferedOnTrigger(type, trigger)) ?? current.trigger;
      return { ...current, type, trigger: offered };
    });
  };

  // The types this column can run on some trigger, as the Add automation
  // picker offers them, plus the row's own type so a legacy or now-blocked row
  // still reads what it is.
  const typeOptions = useMemo(
    () => stableAutomationTypes().filter((type) => type === local.type
      || triggerReasons(type, props.column, props.reportsTurnEnd).some((reason) => reason === null)),
    [local.type, props.column, props.reportsTurnEnd],
  );

  // Mount only, and deliberately not on every focus: a new row arrives named
  // "New run script", which is a placeholder rather than a choice, so the first
  // keystroke should replace it. Re-selecting whenever the field regains focus
  // would eat what the user had already typed on the way back from the Script
  // box.
  useEffect(() => {
    if (props.isNew) nameRef.current?.select();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount only, see above
  }, []);

  const changeConditionLines = (next: ConditionLines): void => {
    // Adding the first line switches the Condition on; removing the last one
    // leaves the switch where it is, saying the row runs for every task.
    const nextOn = conditionOn || next.kinds.length > conditionLines.kinds.length;
    setConditionLines(next);
    setConditionOnState(nextOn);
    setLocal((current) => applyConditionLines(current, next, nextOn));
  };
  const setConditionOn = (on: boolean): void => {
    setConditionOnState(on);
    setLocal((current) => applyConditionLines(current, conditionLines, on));
    if (on) setOpenSection('condition');
  };

  const frequencyOn = local.max_runs !== null;
  const setFrequencyOn = (on: boolean): void => {
    setLocal((current) => ({ ...current, max_runs: on ? maxRunsDraft : null }));
    if (on) setOpenSection('frequency');
  };

  // Saved with no Text match off a turn end: the line kept for a Trigger
  // switched back goes no further than Done.
  const handleDone = (): void => props.onDone({ ...local, ...draftConditionKinds(local), filter: normalizeTaskFilter(local.filter) });

  const exitBudgetSeconds = Math.round(EXIT_GROUP_BUDGET_MS / 1000);
  const pairColumn = entry.fields.find((field) => field.kind === 'column' && !field.hidden) ?? null;
  const otherFields = entry.fields.filter((field) => !field.hidden && field !== pairColumn);
  const sectionProps = (id: SectionId) => ({
    open: openSection === id,
    onOpen: () => setOpenSection(id),
  });

  return (
    <BaseDialog
      onClose={props.onCancel}
      testId="edit-automation-dialog"
      // The picker adds the row and opens this dialog on it, so a fresh
      // automation arrived at a window titled "Edit automation" for something
      // that did not exist a moment ago. `isNew` already distinguishes the two
      // (it selects the generated name for overtyping); the title now says so.
      title={props.isNew ? t`Add automation` : t`Edit automation`}
      // One section open at a time keeps the dialog short, and an open
      // Condition with every line still fits; the body scrolls past that, and
      // the header and footer stay put. Its menus portal, so the scroll clips
      // none of them.
      className="w-[640px] max-h-[calc(100vh-2rem)]"
      bodyClassName="flex-1 min-h-0 overflow-y-auto"
      // Ctrl+S is Done. This dialog sits over the Board Manager, so the key
      // applies the row here and leaves the board unsaved.
      save={{ onSave: handleDone, disabled: blocked }}
      // The standard footer slot, not a `<footer>` among the children. As a
      // child it sat INSIDE the body's own padding, so it carried the body
      // inset plus its own and sat lower than every other dialog's footer.
      footer={
        <DialogFooterActions
          onCancel={props.onCancel}
          onConfirm={handleDone}
          confirmLabel={t({ message: 'Done', context: 'button' })}
          confirmDisabled={blocked}
          cancelTestId="edit-automation-cancel"
          confirmTestId="edit-automation-done"
        />
      }
    >
      {/* No padding of its own. `BaseDialog` already wraps children in
          `px-4 py-4`, so the `px-5 py-4` this used to add landed on top of it
          and inset the body 36px against the header's 16px. */}
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1">
          <span className={SETTING_LABEL_CLASS}><Trans>Name</Trans></span>
          <input
            ref={nameRef}
            autoFocus
            data-testid="edit-automation-name"
            value={local.name}
            aria-invalid={conflict !== null}
            onChange={(event) => setLocal((current) => ({ ...current, name: event.target.value }))}
            className={`${FIELD_CONTROL_CLASS} ${conflict ? 'border-warning' : ''}`}
          />
          {conflict && (
            // Short on purpose: the field is about 310px wide, and naming the
            // column as well wrapped this to two lines.
            <span data-testid="edit-automation-name-error" className="text-[11px] text-warning">
              <Trans>Already used on this column.</Trans>
            </span>
          )}
        </label>

        <RuleCard
          testId="edit-automation-card-trigger"
          icon={<Zap size={16} />}
          title={t`Trigger`}
          description={translateText(AUTOMATION_TRIGGER_LABELS[local.trigger])}
          {...sectionProps('trigger')}
        >
          {/* Full width: three options that each name who acts. */}
          <SegmentedControl
            quiet
            fullWidth
            ariaLabel={t`Trigger`}
            testId="edit-automation-trigger"
            options={triggerOptions}
            value={local.trigger}
            onChange={(trigger) => setLocal((current) => ({ ...current, trigger }))}
          />
          {/* Shown only on exit, and only for a type that can actually take a
              while. The cap is real and nothing else says it: an exit group
              shares EXIT_GROUP_BUDGET_MS in aggregate whatever the adapters
              declare, so a script written for the five minutes its own default
              allows is killed at sixty seconds and the rows behind it are
              skipped. Learning that at runtime, from a run log, is learning it
              too late. */}
          {local.trigger === 'exit' && SLOW_TYPES.has(local.type) && (
            <p data-testid="edit-automation-exit-budget" className={SETTING_DESCRIPTION_CLASS}>
              {t`On exit, this column's automations share ${plural(exitBudgetSeconds, { one: '# second', other: '# seconds' })} in total. Put longer work on enter.`}
            </p>
          )}
        </RuleCard>

        <RuleCard
          testId="edit-automation-card-action"
          // The chosen type's own icon (a speech bubble for Send message), so
          // the card's header changes with Type below it. `data-icon` names it
          // for the specs, which should not lean on lucide's class names.
          icon={<AutomationIcon name={entry.icon} size={16} data-icon={entry.icon} />}
          title={t`Action`}
          description={translateText(entry.label)}
          {...sectionProps('action')}
        >
          <div className={pairColumn ? 'grid grid-cols-2 gap-3' : 'flex flex-col'}>
            {/* A <div>, not a <label>: the control is a button, and a label
                wrapping one steals its click. */}
            <div className="flex min-w-0 flex-col gap-1.5">
              <span className="flex items-center gap-1.5">
                <span className={SETTING_LABEL_CLASS}><Trans>Type</Trans></span>
                <InfoTip label={t`Type`} text={t`What runs. Each type brings its own fields.`} />
              </span>
              {/* Carries each type's icon, which a native <select> cannot: an
                  <option> holds text only. */}
              <AutomationTypePicker
                testId="edit-automation-type"
                ariaLabel={t`Type`}
                value={local.type}
                // The offerable set this column can run. The picker lists the
                // current value too, which keeps a legacy row's type readable.
                options={typeOptions}
                onChange={changeType}
              />
            </div>
            {pairColumn && (
              <ManifestField
                field={pairColumn}
                value={(local.config as Record<string, unknown>)[pairColumn.key]}
                onChange={(value) => setConfigValue(pairColumn.key, value)}
                templatePicker={props.templatePicker}
                columns={props.columns}
                trigger={local.trigger}
              />
            )}
          </div>

          {/* A hidden field is declared so its value round-trips through a
              save, not so the dialog offers it. See `AutomationField.hidden`. */}
          {otherFields.map((field) => (
            <ManifestField
              key={field.key}
              field={field}
              value={(local.config as Record<string, unknown>)[field.key]}
              onChange={(value) => setConfigValue(field.key, value)}
              templatePicker={props.templatePicker}
              columns={props.columns}
              trigger={local.trigger}
            />
          ))}
        </RuleCard>

        <RuleCard
          testId="edit-automation-card-condition"
          icon={<Funnel size={16} />}
          title={t`Condition`}
          description={t`Runs only when all match.`}
          checked={conditionOn}
          onToggle={setConditionOn}
          switchLabel={t`Condition`}
          {...sectionProps('condition')}
        >
          {/* Off, the lines dim and stay as written; Add condition stays live,
              and adding a line switches the Condition on. */}
          <ConditionList
            lines={conditionLines}
            onChange={changeConditionLines}
            linesOff={!conditionOn}
            trigger={local.trigger}
            reportsUserMessages={props.reportsUserMessages}
            automationAgentReady={props.automationAgentReady}
            onOpenAutomationSettings={props.onOpenAutomationSettings}
            templatePicker={props.templatePicker}
          />
        </RuleCard>

        <RuleCard
          testId="edit-automation-card-frequency"
          icon={<Repeat size={16} />}
          title={t`Frequency`}
          description={t`How many times it can run on a task.`}
          checked={frequencyOn}
          onToggle={setFrequencyOn}
          switchLabel={t`Frequency`}
          {...sectionProps('frequency')}
        >
          <div className="flex items-center gap-3">
            {/* Off, the whole panel reads dimmed, its label included, not only
                the stepper. The label dims here rather than the panel because
                the stepper already dims itself when disabled, and a second
                opacity on top of that left it at a quarter. */}
            <span
              data-testid="edit-automation-max-runs-label"
              data-dimmed={!frequencyOn}
              className={`flex min-w-0 flex-1 items-center gap-1.5 ${frequencyOn ? '' : 'opacity-50'}`}
            >
              <span className={SETTING_LABEL_CLASS}><Trans>Maximum runs</Trans></span>
              <InfoTip label={t`Maximum runs`} text={t`Starts over when you move the task or it leaves Done, not when an agent or an automation moves it elsewhere.`} />
            </span>
            <NumberStepper
              testId="edit-automation-max-runs"
              ariaLabel={t`Maximum runs`}
              value={frequencyOn ? (local.max_runs ?? 1) : 1}
              disabled={!frequencyOn}
              onChange={(next) => {
                setMaxRunsDraft(next);
                setLocal((current) => ({ ...current, max_runs: next }));
              }}
            />
          </div>
        </RuleCard>
      </div>
    </BaseDialog>
  );
}

/**
 * One section of the rule: a header (icon, title, one line, the switch alone on
 * the right where the section has one) over its fields, shown only while the
 * section is open. A click on the header opens the section; the switch's own
 * click is the switch's.
 *
 * The header's geometry is `settings-card.tsx`'s (a tile-shaped header target,
 * the icon in a 16px column, the switch on the right edge), reused by choice:
 * `settings-card-design.md` scopes out dialogs, but one tile shape in Settings
 * and in this dialog reads as one design.
 */
function RuleCard({
  testId, icon, title, description, checked, onToggle, switchLabel, open, onOpen, children,
}: {
  testId: string;
  icon: React.ReactNode;
  title: string;
  /** A switched section's static description, or a closed section's value (Trigger, Action). */
  description: string;
  /** The section's switch, when it has one. */
  checked?: boolean;
  onToggle?: (on: boolean) => void;
  switchLabel?: string;
  open: boolean;
  onOpen: () => void;
  children: React.ReactNode;
}) {
  const hasSwitch = checked !== undefined;
  const bodyId = `${testId}-body`;
  return (
    <section data-testid={testId} data-open={open ? 'true' : 'false'} aria-label={title} className="rounded-lg border border-edge">
      <div className="px-3 py-1.5">
        <div
          onClick={(event) => {
            if (event.target instanceof Element && event.target.closest('[role="switch"], a')) return;
            onOpen();
          }}
          className="flex cursor-pointer select-none items-center gap-3 rounded-md px-4 py-2 transition-colors hover:bg-surface-hover/40"
        >
          <span className="flex w-4 flex-shrink-0 justify-center text-fg-muted" aria-hidden="true">
            {icon}
          </span>
          <button
            type="button"
            aria-expanded={open}
            aria-controls={bodyId}
            data-testid={`${testId}-header`}
            className="min-w-0 flex-1 cursor-pointer text-left focus:outline-none focus-visible:underline"
          >
            <span className="block text-sm font-semibold text-fg">{title}</span>
            <span data-testid={`${testId}-description`} className="mt-0.5 block truncate text-xs text-fg-tertiary">{description}</span>
          </button>
          {hasSwitch && (
            <span className="flex flex-shrink-0">
              <ToggleSwitch
                checked={checked}
                onChange={(next) => onToggle?.(next)}
                ariaLabel={switchLabel ?? title}
                testId={`${testId}-switch`}
              />
            </span>
          )}
          <ChevronDown
            size={16}
            aria-hidden="true"
            className={`flex-shrink-0 text-fg-faint transition-transform ${open ? 'rotate-180' : ''}`}
          />
        </div>
      </div>
      {open && (
        <div id={bodyId} data-testid={bodyId} className="px-3 pb-3">
          <div className="flex flex-col gap-3 rounded-md bg-surface-hover/40 px-4 py-3">
            {children}
          </div>
        </div>
      )}
    </section>
  );
}

/** A field's label row: the label, an info tip, and the Optional tag. */
function FieldLabel({ field }: { field: AutomationField }) {
  const label = translateText(field.label);
  return (
    <span className="flex items-center gap-1.5">
      <span className={SETTING_LABEL_CLASS}>{label}</span>
      {field.info && <InfoTip label={label} text={translateText(field.info)} />}
      {field.optional && <OptionalTag />}
    </span>
  );
}

/** One field, rendered from its manifest declaration. No type branching. */
function ManifestField({ field, value, onChange, templatePicker: TemplatePicker, columns, trigger }: {
  field: AutomationField;
  value: unknown;
  onChange: (value: unknown) => void;
  templatePicker: EditAutomationDialogProps['templatePicker'];
  columns: readonly ColumnPickerChoice[];
  /** The row's trigger, which decides whether the field applies (`unavailableOn`). */
  trigger: AutomationTrigger;
}) {
  const { t } = useLingui();
  // Move to column's first choice: the next column on the task's route, else the board.
  const nextColumnOption = useMemo(() => ({ value: '', label: t`Next column` }), [t]);
  const text = typeof value === 'string' ? value : '';
  const testId = `automation-config-${field.key}`;
  // A field the manifest declares does nothing on this trigger (Delivery at a
  // turn end, where the turn is already over) stays in place, disabled, with
  // the reason, and its value is not touched.
  const unavailable = automationFieldUnavailableReason(field, trigger);
  const unavailableReason = unavailable === null ? null : translateText(unavailable);
  const label = translateText(field.label);
  const placeholder = field.placeholder === undefined ? undefined : translateText(field.placeholder);
  const inputRef = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null);
  // A highlighted textarea owns its own caret, so the picker button routes
  // through the field rather than through `inputRef`. Only the plain `text`
  // inputs still use `inputRef`, which is why both survive.
  const templateInsertRef = useRef<TemplateTextFieldInsert | null>(null);
  const highlighted = field.kind === 'textarea' && Boolean(field.templateVariables);
  // The Template variable button is joined to the field's right edge (#872,
  // canvas board F1d), on every field that takes variables.
  const attached = Boolean(field.templateVariables) && (field.kind === 'textarea' || field.kind === 'text');

  /**
   * Insert at the CARET, not at the end.
   *
   * The rAF is load-bearing, and it is the same one the shipped message field
   * carried: `onChange` re-renders the controlled input, and setting the
   * selection before that paint lands puts the caret back at the end of the old
   * value.
   */
  const insertAtCaret = (variable: string): void => {
    if (highlighted) {
      templateInsertRef.current?.(variable);
      return;
    }
    const node = inputRef.current;
    if (!node) {
      onChange(text + variable);
      return;
    }
    const { text: next, cursor } = spliceAtRange(
      text,
      node.selectionStart ?? text.length,
      node.selectionEnd ?? text.length,
      variable,
    );
    onChange(next);
    window.requestAnimationFrame(() => {
      node.focus();
      node.setSelectionRange(cursor, cursor);
    });
  };

  const control = (
    <>
      {field.kind === 'textarea' && highlighted && (
        <TemplateTextField
          value={text}
          onChange={onChange}
          // Every automation runs on a move or a turn end, so this is the
          // catalog that can actually resolve here. A spawn prompt passes 'spawn'.
          context="automation"
          testId={testId}
          // Prose (a message for an agent) declares no `rows`, so it starts one
          // row tall and grows with its text, as Condition does. A script or a
          // JSON body keeps the fixed rows its type asks for.
          {...(field.rows === undefined ? { grow: { maxRows: PROSE_MAX_ROWS } } : { rows: field.rows })}
          placeholder={placeholder}
          ariaLabel={label}
          insertRef={templateInsertRef}
          joinedRight={attached}
        />
      )}

      {field.kind === 'textarea' && !highlighted && (
        <textarea
          ref={(node) => { inputRef.current = node; }}
          data-testid={testId}
          value={text}
          rows={field.rows ?? 3}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
          className={`w-full resize-y rounded border border-edge-input bg-surface-control px-3 py-1.5 text-sm text-fg-tertiary placeholder-fg-muted focus:border-accent focus:outline-none ${attached ? 'rounded-r-none' : ''}`}
        />
      )}

      {field.kind === 'text' && (
        <input
          ref={(node) => { inputRef.current = node; }}
          data-testid={testId}
          value={text}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
          className={`${FIELD_CONTROL_CLASS} ${attached ? 'rounded-r-none' : ''}`}
        />
      )}
    </>
  );

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {field.kind === 'segmented' ? (
        // A short fixed choice reads as a settings card's choice row
        // (`CardChoiceRow`): the label at the left, the control on the panel's
        // right edge, sized to its options rather than stretched.
        <div data-testid={`${testId}-row`} className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <FieldLabel field={field} />
          </div>
          <SegmentedControl
            quiet
            className="flex-shrink-0"
            ariaLabel={label}
            testId={testId}
            // Cached, for the same ResizeObserver reason as the trigger options above.
            options={segmentedOptionsFor(field, unavailableReason)}
            // The whole control dims as well, so it reads as off rather than as
            // a choice with its selected option still live.
            disabled={unavailableReason !== null}
            value={text || String(field.defaultValue ?? '')}
            onChange={(next) => onChange(next)}
          />
        </div>
      ) : (
        <FieldLabel field={field} />
      )}

      {attached ? (
        <div className="flex items-stretch">
          <div className="min-w-0 flex-1">{control}</div>
          <TemplatePicker onInsert={insertAtCaret} testId={`${testId}-variable`} />
        </div>
      ) : control}

      {field.kind === 'number' && (
        // The input takes its content width rather than the row's, so the unit
        // sits against the number instead of a box-width away from it.
        <div className="flex items-center gap-2">
          <div className="w-24">
            <input
              type="number"
              data-testid={testId}
              value={typeof value === 'number' ? value : (field.defaultValue as number ?? '')}
              min={field.min}
              max={field.max}
              onChange={(event) => onChange(Number(event.target.value))}
              className={FIELD_CONTROL_CLASS}
            />
          </div>
          {field.unit && <span className={SETTING_DESCRIPTION_CLASS}>{translateText(field.unit)}</span>}
        </div>
      )}

      {field.kind === 'select' && (
        <Select
          data-testid={testId}
          value={text || String(field.defaultValue ?? '')}
          onChange={(event) => onChange(event.target.value)}
        >
          {(field.options ?? []).map((option) => (
            <option key={option.value} value={option.value}>{translateText(option.label)}</option>
          ))}
        </Select>
      )}

      {field.kind === 'column' && (
        // The board's columns by NAME, each with its own glyph, and Next column
        // (empty) first, set apart: it follows the task's route in a workflow,
        // else the board, so it is not one column. A name the board no longer
        // has (the column was deleted) stays listed and marked, so opening the
        // dialog never silently re-points the row.
        <ColumnPicker
          testId={testId}
          ariaLabel={label}
          value={text}
          columns={columns}
          leadingOption={nextColumnOption}
          onChange={onChange}
        />
      )}

      {field.kind === 'headers' && (
        <textarea
          data-testid={testId}
          rows={2}
          value={formatHeaderLines(value as Record<string, string> | undefined)}
          onChange={(event) => onChange(parseHeaderLines(event.target.value))}
          className="w-full resize-y rounded border border-edge-input bg-surface-control px-3 py-1.5 font-mono text-xs text-fg-tertiary placeholder-fg-muted focus:border-accent focus:outline-none"
        />
      )}

      {field.hint && <span className="text-[11px] text-fg-faint">{translateText(field.hint)}</span>}
    </div>
  );
}
