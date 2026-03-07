import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { PublisherGithub } from '@electron-forge/publisher-github';
import { windowsSign } from './windowsSign';

const config: ForgeConfig = {
  packagerConfig: {
    asar: {
      unpack: '**/node-pty/prebuilds/**',
    },
    name: 'Kangentic',
    executableName: 'kangentic',
    icon: './resources/icon',
    extraResource: ['./resources/icon.png', './resources/icon.ico'],
    ignore: (file: string) => {
      if (!file) return false;

      // Allow Vite build output and package.json
      if (file.startsWith('/.vite') || file.startsWith('/package.json')) return false;

      // Whitelist only native modules that can't be bundled by Vite
      if (file.startsWith('/node_modules')) {
        const allowedModules = ['better-sqlite3', 'bindings', 'file-uri-to-path', 'node-pty'];
        const segments = file.split('/');
        // segments: ['', 'node_modules', '<module>', ...]
        const moduleName = segments[2];
        if (!moduleName) return false; // bare /node_modules dir
        if (!allowedModules.includes(moduleName)) return true; // block unlisted modules

        // Strip C++ source, build scripts, and cross-platform prebuilds from allowed modules
        const subPath = segments.slice(3).join('/');
        if (moduleName === 'node-pty') {
          if (/^(src|scripts|deps|third_party)(\/|$)/.test(subPath)) return true;
          const currentPlatformArch = `${process.platform}-${process.arch}`;
          const prebuildMatch = subPath.match(/^prebuilds\/([^/]+)/);
          if (prebuildMatch && prebuildMatch[1] !== currentPlatformArch) return true;
        }
        if (moduleName === 'better-sqlite3') {
          if (/^(src|deps)(\/|$)/.test(subPath)) return true;
          if (subPath === 'binding.gyp') return true;
        }

        return false;
      }

      // Block everything else (src, tests, configs, etc.)
      return true;
    },
    ...(process.env.AZURE_CODE_SIGNING_DLIB ? { windowsSign } : {}),
    ...(process.env.APPLE_IDENTITY ? {
      osxSign: {},
      osxNotarize: {
        tool: 'notarytool',
        appleId: process.env.APPLE_ID!,
        appleIdPassword: process.env.APPLE_PASSWORD!,
        teamId: process.env.APPLE_TEAM_ID!,
      },
    } : {}),
  },
  rebuildConfig: {
    // node-pty ships NAPI prebuilt binaries that work across Node/Electron
    // without recompilation. Rebuilding it from source breaks on Windows
    // due to winpty's GetCommitHash.bat path issues.
    onlyModules: ['better-sqlite3'],
  },
  makers: [
    new MakerSquirrel({
      name: 'Kangentic',
      setupIcon: './resources/icon.ico',
      setupAppId: 'com.kangentic.app',
      // @ts-expect-error - incorrect types exported by MakerSquirrel
      ...(process.env.AZURE_CODE_SIGNING_DLIB ? { windowsSign } : {}),
    }),
    new MakerDMG({
      name: 'Kangentic',
      icon: './resources/icon.icns',
    }),
    new MakerZIP({}, ['darwin']),
    new MakerDeb({
      options: {
        name: 'kangentic',
        productName: 'Kangentic',
        icon: './resources/icon.png',
      },
    }),
    new MakerRpm({
      options: {
        name: 'kangentic',
        productName: 'Kangentic',
        icon: './resources/icon.png',
      },
    }),
  ],
  publishers: [
    new PublisherGithub({
      repository: {
        owner: 'Kangentic',
        name: 'kangentic',
      },
      prerelease: false,
      draft: true,
    }),
  ],
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      build: [
        {
          entry: 'src/main/index.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/preload/preload.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.mts',
        },
      ],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
