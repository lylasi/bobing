import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 开发时前端 5173，后端 3001；/api 与 /socket.io 由 Vite 代理到后端，保持同源语义。
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:3001', changeOrigin: false },
      '/socket.io': { target: 'http://127.0.0.1:3001', ws: true, changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
