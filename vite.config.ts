import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  // GitHub Pages deploy under /vbh-tracker/
  base: '/vbh-tracker/',
  plugins: [react()],
})
