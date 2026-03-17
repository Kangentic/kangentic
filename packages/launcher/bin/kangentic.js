#!/usr/bin/env node

// Kangentic npx launcher
// Downloads, installs, and launches Kangentic from GitHub Releases.
// Zero dependencies -- pure Node.js built-ins only.

'use strict';

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, spawn } = require('child_process');

const VERSION = require('../package.json').version;
const REPO_OWNER = 'Kangentic';
const REPO_NAME = 'kangentic';
const MAX_REDIRECTS = 5;

// --- Platform detection ---

function getPlatformInfo() {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === 'win32') {
    return { platform: 'win32', arch: 'x64', extension: 'exe' };
  }
  if (platform === 'darwin') {
    return { platform: 'darwin', arch, extension: 'zip' };
  }
  if (platform === 'linux') {
    return { platform: 'linux', arch: 'x64', extension: 'deb' };
  }

  return null;
}

// --- Install path detection ---

function getInstallPath(platformInfo) {
  if (platformInfo.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'Programs', 'Kangentic', 'Kangentic.exe');
  }
  if (platformInfo.platform === 'darwin') {
    const userApps = path.join(os.homedir(), 'Applications', 'Kangentic.app');
    const systemApps = '/Applications/Kangentic.app';
    if (fs.existsSync(userApps)) return userApps;
    if (fs.existsSync(systemApps)) return systemApps;
    return userApps; // default install target
  }
  if (platformInfo.platform === 'linux') {
    return '/usr/bin/kangentic';
  }
  return null;
}

function isInstalled(platformInfo) {
  const installPath = getInstallPath(platformInfo);
  if (!fs.existsSync(installPath)) return false;

  try {
    const installedVersion = fs.readFileSync(getVersionMarkerPath(), 'utf-8').trim();
    return installedVersion === VERSION;
  } catch {
    // Marker missing or unreadable. Force reinstall (idempotent).
    return false;
  }
}

// --- Download URL construction ---

function getArtifactFilename(platformInfo) {
  const version = VERSION;

  if (platformInfo.platform === 'win32') {
    // NSIS produces "Kangentic-Setup-X.Y.Z.exe"
    return `Kangentic-Setup-${version}.exe`;
  }
  if (platformInfo.platform === 'darwin') {
    return `Kangentic-${version}-${platformInfo.arch}-mac.zip`;
  }
  if (platformInfo.platform === 'linux') {
    // Check if rpm-based system
    try {
      execFileSync('which', ['rpm'], { stdio: 'ignore' });
      const hasApt = (() => {
        try {
          execFileSync('which', ['apt'], { stdio: 'ignore' });
          return true;
        } catch {
          return false;
        }
      })();
      if (!hasApt) {
        return `kangentic-${version}-1.x86_64.rpm`;
      }
    } catch {
      // not rpm-based, use deb
    }
    return `kangentic_${version}_amd64.deb`;
  }
  return null;
}

function getDownloadUrl(platformInfo) {
  const filename = getArtifactFilename(platformInfo);
  if (!filename) return null;
  return `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download/v${VERSION}/${filename}`;
}

// --- HTTP download with redirect following ---

function download(url, destinationPath, redirectCount) {
  if (redirectCount === undefined) redirectCount = 0;

  return new Promise((resolve, reject) => {
    if (redirectCount > MAX_REDIRECTS) {
      reject(new Error('Too many redirects'));
      return;
    }

    const protocol = url.startsWith('https') ? https : http;
    const request = protocol.get(url, (response) => {
      // Follow redirects (GitHub -> S3)
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        download(response.headers.location, destinationPath, redirectCount + 1)
          .then(resolve)
          .catch(reject);
        return;
      }

      if (response.statusCode !== 200) {
        reject(new Error(`Download failed: HTTP ${response.statusCode}`));
        return;
      }

      const totalBytes = parseInt(response.headers['content-length'] || '0', 10);
      let downloadedBytes = 0;

      const fileStream = fs.createWriteStream(destinationPath);
      response.on('data', (chunk) => {
        downloadedBytes += chunk.length;
        if (totalBytes > 0) {
          const megabytesDownloaded = (downloadedBytes / 1024 / 1024).toFixed(1);
          const megabytesTotal = (totalBytes / 1024 / 1024).toFixed(1);
          const percent = Math.round((downloadedBytes / totalBytes) * 100);
          process.stdout.write(`\rDownloading... ${megabytesDownloaded}/${megabytesTotal} MB (${percent}%)`);
        } else {
          const megabytesDownloaded = (downloadedBytes / 1024 / 1024).toFixed(1);
          process.stdout.write(`\rDownloading... ${megabytesDownloaded} MB`);
        }
      });

      response.pipe(fileStream);

      fileStream.on('finish', () => {
        process.stdout.write('\n');
        fileStream.close();
        resolve();
      });

      fileStream.on('error', reject);
    });

    request.on('error', reject);
  });
}

