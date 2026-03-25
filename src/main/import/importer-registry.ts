import type { ExternalSource } from '../../shared/types';
import type { ImporterRegistry } from './importer';
import { GitHubImporter } from './github/github-importer';
import { AzureDevOpsImporter } from './azure-devops/azure-devops-importer';
import { GitHubIssuesAdapter } from './github/github-issues-adapter';
import { GitHubProjectsAdapter } from './github/github-projects-adapter';
import { AzureDevOpsAdapter } from './azure-devops/azure-devops-adapter';

/**
 * Create the importer registry with all supported sources.
 * Each ExternalSource value maps to an Importer implementation.
 */
export function createImporterRegistry(): ImporterRegistry {
  const githubImporter = new GitHubImporter();
  const azureDevOpsImporter = new AzureDevOpsImporter();

  return {
    github_issues: new GitHubIssuesAdapter(githubImporter),
    github_projects: new GitHubProjectsAdapter(githubImporter),
    azure_devops: new AzureDevOpsAdapter(azureDevOpsImporter, githubImporter),
  };
}

/** Get an importer for a source, or throw if unsupported. */
export function getImporter(registry: ImporterRegistry, source: ExternalSource) {
  const importer = registry[source];
  if (!importer) {
    throw new Error(`Unsupported import source: ${source}`);
  }
  return importer;
}
