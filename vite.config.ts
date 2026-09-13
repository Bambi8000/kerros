import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Pages serves this repository below /kerros/. Local and native builds keep
  // their root URL; the release workflow explicitly selects the Pages base.
  base: process.env.GITHUB_PAGES === 'true' ? '/kerros/' : '/',
  // Vite wipes the terminal on start, scrollback included, which loses the
  // output of whatever was run before it — a validator run, most of the time.
  clearScreen: false,
  server: {
    // Kerros owns 5180 so it never collides with another local dev server.
    port: 5180,
    strictPort: true,
  },
})
