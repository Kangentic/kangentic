import React, { useEffect, useRef, useState } from 'react';
import { Bot, Info, MessageSquareText, Plus, Settings, SignalHigh, Tag, TextSearch, X } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/runtime-macro';
import { translateText } from '../../../i18n/translate';
import { OverlayPopover } from '../../OverlayPopover';
import { Tooltip } from '../../Tooltip';
import { LabelInput } from '../../LabelInput';
import { TemplateTextField, type TemplateTextFieldInsert } from '../../TemplateTextField';
import { usePopoverPosition } from '../../../hooks/usePopoverPosition';
import { useAllExistingLabels } from '../../../hooks/useAllExistingLabels';
import { useConfigStore } from '../../../stores/config-store';
import { DEFAULT_PRIORITY_CONFIG } from '../../../../shared/types';
import type { AutomationTaskFilter, AutomationTrigger, TextMatchSource } from '../../../../shared/types';
import { TEXT_MATCH_PLACEHOLDER, TEXT_MATCH_USER_PLACEHOLDER } from '../../../../shared/final-line-match';
import { PriorityMeter } from '../../backlog/PriorityMeter';
import { displayPriorityLabel } from '../../backlog/priority-labels';
import { PatternLinesField } from './PatternLinesField';
import { TextMatchPatternsTip } from './TextMatchPatternsTip';

/**
 * The Edit automation dialog's Condition (#872, canvas board F1b): a list of
 * lines, every one of which must hold. Add condition opens one menu in three
 * groups, cheapest check first: Task (Priority, Labels), Text match (Reply,
 * Prompt) and Agent (Evaluation). Each pick adds one line labeled with the
 * menu item's own icon and one-word name.
 *
 * The menu offers only what can still be added: a kind already on the list
 * is left out, Reply and Prompt share one stored field so either leaves out
 * both, and a kind the Trigger cannot run (Text match off a turn end) is left
 * out with its whole group. When nothing is left, Add condition hides.
 */

export type ConditionLineKind = 'priority' | 'labels' | 'reply' | 'prompt' | 'evaluation';

/** The list as the dialog holds it, with each kind's value kept while its line is off. */
export interface ConditionLines {
  /** The lines in the order they were added. */
  kinds: ConditionLineKind[];
  priorities: number[];
  labels: string[];
  /** Reply's or Prompt's patterns, one per line. */
  textMatch: string;
  evaluation: string;
}

interface ConditionKindInfo {
  kind: ConditionLineKind;
  icon: React.ComponentType<{ size?: number; className?: string; 'aria-hidden'?: boolean | 'true' }>;
  name: MessageDescriptor;
  description: MessageDescriptor;
}

/** The menu's groups, in the order a row checks them: free first, then a paid check. */
const CONDITION_GROUPS: ReadonlyArray<{ id: 'task' | 'text' | 'agent'; heading: MessageDescriptor; kinds: ConditionKindInfo[] }> = [
  {
    id: 'task',
    heading: msg({ message: 'Task', context: 'condition group' }),
    kinds: [
      { kind: 'priority', icon: SignalHigh, name: msg({ message: 'Priority', context: 'condition kind' }), description: msg`The task's priority level` },
      { kind: 'labels', icon: Tag, name: msg({ message: 'Labels', context: 'condition kind' }), description: msg`The task's labels` },
    ],
  },
  {
    id: 'text',
    heading: msg({ message: 'Text match', context: 'condition group' }),
    kinds: [
      { kind: 'reply', icon: TextSearch, name: msg({ message: 'Reply', context: 'condition kind' }), description: msg`The agent's last line` },
      { kind: 'prompt', icon: MessageSquareText, name: msg({ message: 'Prompt', context: 'condition kind' }), description: msg`What you sent this turn` },
    ],
  },
  {
    id: 'agent',
    heading: msg({ message: 'Agent', context: 'condition group' }),
    kinds: [
      { kind: 'evaluation', icon: Bot, name: msg({ message: 'Evaluation', context: 'condition kind' }), description: msg`An agent checks your statement` },
    ],
  },
];

