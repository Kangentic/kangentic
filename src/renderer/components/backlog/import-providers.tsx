import React from 'react';
import { Github, KanbanSquare, CircleDot, Cloud } from 'lucide-react';
import type { ExternalSource } from '../../../shared/types';

export interface SourceTypeOption {
  value: ExternalSource;
  label: string;
  description: string;
  placeholder: string;
  hint: string;
  icon: React.ReactNode;
}

export interface Provider {
  id: string;
  label: string;
  icon: React.ReactNode;
  available: boolean;
  comingSoon?: boolean;
  sourceTypes: SourceTypeOption[];
}

export const PROVIDERS: Provider[] = [
  {
    id: 'github',
    label: 'GitHub',
    icon: <Github size={18} />,
    available: true,
    sourceTypes: [
      {
        value: 'github_issues',
        label: 'GitHub Issues',
        description: 'Import from a repository issue tracker',
        placeholder: 'https://github.com/owner/repo',
        hint: 'Paste the full URL to your GitHub repository',
        icon: <CircleDot size={16} />,
      },
      {
        value: 'github_projects',
        label: 'GitHub Projects',
        description: 'Import from a GitHub Project board',
        placeholder: 'https://github.com/orgs/owner/projects/1',
        hint: 'Paste the full URL to your GitHub Project',
        icon: <KanbanSquare size={16} />,
      },
    ],
  },
  {
    id: 'azure',
    label: 'Azure DevOps',
    icon: <Cloud size={18} />,
    available: true,
    sourceTypes: [
      {
        value: 'azure_devops',
        label: 'Work Items',
        description: 'Import from Azure DevOps boards',
        placeholder: 'https://dev.azure.com/org/project',
        hint: 'Paste any Azure DevOps project URL (boards, sprints, backlogs, etc.)',
        icon: <KanbanSquare size={16} />,
      },
    ],
  },
];

/** Get a human-readable label for a source type (e.g., "GitHub Issues", "Azure DevOps Work Items"). */
export function getSourceLabel(source: ExternalSource): string {
  for (const provider of PROVIDERS) {
    for (const sourceType of provider.sourceTypes) {
      if (sourceType.value === source) return `${provider.label} ${sourceType.label}`;
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
  return <Github size={size ?? 18} />;
}

/** Get the provider's display label (e.g., "GitHub", "Azure DevOps"). */
export function getProviderLabel(source: ExternalSource): string {
  for (const provider of PROVIDERS) {
    for (const sourceType of provider.sourceTypes) {
      if (sourceType.value === source) return provider.label;
    }
  }
  return source;
}
