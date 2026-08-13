import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Relative assets keep the pre-built Observatory deployable both at the
// Router root and behind HERMES_HUB_ROUTER_URL's optional pathname prefix.
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: resolve(import.meta.dirname, '../observatory'),
    emptyOutDir: true,
  },
});