const KIND_INFO = new Map<ConditionLineKind, ConditionKindInfo>(
  CONDITION_GROUPS.flatMap((group) => group.kinds.map((info) => [info.kind, info] as const)),
);

/** The order a row's lines are listed in when the dialog opens on a saved row. */
const CANONICAL_ORDER: readonly ConditionLineKind[] = ['priority', 'labels', 'reply', 'prompt', 'evaluation'];

/** Reply and Prompt are one stored field, so a list holds at most one of them. */
function isTextKind(kind: ConditionLineKind): boolean {
  return kind === 'reply' || kind === 'prompt';
}

/** The lines a saved row opens with, in canonical order. */
export function linesFromDraft(draft: {
  filter: AutomationTaskFilter | null;
  final_line: string | null;
  text_match_source: TextMatchSource;
  condition: string | null;
}): ConditionLines {
  const present = new Set<ConditionLineKind>();
  if ((draft.filter?.priorities.length ?? 0) > 0) present.add('priority');
  if ((draft.filter?.labels.length ?? 0) > 0) present.add('labels');
  if (draft.final_line !== null) present.add(draft.text_match_source === 'user' ? 'prompt' : 'reply');
  if (draft.condition !== null) present.add('evaluation');
  return {
    kinds: CANONICAL_ORDER.filter((kind) => present.has(kind)),
    priorities: draft.filter?.priorities ?? [],
    labels: draft.filter?.labels ?? [],
    textMatch: draft.final_line ?? '',
    evaluation: draft.condition ?? '',
  };
}

const TURN_END_ONLY = msg`Turn end only`;

/** Why a kind cannot run on this trigger, or null when it can. */
export function conditionKindUnavailable(kind: ConditionLineKind, trigger: AutomationTrigger): MessageDescriptor | null {
  return isTextKind(kind) && trigger !== 'turn_end' ? TURN_END_ONLY : null;
}

/** The kinds the menu offers for this list on this trigger. */
export function addableConditionKinds(
  kinds: readonly ConditionLineKind[],
  trigger: AutomationTrigger,
  reportsUserMessages: boolean | undefined,
): ConditionLineKind[] {
  const added = new Set(kinds);
  const textAdded = kinds.some(isTextKind);
  return CANONICAL_ORDER.filter((kind) => {
    if (added.has(kind)) return false;
    if (isTextKind(kind) && (textAdded || trigger !== 'turn_end')) return false;
    if (kind === 'prompt' && reportsUserMessages === false) return false;
    return true;
  });
}

export interface ConditionListProps {
  lines: ConditionLines;
  onChange: (next: ConditionLines) => void;
  /** The Condition's switch is off: the lines dim and take no input, and Add condition stays live. */
  linesOff?: boolean;
  trigger: AutomationTrigger;
  reportsUserMessages?: boolean;
  automationAgentReady: boolean;
  onOpenAutomationSettings: () => void;
  /** The template-variable button, joined to each text line's field. */
  templatePicker: React.ComponentType<AutomationTemplatePickerProps>;
}

/** What the dialog's template-variable button takes. */
export interface AutomationTemplatePickerProps {
  onInsert: (variable: string) => void;
  /** Variables this field does not offer (a Text match leaves out agentReply). */
  exclude?: readonly string[];
  disabled?: boolean;
  testId?: string;
}

