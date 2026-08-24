import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev mode: `npm run dev -w @luckagent/admin-ui` serves on :5173 and proxies
// API calls to a locally running bridge. Override the target with
// ADMIN_DEV_PROXY (e.g. http://127.0.0.1:9110 for a sandbox bridge).
const proxyTarget = process.env.ADMIN_DEV_PROXY || 'http://127.0.0.1:9100';

export default defineConfig({
  base: '/admin/',
  plugins: [react()],
  server: {
    proxy: {
      '/api': { target: proxyTarget, changeOrigin: true },
      '/admin/api': { target: proxyTarget, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
