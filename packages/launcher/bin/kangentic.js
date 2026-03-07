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
    return path.join(localAppData, 'Kangentic', 'Kangentic.exe');
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

  // On Windows, check the Squirrel version directory matches
  if (platformInfo.platform === 'win32') {
    const squirrelDir = path.dirname(installPath);
    const versionDir = path.join(squirrelDir, `app-${VERSION}`);
    return fs.existsSync(versionDir);
  }

  // On macOS, check the app bundle's version in Info.plist
  if (platformInfo.platform === 'darwin') {
    try {
      const plistPath = path.join(installPath, 'Contents', 'Info.plist');
      const plistContent = fs.readFileSync(plistPath, 'utf-8');
      const versionMatch = plistContent.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/);
      if (versionMatch && versionMatch[1] !== VERSION) return false;
    } catch {
      // Can't read plist, treat as not installed
      return false;
    }
  }

  // On Linux, check `kangentic --version` output
  if (platformInfo.platform === 'linux') {
    try {
      const output = execFileSync(installPath, ['--version'], { encoding: 'utf-8', timeout: 5000 }).trim();
      if (!output.includes(VERSION)) return false;
    } catch {
      // Can't check version, treat as installed (binary exists)
    }
  }

  return true;
}

// --- Download URL construction ---

function getArtifactFilename(platformInfo) {
  const version = VERSION;

  if (platformInfo.platform === 'win32') {
    // Squirrel produces "Kangentic-X.Y.Z Setup.exe"
    return `Kangentic-${version}%20Setup.exe`;
  }
  if (platformInfo.platform === 'darwin') {
    return `Kangentic-darwin-${platformInfo.arch}-${version}.zip`;
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
  console.log('Installing Kangentic (Squirrel installer)...');
  execFileSync(artifactPath, ['--silent'], { stdio: 'ignore' });
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

function launch(platformInfo, targetDir) {
  const installPath = getInstallPath(platformInfo);

  if (!fs.existsSync(installPath)) {
    console.error('Error: Kangentic installation not found after install.');
    console.error(`Expected at: ${installPath}`);
    process.exit(1);
  }

  console.log('Launching Kangentic...');

  if (platformInfo.platform === 'win32') {
    const child = spawn(installPath, [`--cwd=${targetDir}`], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } else if (platformInfo.platform === 'darwin') {
    execFileSync('open', ['-a', installPath, '--args', `--cwd=${targetDir}`]);
  } else if (platformInfo.platform === 'linux') {
    const child = spawn(installPath, [`--cwd=${targetDir}`], {
      detached: true,
      stdio: 'ignore',
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

// --- Main ---

async function main() {
  const arguments_ = process.argv.slice(2);

  // Determine target directory
  let targetDir = process.cwd();
  if (arguments_.length > 0 && !arguments_[0].startsWith('-')) {
    targetDir = path.resolve(arguments_[0]);
  }

  // Detect platform
  const platformInfo = getPlatformInfo();
  if (!platformInfo) {
    console.error(`Unsupported platform: ${process.platform} ${process.arch}`);
    console.error(`Download manually from: https://github.com/${REPO_OWNER}/${REPO_NAME}/releases`);
    process.exit(1);
  }

  // Check if already installed
  if (isInstalled(platformInfo)) {
    console.log(`Kangentic v${VERSION} is already installed.`);
    launch(platformInfo, targetDir);
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
  launch(platformInfo, targetDir);
}

main().catch((error) => {
  console.error(`Unexpected error: ${error.message}`);
  process.exit(1);
});
