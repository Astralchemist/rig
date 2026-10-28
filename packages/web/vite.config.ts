// SPDX-License-Identifier: Apache-2.0
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// The map server only answers to its own Host and Origin (DNS-rebinding and
// CSRF defense), so the dev proxy presents itself as the server: changeOrigin
// rewrites Host, and Origin is pinned to the server's own.
const API = 'http://127.0.0.1:7474';
const toApi = { target: API, changeOrigin: true, headers: { origin: API } };

export default defineConfig({
  root: __dirname,
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': toApi,
      '/auth': toApi, // token login: sets the session cookie for the dev origin
      '/ws': { ...toApi, target: 'ws://127.0.0.1:7474', ws: true },
    },
  },
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
  },
});
