import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Same env overrides the README documents for the API — Windows excluded-port
// ranges move between reboots, so the defaults can't be relied on everywhere.
const webPort = Number(process.env.ATTACHE_WEB_PORT ?? 7700)
const api = `http://127.0.0.1:${process.env.ATTACHE_API_PORT ?? 7701}`

export default defineConfig({
  plugins: [react()],
  server: {
    host: true, // listen on all interfaces — the GUI is typically reached from other machines
    port: webPort,
    strictPort: true,
    proxy: {
      '/api': api,
      // MCP management server + OAuth endpoints — root-level (not under /api) so
      // they're the correct shape for external MCP/OAuth clients in production,
      // where one Fastify process serves both the API and the built GUI. In dev
      // they're a separate origin from Vite, so proxy them too.
      // Exact-path regexes, not plain prefixes: a plain '/mcp' key also matches
      // the GUI's /mcp-tools page, sending its refresh/deep-link to Fastify —
      // which answers with the stale built bundle (or a 404) instead of Vite's
      // HTML, leaving a blank page.
      '^/mcp(?=$|[/?#])': api,
      '^/authorize(?=$|[/?#])': api,
      '^/token(?=$|[/?#])': api,
      '^/register(?=$|[/?#])': api,
      '^/revoke(?=$|[/?#])': api,
      '/.well-known': api,
    },
  },
})
