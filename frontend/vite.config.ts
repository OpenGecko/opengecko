import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

const backend = process.env.OPENGECKO_API_BASE_URL ?? 'http://127.0.0.1:3000';
const rawApiBase =
  process.env.PUBLIC_OPENGECKO_RAW_API_BASE_URL
  ?? process.env.PUBLIC_OPENGECKO_API_BASE_URL
  ?? process.env.OPENGECKO_API_BASE_URL
  ?? '';

export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
  define: {
    'import.meta.env.PUBLIC_OPENGECKO_RAW_API_BASE_URL': JSON.stringify(rawApiBase)
  },
  server: {
    port: 5173,
    proxy: {
      '/__opengecko_api': {
        target: backend,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/__opengecko_api/, '')
      },
      '/asset_platforms': backend,
      '/coins': backend,
      '/diagnostics': backend,
      '/exchange_rates': backend,
      '/exchanges': backend,
      '/global': backend,
      '/ping': backend,
      '/search': backend,
      '/simple': backend
    }
  }
});
