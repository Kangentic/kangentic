import { FileDiff, ListTree } from 'lucide-react';
import { useLingui } from '@lingui/react/macro';
import type { AppConfig } from '../../../../shared/types';
import { useScopedUpdate } from '../shared';
import { SettingsCard, CardToggleRow, CardChoiceRow } from '../settings-card';
import { settingProps } from '../settings-registry';

export function ChangesTab({ globalConfig }: { globalConfig: AppConfig }) {
  const { t } = useLingui();
  const updateGlobal = useScopedUpdate('global');
  return (
    <div className="space-y-4">
      <SettingsCard
        icon={<FileDiff size={16} />}
        label={t`Diff view`}
        description={t`How the Changes panel shows a file's diff.`}
        searchIds={['diffViewMode', 'diffDefaultScope', 'diffIgnoreWhitespace', 'diffCollapseUnchanged', 'diffWrapLines', 'diffUseInlineWhenNarrow']}
      >
        <CardChoiceRow
          {...settingProps('diffViewMode')}
          options={[
            { value: 'split', label: t`Side by side` },
            { value: 'inline', label: t({ message: 'Inline', context: 'diff view mode' }) },
          ]}
          value={globalConfig.diffViewMode}
          onChange={(value) => updateGlobal({ diffViewMode: value })}
          testId="diff-view-mode-choice"
        />
        <CardChoiceRow
          {...settingProps('diffDefaultScope')}
          options={[
            { value: 'working', label: t({ message: 'Working', context: 'diff scope' }) },
            { value: 'staged', label: t({ message: 'Staged', context: 'diff scope' }) },
            { value: 'branch', label: t({ message: 'Branch', context: 'diff scope' }) },
          ]}
          value={globalConfig.diffDefaultScope}
          onChange={(value) => updateGlobal({ diffDefaultScope: value })}
          testId="diff-default-scope-choice"
        />
        <CardToggleRow
          {...settingProps('diffIgnoreWhitespace')}
          checked={globalConfig.diffIgnoreWhitespace}
          onChange={(value) => updateGlobal({ diffIgnoreWhitespace: value })}
        />
        <CardToggleRow
          {...settingProps('diffCollapseUnchanged')}
          checked={globalConfig.diffCollapseUnchanged}
          onChange={(value) => updateGlobal({ diffCollapseUnchanged: value })}
        />
        <CardToggleRow
          {...settingProps('diffWrapLines')}
          checked={globalConfig.diffWrapLines}
          onChange={(value) => updateGlobal({ diffWrapLines: value })}
        />
        <CardToggleRow
          {...settingProps('diffUseInlineWhenNarrow')}
          checked={globalConfig.diffUseInlineWhenNarrow}
          onChange={(value) => updateGlobal({ diffUseInlineWhenNarrow: value })}
        />
      </SettingsCard>

      <SettingsCard
        icon={<ListTree size={16} />}
        label={t`File list`}
        description={t`How the changed files are sorted and grouped.`}
        searchIds={['diffFileSort', 'diffFlatList']}
      >
        <CardChoiceRow
          {...settingProps('diffFileSort')}
          options={[
            { value: 'name', label: t({ message: 'Name', context: 'sort files by' }) },
            { value: 'status', label: t({ message: 'Status', context: 'sort files by' }) },
            { value: 'size', label: t({ message: 'Size', context: 'sort files by' }) },
            { value: 'ext', label: t({ message: 'Extension', context: 'sort files by' }) },
          ]}
          value={globalConfig.diffFileSort}
          onChange={(value) => updateGlobal({ diffFileSort: value })}
          testId="diff-file-sort-choice"
        />
        <CardToggleRow
          {...settingProps('diffFlatList')}
          checked={globalConfig.diffFlatList}
          onChange={(value) => updateGlobal({ diffFlatList: value })}
        />
      </SettingsCard>
    </div>
  );
}
