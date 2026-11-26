import type {
  ExternalIssue,
  ExternalSource,
  ImportCheckCliResult,
  ImportFetchInput,
  ImportFetchResult,
} from '../../../../shared/types';
import { RefusalError } from '../../../../shared/refusal';
import {
  type AdapterStatus,
  type BoardAdapter,
  type DownloadedAttachment,
  type PrerequisiteResult,
  type SourceProject,
  registerSourceUrlParser,
} from '../../shared';
import { parseScriptOutput, type ScriptImportItem } from './parse-output';
import {
  liveImportScriptRunner,
  SCRIPT_IMPORT_TIMEOUT_MS,
  type ImportScriptRunner,
} from './runner';
import { resolveScriptInvocation } from '../../../pty/spawn/script-invocation';

function firstLineOf(script: string): string {
  return script.split(/\r?\n/).find((line) => line.trim() !== '')?.trim() ?? script;
}

registerSourceUrlParser('script', {
  parse: (script) => ({ repository: script.trim() }),
  buildLabel: (repository) => firstLineOf(repository),
});

function requireProject(project: SourceProject | undefined): SourceProject {
  if (!project) throw new RefusalError('No project is open.');
  return project;
}

/**
 * Board adapter for a command that prints JSON tasks. No sign-in. The saved
 * value is the script, run in the project folder (or on a remote project's
 * host) when Import opens.
 */
export class ImportScriptAdapter implements BoardAdapter {
  readonly id: ExternalSource = 'script';
  readonly displayName = 'Script';
  readonly icon = 'terminal';
  readonly status: AdapterStatus = 'stable';
  /** A fetch and its prune run back to back; one run of the script serves both. */
  private readonly recentRuns = new Map<string, Promise<ScriptImportItem[]>>();

  constructor(private readonly runner: ImportScriptRunner = liveImportScriptRunner) {}

  async checkPrerequisites(): Promise<PrerequisiteResult> {
    return { cliOk: true, authOk: true };
  }

  async checkCli(): Promise<ImportCheckCliResult> {
    return { available: true, authenticated: true };
  }

  async fetch(
    input: ImportFetchInput,
    findAlreadyImported: (source: ExternalSource, externalIds: string[]) => Set<string>,
    project?: SourceProject,
  ): Promise<ImportFetchResult> {
    if (input.page > 1) return { issues: [], totalCount: 0, hasNextPage: false };
    const sourceProject = requireProject(project);
    const items = await this.runScript(input.repository, sourceProject);
    const alreadyImported = findAlreadyImported(this.id, items.map((item) => item.id));
    const fetchedAt = new Date().toISOString();
    const issues = items.map((item) => this.toExternalIssue(item, fetchedAt, alreadyImported.has(item.id)));
    return { issues, totalCount: issues.length, hasNextPage: false };
  }

  async listExternalIds(
    input: { source: ExternalSource; repository: string },
    project?: SourceProject,
  ): Promise<string[]> {
    const sourceProject = requireProject(project);
    const items = await this.runScript(input.repository, sourceProject);
    return items.map((item) => item.id);
  }

  async downloadImages(): Promise<{ attachments: DownloadedAttachment[]; skippedCount: number }> {
    return { attachments: [], skippedCount: 0 };
  }

  private runScript(repository: string, project: SourceProject): Promise<ScriptImportItem[]> {
    const script = repository.trim();
    if (!script) throw new RefusalError('No script to run.');
    const key = `${project.path}\0${script}`;
    const recent = this.recentRuns.get(key);
    if (recent) return recent;
    const run = this.runScriptUncached(script, project);
    this.recentRuns.set(key, run);
    const forget = (): void => {
      if (this.recentRuns.get(key) === run) this.recentRuns.delete(key);
    };
    setTimeout(forget, 5_000).unref();
    run.catch(forget); // report-ok: the caller awaits the same promise and gets the error; this only drops it from the reuse window
    return run;
  }

  private async runScriptUncached(script: string, project: SourceProject): Promise<ScriptImportItem[]> {
    const result = this.runner.isRemote(project.path)
      ? await this.runner.runOnHost({
          projectPath: project.path,
          script,
          timeoutMs: SCRIPT_IMPORT_TIMEOUT_MS,
        })
      : await this.runner.runLocal({
          ...resolveScriptInvocation(await this.runner.getShell(), script),
          cwd: project.path,
          timeoutMs: SCRIPT_IMPORT_TIMEOUT_MS,
        });
    if (result.timedOut) throw new RefusalError('The script did not finish within 15 s.');
    if (result.error) throw new RefusalError(result.error);
    if (result.code !== 0) throw new RefusalError(`Script exited with code ${String(result.code)}.`);
    return parseScriptOutput(result.stdout);
  }

  private toExternalIssue(item: ScriptImportItem, fetchedAt: string, alreadyImported: boolean): ExternalIssue {
    return {
      externalId: item.id,
      externalSource: this.id,
      externalUrl: '',
      title: item.title,
      body: item.body,
      labels: [],
      assignee: null,
      state: '',
      stateCategory: 'open',
      createdAt: fetchedAt,
      updatedAt: fetchedAt,
      alreadyImported,
      attachmentCount: 0,
      displayId: item.id,
    };
  }
}
