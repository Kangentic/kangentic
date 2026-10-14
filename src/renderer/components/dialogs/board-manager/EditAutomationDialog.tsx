import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Funnel, Info, Repeat, Settings, Zap } from 'lucide-react';
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
import { AutomationColumnPicker, type AutomationColumnChoice } from './AutomationColumnPicker';
import { AutomationIcon } from './automation-icons';
import { TemplateTextField, type TemplateTextFieldInsert } from '../../TemplateTextField';
import {
  findNameConflict,
  formatHeaderLines,
  parseHeaderLines,
  spliceAtRange,
  type AutomationDraft,
} from './automation-drafts';

/**
 * The ONE place an automation is edited, laid out as the rule reads: a Name,
 * then one card for each part, Trigger, Condition, Frequency and Action
 * (approved on the #732 canvas, board 15c, as the "condensed cards").
 *
 * Each card is a settings card's header (icon, title, one line, its switch
 * alone on the right) over ONE lighter panel holding all of that card's
 * fields. The switch in a card's header is what makes clear what it controls:
 * the card's border encloses its field, and a click anywhere on the header
 * flips it. Off, a field stays in place, dimmed, with an example in it, so the
 * dialog never changes height (no control comes or goes).
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

/** What a switched-off Condition shows, and the placeholder of an empty one. */
const CONDITION_EXAMPLE = 'All tests pass';
/** How tall a growing prose field may get before it scrolls. */
const PROSE_MAX_ROWS = 8;
/** The Type label's info tip. Type is the dialog's own field, not a manifest one, so its note lives here. */
const TYPE_INFO = 'What runs. Each type brings its own fields.';

/**
 * Module scope, not an inline literal: `SegmentedControl` keys its measuring
 * effect on `options`, and this dialog re-renders on every keystroke in Name or
 * any text field, so a fresh array per render would tear down and rebuild the
 * control's ResizeObserver (and force a synchronous layout read) per character.
 */
const TRIGGER_OPTIONS: SegmentedControlOption<AutomationTrigger>[] = AUTOMATION_TRIGGERS.map((trigger) => ({
  value: trigger,
  label: AUTOMATION_TRIGGER_LABELS[trigger],
  testId: `edit-automation-trigger-${trigger}`,
}));

/**
 * The triggers this type can take in this column, each disabled one carrying
 * its reason as the hover tip. Cached by the reasons, so the same array comes
 * back while nothing that decides them changes. Mirrors
 * `WorktreePlacementControl`'s `blockedOptionsFor`, and for the same reason:
 * a fresh array would defeat the memo on the control.
 */
const blockedTriggerOptions = new Map<string, SegmentedControlOption<AutomationTrigger>[]>();
function triggerOptionsFor(
  type: AutomationType,
  column: Swimlane,
  reportsTurnEnd: boolean | undefined,
): SegmentedControlOption<AutomationTrigger>[] {
  const reasons = triggerReasons(type, column, reportsTurnEnd);
  if (reasons.every((reason) => reason === null)) return TRIGGER_OPTIONS;
  const cacheKey = reasons.map((reason) => reason ?? '').join('\n');
  const cached = blockedTriggerOptions.get(cacheKey);
  if (cached) return cached;
  const built = TRIGGER_OPTIONS.map((option, index) => {
    const reason = reasons[index];
    return reason === null ? option : { ...option, disabled: true, title: reason };
  });
  blockedTriggerOptions.set(cacheKey, built);
  return built;
}

/** Why each trigger is unavailable for this type in this column, or null where it is fine. */
function triggerReasons(type: AutomationType, column: Swimlane, reportsTurnEnd: boolean | undefined): Array<string | null> {
  const facts = { autoSpawn: column.auto_spawn, role: column.role, reportsTurnEnd };
  return AUTOMATION_TRIGGERS.map((trigger) => {
    const group = canTriggerRun(facts, trigger);
    if (!group.ok) return trigger === 'enter' ? `Nothing runs when a task enters ${column.name}.` : group.reason;
    if (!isTypeOfferedOnTrigger(type, trigger)) {
      return AUTOMATION_MANIFEST[type].triggerUnavailableReason ?? 'Not offered on this trigger.';
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
 * changes: the ResizeObserver reason `TRIGGER_OPTIONS` is module scope for.
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
    label: option.label,
    testId: option.testId,
    ...(option.icon ? { icon: <AutomationIcon name={option.icon} size={14} /> } : {}),
    ...(unavailableReason !== null ? { disabled: true, title: unavailableReason } : {}),
  }));
  byReason.set(cacheKey, built);
  return built;
}

