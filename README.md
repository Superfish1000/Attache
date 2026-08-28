# Attaché

A self-hosted web GUI for running **containerized AI agents** — one container per person. Attaché manages the users, the agents' personality files, the Docker lifecycle, and a built-in chat, with [Hermes Agent](https://hermes-agent.nousresearch.com) (Nous Research) as the default runtime. Users can be synced automatically from an Office 365 group, each receiving their own agent.

## Features

- **Users & roles** — admin and standard accounts, scrypt-hashed passwords, cookie sessions. Standard users see only their own agents; admins manage everything.
- **Container definitions** — reusable setups (image, command, mount, ports, env, resource limits) plus a per-definition list of *behavior files* with creation templates. Agents are created from a definition and stay individually tweakable.
- **Agent management** — start/stop/regenerate containers, live logs, editable soul/memory/config files, per-agent cron jobs, auto-assigned host ports.
- **Chat** — streaming chat with any agent you own, proxied through the agent's warm OpenAI-compatible gateway (no cold start per message).
- **Hermes dashboard** — one-click access to each agent's own web dashboard, automatically secured with the owner's Attaché login (hash-only provisioning — no plaintext at rest).
- **Office 365 auto-sync** — poll an Entra group on a schedule: new members get a user (and optionally an agent — auto-started if you choose — plus a welcome email), members who leave are disabled, returners are re-enabled. Admins are never auto-disabled.
- **Email onboarding (SMTP)** — new users get a set-password link by email; no passwords ever travel in mail.
- **Password reset** — self-serve **Forgot password?** on the login screen, plus an admin **Email link** re-send on the Users page. Links are single-use and expire.
- **Restart button** — restart the server from Settings → Updates after an update, no shell needed.
- **MCP tool library** — stub today (`/api/mcp/status`); planned shared tool server for all agents. Its page is hidden from the nav until it's more than a stub.
- **MCP management server** — Attaché itself exposes its own management surface (agents, agent/MCP tool container definitions, MCP tool instances — full lifecycle) as MCP tools, so an agent can create/update/regenerate/delete containers through Attaché's own correct lifecycle instead of hand-editing containers on the host. Off by default; OAuth 2.1 + a static Bearer token for auth.

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

Create accounts with a role and optional password; accounts without a password can't sign in (typical for O365-synced users until you set one). Per-row actions: change role, set password, **Email link** (send a set-password link — needs SMTP configured), create an agent (the dropdown above the table picks which container definition new agents use), **Disable**/**Enable** (disabling revokes sessions and stops the user's containers; the row shows a `disabled` chip), delete (cascades to their agents). Lockout guards prevent deleting/disabling yourself or demoting/deleting the last admin.

### Containers (admin)

Container definitions are the blueprints agents are stamped from:

