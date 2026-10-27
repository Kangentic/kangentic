import React from 'react';
import { KanbanSquare, CircleDot, Cloud } from 'lucide-react';
import { msg } from '@lingui/core/runtime-macro';
import { GitHubIcon } from '../icons/GitHubIcon';
import { translateText } from '../../i18n/translate';
import type { LocalizedText } from '../../../shared/i18n/text';
import type { ExternalSource } from '../../../shared/types';

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
}

export interface Provider {
  id: string;
  label: LocalizedText;
  icon: React.ReactNode;
  available: boolean;
  comingSoon?: boolean;
  /** When true, the popover shows an auth phase (Connect + paste code) before the URL input. */
  requiresAuth?: boolean;
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
        icon: <KanbanSquare size={16} />,
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
        icon: <KanbanSquare size={16} />,
      },
    ],
  },
  {
    id: 'asana',
    label: 'Asana', // i18n-ok: a provider's own name
    icon: <KanbanSquare size={18} />,
    available: true,
    requiresAuth: true,
    sourceTypes: [
      {
        value: 'asana',
        label: msg({ message: 'Project', context: 'import source type' }),
        description: msg({ message: 'Import tasks from an Asana project', context: 'import source type' }),
        placeholder: 'https://app.asana.com/0/1234567890/list', // i18n-ok: an example URL
        hint: msg({ message: 'Paste any Asana project URL (list, board, or calendar view).', context: 'import source type' }),
        icon: <KanbanSquare size={16} />,
      },
    ],
  },
];

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
