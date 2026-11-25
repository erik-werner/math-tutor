import { defineConfig } from 'vite';

const sha = (process.env.GITHUB_SHA ?? 'local').slice(0, 7);
const built = new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

// Relative base so the build works at any path (e.g. https://<user>.github.io/<repo>/).
export default defineConfig({
  base: './',
  define: { __BUILD__: JSON.stringify(`${sha} · ${built}`) },
  build: { target: 'safari16', chunkSizeWarningLimit: 2000 },
});
