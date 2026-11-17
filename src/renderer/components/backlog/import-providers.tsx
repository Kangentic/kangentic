import React from 'react';
import { SquareKanban, CircleDot, Cloud } from 'lucide-react';
import { msg } from '@lingui/core/runtime-macro';
import { GitHubIcon } from '../icons/GitHubIcon';
import { ArtifactPlatformLogo } from '../VendorMark';
import { AsanaSetupDialog } from '../asana/AsanaSetupDialog';
import { LinearSetupDialog } from '../linear/LinearSetupDialog';
import { LinearTeamPicker } from '../linear/LinearTeamPicker';
import { translateText } from '../../i18n/translate';
import type { LocalizedText } from '../../../shared/i18n/text';
import type { ExternalSource, ImportSource } from '../../../shared/types';

/** What a provider's Connect dialog takes. `initialError` shows why it was reopened. */
export interface ProviderSetupDialogProps {
  onClose: () => void;
  /** Called once the credential is checked and saved. */
  onSaved: () => void;
  initialError?: string | null;
}

/**
 * A provider that signs in through Kangentic rather than a CLI. The popover asks
 * `getStatus` before the source step and opens `SetupDialog` when not connected,
 * and the Import dialog's error banner offers the same dialog as a Connect button.
 */
export interface ProviderAuth {
  getStatus: () => Promise<{ connected: boolean }>;
  SetupDialog: React.ComponentType<ProviderSetupDialogProps>;
}

/** What a source picker takes: it replaces the URL field for a provider that lists its sources. */
export interface SourcePickerProps {
  existingSources: ImportSource[];
  /** Add the picked source by its URL, the same path a pasted URL takes. */
  onPick: (url: string) => void;
  /** Open a source that is already saved. */
  onOpenExisting: (source: ImportSource) => void;
  onBack: () => void;
  /** The list failed on sign-in (a revoked key, an expired sign-in): reopen Connect with the provider's message. */
  onAuthFailed: (message: string) => void;
  /** True while a pick is being added. */
  busy: boolean;
  error: string | null;
}

// Text here is a descriptor (or a provider's own name, which stays a plain string)
// resolved with `translateText` where it renders, since this table is built at
// module load, before the session's catalog is active. Placeholders are example
// URLs and stay as written.
export interface SourceTypeOption {
  value: ExternalSource;
  label: LocalizedText;
  description: LocalizedText;
  placeholder: string;
  hint: LocalizedText;
  icon: React.ReactNode;
  /** Shown in place of the URL field: the provider lists its sources and the user picks one. */
  picker?: React.ComponentType<SourcePickerProps>;
}

export interface Provider {
  id: string;
  label: LocalizedText;
  icon: React.ReactNode;
  available: boolean;
  comingSoon?: boolean;
  /** Present for a provider that signs in through Kangentic (Asana, Linear). */
  auth?: ProviderAuth;
  sourceTypes: SourceTypeOption[];
}

