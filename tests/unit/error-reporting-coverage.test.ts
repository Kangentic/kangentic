/**
 * Enforces .claude/rules/error-reporting.md: a caught error is reported,
 * rethrown, handed on, or swallowed with a stated reason. A catch that only
 * logs is how handled failures in key features never reached Sentry, so the
 * sites that already did that are counted per file in a shrink-only list, and
 * a new one fails here.
 *
 * The detector lives in helpers/error-reporting-scan.ts; this file runs it over
 * src/main and src/renderer, holds the counts to the list, pins the reporter
 * set to real declarations, and drives the detector over known source so a
 * broken match cannot pass by reporting nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPORTER_FUNCTIONS, scanCatchSites, type CatchSite } from './helpers/error-reporting-scan';
import { UNREPORTED_CATCH_SITES } from './helpers/error-reporting-unreported-sites';

const REPO_ROOT = path.resolve(__dirname, '../..');
const SCAN_ROOTS = ['src/main', 'src/renderer'];

function collectSourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...collectSourceFiles(fullPath));
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) found.push(fullPath);
  }
  return found;
}

const relativeOf = (filePath: string): string => path.relative(REPO_ROOT, filePath).replace(/\\/g, '/');
const sourceFiles = SCAN_ROOTS.flatMap((root) => collectSourceFiles(path.join(REPO_ROOT, root)));
const sourceText = new Map(sourceFiles.map((file) => [relativeOf(file), fs.readFileSync(file, 'utf8')]));
const allSites: CatchSite[] = [...sourceText].flatMap(([file, text]) => scanCatchSites(file, text));

const unreportedByFile = new Map<string, CatchSite[]>();
for (const site of allSites) {
  if (site.reported) continue;
  const list = unreportedByFile.get(site.file) ?? [];
  list.push(site);
  unreportedByFile.set(site.file, list);
}

describe('every caught error is reported, rethrown, or swallowed with a reason', () => {
  it('adds no unreported catch site', () => {
    const grown: string[] = [];
    for (const [file, sites] of unreportedByFile) {
      const allowed = UNREPORTED_CATCH_SITES[file] ?? 0;
      if (sites.length > allowed) {
        grown.push(`${file}: ${sites.length} unreported, ${allowed} allowed\n${sites.map((site) => `    line ${site.line} (${site.kind})`).join('\n')}`);
      }
    }
    expect(
      grown,
      'A catch that only logs or swallows keeps a failure out of Sentry. Report it (a chokepoint\n'
        + "reporter, reportHandledError, reportRendererFailure), rethrow it, or mark it\n"
        + '`// report-ok: <reason>` at the catch. See .claude/rules/error-reporting.md.',
    ).toEqual([]);
  });

  it('lowers a count in the list when a site is fixed (the list only shrinks)', () => {
    const stale: string[] = [];
    for (const [file, allowed] of Object.entries(UNREPORTED_CATCH_SITES)) {
      const actual = unreportedByFile.get(file)?.length ?? 0;
      if (actual < allowed) stale.push(`${file}: listed ${allowed}, now ${actual}${sourceText.has(file) ? '' : ' (file gone)'}`);
    }
    expect(stale, 'Lower these counts in tests/unit/helpers/error-reporting-unreported-sites.ts, or drop the entry at 0.').toEqual([]);
  });

  it('still finds the sites it has to (the scan is not vacuous)', () => {
    expect(sourceFiles.length).toBeGreaterThan(1000);
    expect(allSites.length).toBeGreaterThan(2000);
    const reportedIn = new Set(allSites.filter((site) => site.reported).map((site) => site.file));
    for (const file of [
      'src/main/ipc/handlers/task-move.ts',
      'src/main/ipc/handlers/session-resume.ts',
      'src/main/held-messages/held-messages.ts',
      'src/main/pty/host/pty-host-core.ts',
      'src/renderer/stores/board-store/board-hydration-slice.ts',
    ]) {
      expect(reportedIn, file).toContain(file);
    }
  });
});

describe('the reporter set names real reporters', () => {
  const allSource = [...sourceText.values()].join('\n');

  it.each(REPORTER_FUNCTIONS.map((name) => [name]))('%s is declared under src/', (name) => {
    const declared = new RegExp(`(?:function ${name}\\s*\\(|\\b${name}\\s*\\([^)]*\\)\\s*:\\s*[\\w<>| ]+\\s*\\{|\\b${name}\\s*=)`);
    expect(allSource).toMatch(declared);
  });

  it('names every chokepoint reporter *Reporter, which the scan keys on', () => {
    const bindings = [...allSource.matchAll(/(?:const|let)\s+(\w+)\s*=\s*createChokepointReporter\(/g)].map((match) => match[1]);
    expect(bindings.length).toBeGreaterThan(15);
    expect(bindings.filter((name) => !name.endsWith('Reporter'))).toEqual([]);
  });
});

describe('the catch-site detector', () => {
  const scan = (source: string): boolean[] => scanCatchSites('probe.ts', source).map((site) => site.reported);

  it('counts a swallow as unreported, in a catch clause and a .catch callback', () => {
    expect(scan('try { work(); } catch (error) { console.warn(error); }')).toEqual([false]);
    expect(scan('work().catch(() => {});')).toEqual([false]);
    expect(scan('work().catch(() => undefined);')).toEqual([false]);
    expect(scan('work().catch(console.error);')).toEqual([false]);
  });

  it('passes a rethrow, a hand-on, a reporter and a worker relay', () => {
    expect(scan('try { work(); } catch (error) { throw new Error("wrapped", { cause: error }); }')).toEqual([true]);
    expect(scan('new Promise((resolve, reject) => { try { work(); } catch (error) { reject(error); } });')).toEqual([true]);
    expect(scan('work().catch((error) => Promise.reject(error));')).toEqual([true]);
    expect(scan('try { work(); } catch (error) { reportHandledError(error, {}); }')).toEqual([true]);
    expect(scan('work().catch((error) => taskMoveReporter.report(error));')).toEqual([true]);
    expect(scan('try { work(); } catch (error) { this.handledErrors.report("root_pin", error); }')).toEqual([true]);
    expect(scan('try { work(); } catch (error) { post({ type: "handledError", code: "x" }); }')).toEqual([true]);
    expect(scan('work().catch(reportRendererFailure);')).toEqual([true]);
  });

  it('does not pass a reporter it would not run, or a report method on anything else', () => {
    expect(scan('try { work(); } catch (error) { setTimeout(() => reportHandledError(error, {}), 0); }')).toEqual([false]);
    expect(scan('try { work(); } catch (error) { progress.report(error); }')).toEqual([false]);
    expect(scan('try { work(); } catch (error) { markReported(error); }')).toEqual([false]);
    expect(scan('try { work(); } catch (error) { reportTitleOf(error); }')).toEqual([false]);
  });

  it('passes a report-ok marker with a reason, and only with one', () => {
    expect(scan('try { work(); } catch {\n  // report-ok: a missing file is the normal first run.\n  return null;\n}')).toEqual([true]);
    expect(scan('try { work(); } catch { /* report-ok: optional probe */ }')).toEqual([true]);
    expect(scan('// report-ok: the load event reports it.\nwork().catch(() => undefined);')).toEqual([true]);
    expect(scan('try { work(); } catch {\n  // report-ok:\n  return null;\n}')).toEqual([false]);
  });

  it('reads TSX', () => {
    const sites = scanCatchSites('probe.tsx', 'const view = <div onClick={() => { try { work(); } catch {} }} />;');
    expect(sites.map((site) => site.reported)).toEqual([false]);
  });
});
