import { defineConfig } from 'vite';

// Kennung dieses Builds (Datum + Uhrzeit). Sie steht im Code (__BUILD__) und in dist/version.json;
// die App vergleicht beides und weist auf eine neuere Version hin.
const build = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');

export default defineConfig({
  define: { __BUILD__: JSON.stringify(build) },
  plugins: [
    {
      name: 'version-json',
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ build }) });
      },
    },
  ],
  server: {
    host: true,
    port: 5273,
    strictPort: true,
    proxy: { '/ws': { target: 'ws://localhost:8787', ws: true } },
  },
});
