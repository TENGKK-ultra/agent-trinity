/// <reference types="vitest/config" />
import { readFileSync } from 'node:fs'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The dev server proxy is what lets a real browser preview talk to a chosen
// Core without adding CORS to it. The packaged desktop does not use this: it
// calls the configured absolute URL through the Tauri HTTP plugin.
const devCoreTarget = process.env.VITE_TRINITY_CORE_URL?.trim() || 'http://127.0.0.1:3210'

// The status bar must show the version that was actually built, not a literal
// that drifts the next time package.json changes.
const { version } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { version: string }

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {
    __TRINITY_DEV_CORE_TARGET__: JSON.stringify(devCoreTarget),
    __APP_VERSION__: JSON.stringify(version),
  },
  server: {
    proxy: {
      '/api': {
        target: devCoreTarget,
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
