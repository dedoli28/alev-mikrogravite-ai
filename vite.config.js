import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// `npm run build:single` tek dosyalık, çevrimdışı açılabilen bir HTML üretir.
export default defineConfig(({ mode }) => ({
  server: { host: '0.0.0.0', port: 47321, strictPort: true },
  preview: { host: '0.0.0.0', port: 47322, strictPort: true },
  plugins: mode === 'single' ? [viteSingleFile()] : [],
  build: {
    target: 'es2020',
    outDir: mode === 'single' ? 'dist-single' : 'dist',
    assetsInlineLimit: mode === 'single' ? 100000000 : 4096,
  },
}));
