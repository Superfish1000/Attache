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

## Agent runtime: Hermes

Default agent image is [Hermes Agent](https://hermes-agent.nousresearch.com) (`nousresearch/hermes-agent:latest`, command `gateway run`). Attache mounts each agent's data dir at `/opt/data` — Hermes keeps `SOUL.md`, `.env`, `config.yaml`, `sessions/`, `memories/`, `skills/` there, so the soul you edit in the GUI is the one Hermes loads.

Container setups live under **Containers** as reusable definitions: image/command/mount/ports/limits/env plus the behavior-file list (with creation templates). Ports declared on a definition auto-map to free host ports (default range 18000+) at every deploy — no manual port bookkeeping. Env layers: Settings default env → definition env → per-agent env.

Put shared model credentials (`ANTHROPIC_API_KEY` or `OPENAI_API_KEY`) in **Settings → Docker → Default env**, then press **Regenerate** on each agent (recreates the container so env/port/definition changes apply; behavior files are untouched unless you tick *reset files from templates*). The ⓘ next to every env editor documents the variables.

The **Chat** tab talks to any agent you own through its OpenAI-compatible gateway (Attache proxies with the per-agent `API_SERVER_KEY`; streaming, history kept per agent in your browser).

## Notes

- Docker daemon optional — container features report unavailable instead of failing.
- Per-agent image/command/env/mount/ports/limits overridable in the GUI (Agent detail page).
- O365 sync needs an Entra app registration (client-credentials) — tenant ID, client ID, secret, group ID entered on the Integrations page. Requires `GroupMember.Read.All` + `User.Read.All` application permissions.
- MCP tool library is a stub (`/api/mcp/status`).
