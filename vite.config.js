import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
// `base` matches the GitHub Pages subpath only for production builds:
//   https://nagendra-bridgethings.github.io/bridgethings-erp-/
// Trailing slash is required. In dev we serve from root ('/') so
// http://localhost:5173/ works directly — no subpath to remember.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/bridgethings-erp-/' : '/',
  plugins: [react()],
}))
