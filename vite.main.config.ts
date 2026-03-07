import { defineConfig } from 'vite';
import { copyFileSync, existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';

/**
 * Copies plain JS bridge scripts (event-bridge, status-bridge) next to the
 * main bundle so resolveBridgeScript() finds them via __dirname at runtime.
 */
function copyBridgeScripts(): import('vite').Plugin {
  return {
    name: 'copy-bridge-scripts',
    writeBundle(options) {
      const outDir = options.dir || resolve(__dirname, '.vite/build');
      if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
      for (const name of ['event-bridge.js', 'status-bridge.js']) {
        const source = resolve(__dirname, 'src/main/agent', name);
        if (existsSync(source)) {
          copyFileSync(source, resolve(outDir, name));
        }
      }
    },
  };
}

export default defineConfig({
  resolve: {
    alias: {
      '@shared': '/src/shared',
    },
  },
  plugins: [copyBridgeScripts()],
  build: {
    rollupOptions: {
      external: ['better-sqlite3', 'node-pty'],
    },
  },
});