export interface EditAutomationDialogProps {
  draft: AutomationDraft;
  column: Swimlane;
  /** Whether the column's agent reports a turn end. Undefined while unknown. */
  reportsTurnEnd?: boolean;
  /**
   * The board's other columns in board order, for a Column field: the Board
   * Manager's drafts, so a column added or recolored in this unsaved session
   * shows its own dot.
   */
  columns: AutomationColumnChoice[];
  /**
   * Whether the Automation agent is set up (Settings > Workflows). Until it
   * is, a Condition cannot be switched on: nothing could check it.
   */
  automationAgentReady: boolean;
  /** Open Settings at the Automation agent, from the Condition card's notice. */
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
  templatePicker: React.ComponentType<{ onInsert: (variable: string) => void }>;
  onDone: (draft: AutomationDraft) => void;
  onCancel: () => void;
}

export function EditAutomationDialog(props: EditAutomationDialogProps) {
  // A LOCAL copy: Done applies it to the board draft, Cancel discards it. That
  // is what makes the dialog safe to experiment in.
  const [local, setLocal] = useState<AutomationDraft>(props.draft);
  // What a switched-off guard returns to when switched back on, so turning a
  // Condition off and on again does not lose what was written.
  const [conditionDraft, setConditionDraft] = useState<string>(props.draft.condition ?? '');
  const [maxRunsDraft, setMaxRunsDraft] = useState<number>(props.draft.max_runs ?? 1);
  const nameRef = useRef<HTMLInputElement | null>(null);
  const conditionInsertRef = useRef<TemplateTextFieldInsert | null>(null);

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

  // The Condition card. With no Automation agent its switch reads off and is
  // disabled, and a Condition written earlier is KEPT on the row, untouched, so
  // it returns once an agent is set up.
  const conditionOn = props.automationAgentReady && local.condition !== null;
  const setConditionOn = (on: boolean): void => {
    setLocal((current) => ({ ...current, condition: on ? (conditionDraft.trim() || null) ?? '' : null }));
  };
  const frequencyOn = local.max_runs !== null;
  const setFrequencyOn = (on: boolean): void => {
    setLocal((current) => ({ ...current, max_runs: on ? maxRunsDraft : null }));
  };

  const pairColumn = entry.fields.find((field) => field.kind === 'column' && !field.hidden) ?? null;
  const otherFields = entry.fields.filter((field) => !field.hidden && field !== pairColumn);

  return (
    <BaseDialog
      onClose={props.onCancel}
      testId="edit-automation-dialog"
      // The picker adds the row and opens this dialog on it, so a fresh
      // automation arrived at a window titled "Edit automation" for something
      // that did not exist a moment ago. `isNew` already distinguishes the two
      // (it selects the generated name for overtyping); the title now says so.
      title={props.isNew ? 'Add automation' : 'Edit automation'}
      // With every card on the dialog is about 990px tall, past the 600px
      // window floor, so the body scrolls and the header and footer stay put.
      // Its menus (Type, Template variable, Column) portal, so the scroll clips
      // none of them.
      className="w-[640px] max-h-[calc(100vh-2rem)]"
      bodyClassName="flex-1 min-h-0 overflow-y-auto"
      // The standard footer slot, not a `<footer>` among the children. As a
      // child it sat INSIDE the body's own padding, so it carried the body
      // inset plus its own and sat lower than every other dialog's footer.
      footer={
        <DialogFooterActions
          onCancel={props.onCancel}
          onConfirm={() => props.onDone(local)}
          confirmLabel="Done"
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
          <span className={SETTING_LABEL_CLASS}>Name</span>
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
              Already used on this column.
            </span>
          )}
        </label>

        <RuleCard testId="edit-automation-card-trigger" icon={<Zap size={16} />} title="Trigger" description="What starts it.">
          {/* Full width: three options that each name who acts. */}
          <SegmentedControl
            quiet
            fullWidth
            ariaLabel="Trigger"
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
              {`On exit, this column's automations share ${Math.round(EXIT_GROUP_BUDGET_MS / 1000)} seconds in total. Put longer work on enter.`}
            </p>
          )}
        </RuleCard>

        <RuleCard
          testId="edit-automation-card-condition"
          icon={<Funnel size={16} />}
          title="Condition"
          description="Describe it in plain words; an agent checks it."
          checked={conditionOn}
          onToggle={props.automationAgentReady ? setConditionOn : undefined}
          switchDisabled={!props.automationAgentReady}
          dimmed={!props.automationAgentReady}
          switchLabel="Condition"
        >
          {props.automationAgentReady ? (
            <div className="flex flex-col gap-2">
              <TemplateTextField
                value={conditionOn ? (local.condition ?? '') : ''}
                onChange={(next) => {
                  setConditionDraft(next);
                  // An empty Condition while on is kept as '' in the dialog so
                  // the field does not switch itself off mid-edit; the save
                  // normalizes a blank one to none.
                  setLocal((current) => ({ ...current, condition: next }));
                }}
                context="automation"
                testId="edit-automation-condition"
                placeholder={CONDITION_EXAMPLE}
                ariaLabel="Condition"
                grow={{ maxRows: PROSE_MAX_ROWS }}
                disabled={!conditionOn}
                insertRef={conditionInsertRef}
              />
              <div className={`flex ${conditionOn ? '' : 'pointer-events-none opacity-50'}`}>
                <props.templatePicker onInsert={(variable) => conditionInsertRef.current?.(variable)} />
              </div>
            </div>
          ) : (
            // No field and no Template variable: there is nothing to write a
            // condition for until something can check it.
            <div
              data-testid="edit-automation-condition-setup"
              className="flex items-center gap-3 rounded-md border border-accent/40 bg-accent/10 px-3 py-2.5"
            >
              <Info size={16} className="flex-shrink-0 text-accent-fg" aria-hidden="true" />
              <span data-testid="edit-automation-condition-setup-text" className="min-w-0 flex-1 text-[13px] font-semibold text-fg">
                Set up an Automation agent
              </span>
              {/* Accent outline and text: the one thing to do here, so it reads as
                  the way forward rather than a neutral secondary button. */}
              <button
                type="button"
                data-testid="edit-automation-open-settings"
                onClick={props.onOpenAutomationSettings}
                className="inline-flex flex-shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded border border-accent/50 px-3 py-1.5 text-xs font-medium text-accent-fg transition-colors hover:bg-accent/10"
              >
                <Settings size={14} aria-hidden="true" />
                Open Settings
              </button>
            </div>
          )}
        </RuleCard>

        <RuleCard
          testId="edit-automation-card-frequency"
          icon={<Repeat size={16} />}
          title="Frequency"
          description="How many times it can run on a task."
          checked={frequencyOn}
          onToggle={setFrequencyOn}
          switchLabel="Frequency"
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
              <span className={SETTING_LABEL_CLASS}>Maximum runs</span>
              <InfoTip label="Maximum runs" text="Counted per task, starting over when the task leaves Done. A run its Condition skipped does not count." />
            </span>
            <NumberStepper
              testId="edit-automation-max-runs"
              ariaLabel="Maximum runs"
              value={frequencyOn ? (local.max_runs ?? 1) : 1}
              disabled={!frequencyOn}
              onChange={(next) => {
                setMaxRunsDraft(next);
                setLocal((current) => ({ ...current, max_runs: next }));
              }}
            />
          </div>
        </RuleCard>

        <RuleCard
          testId="edit-automation-card-action"
          // The chosen type's own icon (a speech bubble for Send message), so
          // the card's header changes with Type below it. `data-icon` names it
          // for the specs, which should not lean on lucide's class names.
          icon={<AutomationIcon name={entry.icon} size={16} data-icon={entry.icon} />}
          title="Action"
          description="What it does."
        >
          <div className={pairColumn ? 'grid grid-cols-2 gap-3' : 'flex flex-col'}>
            {/* A <div>, not a <label>: the control is a button, and a label
                wrapping one steals its click. */}
            <div className="flex min-w-0 flex-col gap-1.5">
              <span className="flex items-center gap-1.5">
                <span className={SETTING_LABEL_CLASS}>Type</span>
                <InfoTip label="Type" text={TYPE_INFO} />
              </span>
              {/* Carries each type's icon, which a native <select> cannot: an
                  <option> holds text only. */}
              <AutomationTypePicker
                testId="edit-automation-type"
                ariaLabel="Type"
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
      </div>
    </BaseDialog>
  );
}

