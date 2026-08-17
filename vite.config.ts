import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Kerros owns 5180 so it never collides with another local dev server.
    port: 5180,
    strictPort: true,
  },
})
