import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import type { ExternalSource, ImportSource } from '../../shared/types';

interface ProjectImportConfig {
  importSources?: ImportSource[];
}

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

    const newSource: ImportSource = {
      id: uuidv4(),
      source,
      label: repository,
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

  if (source === 'github_projects') {
    const projectUrlPattern = /https?:\/\/github\.com\/(?:orgs|users)\/([^/\s]+)\/projects\/(\d+)/;
    const projectMatch = projectUrlPattern.exec(trimmed);
    if (projectMatch) {
      return { repository: `${projectMatch[1]}/${projectMatch[2]}` };
    }
    throw new Error('Invalid GitHub Projects URL. Expected format: https://github.com/orgs/owner/projects/1');
  }

  if (source === 'github_issues') {
    const repoUrlPattern = /https?:\/\/github\.com\/(?!orgs\/)(?!users\/)([^/\s]+\/[^/\s]+?)(?:\/(?:issues|pulls|wiki|actions)?)?(?:\?.*)?$/;
    const repoMatch = repoUrlPattern.exec(trimmed);
    if (repoMatch) {
      return { repository: repoMatch[1] };
    }
    throw new Error('Invalid GitHub repository URL. Expected format: https://github.com/owner/repo');
  }

  throw new Error(`Unsupported source type: ${source}`);
}