export function ConditionList(props: ConditionListProps) {
  const { t } = useLingui();
  const { lines, onChange, trigger } = props;
  const addable = addableConditionKinds(lines.kinds, trigger, props.reportsUserMessages);

  const listRef = useRef<HTMLDivElement>(null);
  const addLine = (kind: ConditionLineKind): void => {
    onChange({ ...lines, kinds: [...lines.kinds, kind] });
    // The new line's field takes the cursor, so picking a kind is the start of typing it.
    window.requestAnimationFrame(() => {
      const field = listRef.current?.querySelector<HTMLElement>(`[data-condition-field="${kind}"] input, [data-condition-field="${kind}"] textarea`);
      field?.focus();
    });
  };
  const removeLine = (kind: ConditionLineKind): void => {
    onChange({ ...lines, kinds: lines.kinds.filter((existing) => existing !== kind) });
  };

  return (
    <div ref={listRef} className="flex flex-col gap-2" data-testid="edit-automation-condition-list">
      {lines.kinds.length === 0 ? (
        <p data-testid="edit-automation-condition-empty" className="text-xs text-fg-tertiary">
          <Trans>Runs for every task.</Trans>
        </p>
      ) : (
        // The label column is as wide as the longest label present, so the
        // fields start further right only once a longer label is a line.
        <div
          data-testid="edit-automation-condition-lines"
          inert={props.linesOff === true}
          className={`grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-2 ${props.linesOff ? 'opacity-50' : ''}`}
        >
          {lines.kinds.map((kind) => (
            <ConditionLine
              key={kind}
              kind={kind}
              {...props}
              onRemove={() => removeLine(kind)}
              removeLabel={t`Remove condition`}
            />
          ))}
        </div>
      )}
      {addable.length > 0 && <AddConditionButton addable={addable} onAdd={addLine} />}
    </div>
  );
}

function ConditionLine(props: ConditionListProps & { kind: ConditionLineKind; onRemove: () => void; removeLabel: string }) {
  const { kind, trigger } = props;
  const info = KIND_INFO.get(kind);
  const unavailable = conditionKindUnavailable(kind, trigger);
  if (!info) return null;
  const Icon = info.icon;
  const name = translateText(info.name);
  return (
    <>
      {/* The menu item's icon and name, unchanged, so a picked kind reads the
          same in the menu and on the line. Its tip is the item's description. */}
      <Tooltip label={translateText(info.description)} describe={false}>
        <span
          data-testid={`edit-automation-condition-line-${kind}`}
          className={`flex h-[34px] select-none items-center gap-2 text-[13px] text-fg-secondary ${unavailable ? 'opacity-50' : ''}`}
        >
          <Icon size={16} className="flex-shrink-0 text-fg-muted" aria-hidden="true" />
          {name}
        </span>
      </Tooltip>
      <div data-condition-field={kind} className={`flex min-w-0 flex-col gap-1 ${unavailable ? 'opacity-50' : ''}`}>
        <ConditionLineField {...props} kind={kind} name={name} />
        {unavailable && (
          <span data-testid={`edit-automation-condition-line-${kind}-unavailable`} className="text-[11px] text-fg-faint">
            {translateText(unavailable)}
          </span>
        )}
      </div>
      <Tooltip label={props.removeLabel}>
        <button
          type="button"
          onClick={props.onRemove}
          aria-label={props.removeLabel}
          data-testid={`edit-automation-condition-line-${kind}-remove`}
          className="flex h-[34px] w-7 cursor-pointer items-center justify-center rounded text-fg-faint transition-colors hover:bg-surface-hover hover:text-fg"
        >
          <X size={14} aria-hidden="true" />
        </button>
      </Tooltip>
    </>
  );
}