/**
 * One part of the rule: a settings card's header over one lighter panel.
 *
 * The geometry is `settings-card.tsx`'s (a tile-shaped header target, the
 * icon in a 16px column, the switch on the panel's right edge), reused by
 * choice: `settings-card-design.md` scopes out dialogs, but one tile shape in
 * Settings and in this dialog reads as one design.
 */
function RuleCard({
  testId, icon, title, description, checked, onToggle, switchDisabled, dimmed, switchLabel, children,
}: {
  testId: string;
  icon: React.ReactNode;
  title: string;
  description: string;
  /** The card's switch, when it has one. */
  checked?: boolean;
  onToggle?: (on: boolean) => void;
  switchDisabled?: boolean;
  /** Dim the header (the Condition card with no Automation agent). */
  dimmed?: boolean;
  switchLabel?: string;
  children: React.ReactNode;
}) {
  const hasSwitch = checked !== undefined;
  const toggle = hasSwitch && onToggle && !switchDisabled ? () => onToggle(!checked) : undefined;
  return (
    <section data-testid={testId} aria-label={title} className="rounded-lg border border-edge">
      <div className="px-3 py-1.5">
        <div
          // A click anywhere on the header flips its switch, as a settings
          // card's does. The switch's own click is left to the switch.
          onClick={toggle ? (event) => {
            if (event.target instanceof Element && event.target.closest('[role="switch"], button, a')) return;
            toggle();
          } : undefined}
          className={`flex items-center gap-3 rounded-md px-4 py-2 ${toggle ? 'cursor-pointer select-none transition-colors hover:bg-surface-hover/40' : ''}`}
        >
          <span className={`flex w-4 flex-shrink-0 justify-center text-fg-muted ${dimmed ? 'opacity-50' : ''}`} aria-hidden="true">
            {icon}
          </span>
          <span className={`min-w-0 flex-1 ${dimmed ? 'opacity-50' : ''}`}>
            <span className="block text-sm font-semibold text-fg">{title}</span>
            <span className="mt-0.5 block text-xs text-fg-tertiary">{description}</span>
          </span>
          {hasSwitch && (
            <span className="flex flex-shrink-0">
              <ToggleSwitch
                checked={checked}
                onChange={(next) => onToggle?.(next)}
                disabled={switchDisabled}
                ariaLabel={switchLabel ?? title}
                testId={`${testId}-switch`}
              />
            </span>
          )}
        </div>
      </div>
      <div className="px-3 pb-3">
        <div className="flex flex-col gap-3 rounded-md bg-surface-hover/40 px-4 py-3">
          {children}
        </div>
      </div>
    </section>
  );
}

