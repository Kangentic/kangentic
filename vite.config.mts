import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import rendererOptimizeDeps from './scripts/renderer-optimize-deps.json';

export default defineConfig({
  plugins: [tailwindcss(), react()],
  resolve: {
    alias: {
      '@shared': '/src/shared',
    },
  },
  server: {
    watch: {
      // Ignore .kangentic/ (worktrees, sessions, etc.) created inside the project.
      // Without this, Vite detects tsconfig.json in worktrees and triggers a
      // full page reload, which loses all React state.
      ignored: ['**/.kangentic/**'],
    },
  },
  optimizeDeps: {
    include: rendererOptimizeDeps,
  },
  build: {
    // Electron loads from disk, so large chunks are not a performance concern.
    // Split xterm into its own chunk to keep the main bundle smaller.
    rollupOptions: {
      output: {
        manualChunks: {
          xterm: ['@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-webgl'],
        },
      },
    },
    chunkSizeWarningLimit: 600,
  },
});
