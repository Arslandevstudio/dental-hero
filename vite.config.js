import { defineConfig } from 'vite';

export default defineConfig({
  build: { chunkSizeWarningLimit: 700 }, // three.js alone is ~580 kB
});
