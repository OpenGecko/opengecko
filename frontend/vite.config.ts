import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

const backend = process.env.OPENGECKO_API_BASE_URL ?? 'http://127.0.0.1:3000';

export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
  server: {
    port: 5173,
    proxy: {
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
