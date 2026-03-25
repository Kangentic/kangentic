import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import type { ExternalSource, ImportSource } from '../../shared/types';
import { parseGitHubIssuesUrl, parseGitHubProjectsUrl, buildGitHubLabel } from './github/url-parser';
import { parseAzureDevOpsUrl, buildAzureDevOpsLabel } from './azure-devops/url-parser';

interface ProjectImportConfig {
  importSources?: ImportSource[];
}

/** URL parser for a specific source type. */
interface SourceUrlParser {
  parse: (url: string) => { repository: string };
  buildLabel: (repository: string) => string;
}

/** Registry of URL parsers keyed by ExternalSource. */
const urlParsers: Record<ExternalSource, SourceUrlParser> = {
  github_issues: { parse: parseGitHubIssuesUrl, buildLabel: buildGitHubLabel },
  github_projects: { parse: parseGitHubProjectsUrl, buildLabel: buildGitHubLabel },
  azure_devops: { parse: parseAzureDevOpsUrl, buildLabel: buildAzureDevOpsLabel },
};

/**
 * Persists saved import sources in the project's .kangentic/config.json file
 * under the `importSources` key.
 */
export class ImportSourceStore {
  private configPath: string;

  constructor(projectPath: string) {
    this.configPath = path.join(projectPath, '.kangentic', 'config.json');
  }

  list(): ImportSource[] {
    const config = this.readConfig();
    return config.importSources ?? [];
  }

  add(source: ExternalSource, url: string): ImportSource {
    const config = this.readConfig();
    const sources = config.importSources ?? [];

    const { repository } = parseUrlForSource(source, url);

    // Check for duplicate (same source + repository)
    const existing = sources.find(
      (existingSource) => existingSource.source === source && existingSource.repository === repository,
    );
    if (existing) {
      return existing;
    }

    const parser = urlParsers[source];
    const newSource: ImportSource = {
      id: uuidv4(),
      source,
      label: parser ? parser.buildLabel(repository) : repository,
      repository,
      url,
      createdAt: new Date().toISOString(),
    };

    sources.push(newSource);
    this.writeConfig({ ...config, importSources: sources });
    return newSource;
  }

  remove(id: string): void {
    const config = this.readConfig();
    const sources = config.importSources ?? [];
    const filtered = sources.filter((source) => source.id !== id);
    this.writeConfig({ ...config, importSources: filtered });
  }

  private readConfig(): ProjectImportConfig {
    try {
      const raw = fs.readFileSync(this.configPath, 'utf-8');
      return JSON.parse(raw) as ProjectImportConfig;
    } catch {
      return {};
    }
  }

  private writeConfig(config: ProjectImportConfig): void {
    const directory = path.dirname(this.configPath);
    if (!fs.existsSync(directory)) {
      fs.mkdirSync(directory, { recursive: true });
    }

    // Preserve existing config keys, only update importSources
    let existing: Record<string, unknown> = {};
    try {
      const raw = fs.readFileSync(this.configPath, 'utf-8');
      existing = JSON.parse(raw) as Record<string, unknown>;
    } catch { /* start fresh */ }

    existing.importSources = config.importSources;
    fs.writeFileSync(this.configPath, JSON.stringify(existing, null, 2));
  }
}

/** Parse a URL for a specific source type, returning the repository identifier. */
export function parseUrlForSource(source: ExternalSource, url: string): { repository: string } {
  const trimmed = url.trim().replace(/\/+$/, '');
  const parser = urlParsers[source];
  if (!parser) {
    throw new Error(`Unsupported source type: ${source}`);
  }
  return parser.parse(trimmed);
}
