import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: true, // listen on all interfaces — the GUI is typically reached from other machines
    port: 7700,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:7701',
      // MCP management server + OAuth endpoints — root-level (not under /api) so
      // they're the correct shape for external MCP/OAuth clients in production,
      // where one Fastify process serves both the API and the built GUI. In dev
      // they're a separate origin from Vite, so proxy them too.
      '/mcp': 'http://127.0.0.1:7701',
      '/authorize': 'http://127.0.0.1:7701',
      '/token': 'http://127.0.0.1:7701',
      '/register': 'http://127.0.0.1:7701',
      '/revoke': 'http://127.0.0.1:7701',
      '/.well-known': 'http://127.0.0.1:7701',
    },
  },
})
