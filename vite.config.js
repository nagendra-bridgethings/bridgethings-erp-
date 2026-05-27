import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
// `base` matches the GitHub Pages subpath:
//   https://nagendra-bridgethings.github.io/bridgethings-erp-/
// Trailing slash is required.
export default defineConfig({
  base: '/bridgethings-erp-/',
  plugins: [react()],
})
