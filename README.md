# Attaché

A self-hosted web GUI for running **containerized AI agents** — one container per person. Attaché manages the users, the agents' personality files, the Docker lifecycle, and a built-in chat, with [Hermes Agent](https://hermes-agent.nousresearch.com) (Nous Research) as the default runtime. Users can be synced automatically from an Office 365 group, each receiving their own agent.

## Features

- **Users & roles** — admin and standard accounts, scrypt-hashed passwords, cookie sessions. Standard users see only their own agents; admins manage everything.
- **Container definitions** — reusable setups (image, command, mount, ports, env, resource limits) plus a per-definition list of *behavior files* with creation templates. Agents are created from a definition and stay individually tweakable.
- **Agent management** — start/stop/regenerate containers, live logs, editable soul/memory/config files, per-agent cron jobs, auto-assigned host ports.
- **Chat** — streaming chat with any agent you own, proxied through the agent's warm OpenAI-compatible gateway (no cold start per message).
- **Hermes dashboard** — one-click access to each agent's own web dashboard, automatically secured with the owner's Attaché login (hash-only provisioning — no plaintext at rest).
- **Office 365 sync** — pull members of an Entra group; new members get a user + agent automatically.
- **MCP tool library** — stub today; planned shared tool server for all agents.

## Stack

npm-workspaces monorepo: `server/` (Fastify + TypeScript, run by tsx) and `web/` (Vite + React + TypeScript). State lives in a JSON file store (`data/db.json`) plus per-agent data dirs (`data/agents/<id>/`) that are bind-mounted into containers. No database server required.

## Requirements

- **Node.js 20+** (developed on Node 25) and npm
- **Docker** with the daemon running (Docker Desktop on Windows). The GUI works without Docker, but container features report "docker offline" until the daemon is up.
- Windows, macOS, or Linux. Developed on Windows 10; dockerode talks to the daemon via the platform default (named pipe / unix socket), overridable in Settings.

## Setup

```bash
git clone https://github.com/Superfish1000/Attache.git
cd Attache
npm install
npm run dev
```

- GUI: **http://localhost:7700**  ·  API: http://localhost:7701 (proxied at `/api` in dev)
- Production-ish: `npm run build` then `npm start` — the API server serves the built GUI itself.

> Ports 7700/7701 were chosen because Windows excluded-port ranges commonly swallow 5173/4517. Override with `ATTACHE_API_PORT` / `ATTACHE_API_HOST` env vars or Settings → Server (restart required). The data location is overridable with `ATTACHE_DATA_DIR` (default: `./data`, gitignored).

### First run

1. Open the GUI — you'll get a **create the first admin** screen. That account is yours; there are no default credentials. (Prefer the command line, or need to script it? `npm run create-admin -- you@example.com yourpassword "Your Name"` does the same thing — see *Account recovery* below.)
2. Go to **Settings → Docker** and set **Default env for all agents** to include your model API key, e.g. `{"ANTHROPIC_API_KEY": "sk-ant-…"}` (the ⓘ popup next to env fields documents all recognized variables). Agents cannot think without a provider key.
3. Check the **Containers** page — a **Hermes** definition ships by default (`nousresearch/hermes-agent:latest`, data mounted at `/opt/data`, gateway port 8642 + dashboard port 9119 auto-mapped).
4. Create a user on the **Users** page (with a password if they should log in), then click **New agent** on their row.
5. On the agent page press **Start** — the first start pulls the image (~2 GB, one time). Then chat away.

### Old Docker daemons (pre-20.10.10)

