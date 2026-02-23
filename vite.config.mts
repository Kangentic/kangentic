import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [tailwindcss(), react()],
  resolve: {
    alias: {
      '@shared': '/src/shared',
    },
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
