import { useEffect, useMemo, useState } from 'react';
import { Bot, ListOrdered, Plus, TriangleAlert } from 'lucide-react';
import { AgentLogo } from '../../VendorMark';
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
import { agentDisplayName } from '../../../utils/agent-display-name';
import { KEYBOARD_SENSOR_OPTIONS, POINTER_SENSOR_OPTIONS } from '../../../utils/dnd-sensor-options';
import { useHmrGeneration } from '../../../utils/hmr-generation';
import { IntentKeyboardSensor } from '../../../utils/intent-keyboard-sensor';
import { ConfirmDialog } from '../../dialogs/ConfirmDialog';
import { AccountLoginDialog } from '../accounts/AccountLoginDialog';
import { AccountRow, AccountRowOverlay } from '../accounts/AccountRow';
import { useScopedUpdate } from '../shared';
import { SettingsCard, CardChoiceRow, CardTile, CardToggleRow, InfoTip } from '../settings-card';
import { settingProps } from '../settings-registry';

/** How often the reset times and the tracks' time marks move. */
const CLOCK_TICK_MS = 30_000;

/**
 * Settings > Accounts (task #1057): one ordered list of accounts per agent. New sessions start on
 * the first account in the list with room. Usage is read in the background and when this tab
 * opens; nothing here asks the user to refresh.
 */
export function AccountsTab({ globalConfig }: { globalConfig: AppConfig }) {
  const { t } = useLingui();
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
  const anyAgentHasTwo = cards.some((card) => card.accounts.length > 1);
  const orderOptions = useMemo(() => [
    { value: 'automatic' as const, label: t`Automatic`, tip: t`Soonest reset first` },
    { value: 'manual' as const, label: t`Manual`, tip: t`Your order` },
  ], [t]);

  const accountById = (accountId: string | null): { account: AgentAccount; card: AgentAccountsCard; place: number } | null => {
    for (const card of cards) {
      const index = card.accounts.findIndex((account) => account.id === accountId);
      if (index >= 0) return { account: card.accounts[index], card, place: index + 1 };
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

  return (
    <div className="space-y-4" data-testid="accounts-tab">
      {anyAgentHasTwo ? (
        <SettingsCard
          icon={<ListOrdered size={16} />}
          label={t`Run order`}
          description={t`Which account new sessions start on.`}
          searchIds={['accounts.orderMode', 'accounts.autoSwitchAtLimit']}
          testId="settings-card-accounts-run-order"
        >
          <CardChoiceRow<AgentAccountOrderMode>
            {...settingProps('accounts.orderMode')}
            options={orderOptions}
            value={accountsConfig.orderMode}
            onChange={(orderMode) => {
              void Promise.resolve(updateGlobal({ agent: { accounts: { orderMode } } }))
                .then(() => useAccountsStore.getState().loadAccounts())
                .catch((error: unknown) => console.warn('[accounts] Could not save the run order:', error));
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

      {cards.map((card) => {
        const agentName = agentDisplayName(card.agent);
        const reorderable = card.accounts.length > 1;
        // What every row of this card shares, the dragged copy included.
        const cardRowProps = {
          reportsUsage: card.reportsUsage,
          switchMovesSessions: card.switchMovesSessions,
          keyFileAgent: card.kind === 'key-file',
          now,
        };
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
                className="flex h-7 items-center gap-1.5 rounded-md border border-edge-input bg-surface-control px-2.5 text-xs text-fg hover:bg-surface-hover focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
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
                {card.accounts.map((account, index) => (
                  <AccountRow
                    key={account.id}
                    account={account}
                    place={index + 1}
                    active={card.activeAccountId === account.id && reorderable}
                    reorderable={reorderable}
                    {...cardRowProps}
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
                        place={dragged.place}
                        active={card.activeAccountId === dragged.account.id}
                        reorderable
                        {...cardRowProps}
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
