const { execFileSync } = require('child_process');

/**
 * Microsoft's timestamp server for Trusted Signing, and the digest it signs with. The same two
 * values electron-builder's own Azure signer defaults to (app-builder-lib,
 * windowsSignAzureManager.js).
 */
const TIMESTAMP_SERVER = 'http://timestamp.acs.microsoft.com';
const TIMESTAMP_DIGEST = 'SHA256';

/**
 * Every kind of sign-in Invoke-TrustedSigning would try before the Azure CLI's, and after it.
 *
 * The workflow signs in to Azure before it builds (azure/login, through GitHub's OIDC federation:
 * no client secret, so nothing to expire or renew), and the Azure CLI then holds the only sign-in
 * that can work. The cmdlet's default is to try each kind in turn. Excluding the rest means none
 * is tried first, which is what Microsoft's own signing action does for this setup, and it means
 * a runner that happens to carry another kind of sign-in can never sign as someone else.
 */
const EXCLUDED_CREDENTIALS = [
  'EnvironmentCredential',
  'WorkloadIdentityCredential',
  'ManagedIdentityCredential',
  'SharedTokenCacheCredential',
  'VisualStudioCredential',
  'VisualStudioCodeCredential',
  'AzurePowerShellCredential',
  'AzureDeveloperCliCredential',
  'InteractiveBrowserCredential',
];

let moduleInstalled = false;

function ensureTrustedSigningModule() {
  if (moduleInstalled) return;
  execFileSync('pwsh.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    'Install-Module -Name TrustedSigning -Force -Scope CurrentUser -ErrorAction SilentlyContinue',
  ], { stdio: 'inherit', timeout: 120000 });
  moduleInstalled = true;
}

/** A PowerShell single-quoted string. A quote inside one is written twice. */
function quote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * The Invoke-TrustedSigning command for one file.
 *
 * The timestamp is what keeps a signature good. A Trusted Signing certificate lasts about three
 * days, and Windows judges a signature with no timestamp against today's date, so it stops
 * verifying the day its certificate ends. Invoke-TrustedSigning adds a timestamp only when it is
 * given a server. Every installer through 0.59.0 was signed without one: the 0.56.0 installer's
 * certificate ran from 2026-11-07 to 2026-11-10, and by 2026-11-17 Windows reported that
 * signature as outside its validity period. .github/workflows/signing-credentials.yml signs a
 * file through this hook every night and fails when the signature carries no timestamp.
 *
 * @param {string} filePath
 * @param {Record<string, string | undefined>} env
 * @returns {string}
 */
function signingCommand(filePath, env) {
  return [
    'Invoke-TrustedSigning',
    '-FileDigest', 'SHA256',
    '-TimestampRfc3161', quote(TIMESTAMP_SERVER),
    '-TimestampDigest', TIMESTAMP_DIGEST,
    '-Endpoint', quote(env.AZURE_SIGNING_ENDPOINT),
    '-CertificateProfileName', quote(env.AZURE_CERT_PROFILE),
    '-CodeSigningAccountName', quote(env.AZURE_SIGNING_ACCOUNT),
    ...EXCLUDED_CREDENTIALS.map((kind) => `-Exclude${kind}`),
    '-Files', quote(filePath),
  ].join(' ');
}

let skipLogged = false;

exports.default = async function sign(configuration) {
  if (!process.env.AZURE_SIGNING_ACCOUNT) {
    // electron-builder calls this once per file. Say it once: a release cannot
    // reach here unsigned, because release.yml names the account on its build
    // step and its preflight-signing job fails first when an Azure secret the
    // sign-in needs is missing.
    if (!skipLogged) {
      console.log('[windowsSign] Skipping signing: AZURE_SIGNING_ACCOUNT is not set (dev build).');
      skipLogged = true;
    }
    return;
  }

  ensureTrustedSigningModule();

  // Use Invoke-TrustedSigning PowerShell module directly.
  // This avoids the signtool/dlib dependency and properly handles
  // file paths with spaces (which azureSignOptions does not).
  execFileSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', signingCommand(configuration.path, process.env)], {
    stdio: 'inherit',
    timeout: 120000,
  });
};

exports.signingCommand = signingCommand;
exports.TIMESTAMP_SERVER = TIMESTAMP_SERVER;
exports.EXCLUDED_CREDENTIALS = EXCLUDED_CREDENTIALS;
