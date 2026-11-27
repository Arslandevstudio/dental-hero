import { defineConfig } from 'vite';

export default defineConfig({
  // relative base: works at a domain root and under a sub-path such as GitHub Pages /dental-hero/
  base: './',
  build: { chunkSizeWarningLimit: 700 }, // three.js alone is ~580 kB
});
