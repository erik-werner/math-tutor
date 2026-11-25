import { defineConfig } from 'vite';

// Relative base so the build works at any path (e.g. https://<user>.github.io/<repo>/).
export default defineConfig({
  base: './',
  build: { target: 'safari16', chunkSizeWarningLimit: 2000 },
});
