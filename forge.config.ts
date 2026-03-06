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

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    name: 'Kangentic',
    executableName: 'kangentic',
    icon: './resources/icon',
    extraResource: ['./resources/icon.png'],
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