Modern images (glibc 2.34+) need the `clone3` syscall, which old daemons' seccomp profiles block — Python inside the container fails with `can't start new thread`. Workaround until you upgrade Docker: **Settings → Docker → Security options** = `seccomp=unconfined`. Remove it after upgrading.

## Using the application

### Users (admin)

Create accounts with a role and optional password; accounts without a password can't sign in (typical for O365-synced users until you set one). Per-row actions: change role, set password, create an agent (the dropdown above the table picks which container definition new agents use), delete (cascades to their agents). Lockout guards prevent deleting yourself or demoting/deleting the last admin.

### Containers (admin)

Container definitions are the blueprints agents are stamped from:

- **Runtime**: image, command, data mount path, auto-mapped container ports, memory/CPU limits, definition-level env (applied to containers at start; per-agent env wins).
- **Behavior files**: the file list every agent of this definition exposes as editors on its page — key, label, path (relative to the agent's data dir), hint, and an optional **template** written at agent creation. Templates substitute `{{AGENT_NAME}}` and `{{OWNER_NAME}}`.
- **MCP servers**: a list of Model Context Protocol servers (name + URL) pre-loaded into every agent of the definition, plus a runtime-specific *provision command template* (`{{NAME}}`/`{{URL}}` substituted, run inside the container) describing how that runtime ingests one server — the stock Hermes definition uses `hermes mcp add`. Servers that need auth take an optional **bearer token**: Attaché writes it into the agent's `.env` under the definition's token env-key pattern (Hermes reads `MCP_<NAME>_API_KEY`, then wires the `Authorization` header itself), and the template can also use `{{TOKEN}}` for runtimes that take it as an argument; OAuth-based servers register credential-less and complete login in the runtime's own UI (e.g. the Hermes dashboard). Provisioning runs automatically at container start/regenerate and on demand via the agent page's **Provision MCP** button, which shows per-server results. Note Hermes only persists servers it can actually reach at add time. Servers can also be **stdio commands** instead of URLs (binary baked into the image), with per-server extra args in which `{{OWNER_EMAIL}}`/`{{OWNER_NAME}}` substitute per agent — that's how identity-pinned integrations deploy with zero manual steps. Definitions may additionally carry an **MCP sign-in command** (an interactive device-code flow run detached in the container); when set, agent pages show an owner-accessible **MCP sign-in** button that surfaces the sign-in URL + code.

### Building definition images from the GUI

At the top of the definition editor, **Image source** chooses between a **standard image** (just a name, e.g. `nousresearch/hermes-agent:latest`) and **Build from Dockerfile** — a collapsible Dockerfile editor whose **Build image** button builds it tagged as the definition's image, no terminal needed. The two are an either/or: saving in standard-image mode clears the stored Dockerfile. On old daemons where `docker build` aborts (the seccomp/`clone3` issue), simple `FROM` + `RUN` Dockerfiles are automatically built by running the steps in a container under the configured security options and committing the result; the output panel tells you which path ran. The two ⓘ buttons in the MCP section document every field and every template placeholder (`{{NAME}}`, `{{URL}}`, `{{COMMAND}}`, `{{TOKEN}}`, `{{EXTRA}}`, `{{OWNER_EMAIL}}`, `{{OWNER_NAME}}`, `{{NAME_UPPER}}`, `{{LOG}}`).

### Worked example: Microsoft 365 per user

`images/hermes-m365/Dockerfile` bakes [`@softeria/ms-365-mcp-server`](https://github.com/softeria/ms-365-mcp-server) into the Hermes image — the same content ships in the stock Hermes definition's Dockerfile field, so **Build image** produces it from the GUI. Point the definition's image at `hermes-m365`, add an MCP server row — name `ms365`, stdio command `ms-365-mcp-server`, extra args setting `MS365_MCP_ORG_MODE`, `MS365_MCP_EXPECTED_USERNAME={{OWNER_EMAIL}}` (the identity pin) and token-cache paths under the agent's data dir — and set the sign-in command to `ms-365-mcp-server --login`. Each agent then gets an M365 integration that can only act as its owner; the owner clicks **MCP sign-in** once, enters the device code at Microsoft, and the token persists in their agent's data dir across regenerates. Existing agents need their config image updated (Agent page → Configuration) plus a Regenerate.
- One definition is the **default** for new agents; agents can be switched between definitions later (their file list follows).

The stock Hermes definition exposes: Soul (`SOUL.md`), Memory (`memories/MEMORY.md`), User profile (`memories/USER.md`), Agents (`AGENTS.md`), Tools (`TOOLS.md`), Context (`.hermes.md`).

### Agents

Each agent owns a data dir (`data/agents/<id>/`) mounted into its container — souls and memories edited in the GUI are the same files the agent reads and writes. The agent page has:

- **Container panel** — status, port mappings, Start / Stop / **Regenerate** (remove + recreate + start in one step, so env/port/definition changes apply; files are untouched unless you tick *reset files from templates*), log viewer, **Open dashboard**.
- **Configuration** — definition switcher and per-agent overrides: image, command, env (JSON), mount path, port mappings, memory/CPU limits. Admin-only; owners can view.
- **Files** — expandable editors for the definition's behavior files (owners can edit their own agent's files).
- **Cron jobs** — dropdown editor for scheduled-job files under `cron/`.

Host ports are auto-assigned per agent from a configurable range (default 18000+). Definition-declared ports missing from an agent are added automatically at every start/regenerate.

### Connecting Hermes to a custom model server

Hermes can talk to any OpenAI-compatible endpoint — vLLM, Ollama, LM Studio, llama.cpp, or a company gateway — instead of a hosted provider. It's all configured in the agent's **Runtime config** file (`config.yaml`, editable in the Files section of the agent page):

```yaml
model:
  default: "meta-llama/Llama-3.1-70B-Instruct"  # exact id the server reports at GET <base_url>/models
  provider: custom                              # aliases: ollama / vllm / llamacpp; LM Studio: lmstudio
  base_url: "http://192.168.1.50:8000/v1"       # include /v1
  api_key: "${MY_LLM_KEY}"                      # omit the whole line for no-auth servers
