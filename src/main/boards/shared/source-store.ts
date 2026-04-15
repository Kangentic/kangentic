import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import type { ExternalSource, ImportSource } from '../../../shared/types';

interface ProjectImportConfig {
  importSources?: ImportSource[];
}

/** URL parser contract. Each adapter registers one via registerSourceUrlParser(). */
export interface SourceUrlParser {
  parse: (url: string) => { repository: string };
  buildLabel: (repository: string) => string;
}

const urlParsers = new Map<ExternalSource, SourceUrlParser>();

/** Register a URL parser for an ExternalSource. Called once per adapter at load time. */
export function registerSourceUrlParser(source: ExternalSource, parser: SourceUrlParser): void {
  urlParsers.set(source, parser);
}

/** Parse a URL for a specific source type, returning the repository identifier. */
export function parseUrlForSource(source: ExternalSource, url: string): { repository: string } {
  const trimmed = url.trim().replace(/\/+$/, '');
  const parser = urlParsers.get(source);
  if (!parser) {
    throw new Error(`Unsupported source type: ${source}`);
  }
  return parser.parse(trimmed);
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

    const existing = sources.find(
      (existingSource) => existingSource.source === source && existingSource.repository === repository,
    );
    if (existing) {
      return existing;
    }

    const parser = urlParsers.get(source);
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

  /** Patch the display label for an existing source. Used by providers that
   * can lazily resolve a nicer name (e.g. Asana project GID -> project name). */
  updateLabel(id: string, newLabel: string): ImportSource | null {
    const trimmed = newLabel.trim();
    if (trimmed.length === 0) return null;
    const config = this.readConfig();
    const sources = config.importSources ?? [];
    const index = sources.findIndex((source) => source.id === id);
    if (index < 0) return null;
    const updated: ImportSource = { ...sources[index], label: trimmed };
    sources[index] = updated;
    this.writeConfig({ ...config, importSources: sources });
    return updated;
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

    let existing: Record<string, unknown> = {};
    try {
      const raw = fs.readFileSync(this.configPath, 'utf-8');
      existing = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      /* start fresh */
    }

    existing.importSources = config.importSources;
    fs.writeFileSync(this.configPath, JSON.stringify(existing, null, 2));
  }
}
