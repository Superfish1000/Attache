import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: true, // listen on all interfaces — the GUI is typically reached from other machines
    port: 7700,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:7701' },
  },
})
