import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Electron 44.5.0+ aborts startup before any child process starts when the install folder's ACL
// carries an AppContainer package entry (S-1-15-2-*) but no ALL APPLICATION PACKAGES grant
// (electron/electron#54484). Our per-user NSIS install under %LOCALAPPDATA%\Programs does not
// inherit that grant the way Program Files does, so build/installer.nsh adds it on every install
// and every --updated auto-update. These pins keep the grant wired, keep it re-running on update,
// and say when upstream has made it redundant.

const REPO_ROOT = path.resolve(__dirname, '../..');
const builderYml = fs.readFileSync(path.join(REPO_ROOT, 'electron-builder.yml'), 'utf8').replace(/\r\n/g, '\n');
const installerScript = fs.readFileSync(path.join(REPO_ROOT, 'build', 'installer.nsh'), 'utf8').replace(/\r\n/g, '\n');

function extractTopLevelBlock(yamlSource: string, topLevelKey: string): string {
  const match = yamlSource.match(new RegExp(`\\n${topLevelKey}:\\n((?:[ \\t].*\\n?)*)`));
  if (!match) throw new Error(`electron-builder.yml: could not find top-level key "${topLevelKey}:"`);
  return match[1];
}

/** The body of `!macro customInstall`, without comment lines. */
function customInstallBody(script: string): string {
  const match = script.match(/^!macro customInstall\s*\n([\s\S]*?)^!macroend/m);
  if (!match) throw new Error('build/installer.nsh defines no customInstall macro.');
  return match[1]
    .split('\n')
    .filter((line) => !/^\s*;/.test(line))
    .join('\n');
}

describe('NSIS ALL APPLICATION PACKAGES grant', () => {
  it('is wired into the per-user installer through nsis.include', () => {
    const nsis = extractTopLevelBlock(builderYml, 'nsis');
    expect(nsis).toMatch(/^ {2}include: build\/installer\.nsh$/m);
    expect(nsis).toMatch(/^ {2}perMachine: false$/m);
  });

  it('grants S-1-15-2-1 read and execute, inherited by files and folders, through the system icacls', () => {
    const body = customInstallBody(installerScript);
    expect(body).toContain(`nsExec::ExecToLog '"$SYSDIR\\icacls.exe" "$INSTDIR" /grant *S-1-15-2-1:(OI)(CI)(RX)'`);
  });

  // customInstall runs on fresh installs AND on the --updated re-run electron-updater performs,
  // and the update deletes $INSTDIR first. A guard on ${isUpdated} (or moving this into a hook
  // that only runs once, like customInit) would leave every auto-updated install without it.
  it('runs on every install and update, only for per-user installs', () => {
    const body = customInstallBody(installerScript);
    expect(body).toContain('${if} $installMode == "CurrentUser"');
    expect(body).not.toMatch(/isUpdated/);
  });

  it('logs a failed grant and never aborts the install', () => {
    const body = customInstallBody(installerScript);
    expect(body).toContain('Pop $0');
    expect(body).toContain('DetailPrint');
    expect(body).not.toMatch(/\b(Abort|Quit|SetErrorLevel)\b/);
  });

  // electron-userland/electron-builder#10242 adds the same grant to electron-builder's own
  // installSection.nsh. Once a version carrying it is installed, ours runs it twice for nothing.
  it('is still needed: the installed electron-builder does not grant it itself', () => {
    const templatesDir = path.join(REPO_ROOT, 'node_modules', 'app-builder-lib', 'templates', 'nsis');
    const upstreamGrants = fs
      .readdirSync(templatesDir, { recursive: true, encoding: 'utf8' })
      .filter((name) => name.endsWith('.nsh') || name.endsWith('.nsi'))
      .filter((name) => fs.readFileSync(path.join(templatesDir, name), 'utf8').includes('S-1-15-2-1'));
    expect(
      upstreamGrants,
      'electron-builder now grants ALL APPLICATION PACKAGES itself (electron-builder#10242). Delete ' +
        'build/installer.nsh, the nsis.include line in electron-builder.yml, this test, and the ' +
        'troubleshooting note in docs/installation.md.'
    ).toEqual([]);
  });
});
