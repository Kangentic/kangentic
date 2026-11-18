/**
 * build/windowsSign.js - the command the Windows release leg signs each file with.
 *
 * What a user loses if it breaks: a Windows installer whose signature stops verifying about three
 * days after release. A Trusted Signing certificate lasts that long, and Windows judges a
 * signature with no timestamp against today's date. Every installer through 0.59.0 shipped
 * without one, because the command named no timestamp server and Invoke-TrustedSigning adds a
 * timestamp only when it is given one. The nightly in .github/workflows/signing-credentials.yml
 * proves the real signature carries a timestamp. This is the same guarantee one tier down, so a
 * change that drops the argument fails a pull request and not the next night's run.
 *
 * Tier: Unit. It calls the hook's own command builder.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const windowsSign = require('../../build/windowsSign.js') as {
  signingCommand: (filePath: string, env: Record<string, string | undefined>) => string;
  TIMESTAMP_SERVER: string;
  EXCLUDED_CREDENTIALS: string[];
};

const ENVIRONMENT = {
  AZURE_SIGNING_ENDPOINT: 'https://example.codesigning.azure.net/',
  AZURE_SIGNING_ACCOUNT: 'example-account',
  AZURE_CERT_PROFILE: 'example-profile',
};

describe('the Windows signing command', () => {
  it('names a timestamp server and its digest', () => {
    const command = windowsSign.signingCommand('C:\\out\\Kangentic-Setup-1.0.0.exe', ENVIRONMENT);
    expect(windowsSign.TIMESTAMP_SERVER).toMatch(/^https?:\/\/\S+$/);
    expect(command).toContain(`-TimestampRfc3161 '${windowsSign.TIMESTAMP_SERVER}'`);
    expect(command).toContain('-TimestampDigest SHA256');
  });

  it('signs the file it was given, on the account and profile from the environment', () => {
    const command = windowsSign.signingCommand('C:\\out\\Kangentic-Setup-1.0.0.exe', ENVIRONMENT);
    expect(command.startsWith('Invoke-TrustedSigning ')).toBe(true);
    expect(command).toContain("-Endpoint 'https://example.codesigning.azure.net/'");
    expect(command).toContain("-CodeSigningAccountName 'example-account'");
    expect(command).toContain("-CertificateProfileName 'example-profile'");
    expect(command).toContain("-Files 'C:\\out\\Kangentic-Setup-1.0.0.exe'");
    expect(command).toContain('-FileDigest SHA256');
  });

  // The release signs in to Azure through GitHub's OIDC federation and the Azure CLI then holds
  // the sign-in. If the Azure CLI's kind were excluded, or the environment's kind let back in, the
  // cmdlet would look for a client secret that no longer exists and sign nothing.
  it('leaves the Azure CLI sign-in as the only kind the cmdlet may use', () => {
    const command = windowsSign.signingCommand('C:\\out\\app.exe', ENVIRONMENT);
    const excluded = [...command.matchAll(/ -Exclude([A-Za-z]+Credential)\b/g)].map((match) => match[1]);
    expect(excluded).toEqual(windowsSign.EXCLUDED_CREDENTIALS);
    expect(excluded).toContain('EnvironmentCredential');
    expect(excluded).toContain('ManagedIdentityCredential');
    expect(excluded).not.toContain('AzureCliCredential');
    // The ten kinds Invoke-TrustedSigning 0.5.8 can exclude, less the one that is used.
    expect(excluded).toHaveLength(9);
  });

  it('keeps a path with a space or a quote one argument', () => {
    const command = windowsSign.signingCommand("C:\\Program Files\\it's here\\app.exe", ENVIRONMENT);
    expect(command).toContain("-Files 'C:\\Program Files\\it''s here\\app.exe'");
  });

  // PowerShell ends a single-quoted string at U+2018, U+2019, U+201A and U+201B as well as the
  // plain quote, so a path or a secret holding one would close the string early and the rest
  // would run as PowerShell.
  it('doubles each typographic single quote, in the file path and in an environment value', () => {
    const quotes = ['\u2018', '\u2019', '\u201A', '\u201B'];
    const filePath = `C:\\out\\a${quotes.join('b')}c.exe`;
    const doubledPath = `C:\\out\\a${quotes.map((quote) => quote + quote).join('b')}c.exe`;
    const command = windowsSign.signingCommand(filePath, { ...ENVIRONMENT, AZURE_SIGNING_ACCOUNT: 'acct\u2019s' });
    expect(command).toContain(`-Files '${doubledPath}'`);
    expect(command).toContain("-CodeSigningAccountName 'acct\u2019\u2019s'");
  });
});

describe('the signing hook\'s skip guard', () => {
  const ENVIRONMENT_NAMES = ['AZURE_SIGNING_ACCOUNT', 'AZURE_SIGNING_ENDPOINT', 'AZURE_CERT_PROFILE', 'AZURE_TENANT_ID'];
  const MODULE_PATH = require.resolve('../../build/windowsSign.js');
  const childProcess = require('child_process') as { execFileSync: (...args: unknown[]) => unknown };
  const savedEnvironment: Record<string, string | undefined> = {};
  let spy: MockInstance;

  /** A fresh copy of the hook, so its install and logged-once flags start clean, loaded after the spy. */
  function freshHook(): { default: (configuration: { path: string }) => Promise<void> } {
    delete require.cache[MODULE_PATH];
    return require('../../build/windowsSign.js');
  }

  beforeEach(() => {
    for (const name of ENVIRONMENT_NAMES) {
      savedEnvironment[name] = process.env[name];
      delete process.env[name];
    }
    spy = vi.spyOn(childProcess, 'execFileSync').mockImplementation(() => Buffer.from(''));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete require.cache[MODULE_PATH];
    for (const name of ENVIRONMENT_NAMES) {
      if (savedEnvironment[name] === undefined) delete process.env[name];
      else process.env[name] = savedEnvironment[name];
    }
  });

  it('leaves a file unsigned, and starts nothing, when no signing account is set', async () => {
    process.env.AZURE_TENANT_ID = 'example-tenant';
    await expect(freshHook().default({ path: 'C:\\out\\app.exe' })).resolves.toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });

  it('signs the file through PowerShell when the signing account is set', async () => {
    Object.assign(process.env, ENVIRONMENT);
    await freshHook().default({ path: 'C:\\out\\app.exe' });
    const lastCall = spy.mock.calls.at(-1) as [string, string[]];
    expect(lastCall[0]).toBe('pwsh.exe');
    const args = lastCall[1];
    expect(args[args.indexOf('-Command') + 1]).toBe(windowsSign.signingCommand('C:\\out\\app.exe', process.env));
  });
});
