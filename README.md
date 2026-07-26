# Attache

Web GUI for spinning up containers with AI agents in them. Manage users, their
agents (soul files + config), sync users from an Office 365 group, and — later —
serve a shared tool library over MCP.

## Run

```bash
npm install
npm run dev
```

- GUI: http://localhost:7700
- API: http://localhost:7701 (proxied at `/api` in dev)

(Ports chosen to dodge Windows excluded port ranges — 5173/4517 are blocked on this box.)

Production-ish: `npm run build` then `npm start` — the API server serves the
built GUI from `web/dist`.

## Layout

| Path | What |
|------|------|
| `server/` | Fastify API — users, agents, containers (dockerode), O365 sync, MCP stub |
| `web/` | Vite + React GUI |
| `data/` | Runtime state (gitignored): `db.json` + `agents/{id}/SOUL.md` |
| `docs/superpowers/specs/` | Design docs |

## Notes

- Docker daemon optional — container features report unavailable instead of failing.
- Agent containers are placeholder `alpine` + `sleep infinity` until a real agent image exists; per-agent image/command/env overridable in the GUI.
- O365 sync needs an Entra app registration (client-credentials) — tenant ID, client ID, secret, group ID entered on the Integrations page. Requires `GroupMember.Read.All` + `User.Read.All` application permissions.
- MCP tool library is a stub (`/api/mcp/status`).
