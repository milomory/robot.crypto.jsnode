import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'ui',
  base: process.env.VITE_BASE_PATH ?? '/',
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:3000',
      '/health': 'http://127.0.0.1:3000'
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true
  }
});
