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
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const windowsSign = require('../../build/windowsSign.js') as {
  signingCommand: (filePath: string, env: Record<string, string | undefined>) => string;
  TIMESTAMP_SERVER: string;
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

  it('keeps a path with a space or a quote one argument', () => {
    const command = windowsSign.signingCommand("C:\\Program Files\\it's here\\app.exe", ENVIRONMENT);
    expect(command).toContain("-Files 'C:\\Program Files\\it''s here\\app.exe'");
  });
});