function ConditionLineField(props: ConditionListProps & { kind: ConditionLineKind; name: string }) {
  const { t } = useLingui();
  const { kind, lines, onChange, name } = props;
  const priorityLevels = useConfigStore((state) => state.config.backlog?.priorities) ?? DEFAULT_PRIORITY_CONFIG;
  const textInsertRef = useRef<((text: string) => void) | null>(null);
  const evaluationInsertRef = useRef<TemplateTextFieldInsert | null>(null);
  const TemplatePicker = props.templatePicker;

  if (kind === 'priority') {
    const levelOptions = priorityLevels.map((_level, index) => String(index));
    const levelName = (value: string): string => {
      const entry = priorityLevels[Number(value)];
      return entry ? displayPriorityLabel(entry.label) : value;
    };
    return (
      <LabelInput
        labels={lines.priorities.map(String)}
        setLabels={(values) => onChange({ ...lines, priorities: values.map(Number).filter((level) => Number.isInteger(level)) })}
        labelColors={Object.fromEntries(priorityLevels.map((level, index) => [String(index), level.color]))}
        allExistingLabels={levelOptions}
        displayValue={levelName}
        renderLeading={(value) => {
          const level = Number(value);
          const entry = priorityLevels[level];
          return <PriorityMeter level={level} levelCount={priorityLevels.length} color={entry?.color ?? '#6b7280'} />;
        }}
        allowCustom={false}
        placeholder={t`Pick levels...`}
        ariaLabel={name}
        testId="edit-automation-condition-priority"
      />
    );
  }

  if (kind === 'labels') return <LabelsLineField lines={lines} onChange={onChange} name={name} />;

  if (kind === 'reply' || kind === 'prompt') {
    return (
      <div className="flex items-stretch">
        <div className="min-w-0 flex-1">
          <PatternLinesField
            testId="edit-automation-final-line"
            ariaLabel={name}
            value={lines.textMatch}
            placeholder={kind === 'prompt' ? TEXT_MATCH_USER_PLACEHOLDER : TEXT_MATCH_PLACEHOLDER}
            disabled={false}
            onChange={(next) => onChange({ ...lines, textMatch: next })}
            joinedRight
            endAdornment={<TextMatchPatternsTip />}
            insertRef={textInsertRef}
          />
        </div>
        {/* A Text match is matched against the agent's reply, so it never
            offers the reply itself as a variable. */}
        <TemplatePicker
          onInsert={(variable) => textInsertRef.current?.(variable)}
          exclude={TEXT_MATCH_EXCLUDED_VARIABLES}
          testId="edit-automation-final-line-variable"
        />
      </div>
    );
  }

  // Evaluation. Pickable before an Automation agent exists: the line then
  // says so, the same size as the Labels field, with the way to set one up.
  if (!props.automationAgentReady) {
    return (
      <div
        data-testid="edit-automation-condition-setup"
        className="flex min-h-[34px] items-center gap-2 rounded border border-accent/40 bg-accent/10 py-1 pl-2.5 pr-1"
      >
        <span data-testid="edit-automation-condition-setup-text" className="min-w-0 flex-1 text-[13px] text-fg">
          <Trans>Needs an Automation agent.</Trans>
        </span>
        <button
          type="button"
          data-testid="edit-automation-open-settings"
          onClick={props.onOpenAutomationSettings}
          className="inline-flex flex-shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded border border-accent/50 px-2 py-0.5 text-xs font-medium text-accent-fg transition-colors hover:bg-accent/10"
        >
          <Settings size={13} aria-hidden="true" />
          <Trans>Set up</Trans>
        </button>
      </div>
    );
  }
  return (
    <div className="flex items-stretch">
      <div className="min-w-0 flex-1">
        <TemplateTextField
          value={lines.evaluation}
          onChange={(next) => onChange({ ...lines, evaluation: next })}
          context="automation"
          testId="edit-automation-condition"
          placeholder={t`All tests pass`}
          ariaLabel={name}
          grow={{ maxRows: EVALUATION_MAX_ROWS }}
          insertRef={evaluationInsertRef}
          joinedRight
          endAdornment={(
            <Tooltip label={t`An Automation agent reads this statement against the turn and answers yes or no, after the variables are filled in.`}>
              <span
                tabIndex={0}
                role="img"
                aria-label={t`How Evaluation works`}
                data-testid="edit-automation-condition-info"
                className="inline-flex cursor-help text-fg-faint hover:text-fg-tertiary"
              >
                <Info size={13} aria-hidden="true" />
              </span>
            </Tooltip>
          )}
        />
      </div>
      <TemplatePicker
        onInsert={(variable) => evaluationInsertRef.current?.(variable)}
        testId="edit-automation-condition-variable"
      />
    </div>
  );
}

