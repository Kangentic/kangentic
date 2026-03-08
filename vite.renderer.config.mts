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
  optimizeDeps: {
    include: rendererOptimizeDeps,
  },
  server: {
    watch: {
      ignored: ['**/.kangentic/**'],
    },
  },
});
