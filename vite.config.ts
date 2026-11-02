import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { cspPlugin } from './scripts/security-csp.ts';

/* The page's Content-Security-Policy is defined in scripts/security-csp.ts (img-src 'self' data: blob:, connect-src 'self':
   never loosen them). The plugin stamps it on every html page of the build; scripts/check-build.mjs verifies dist/. */

const page = (name: string) => fileURLToPath(new URL(name, import.meta.url));

// Same setup as AIROOM: Vite's built-in TSX transform, relative base so dist/ opens from any folder.
// 三个页面：主应用（index.html）、桌宠窗口（pet.html）、隐藏的画面采集页（capture.html，docs/PET-PLAN.md）。
export default defineConfig({
  base: './',
  plugins: [cspPlugin()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2023',
    rolldownOptions: {
      input: { main: page('index.html'), pet: page('pet.html'), capture: page('capture.html') },
    },
  },
});