/** A field's label row: the label, an info tip, and the Optional tag. */
function FieldLabel({ field }: { field: AutomationField }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={SETTING_LABEL_CLASS}>{field.label}</span>
      {field.info && <InfoTip label={field.label} text={field.info} />}
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
  columns: readonly AutomationColumnChoice[];
  /** The row's trigger, which decides whether the field applies (`unavailableOn`). */
  trigger: AutomationTrigger;
}) {
  const text = typeof value === 'string' ? value : '';
  const testId = `automation-config-${field.key}`;
  // A field the manifest declares does nothing on this trigger (Delivery at a
  // turn end, where the turn is already over) stays in place, disabled, with
  // the reason, and its value is not touched.
  const unavailableReason = automationFieldUnavailableReason(field, trigger);
  const inputRef = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null);
  // A highlighted textarea owns its own caret, so the picker button routes
  // through the field rather than through `inputRef`. Only the plain `text`
  // inputs still use `inputRef`, which is why both survive.
  const templateInsertRef = useRef<TemplateTextFieldInsert | null>(null);
  const highlighted = field.kind === 'textarea' && Boolean(field.templateVariables);

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
            ariaLabel={field.label}
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
          placeholder={field.placeholder}
          ariaLabel={field.label}
          insertRef={templateInsertRef}
        />
      )}

      {field.kind === 'textarea' && !highlighted && (
        <textarea
          ref={(node) => { inputRef.current = node; }}
          data-testid={testId}
          value={text}
          rows={field.rows ?? 3}
          placeholder={field.placeholder}
          onChange={(event) => onChange(event.target.value)}
          className="w-full resize-y rounded border border-edge-input bg-surface-control px-3 py-1.5 text-sm text-fg-tertiary placeholder-fg-muted focus:border-accent focus:outline-none"
        />
      )}

      {field.kind === 'text' && (
        <input
          ref={(node) => { inputRef.current = node; }}
          data-testid={testId}
          value={text}
          placeholder={field.placeholder}
          onChange={(event) => onChange(event.target.value)}
          className={FIELD_CONTROL_CLASS}
        />
      )}

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
          {field.unit && <span className={SETTING_DESCRIPTION_CLASS}>{field.unit}</span>}
        </div>
      )}

      {field.kind === 'select' && (
        <Select
          data-testid={testId}
          value={text || String(field.defaultValue ?? '')}
          onChange={(event) => onChange(event.target.value)}
        >
          {(field.options ?? []).map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </Select>
      )}

      {field.kind === 'column' && (
        // The board's columns by NAME, each with its color dot, Next column
        // (empty) first. A name the board no longer has (the column was
        // deleted) stays listed and marked, so opening the dialog never
        // silently re-points the row.
        <AutomationColumnPicker
          testId={testId}
          ariaLabel={field.label}
          value={text}
          columns={columns}
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

      {/* Template variable sits UNDER its field, at the left, where the typing
          is (the Agent prompt card's layout). */}
      {field.templateVariables && (
        <div className="flex">
          <TemplatePicker onInsert={insertAtCaret} />
        </div>
      )}

      {field.hint && <span className="text-[11px] text-fg-faint">{field.hint}</span>}
    </div>
  );
}