export const PROVIDERS: Provider[] = [
  {
    id: 'github',
    label: 'GitHub', // i18n-ok: a provider's own name
    icon: <GitHubIcon size={18} />,
    available: true,
    sourceTypes: [
      {
        value: 'github_issues',
        label: msg({ message: 'Issues', context: 'import source type' }),
        description: msg({ message: 'Import from a repository issue tracker', context: 'import source type' }),
        placeholder: 'https://github.com/owner/repo', // i18n-ok: an example URL
        hint: msg({ message: 'Paste the full URL to your GitHub repository', context: 'import source type' }),
        icon: <CircleDot size={16} />,
      },
      {
        value: 'github_projects',
        label: msg({ message: 'Projects', context: 'import source type' }),
        description: msg({ message: 'Import from a GitHub Project board', context: 'import source type' }),
        placeholder: 'https://github.com/orgs/owner/projects/1', // i18n-ok: an example URL
        hint: msg({ message: 'Paste the full URL to your GitHub Project', context: 'import source type' }),
        icon: <SquareKanban size={16} />,
      },
    ],
  },
  {
    id: 'azure',
    label: 'Azure DevOps', // i18n-ok: a provider's own name
    icon: <Cloud size={18} />,
    available: true,
    sourceTypes: [
      {
        value: 'azure_devops',
        label: msg({ message: 'Work Items', context: 'import source type' }),
        description: msg({ message: 'Import from Azure DevOps boards', context: 'import source type' }),
        placeholder: 'https://dev.azure.com/org/project', // i18n-ok: an example URL
        hint: msg({ message: 'Paste any Azure DevOps project URL (boards, sprints, backlogs, etc.)', context: 'import source type' }),
        icon: <SquareKanban size={16} />,
      },
    ],
  },
  {
    id: 'asana',
    label: 'Asana', // i18n-ok: a provider's own name
    icon: <SquareKanban size={18} />,
    available: true,
    auth: {
      getStatus: () => window.electronAPI.backlog.asana.authStatus(),
      SetupDialog: AsanaSetupDialog,
    },
    sourceTypes: [
      {
        value: 'asana',
        label: msg({ message: 'Project', context: 'import source type' }),
        description: msg({ message: 'Import tasks from an Asana project', context: 'import source type' }),
        placeholder: 'https://app.asana.com/0/1234567890/list', // i18n-ok: an example URL
        hint: msg({ message: 'Paste any Asana project URL (list, board, or calendar view).', context: 'import source type' }),
        icon: <SquareKanban size={16} />,
      },
    ],
  },
  {
    id: 'linear',
    label: 'Linear', // i18n-ok: a provider's own name
    icon: <ArtifactPlatformLogo platformId="linear" size={16} />,
    available: true,
    auth: {
      getStatus: () => window.electronAPI.backlog.linear.authStatus(),
      SetupDialog: LinearSetupDialog,
    },
    sourceTypes: [
      {
        value: 'linear',
        label: msg({ message: 'Team', context: 'import source type' }),
        description: msg({ message: 'Import issues from a Linear team', context: 'import source type' }),
        placeholder: 'https://linear.app/acme/team/ENG/all', // i18n-ok: an example URL
        hint: msg({ message: 'Paste the URL of any page in your Linear team.', context: 'import source type' }),
        icon: <ArtifactPlatformLogo platformId="linear" size={16} />,
        picker: LinearTeamPicker,
      },
    ],
  },
];

/** The provider whose source types include `source`. */
export function getProviderForSource(source: ExternalSource): Provider | undefined {
  return PROVIDERS.find((provider) => provider.sourceTypes.some((sourceType) => sourceType.value === source));
}

/** The provider and source type as one phrase ("GitHub Issues"), whose word order a language may change. */
const SOURCE_LABEL_MESSAGE = msg({ message: '{provider} {sourceType}', context: 'import source' });

/** Get a human-readable label for a source type (e.g., "GitHub Issues", "Azure DevOps Work Items"). */
export function getSourceLabel(source: ExternalSource): string {
  for (const provider of PROVIDERS) {
    for (const sourceType of provider.sourceTypes) {
      if (sourceType.value === source) {
        return translateText(SOURCE_LABEL_MESSAGE, {
          provider: translateText(provider.label),
          sourceType: translateText(sourceType.label),
        });
      }
    }
  }
  return source;
}

/** Get the provider icon for a source type. Returns the icon at its default size. */
export function getSourceIcon(source: ExternalSource, size?: number): React.ReactNode {
  for (const provider of PROVIDERS) {
    for (const sourceType of provider.sourceTypes) {
      if (sourceType.value === source) {
        if (size !== undefined) {
          return React.cloneElement(provider.icon as React.ReactElement<{ size: number }>, { size });
        }
        return provider.icon;
      }
    }
  }
  return <GitHubIcon size={size ?? 18} />;
}

/** Get the provider's display label (e.g., "GitHub", "Azure DevOps"). */
export function getProviderLabel(source: ExternalSource): string {
  for (const provider of PROVIDERS) {
    for (const sourceType of provider.sourceTypes) {
      if (sourceType.value === source) return translateText(provider.label);
    }
  }
  return source;
}