```

Or the named-provider form (reusable, and valid as a fallback target):

```yaml
model:
  default: "meta-llama/Llama-3.1-70B-Instruct"
  provider: my-gateway                 # or "custom:my-gateway"
providers:
  my-gateway:
    base_url: "https://llm.internal.example.com/v1"
    key_env: MY_GATEWAY_API_KEY        # NAME of the env var holding the key
    # extra_headers: { X-Corp-Auth: "${CORP_TOKEN}" }
    # ssl_verify: false                # or ssl_ca_cert: /path/ca.pem
```

Automatic failover when the primary errors (429 / 503 / 529 / connection failure):

```yaml
fallback_model:
  provider: custom
  model: "llama-3.3-70b"
  base_url: "http://127.0.0.1:11434/v1"
  key_env: OLLAMA_LOCAL_KEY            # optional; inline api_key also accepted
```

**The API key lives in an env var you name yourself.** Add it to the agent's env (Configuration → env), press **Regenerate** so the container is recreated with it, and reference it from config as `${MY_LLM_KEY}` or via `key_env`. There is no fixed built-in variable for custom endpoints — `OPENAI_API_KEY` is deliberately host-gated to `api.openai.com` and is **never sent** to other hosts.

| Variable | Purpose |
| --- | --- |
| *(your own name, e.g. `MY_LLM_KEY`)* | Key for the custom endpoint — referenced from config via `${…}` or `key_env` |
| `CUSTOM_BASE_URL` | Env-only endpoint override — beats `model.base_url` without editing config |
| `HERMES_MODEL` | Model override for the warm gateway (what the Chat tab talks to) and cron jobs |
| `OPENAI_API_KEY` | Only for `api.openai.com` (`provider: openai-api`) — not sent to custom hosts |
| `OPENAI_BASE_URL` | Only honored for `provider: openai-api` — **not** a custom-endpoint override |

Gotchas:

- `provider: openai` is **invalid** and errors at runtime — use `custom` (or `openai-api` for actual OpenAI).
- With a non-loopback `base_url` there is **no model auto-detect** — always set `model.default` to the exact id the server serves.
- A no-auth local server needs no key at all: omit `api_key` and Hermes sends a placeholder.
- From inside the container, LAN IPs are reachable directly; for a server running on the Docker host itself use `host.docker.internal`.
- `api_mode` defaults to `chat_completions`; set `anthropic_messages` for Anthropic-protocol endpoints.
- Config is read at process start: after editing Runtime config, **Stop/Start** the container; after env changes, **Regenerate**.

### Chat

Pick an agent and talk. Messages stream through the agent's OpenAI-compatible gateway — a warm, always-loaded process, so replies take seconds, not minutes. History is kept per agent in your browser. **Timing note:** after a container starts, the gateway needs ~2–4 minutes to come up; a "gateway unreachable" error right after boot just means wait.

### Hermes dashboard

Every Hermes agent also serves its own full-featured web dashboard (port 9119, auto-mapped). Click **Open dashboard ↗** on the agent page or chat header and sign in with the **owner's Attaché email and password**. Provisioning is automatic and hash-only: whenever a password is set or changed in Attaché, a Hermes-format scrypt hash (never the plaintext) is written into each owned agent's `.env`, and running dashboards restart to pick it up. The dashboard takes up to ~4 minutes after container start.

### Integrations — Office 365 (admin)

Sync users from an Entra (Azure AD) group:

1. Create an app registration with **application** permissions `GroupMember.Read.All` + `User.Read.All` (admin-consented), client-credentials flow.
2. Enter tenant ID, client ID, client secret, and the group's object ID on the Integrations page.
3. **Preview members** to sanity-check, then **Sync now** — each new member gets a user (no password, `o365` source) and a default agent. Re-syncs are idempotent.

### Settings (admin)

- **Server** — API bind host/port (restart required), data-dir display.
- **Docker** — universal daemon config: socket/pipe path, auto-pull, host-port range start, restart policy, security options, and the shared **default env** merged into every container (settings → definition → agent, later wins).
- **Security** — session lifetime. Passwords are scrypt hashes; sessions persist across server restarts.

## Account recovery / CLI account creation

Locked out, or provisioning from a script? With the server **stopped** (it holds the store in memory and would overwrite the change):

```bash
npm run create-admin -- admin@example.com a-strong-password "Display Name"
```

Creates the account as an admin, or — if the email already exists — promotes it to admin and resets its password. Both the Attaché password hash and the agent-dashboard hash are set, so owned agents' Hermes dashboards accept the new password after their next restart. Start the server again and sign in.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| "gateway unreachable" in Chat right after starting a container | Gateway boots in ~2–4 min. Wait, then retry. |
| Dashboard button 404s / connection refused | Dashboard takes up to ~4 min after container start. Also requires the owner to have an Attaché password. |
| `can't start new thread` in agent logs; chat/dashboard never come up | Old Docker daemon seccomp vs `clone3` — see *Old Docker daemons* above. |
| Container features all say "docker offline" | Start Docker Desktop / the daemon. The GUI degrades gracefully meanwhile. |
| GUI dev server won't bind | Windows excluded-port ranges — `netsh interface ipv4 show excludedportrange protocol=tcp`, then change ports in `.claude/launch.json` / vite config. |
| Slow replies despite warm gateway | The model does the thinking — switch the agent's model (e.g. `hermes config set model.default anthropic/claude-sonnet-5` inside the container) for faster turnaround. |
| Update blocked: "working tree has local changes" | The error names the files. `git stash` (or `git checkout -- <files>`) in the install dir, then retry. Lockfile-only churn from `npm install` is reset automatically. |
| Agent files unreadable on a Linux host ("permission denied" / accessed-through-container notes) | The runtime chowns its data dir to its internal user (e.g. UID 10000) at container start. Attaché transparently reads **and writes** those files through Docker while the container runs — file editors, password→dashboard sync, and MCP token writes all keep working. Only shell access, stopped-container edits, and *reset files* during regenerate need host access: `sudo setfacl -R -m u:$USER:rwX -m d:u:$USER:rwX data/agents` (the `d:` default survives new files; re-run if the container resets modes). |

## Security notes

- `data/` is gitignored and holds everything sensitive: user records (hashes only), sessions, agent souls/memories, and the definition env (which contains your model API key). Don't commit it.
- Dashboard credentials are provisioned as hashes; plaintext passwords exist only in transit during login/set-password requests.
- The GUI listens on all interfaces (LAN-reachable) so other machines can use it; the API stays loopback-only and is reached through the GUI's proxy. On untrusted networks, firewall port 7700 (and the agent port range) or put TLS in front.

## Roadmap

- Shared tool library served over MCP (currently a stub at `/api/mcp/status` and the Tools page)
- SQLite store swap (interface already isolated in `server/src/store.ts`)
- Run-as-a-service install (survive reboots without a dev session)
- Per-user dashboard OAuth instead of basic auth

## Repo layout

| Path | What |
|------|------|
| `server/` | Fastify API — auth, users, agents, container defs, docker, chat proxy, O365, MCP stub |
| `web/` | Vite + React GUI |
| `data/` | Runtime state (gitignored): `db.json` + `agents/<id>/` data dirs |
| `docs/superpowers/specs/` | Design docs |