// --- Platform-specific install ---

function installWindows(artifactPath) {
  console.log('Installing Kangentic (NSIS installer)...');
  execFileSync(artifactPath, ['/S'], { stdio: 'ignore' });
  console.log('Installation complete.');
}

function installMacOS(artifactPath) {
  const tempDir = path.dirname(artifactPath);
  const extractDir = path.join(tempDir, 'kangentic-extract');

  console.log('Extracting Kangentic.app...');
  fs.mkdirSync(extractDir, { recursive: true });
  execFileSync('unzip', ['-o', '-q', artifactPath, '-d', extractDir]);

  const appSource = path.join(extractDir, 'Kangentic.app');
  const appTarget = path.join(os.homedir(), 'Applications', 'Kangentic.app');

  // Ensure ~/Applications exists
  const userAppsDir = path.join(os.homedir(), 'Applications');
  fs.mkdirSync(userAppsDir, { recursive: true });

  // Remove old install if present
  if (fs.existsSync(appTarget)) {
    fs.rmSync(appTarget, { recursive: true, force: true });
  }

  console.log(`Installing to ${appTarget}...`);
  fs.renameSync(appSource, appTarget);

  // Clean up extract dir
  fs.rmSync(extractDir, { recursive: true, force: true });

  console.log('Installation complete.');
}

function installLinux(artifactPath) {
  console.log('Installing Kangentic...');
  if (artifactPath.endsWith('.deb')) {
    console.log('Running: sudo dpkg -i (you may be prompted for your password)');
    execFileSync('sudo', ['dpkg', '-i', artifactPath], { stdio: 'inherit' });
  } else if (artifactPath.endsWith('.rpm')) {
    console.log('Running: sudo rpm -i (you may be prompted for your password)');
    execFileSync('sudo', ['rpm', '-i', artifactPath], { stdio: 'inherit' });
  }
  console.log('Installation complete.');
}

function install(platformInfo, artifactPath) {
  if (platformInfo.platform === 'win32') {
    installWindows(artifactPath);
  } else if (platformInfo.platform === 'darwin') {
    installMacOS(artifactPath);
  } else if (platformInfo.platform === 'linux') {
    installLinux(artifactPath);
  }
}

// --- Launch ---

function launch(platformInfo, targetDir, dataDir, extraArgs) {
  const installPath = getInstallPath(platformInfo);

  if (!fs.existsSync(installPath)) {
    console.error('Error: Kangentic installation not found after install.');
    console.error(`Expected at: ${installPath}`);
    process.exit(1);
  }

  console.log('Launching Kangentic...');

  const childEnv = { ...process.env };
  if (dataDir) {
    childEnv.KANGENTIC_DATA_DIR = dataDir;
  }

  const launchArgs = targetDir ? [`--cwd=${targetDir}`] : [];
  if (extraArgs) {
    launchArgs.push(...extraArgs);
  }

  if (platformInfo.platform === 'win32') {
    const child = spawn(installPath, launchArgs, {
      detached: true,
      stdio: 'ignore',
      env: childEnv,
    });
    child.unref();
  } else if (platformInfo.platform === 'darwin') {
    const openArgs = ['-a', installPath];
    const appArgs = [...launchArgs];
    if (dataDir) {
      appArgs.push(`--data-dir=${dataDir}`);
    }
    if (appArgs.length > 0) {
      openArgs.push('--args', ...appArgs);
    }
    execFileSync('open', openArgs);
  } else if (platformInfo.platform === 'linux') {
    const child = spawn(installPath, launchArgs, {
      detached: true,
      stdio: 'ignore',
      env: childEnv,
    });
    child.unref();
  }
}

// --- Config directory for temp downloads ---

