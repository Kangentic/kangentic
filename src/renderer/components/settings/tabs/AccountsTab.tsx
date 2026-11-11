import { useEffect, useMemo, useState } from 'react';
import { ArrowLeftRight, Bot, ChevronDown, Plus, TriangleAlert } from 'lucide-react';
import { AgentLogo } from '../../AgentLogo';
import { Trans, useLingui } from '@lingui/react/macro';
import { DndContext, DragOverlay, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from '@dnd-kit/core';
import { SortableContext, arrayMove, verticalListSortingStrategy } from '@dnd-kit/sortable';
import type { AppConfig } from '../../../../shared/types';
import {
  accountDisplayName,
  type AgentAccount,
  type AgentAccountKeyFileResult,
  type AgentAccountOrderMode,
  type AgentAccountsCard,
} from '../../../../shared/agent-accounts';
import { useAccountsStore } from '../../../stores/accounts-store';
import { useToastStore } from '../../../stores/toast-store';
import { accountSwitchingCards, isAccountOrderEditable, partitionAccountCards } from '../../../utils/account-cards';
import { agentDisplayName } from '../../../utils/agent-display-name';
import { KEYBOARD_SENSOR_OPTIONS, POINTER_SENSOR_OPTIONS } from '../../../utils/dnd-sensor-options';
import { useHmrGeneration } from '../../../utils/hmr-generation';
import { IntentKeyboardSensor } from '../../../utils/intent-keyboard-sensor';
import { ConfirmDialog } from '../../dialogs/ConfirmDialog';
import { KebabMenu, KebabMenuItem } from '../../KebabMenu';
import { AccountLoginDialog } from '../accounts/AccountLoginDialog';
import { AccountRow, AccountRowOverlay } from '../accounts/AccountRow';
import { useScopedUpdate } from '../shared';
import { SettingsCard, CardChoiceRow, CardTile, CardToggleRow, InfoTip } from '../settings-card';
import { settingProps } from '../settings-registry';

/** How often the reset times and the tracks' time marks move. */
const CLOCK_TICK_MS = 30_000;

/** The header button that adds an account, on an agent's card and on More agents. */
const ADD_ACCOUNT_BUTTON_CLASS = 'flex h-7 items-center gap-1.5 rounded-md border border-edge-input bg-surface-control px-2.5 text-xs text-fg hover:bg-surface-hover focus:outline-none focus-visible:ring-1 focus-visible:ring-accent';

/** Past this many agents the switching card's description names none, to stay on one line. */
const MAX_NAMED_SWITCHING_AGENTS = 2;

/**
 * Settings > Accounts (tasks #1057, #1064): one ordered list of accounts per agent. New sessions
 * start on the first account in the list with room. Usage is read in the background and when this
 * tab opens; nothing here asks the user to refresh. An agent with nothing beyond its own login
 * shares the More agents card.
 */
export function AccountsTab({ globalConfig }: { globalConfig: AppConfig }) {
  const { t, i18n } = useLingui();
  const updateGlobal = useScopedUpdate('global');
  const cards = useAccountsStore((state) => state.cards);
  const loaded = useAccountsStore((state) => state.loaded);
  const [now, setNow] = useState(() => Date.now());
  const [draggedAccountId, setDraggedAccountId] = useState<string | null>(null);
  const [accountToRemove, setAccountToRemove] = useState<AgentAccount | null>(null);
  // Re-key DndContext on HMR; see src/renderer/utils/hmr-generation.ts.
  const hmrGeneration = useHmrGeneration();
  const sensors = useSensors(
    useSensor(PointerSensor, POINTER_SENSOR_OPTIONS),
    useSensor(IntentKeyboardSensor, KEYBOARD_SENSOR_OPTIONS),
  );

  useEffect(() => {
    // The saved cards first, so the tab paints at once; then who is signed in and the usage.
    void useAccountsStore.getState().loadAccounts().then(() => useAccountsStore.getState().refreshUsage());
    const clock = window.setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => window.clearInterval(clock);
  }, []);

  const accountsConfig = globalConfig.agent.accounts;
  const orderMode = accountsConfig.orderMode;
  const { own: ownCards, more: moreCards } = partitionAccountCards(cards);
  // Order and the switch act through usage: Automatic sorts by reset, the switch reads a full
  // account. So the card shows once an agent that reports usage has two accounts, and names them.
  const switchingCards = accountSwitchingCards(cards);
  const showSwitching = switchingCards.length > 0;
  const switchingAgentNames = switchingCards.map((card) => agentDisplayName(card.agent));
  const agentNames = new Intl.ListFormat(i18n.locale, { type: 'conjunction' }).format(switchingAgentNames);
  const switchingDescription = switchingAgentNames.length > 0 && switchingAgentNames.length <= MAX_NAMED_SWITCHING_AGENTS
    ? t`Applies to agents that report usage: ${agentNames}.`
    : t`Applies to agents that report usage.`;
  const orderOptions = useMemo(() => [
    { value: 'automatic' as const, label: t`Automatic`, tip: t`Soonest reset first` },
    { value: 'manual' as const, label: t`Manual`, tip: t`Your order` },
  ], [t]);

  const accountById = (accountId: string | null): { account: AgentAccount; card: AgentAccountsCard } | null => {
    for (const card of cards) {
      const account = card.accounts.find((candidate) => candidate.id === accountId);
      if (account) return { account, card };
    }
    return null;
  };
  const dragged = accountById(draggedAccountId);
  const accountToRemoveName = accountToRemove ? accountDisplayName(accountToRemove) : null;
  const removeTitle = accountToRemoveName ? t`Remove ${accountToRemoveName}?` : t`Remove this account?`;

  const reportFailure = (title: string, message: string): void => {
    useToastStore.getState().addToast({ title, message, variant: 'error' });
  };

  const addAccount = async (card: AgentAccountsCard): Promise<void> => {
    const agentName = agentDisplayName(card.agent);
    if (card.kind === 'folder') {
      const started = await useAccountsStore.getState().startLogin(card.agent);
      if (!started) reportFailure(t`Couldn't start sign-in`, t`The ${agentName} sign-in did not start.`);
      return;
    }
    let result: AgentAccountKeyFileResult | null;
    try {
      result = await window.electronAPI.accounts.addKeyFile(card.agent);
    } catch (error) {
      console.warn('[accounts] Could not add a key file:', error);
      result = { ok: false, reason: 'unreadable' };
    }
    if (!result || result.ok) return;
    const reasons: Record<Exclude<AgentAccountKeyFileResult, { ok: true }>['reason'], string> = {
      unsupported: t`${agentName} does not take a key file.`,
      unreadable: t`The file could not be read.`,
      'no-keys': t`The file sets none of the keys ${agentName} reads.`,
      duplicate: t`That file is already in the list.`,
    };
    reportFailure(t`Couldn't add account`, reasons[result.reason]);
  };

  const signInAgain = async (account: AgentAccount): Promise<void> => {
    const started = await useAccountsStore.getState().startLoginAgain(account);
    const agentName = agentDisplayName(account.agent);
    if (!started) reportFailure(t`Couldn't start sign-in`, t`The ${agentName} sign-in did not start.`);
  };

  const handleDragStart = (event: DragStartEvent): void => setDraggedAccountId(String(event.active.id));
  const handleDragEnd = (card: AgentAccountsCard) => (event: DragEndEvent): void => {
    setDraggedAccountId(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const ids = card.accounts.map((account) => account.id);
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    void useAccountsStore.getState().reorder(card.agent, arrayMove(ids, from, to));
  };

  // What every row of a card shares, the dragged copy included.
  const rowPropsFor = (card: AgentAccountsCard) => ({
    reorderable: card.accounts.length > 1,
    orderEditable: isAccountOrderEditable(card, orderMode),
    reportsUsage: card.reportsUsage,
    usageWindows: card.usageWindows,
    switchMovesSessions: card.switchMovesSessions,
    keyFileAgent: card.kind === 'key-file',
    now,
  });

  return (
    <div className="space-y-4" data-testid="accounts-tab">
      {showSwitching ? (
        <SettingsCard
          icon={<ArrowLeftRight size={16} />}
          label={t`Account switching`}
          description={switchingDescription}
          searchIds={['accounts.orderMode', 'accounts.autoSwitchAtLimit']}
          testId="settings-card-accounts-switching"
        >
          <CardChoiceRow<AgentAccountOrderMode>
            {...settingProps('accounts.orderMode')}
            inlineDescription
            options={orderOptions}
            value={orderMode}
            onChange={(nextOrderMode) => {
              void Promise.resolve(updateGlobal({ agent: { accounts: { orderMode: nextOrderMode } } }))
                .then(() => useAccountsStore.getState().loadAccounts())
                .catch((error: unknown) => console.warn('[accounts] Could not save the account order:', error));
            }}
            testId="accounts-order-mode"
          />
          <CardToggleRow
            {...settingProps('accounts.autoSwitchAtLimit')}
            inlineDescription
            checked={accountsConfig.autoSwitchAtLimit}
            onChange={(autoSwitchAtLimit) => updateGlobal({ agent: { accounts: { autoSwitchAtLimit } } })}
          />
        </SettingsCard>
      ) : null}

      {ownCards.map((card) => {
        const agentName = agentDisplayName(card.agent);
        const rowProps = rowPropsFor(card);
        return (
          <SettingsCard
            key={card.agent}
            icon={<AgentLogo agent={card.agent} />}
            label={agentName}
            searchIds={['accounts.list']}
            testId={`settings-card-accounts-${card.agent}`}
            headerAction={card.unsupportedTarget ? undefined : (
              <button
                type="button"
                onClick={() => { void addAccount(card); }}
                className={ADD_ACCOUNT_BUTTON_CLASS}
                data-testid={`accounts-add-${card.agent}`}
              >
                <Plus size={13} aria-hidden="true" />
                <Trans>Add account</Trans>
              </button>
            )}
          >
            {card.overrides.map(({ variable }) => (
              <CardTile key={variable} className="flex items-center gap-2" testId="accounts-override-line">
                <TriangleAlert size={14} className="flex-shrink-0 text-warning" aria-hidden="true" />
                <span className="min-w-0 truncate text-xs text-warning">
                  <Trans><span className="font-mono">{variable}</span> overrides these accounts.</Trans>
                </span>
                <InfoTip
                  label={variable}
                  text={t`${agentName} uses this variable, set where Kangentic started, ahead of any account here.`}
                />
              </CardTile>
            ))}
            {card.unsupportedTarget ? (
              <CardTile className="text-xs text-fg-muted" testId="accounts-remote-note">
                <Trans>{agentName} runs in WSL here, where it keeps the one login it has.</Trans>
              </CardTile>
            ) : null}
            <DndContext
              key={hmrGeneration}
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd(card)}
              onDragCancel={() => setDraggedAccountId(null)}
            >
              <SortableContext items={card.accounts.map((account) => account.id)} strategy={verticalListSortingStrategy}>
                {card.accounts.map((account) => (
                  <AccountRow
                    key={account.id}
                    account={account}
                    active={card.activeAccountId === account.id && rowProps.reorderable}
                    {...rowProps}
                    onSwitchTo={() => { void useAccountsStore.getState().switchTo(account.id); }}
                    onSignIn={() => { void signInAgain(account); }}
                    onRemove={() => setAccountToRemove(account)}
                  />
                ))}
              </SortableContext>
              <DragOverlay>
                {dragged && dragged.card.agent === card.agent ? (
                  // `.drag-overlay` is the box dnd-kit measures, so the tilt sits one layer in.
                  <div className="drag-overlay">
                    <div className="drag-overlay-tilt">
                      <AccountRowOverlay
                        account={dragged.account}
                        active={card.activeAccountId === dragged.account.id}
                        {...rowProps}
                        onSwitchTo={() => undefined}
                        onSignIn={() => undefined}
                        onRemove={() => undefined}
                      />
                    </div>
                  </div>
                ) : null}
              </DragOverlay>
            </DndContext>
          </SettingsCard>
        );
      })}

      {moreCards.length > 0 ? (
        <SettingsCard
          icon={<Bot size={16} />}
          label={t`More agents`}
          description={t`These use their own sign-in.`}
          searchIds={['accounts.list']}
          testId="settings-card-accounts-more"
          headerAction={(
            <KebabMenu
              label={t`Add account`}
              labelShown
              icon={(
                <>
                  <Plus size={13} aria-hidden="true" />
                  <Trans>Add account</Trans>
                  <ChevronDown size={12} aria-hidden="true" />
                </>
              )}
              triggerClassName={ADD_ACCOUNT_BUTTON_CLASS}
              triggerTestId="accounts-add-more"
              menuTestId="accounts-add-more-menu"
            >
              {(close) => moreCards.map((card) => (
                <KebabMenuItem
                  key={card.agent}
                  icon={<AgentLogo agent={card.agent} size={14} />}
                  label={agentDisplayName(card.agent)}
                  onClick={() => { close(); void addAccount(card); }}
                  data-testid={`accounts-add-${card.agent}`}
                />
              ))}
            </KebabMenu>
          )}
        >
          {moreCards.map((card) => (
            <CardTile key={card.agent} className="flex items-center gap-2.5" testId={`accounts-more-${card.agent}`}>
              <span className="flex flex-shrink-0 text-fg-secondary"><AgentLogo agent={card.agent} size={14} /></span>
              <span className="min-w-0 truncate text-xs font-medium text-fg">{agentDisplayName(card.agent)}</span>
            </CardTile>
          ))}
        </SettingsCard>
      ) : null}

      {loaded && cards.length === 0 ? (
        <SettingsCard
          icon={<Bot size={16} />}
          label={t`No agents with accounts`}
          description={t`Install an agent that signs in, and its accounts show here.`}
          searchIds={['accounts.list']}
          testId="settings-card-accounts-empty"
        />
      ) : null}

      <AccountLoginDialog />

      {accountToRemove ? (
        <ConfirmDialog
          testId="account-remove-confirm"
          variant="danger"
          title={removeTitle}
          message={t`Kangentic stops using it for new sessions.`}
          confirmLabel={t`Remove`}
          onConfirm={() => {
            void useAccountsStore.getState().remove(accountToRemove.id);
            setAccountToRemove(null);
          }}
          onCancel={() => setAccountToRemove(null)}
        />
      ) : null}
    </div>
  );
}