/**
 * The Labels line's field. Its own component so only a Labels line subscribes
 * to the board's and backlog's labels, which every task change rescans.
 */
function LabelsLineField({ lines, onChange, name }: Pick<ConditionListProps, 'lines' | 'onChange'> & { name: string }) {
  const labelColors = useConfigStore((state) => state.config.backlog?.labelColors) ?? EMPTY_COLORS;
  const allLabels = useAllExistingLabels();
  return (
    <LabelInput
      labels={lines.labels}
      setLabels={(values) => onChange({ ...lines, labels: values })}
      labelColors={labelColors}
      allExistingLabels={allLabels}
      ariaLabel={name}
      testId="edit-automation-condition-labels"
    />
  );
}

const EMPTY_COLORS: Record<string, string> = {};
const TEXT_MATCH_EXCLUDED_VARIABLES = ['agentReply'] as const;
/** How tall an Evaluation statement may grow before it scrolls. */
const EVALUATION_MAX_ROWS = 6;

/** The dashed full-width Add condition button, the same as Column Manager's Add automation, and its menu. */
function AddConditionButton({ addable, onAdd }: { addable: ConditionLineKind[]; onAdd: (kind: ConditionLineKind) => void }) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const { style, placement } = usePopoverPosition(
    buttonRef as React.RefObject<HTMLElement>,
    menuRef as React.RefObject<HTMLElement>,
    open,
    { mode: 'dropdown', strategy: 'fixed', matchTriggerWidth: true },
  );

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (buttonRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', handlePointerDown, true);
    document.addEventListener('keydown', handleKey, true);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKey, true);
    };
  }, [open]);

  const offered = new Set(addable);
  const groups = CONDITION_GROUPS
    .map((group) => ({ ...group, kinds: group.kinds.filter((info) => offered.has(info.kind)) }))
    .filter((group) => group.kinds.length > 0);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        data-testid="edit-automation-add-condition"
        className="flex w-full cursor-pointer items-center justify-center gap-1.5 rounded-md border border-dashed border-edge-input py-1.5 text-xs font-medium text-fg-tertiary transition-colors hover:border-edge hover:bg-surface-hover/40 hover:text-fg"
      >
        <Plus size={14} aria-hidden="true" />
        <Trans>Add condition</Trans>
      </button>
      <OverlayPopover
        open={open}
        popoverRef={menuRef}
        style={style}
        portal
        transformOrigin={placement.vertical === 'above' ? 'bottom center' : 'top center'}
        className="fixed z-[2147483646] max-h-80 overflow-y-auto rounded-lg border border-edge bg-surface py-1 shadow-xl"
        data-testid="edit-automation-add-condition-menu"
        role="menu"
        aria-label={t`Add condition`}
      >
        {groups.map((group, groupIndex) => (
          <div key={group.id} className={groupIndex > 0 ? 'mt-1 border-t border-edge/60 pt-1' : ''}>
            <div className="px-3 pb-0.5 pt-1 text-[11px] font-medium uppercase tracking-wide text-fg-faint">
              {translateText(group.heading)}
            </div>
            {group.kinds.map((info) => {
              const Icon = info.icon;
              return (
                <button
                  key={info.kind}
                  type="button"
                  role="menuitem"
                  data-testid={`edit-automation-add-condition-${info.kind}`}
                  onClick={() => {
                    onAdd(info.kind);
                    setOpen(false);
                  }}
                  className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-surface-hover focus:outline-none focus-visible:bg-surface-hover"
                >
                  <Icon size={16} className="flex-shrink-0 text-fg-muted" aria-hidden="true" />
                  <span className="text-[13px] text-fg">{translateText(info.name)}</span>
                  <span className="min-w-0 truncate text-xs text-fg-faint">{translateText(info.description)}</span>
                </button>
              );
            })}
          </div>
        ))}
      </OverlayPopover>
    </>
  );
}