function getTempDir() {
  const platform = process.platform;
  let base;
  if (platform === 'win32') {
    base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  } else if (platform === 'darwin') {
    base = path.join(os.homedir(), 'Library', 'Application Support');
  } else {
    base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  }
  const tempDir = path.join(base, 'kangentic', 'launcher');
  fs.mkdirSync(tempDir, { recursive: true });
  return tempDir;
}

// --- Version marker ---

function getVersionMarkerPath() {
  return path.join(getTempDir(), 'installed-version');
}

function writeVersionMarker() {
  try {
    fs.writeFileSync(getVersionMarkerPath(), VERSION + '\n', 'utf-8');
  } catch {
    console.warn('Warning: Could not write version marker file.');
  }
}

// --- Main ---

function parseDataDir(arguments_) {
  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index];
    if (argument.startsWith('--data-dir=')) {
      return argument.slice('--data-dir='.length);
    }
    if (argument === '--data-dir' && index + 1 < arguments_.length) {
      const nextArgument = arguments_[index + 1];
      if (!nextArgument.startsWith('-')) {
        return nextArgument;
      }
    }
  }
  return null;
}

function findTargetDir(arguments_) {
  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index];
    if (argument.startsWith('-')) {
      // Skip --data-dir's value argument
      if (argument === '--data-dir' && index + 1 < arguments_.length) {
        index++;
      }
      continue;
    }
    return path.resolve(argument);
  }
  return null;
}

async function main() {
  const arguments_ = process.argv.slice(2);

  // Determine target directory (first positional argument, skipping flags and their values)
  const targetDir = findTargetDir(arguments_);

  // Check for --demo and --force flags
  const isDemo = arguments_.includes('--demo');
  const forceInstall = arguments_.includes('--force');

  // Resolve data directory: env var takes priority, then --data-dir flag
  const dataDirFlag = parseDataDir(arguments_);
  let dataDir = process.env.KANGENTIC_DATA_DIR || dataDirFlag;

  // Demo mode: use an ephemeral temp data directory
  if (isDemo && !dataDir) {
    dataDir = path.join(os.tmpdir(), `kangentic-demo-${Date.now()}`);
    fs.mkdirSync(dataDir, { recursive: true });
    console.log('Demo mode: using temporary data directory');
    console.log(`  ${dataDir}`);
  }

  // Extra args to pass to the launched app
  const extraArgs = [];
  if (isDemo) {
    extraArgs.push('--ephemeral');
  }

  // Detect platform
  const platformInfo = getPlatformInfo();
  if (!platformInfo) {
    console.error(`Unsupported platform: ${process.platform} ${process.arch}`);
    console.error(`Download manually from: https://github.com/${REPO_OWNER}/${REPO_NAME}/releases`);
    process.exit(1);
  }

  // Check if already installed
  if (!forceInstall && isInstalled(platformInfo)) {
    console.log(`Kangentic v${VERSION} is already installed.`);
    launch(platformInfo, targetDir, dataDir, extraArgs);
    return;
  }

  // Download
  const downloadUrl = getDownloadUrl(platformInfo);
  const artifactFilename = getArtifactFilename(platformInfo).replace(/%20/g, ' ');
  const tempDir = getTempDir();
  const artifactPath = path.join(tempDir, artifactFilename);

  console.log(`Kangentic v${VERSION} is not installed. Downloading...`);
  console.log(`URL: ${downloadUrl.replace(/%20/g, ' ')}`);

  try {
    await download(downloadUrl, artifactPath);
  } catch (error) {
    console.error(`\nDownload failed: ${error.message}`);
    console.error(`\nDownload manually from: https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/tag/v${VERSION}`);
    process.exit(1);
  }

  // Install
  try {
    install(platformInfo, artifactPath);
    writeVersionMarker();
  } catch (error) {
    console.error(`\nInstallation failed: ${error.message}`);
    console.error(`\nTry installing manually. The downloaded file is at: ${artifactPath}`);
    process.exit(1);
  }

  // Clean up downloaded artifact
  try {
    fs.unlinkSync(artifactPath);
  } catch {
    // ignore cleanup errors
  }

  // Launch
  launch(platformInfo, targetDir, dataDir, extraArgs);
}

// Only auto-run when executed directly (not when required for testing)
if (require.main === module) {
  main().catch((error) => {
    console.error(`Unexpected error: ${error.message}`);
    process.exit(1);
  });
}

// Exported for testing
module.exports = { isInstalled, getVersionMarkerPath, writeVersionMarker, getInstallPath, getTempDir };