- **Runtime**: image, command, data mount path, auto-mapped container ports, memory/CPU limits, definition-level env (applied to containers at start; per-agent env wins).
- **Behavior files**: the file list every agent of this definition exposes as editors on its page — key, label, path (relative to the agent's data dir), hint, and an optional **template** written at agent creation. Templates substitute `{{AGENT_NAME}}` and `{{OWNER_NAME}}`.
- **MCP servers**: a list of Model Context Protocol servers (name + URL) pre-loaded into every agent of the definition, plus a runtime-specific *provision command template* (`{{NAME}}`/`{{URL}}` substituted, run inside the container) describing how that runtime ingests one server — the stock Hermes definition uses `hermes mcp add`. Servers that need auth take an optional **bearer token**: Attaché writes it into the agent's `.env` under the definition's token env-key pattern (Hermes reads `MCP_<NAME>_API_KEY`, then wires the `Authorization` header itself), and the template can also use `{{TOKEN}}` for runtimes that take it as an argument; OAuth-based servers register credential-less and complete login in the runtime's own UI (e.g. the Hermes dashboard). Provisioning runs automatically at container start/regenerate and on demand via the agent page's **Provision MCP** button, which shows per-server results. Note Hermes only persists servers it can actually reach at add time. Servers can also be **stdio commands** instead of URLs (binary baked into the image), with per-server extra args in which `{{OWNER_EMAIL}}`/`{{OWNER_NAME}}` substitute per agent — that's how identity-pinned integrations deploy with zero manual steps. Definitions may additionally carry an **MCP sign-in command** (an interactive device-code flow run detached in the container); when set, agent pages show an owner-accessible **MCP sign-in** button that surfaces the sign-in URL + code.

### Building definition images from the GUI

At the top of the definition editor, **Image source** chooses between a **standard image** (just a name, e.g. `nousresearch/hermes-agent:latest`) and **Build from Dockerfile** — a collapsible Dockerfile editor whose **Build image** button builds it tagged as the definition's image, no terminal needed. The two are an either/or: saving in standard-image mode clears the stored Dockerfile. On old daemons where `docker build` aborts (the seccomp/`clone3` issue), simple `FROM` + `RUN` Dockerfiles are automatically built by running the steps in a container under the configured security options and committing the result; the output panel tells you which path ran. The two ⓘ buttons in the MCP section document every field and every template placeholder (`{{NAME}}`, `{{URL}}`, `{{COMMAND}}`, `{{TOKEN}}`, `{{EXTRA}}`, `{{OWNER_EMAIL}}`, `{{OWNER_NAME}}`, `{{NAME_UPPER}}`, `{{LOG}}`).

### Worked example: Microsoft 365 per user

`images/hermes-m365/Dockerfile` bakes [`@softeria/ms-365-mcp-server`](https://github.com/softeria/ms-365-mcp-server) into the Hermes image — the same content ships in the stock Hermes definition's Dockerfile field, so **Build image** produces it from the GUI. Point the definition's image at `hermes-m365`, add an MCP server row — name `ms365`, stdio command `ms-365-mcp-server`, extra args:

```
--env MS365_MCP_ORG_MODE=true MS365_MCP_EXPECTED_USERNAME={{OWNER_EMAIL}} MS365_MCP_TOKEN_CACHE_PATH=/opt/data/m365/token-cache.json MS365_MCP_SELECTED_ACCOUNT_PATH=/opt/data/m365/selected-account.json MS365_MCP_LOG_DIR=/opt/data/m365/logs --args --org-mode
```

(`EXPECTED_USERNAME` is the identity pin.) **One `--env` flag, many `KEY=VALUE` words**: hermes' `mcp add --env` takes a space-separated list, and *repeating* the flag silently keeps only the last one — a field bug that cost hours (registrations kept only whichever env came last). `--args` must stay the final option. **All three path envs are load-bearing** — miss `TOKEN_CACHE_PATH` and the server falls back to a root-owned dir inside the npm package: token writes fail silently, `verify_login` still reports success, and every real tool call returns "No accounts found". Set the **MCP sign-in command** to:

```
mkdir -p /opt/data/m365/logs /opt/data/.ms-365-mcp-server && chown -R hermes /opt/data/m365 /opt/data/.ms-365-mcp-server 2>/dev/null; runuser -u hermes -- env HOME=/opt/data MS365_MCP_ORG_MODE=true MS365_MCP_EXPECTED_USERNAME={{OWNER_EMAIL}} MS365_MCP_TOKEN_CACHE_PATH=/opt/data/m365/token-cache.json MS365_MCP_SELECTED_ACCOUNT_PATH=/opt/data/m365/selected-account.json MS365_MCP_LOG_DIR=/opt/data/m365/logs ms-365-mcp-server --login --org-mode > {{LOG}} 2>&1
```

The root-run `mkdir`/`chown` prelude matters on Linux hosts: Attaché's execs (and the Hermes gateway) run as root, so tool state dirs can end up root-owned — the login then drops to the `hermes` user and dies with `EACCES`. Prepping ownership before `runuser` self-heals that on every sign-in. Two more field notes: (1) a Python `RuntimeError: Event loop is closed` traceback after a `── name: OK ──` provision result is Hermes' own teardown noise, not a failure; (2) **the definition is the source of truth** — provisioning re-adds servers from it at every container start, so runtime-side hand-fixes (`hermes config set mcp_servers...`) get wiped; put env fixes in the definition's extra args. After completing a sign-in, restart the container (or the MCP server) — a server that was already running keeps its pre-login account state in memory.

Each agent then gets an M365 integration that can only act as its owner; the owner clicks **MCP sign-in** once, enters the device code at Microsoft, and the token persists in their agent's data dir across regenerates. Existing agents need their config image updated (Agent page → Configuration) plus a Regenerate.

#### Adding the Teams Developer CLI (optional)

Add one line to the definition's Dockerfile and rebuild:

```
RUN npm install -g @microsoft/teams.cli@preview
```

A true single sign-on covering both tools isn't possible — the MCP server and the Teams CLI are **separate Azure app registrations** (each has its own client ID, token cache, and consent), and Microsoft doesn't let one app redeem another's tokens. The next best thing works well: a combined sign-in command that runs both device-code flows **in succession** with the same Microsoft account:

```
mkdir -p /opt/data/m365/logs /opt/data/.ms-365-mcp-server /opt/data/.config && chown -R hermes /opt/data/m365 /opt/data/.ms-365-mcp-server /opt/data/.config 2>/dev/null; runuser -u hermes -- env HOME=/opt/data MS365_MCP_ORG_MODE=true MS365_MCP_EXPECTED_USERNAME={{OWNER_EMAIL}} MS365_MCP_TOKEN_CACHE_PATH=/opt/data/m365/token-cache.json MS365_MCP_SELECTED_ACCOUNT_PATH=/opt/data/m365/selected-account.json MS365_MCP_LOG_DIR=/opt/data/m365/logs ms-365-mcp-server --login --org-mode > {{LOG}} 2>&1; echo "--- Microsoft 365 sign-in finished. Teams CLI sign-in starting — press Sign-in status for the second code ---" >> {{LOG}}; runuser -u hermes -- env HOME=/opt/data TEAMS_NO_INTERACTIVE=1 teams login --device-code -y --disable-auto-update >> {{LOG}} 2>&1
```

#### Letting standard users sign in (admin consent)

The MCP server signs users in through its own multi-tenant Azure app (client ID `084a3e9f-a9f4-43f7-89f9-d229cf97853e`). In most org tenants, standard users can't consent to third-party apps, so their sign-in stops at Microsoft's **"Need admin approval"** screen. Two ways out:

1. **One-click tenant consent** (fastest): a tenant admin opens
   `https://login.microsoftonline.com/<tenant-id>/adminconsent?client_id=084a3e9f-a9f4-43f7-89f9-d229cf97853e`
   and accepts. All users can then complete the device-code sign-in. Trade-off: you're granting a third-party app's delegated permissions tenant-wide.
2. **Bring your own app registration** (recommended for orgs): create a single-tenant app in Entra, set *Authentication → Allow public client flows* = **Yes**, add the **delegated** Graph permissions for the toolsets you use (`User.Read`, `offline_access`, `Mail.ReadWrite`, `Calendars.ReadWrite`, `Files.ReadWrite.All`, …) and press *Grant admin consent*. Then add `MS365_MCP_CLIENT_ID=<your-app-id> MS365_MCP_TENANT_ID=<tenant-id>` to **both** the ms365 row's extra args (inside the single `--env` list) and the sign-in command's env block, and re-provision. Users already signed in under the default app must sign in once more — token caches are per-app.

Flow for the owner: press **MCP sign-in** → complete the first device code (Microsoft 365) → press **Sign-in status** → the Teams CLI's second code appears → complete it. Both token caches live in the agent's data dir (`m365/` and `.config/teams-cli/` — the CLI resolves its config under `HOME`), so they survive regenerates. `TEAMS_NO_INTERACTIVE=1` and `-y` keep the CLI from waiting on prompts that can't be answered in a detached shell.

- One definition is the **default** for new agents; agents can be switched between definitions later (their file list follows).

The stock Hermes definition exposes: Soul (`SOUL.md`), Memory (`memories/MEMORY.md`), User profile (`memories/USER.md`), Agents (`AGENTS.md`), Tools (`TOOLS.md`), Context (`.hermes.md`).

### MCP tool containers

MCP tool containers (standalone containers that just run MCP server software, decoupled from any agent) are split into **definitions** and **instances** — the same template/copy relationship container definitions have with agents. A definition is a reusable template (image, command, env, ports, mount path, resource limits, optional Dockerfile); an instance is one running (or stoppable) copy of it, with its own **network alias** and independently editable config. One definition can be run as several independently-managed instances.

**Definitions** live in the **MCP tool containers** table below the agent-container-definitions table on the **Containers** page (admin-only) — name, image, an **Instances** count, and an editor (image/Dockerfile toggle, command, env, ports, mount path, resource limits) that mirrors the agent-definition editor. Deleting a definition is blocked while any instance still references it.

**Instances** are managed from the dedicated **MCP Tools** sidebar page, visible to everyone: any signed-in user sees each instance's name, definition, network alias, **Reachable at** address, and status, with **Copy** buttons for the alias/address. Admins additionally get **New instance** (pick a definition; the network alias is auto-generated from the definition's name, slugified and de-duplicated, and editable after) plus a per-instance editor and lifecycle controls — **Save**, **Start**, **Stop**, **Restart** (in-place, keeps the same container — use this for a quick bounce), **Regenerate** (remove + recreate + start, so image/env/port changes apply), **View logs**, and **Delete** (stops and removes its container).

**Shared network.** Every agent container and every tool instance automatically joins a Docker bridge network named `attache-net`. Docker's built-in DNS makes a tool instance reachable from any agent at `http://<network alias>:<port>` — no host port needed. Agent containers created before this network existed get attached to it live (a `docker network connect`, not a rebuild) the next time they start, or automatically at Attaché's next boot.

**Using one.** Create and start an instance on the **MCP Tools** page, then note its **Reachable at** address (`http://<alias>:<port>`), shown once the instance has a network alias and at least one container port. Go to an agent's container definition → **MCP servers** section and paste that address into a server row's **URL** field — the field also offers known tool addresses via autocomplete. Nothing about the existing MCP-server-provisioning mechanism changes; a tool instance's address is just another external MCP URL.

**Security note.** The shared network has no per-agent ACLs — any agent container can reach any tool instance on it. That matches the "shared tool library" intent, but only start tool instances you're comfortable *all* agents (and their owners) reaching.

**Optional host publishing.** An **Also publish to a host port** checkbox (off by default) additionally maps an instance's ports to auto-assigned host ports, for direct/admin testing (e.g. `curl` from the host). Agents never need this — they reach the instance over `attache-net`.

### MCP management server

Attaché can expose its own management capabilities — agents, agent container definitions, MCP tool container definitions, MCP tool instances, and their full lifecycle (create/update/delete/build/check-for-update/upgrade/start/stop/restart/regenerate) — as MCP tools an agent can call. It's the fix for the "I updated my custom MCP tool container and now the agent connected to it needs a manual regenerate + disable/restart-gateway/re-enable dance" problem: give the agent a tool that goes through Attaché's own correct container lifecycle instead of hand-editing containers on the host, and the DNS-alias/network bookkeeping never gets corrupted in the first place.

**Enabling it.** Off by default — **Settings → MCP management server** → **Enabled**. When off, `/mcp`, `/authorize`, `/token`, `/register`, and the well-known metadata endpoints all return 503.

**Access model.** No per-agent/per-owner scoping — any caller holding a valid credential gets the same access an admin has in the GUI: every agent, every definition, every instance, regardless of owner. This mirrors how every other MCP server integration already works in Attaché (wired into an agent via the existing MCP-servers mechanism) — there's no new permission layer.

**Connecting an agent (internal, Bearer token).** Add an entry to a container definition's **MCP servers** list (Containers page) the same way you'd add any other MCP server: URL `http://host.docker.internal:<api-port>/mcp` (agent containers get `host.docker.internal` mapped to the Docker host automatically), and the Bearer token from **Settings → MCP management server** (reveal/regenerate there). No browser, no human-in-the-loop — same as any other pre-provisioned MCP server.

**Connecting an external client (OAuth).** Point a remote MCP client (Claude Desktop, Claude.ai's remote-MCP connector, etc.) at `<Public GUI address>/mcp` (Settings → Server → **Public GUI address** must be set — OAuth needs a stable public address to scope tokens to). The client registers via Dynamic Client Registration (`POST /register`) or a Client ID Metadata Document (a `client_id` that's itself an HTTPS URL Attaché fetches), then walks the standard OAuth 2.1 + PKCE authorization-code flow. The first connection shows an admin a consent prompt ("*`<client>`* wants to connect to Attaché's MCP server — Approve/Deny") — only an admin can approve, since approving grants full admin-equivalent access. Approved clients show up under **Settings → MCP management server → Connected OAuth clients**, with a **Revoke** action.

**Connecting over HTTPS.** Claude Desktop's remote-MCP connector requires a trusted HTTPS connection — it won't connect to the plain-HTTP address above. If Claude Desktop runs on a different machine than the one hosting Attaché (the common case) and you don't have a domain name, generate a locally-trusted certificate with [mkcert](https://github.com/FiloSottile/mkcert):

1. Install mkcert, then run `mkcert -install` on **this** machine (the one running Attaché) — creates a local certificate authority and installs it into this machine's trust store.
2. Run `mkcert <this-machine's-LAN-IP> localhost 127.0.0.1` (Settings → HTTPS shows your detected local IPs) — produces a certificate (`<name>+2.pem`) and key (`<name>+2-key.pem`) file.
3. In **Settings → HTTPS**, enable it, point **Certificate file path** / **Key file path** at those two files, and point **CA certificate file path** at `rootCA.pem` (run `mkcert -CAROOT` to find where that lives) — then restart the server.
4. On the **other** machine (wherever Claude Desktop runs), open Attaché's existing HTTP address, go to **Settings → HTTPS**, and click **Download CA certificate**. Import that file into that machine's trust store the same way `mkcert -install` did on this one (Windows: double-click the file → Install Certificate → Local Machine → Trusted Root Certification Authorities).
5. Point Claude Desktop's MCP connector at `https://<this-machine's-LAN-IP>:<HTTPS port>/mcp`, and update **Public GUI address** (Settings → Server) to that same `https://...` address — that's the field the OAuth flow uses to scope tokens and build discovery URLs.

The existing plain-HTTP address keeps working unchanged throughout — for browsing the GUI, and for the agent-container-to-Attaché MCP wiring described above, which stays on HTTP permanently (that connection uses `host.docker.internal`, Docker's own mechanism for a container to reach its host machine, and is unrelated to needing a trusted certificate).

**Connecting locally (stdio).** `npm run mcp-stdio` (from `server/`) runs the same tools over stdio, in-process, no network/auth layer — for local-machine MCP clients that prefer a subprocess over HTTP.

**Destructive-action safety.** Every tool that deletes, stops, or recreates something already running (`delete_*`, `stop_*`, `regenerate_*`, and `upgrade_*`/`upgrade_all_*` calls with `mode: 'update-regen'`) requires `confirm: true` in its input. This is a cheap safety net against a hallucinated or misfired call, not a hard security boundary — a determined/compromised client can always pass `confirm: true`, which is an acceptable tradeoff given the access model is already full-admin trust for any holder of a valid credential.

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

Sync users from an Entra (Azure AD) group. The page walks through it:

1. **App registration** — paste the tenant ID, client ID, and client secret of an app registration with **application** permissions `GroupMember.Read.All` + `User.Read.All` (client-credentials flow). Once tenant + client IDs are entered, the page shows a one-click **grant admin consent** link straight into Microsoft's consent screen.
2. **Group** — paste the group's object ID, then **Test connection** / **Preview members** to sanity-check (tests use *saved* values — save after changing credentials).
3. **Polling** — poll interval in minutes (**0 = off**). Changes apply without a restart, and a sync also runs ~30 s after server boot. The button reads **Sync now** when the form matches what's saved, or **Save and Sync** when you've made unsaved changes (it saves first, then syncs exactly what's on screen). A run-history table shows recent runs: members, created, disabled, re-enabled, email failures, error.
4. **New member actions** — checkboxes for what happens beyond the user account itself, each gated on the one above it: **create an agent** for each new user → **start its container immediately** (first start pulls the image) → **run the definition's MCP provisioning script** (needs the container running) — and independently, **email a set-password link** (requires SMTP *and* the Public GUI address — the page warns if either is missing). **Save settings** lives at the bottom of the page, below all four steps.

Sync semantics are **disable, don't delete**: members who leave the group are disabled (sessions revoked, containers stopped), members who return are re-enabled, and admins are never auto-disabled. **Important:** for O365-synced users, group membership is the source of truth — manually disabling a user who is still in the group gets reverted at the next poll. To keep someone out, remove them from the group instead.

### Settings (admin)

- **Updates** — shows the running commit vs GitHub with **Check for updates** / **Update now**, plus a **Restart server** button so updated code actually runs. The restart works by exiting the process and relying on whatever supervises it to bring it back: in production run Attaché under a supervisor (systemd with `Restart=always` — the recommendation for a Linux server — or pm2, or docker); in dev the tsx watcher respawns it.
- **Server** — API bind host/port (restart required), **Public GUI address** (the origin used in emailed links), data-dir display.
- **Email (SMTP)** — host, port, TLS mode (STARTTLS/none vs implicit TLS), optional username/password (blank username = no auth), and From address; leave host empty to disable email entirely. A **Send test email** button mails the signed-in admin to prove the config. This powers all set-password links: new-user onboarding, **Forgot password?**, and the Users page's **Email link** button. Emailed links **require** the Public GUI address (Settings → Server) to be set — without it Attaché can't know what URL to put in the mail.
- **Docker** — universal daemon config: socket/pipe path, auto-pull, host-port range start, restart policy, security options, and the shared **default env** merged into every container (settings → definition → agent, later wins).
- **Security** — session lifetime. Passwords are scrypt hashes; sessions persist across server restarts.
- **MCP management server** — enable/disable, the Bearer token agents use to connect (reveal/regenerate), and connected OAuth clients (revoke). See *MCP management server* above.
- **HTTPS** — a second listener (enabled by default — a no-op until a certificate is configured) for clients that require a trusted connection, e.g. Claude Desktop's remote-MCP connector. Port, certificate/key file paths, an optional CA certificate path (enables a **Download CA certificate** button, for installing on a different machine's trust store), and a status line showing whether it's actually running. See *Connecting over HTTPS* above.

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
| Dashboard button 404s / connection refused | Dashboard takes up to ~4 min after container start. Owners without an Attaché password yet still get a working (but unusable) dashboard bind — a placeholder credential nobody knows — so it's never the crash-loop cause; once they set their password the real credential lands automatically. |
| `can't start new thread` in agent logs; chat/dashboard never come up | Old Docker daemon seccomp vs `clone3` — see *Old Docker daemons* above. |
| Container features all say "docker offline" | Start Docker Desktop / the daemon. The GUI degrades gracefully meanwhile. |
| Agent can't reach a tool container by its network alias | The agent's container predates `attache-net`. Stop/Start it (or wait for Attaché's next restart) to get retrofitted onto the network. |
| GUI dev server won't bind | Windows excluded-port ranges — `netsh interface ipv4 show excludedportrange protocol=tcp`, then change ports in `.claude/launch.json` / vite config. |
| Slow replies despite warm gateway | The model does the thinking — switch the agent's model (e.g. `hermes config set model.default anthropic/claude-sonnet-5` inside the container) for faster turnaround. |
| Update blocked: "working tree has local changes" | The error names the files. `git stash` (or `git checkout -- <files>`) in the install dir, then retry. Lockfile-only churn from `npm install` is reset automatically. |
| Set-password emails not arriving | Settings → Email → **Send test email** to prove SMTP; the **Public GUI address** (Settings → Server) must be set for links; check the run history's email-failures column on the Integrations page. |
| Disabled user came back (re-enabled) | They're still in the O365 group — group membership is the source of truth for synced users. Remove them from the group instead. |
| Deleting an agent fails ("permission denied" rmdir) | Files the runtime created (e.g. `.local/share`) can block a plain host delete on Linux. Deletion now falls back to clearing the dir as root through a throwaway container when the host can't — should self-resolve; if it doesn't, the leftover path is logged server-side. |
| Agent files unreadable on a Linux host ("permission denied" / accessed-through-container notes) | The runtime chowns its data dir to its internal user (e.g. UID 10000) at container start. Attaché handles this two ways: (1) it transparently reads **and writes** through Docker while the container runs, and (2) ~20s–2min after each container start it re-groups the data dir to its own group (`g+rwX`, setgid dirs — owner stays the runtime's user), restoring normal on-disk access for the account running Attaché. Files the runtime creates between fixes are group-readable immediately and group-writable after the next start. For other accounts or stronger guarantees: `sudo setfacl -R -m u:$USER:rwX -m d:u:$USER:rwX data/agents`. |

## Security notes

- `data/` is gitignored and holds everything sensitive: user records (hashes only), sessions, agent souls/memories, and the definition env (which contains your model API key). Don't commit it.
- Dashboard credentials are provisioned as hashes; plaintext passwords exist only in transit during login/set-password requests.
- The GUI listens on all interfaces (LAN-reachable) so other machines can use it; the API stays loopback-only and is reached through the GUI's proxy. On untrusted networks, firewall port 7700 (and the agent port range) or put TLS in front.

## Roadmap

- Shared tool library served over MCP — the hosting infrastructure now ships: admins manage MCP tool container definitions (templates) on the **Containers** page and run/manage any number of independently-managed instances of them from the **MCP Tools** page, wiring instance addresses into any agent's MCP servers (see *MCP tool containers*). Still to build: identity-aware/multi-tenant tool logic — a tool acting **as** the specific calling agent's owner (e.g. sending mail from their mailbox), the way the M365 stdio integration does per-agent today; today's tool instances are anonymous/shared, with no per-agent identity threading. Separately, the browsable-library UI is still a stub (`/api/mcp/status`) and its Tools page stays hidden from the nav — `web/src/pages/Tools.tsx` still exists, ready to re-link
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
