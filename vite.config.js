import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: true,
    port: 5273,
    strictPort: true,
    proxy: { '/ws': { target: 'ws://localhost:8787', ws: true } },
  },
});
