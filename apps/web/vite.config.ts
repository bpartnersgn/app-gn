import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// En développement, /v1 est relayé vers l'API locale si VITE_API_URL=/ ; sans elle, l'application
// embarque le noyau (@app-gn/core) et tourne seule sur données fictives (mode démo).
export default defineConfig({
  base: './',
  plugins: [react()],
  server: { proxy: { '/v1': 'http://127.0.0.1:3100' } },
});
