# DeepChat

A **local AI-companion chat desktop app** built on top of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`).

Create multiple AI companions, each with its own persona, skills and tool permissions. Chat with them one-on-one, or drop several of them into a group where they speak up on their own — following rules plus a bit of probability — and riff off each other.

**All data stays on your machine.** No server required.

---

## What this is

The chat product is built as **plugins** on top of DeepSeek Harness:

- **Runtime comes entirely from dsh** — agent loop, tool system, LLM adapters, session event log, HTTP/WS transport, Cordis plugin tree
- **Chat business logic is ours** — AI companions, the group trigger engine, long-term memory, desktop UI
- **UI carried over from the original chat-agent** — Tauri 2 + Vue 3, with the transport switched from stdin/stdout to HTTP + SSE

> The upstream framework docs are kept in full under [`docs/`](docs/) (219 pages). This file describes this project itself; the Chinese version lives in [`README.zh.md`](README.zh.md).

## Getting started

**Requirements**

- [Node.js](https://nodejs.org/) ≥ 20
- [pnpm](https://pnpm.io/) ≥ 9
- [Rust](https://www.rust-lang.org/) toolchain (to build the Tauri desktop app)

**1. Install dependencies and build the dsh core**

The desktop app launches the backend host via `node apps/cli/lib/bin.js --profile chat-agent`, so the core **must be built first** — otherwise startup fails with "unable to locate dsh".

```bash
cd deepseek-harness
pnpm install --ignore-scripts
pnpm run build          # builds host + client, emits apps/cli/lib/
```

**2. Start the desktop app**

```bash
cd apps/desktop
pnpm tauri dev          # first Rust compile takes roughly 1–3 minutes
```

`pnpm tauri dev` does two things:

1. Runs `beforeDevCommand` (`pnpm dev`), starting the Vite dev server at `http://localhost:1420`
2. Spawns the dsh host from the Rust side (`spawn_dsh`), polls `127.0.0.1:3180` until it is ready, then tells the frontend it can start making requests

**3. Other ways to run it**

```bash
# Frontend only (start the backend in another terminal) — handy for UI work
cd apps/desktop && pnpm dev
DSH_HOME=$PWD/.dsh-home node apps/cli/lib/bin.js --profile chat-agent

# Backend only, no desktop window
DSH_HOME=$PWD/.dsh-home node apps/cli/lib/bin.js --profile chat-agent
curl http://127.0.0.1:3180/chatapi/bots

# Point the app at a custom host command (overrides the in-repo CLI)
DEEPCHAT_DSH_CMD="node /abs/path/to/bin.js" pnpm tauri dev
```

**Packaging the desktop app**

```bash
cd apps/desktop
pnpm tauri build        # beforeBuildCommand runs `pnpm build` first to emit dist
```

> After changing `packages/chat/*`, rebuild the plugin packages (`tsc -b` + `tsdown`) **and restart the host process**: Vite hot-reloads the frontend, but already-loaded Node modules are never swapped in place.

## Features

**AI companions**
- Persona injection, avatar, tagline, dedicated workspace directory
- Per-companion allow-lists for **tools / skills / MCP servers** (dedicated pickers — no more typing names by hand)
- Agent capability switch: turn it off and the companion is pure chat, with no tools exposed to the model
- **AI-assisted generation**: describe it in one line and the persona, self-introduction or group description streams into the field over SSE
- **Long-term memory**: clearing a conversation distills the relationship into `MEMORY.md`. It survives across sessions and clearing the chat log, and you can read or hand-edit it in the edit dialog
- **Clone a companion**: one click produces a twin with identical configuration but a fresh identity — persona, model, tools, skills, avatar file and long-term memory are copied, and the source conversation is immediately distilled into the clone's memory. Names increment automatically (`Xiaoyi` → `Xiaoyi-Clone` → `Xiaoyi-Clone2`)

**Groups**
- Several companions in one room, speaking on their own: `@name` always answers → cooldown window → keyword hit → base probability
- **Proactive speaking**: opt-in; once the room has been idle for N minutes, a companion starts a new thread (randomized between 5 and 10 minutes so members do not speak in unison)
- Each (group, companion) pair keeps its own session memory, so group history and private chats never bleed into each other
- **Shared group workspace**: the group and every member have their own directory, injected into context so each companion picks where to read and write
- Companions can chain off each other (up to 3 rounds)

**Conversations & interface**
- Dark theme, streaming typewriter output; Chinese and English (follows the system, switchable by hand)
- Pin conversations, clear history, delete sessions; right-click menu on the list (companions: message / clone / delete; groups: disband, with a confirmation step)
- **Image attachments persist**: sent images are written to `$HOME/chat-agent-images/<conversation id>/`; older images are migrated automatically and keep rendering after a restart

**Models**
- OpenAI / Anthropic plus any OpenAI-compatible endpoint
- Model configuration and API keys live in a local credentials file
- With no key configured, web search falls back to a keyless channel

**Desktop app**
- Tool-call cards: arguments and results expand live, so a slow tool shows progress instead of a blank wait
- Conversation list, companion list and message history are all paginated / incrementally rendered — long lists stay smooth
- Built-in debug panel: LLM call waterfall, runtime logs

## Architecture

```
┌─────────────────────────────────────────────┐
│  Tauri 2 desktop app (apps/desktop)         │
│  Vue 3 + Pinia + Tailwind 4                 │
└──────────────────┬──────────────────────────┘
                   │ HTTP / SSE  127.0.0.1:3180
┌──────────────────▼──────────────────────────┐
│  chat plugin family (packages/chat/)        │
│  chat-bots   registry + DMs + models/skills │
│  chat-group  orchestration + trigger engine │
│  chat-agent  bundle composition (cordis)    │
└──────────────────┬──────────────────────────┘
                   │
┌──────────────────▼──────────────────────────┐
│  DeepSeek Harness core                      │
│  agent-loop · tools · llm · session · http  │
└─────────────────────────────────────────────┘
```

The full path of one message:

```
user sends a message
  → POST /chatapi/bots/:id/send    (groups: /chatapi/groups/:id/send)
  → ensureAgent → agent.followup()
  → dsh agent-loop runs, multiple tool calls per turn
  → session events are translated to frontend events by bridge.ts
  → pushed over SSE /chatapi/events
  → rendered: message.stream → typewriter → message.created
```

## Layout

```
deepseek-harness/
├── apps/
│   ├── desktop/            # Tauri 2 desktop app (this project's UI)
│   ├── cli/                # dsh CLI entrypoint
│   └── web/                # dsh's own web UI (debugging)
├── packages/
│   ├── chat/               # this project's plugins
│   │   ├── chat-bots/      #   companions + DMs + model/skill/tool endpoints
│   │   ├── chat-group/     #   group orchestration + trigger engine
│   │   └── chat-agent/     #   bundle composition layer
│   └── ...                 # the rest of dsh
├── .dsh-home/              # dev-mode DSH_HOME (gitignored)
├── chat-agent-context/     # migration and design docs
└── docs/                   # upstream dsh docs
```

## Where data lives

Everything sits under `DSH_HOME` (`repo/.dsh-home` in dev mode); the Settings page can open it directly.

| Path | Contents |
|---|---|
| `storages/` | Structured data (companions, groups, model config), persisted as JSON |
| `workspace/agents/` | One directory per companion: work files + `memory/MEMORY.md` (long-term memory) |
| `workspace/groups/` | Group-shared work files |
| `sessions/` | Session event logs (zstd-compressed JSONL, append-only) |
| `skills/` | Installed skill packages |
| `logs/` | Runtime logs (`debug.log`) |
| `$HOME/chat-agent-images/` | Conversation image attachments (one directory per conversation, loadable by the webview) |

Sessions are an **append-only event log**. What you see as messages is a projection aggregated by turn/prompt — not database rows.

## Key conventions

| Item | Convention |
|---|---|
| Ports | backend `127.0.0.1:3180`, frontend dev server `localhost:1420` |
| Session id | private `private:{botId}`, group `{groupId}` |
| Message id | user `u-{seq}`, assistant `m-p{promptSeq}` |
| Model route id | `chat-{modelId}` |
| Credential ref | `CHAT_AGENT_MODEL_{ID uppercased}` |
| Companion id | `bot-{uuid}` |
| Clone naming | `{original}-{clone word}{index}`; the first clone carries no number |

## Development notes

- Plugins follow the Cordis contract: `export const name` / `inject` / `Config` / `apply(ctx, config)`
- `settings` and `credentials` must **not** go into the module-level `inject` (it deadlocks startup); inject them dynamically with `ctx.inject()`
- Calling `storageDomain.open` twice inside one plugin throws `json backend is closed` — share a single domain handle across all tables
- After changing `packages/chat/*`, re-run `tsdown` **and restart the host process**: the profile is a symlink, but already-loaded modules are not hot-replaced
- Message history paginates by cursor (`?before=<seq>`), not offset, so appending new messages never shifts the page
- The host has no i18n service, so localized strings needed by the backend (e.g. the clone suffix word) are passed in by the frontend

## Documentation index

Migration background, plugin responsibilities, event bridging and storage design are documented under [`chat-agent-context/`](chat-agent-context/):

| File | Contents |
|---|---|
| `00-overview.md` | Project overview and migration background |
| `01-backend-plugins.md` | Responsibilities and endpoints of the three chat plugins |
| `02-event-bridge.md` | Translating session events into frontend events |
| `03-workspace-sandbox.md` | Workspaces and sandboxing |
| `04-models-skills-tools.md` | Model, skill and tool mechanics |
| `05-frontend.md` | Frontend architecture |
| `06-storage.md` | Data storage layout |
| `07-pitfalls.md` | Pitfalls already hit |
| `08-milestones.md` | Milestones and backlog |

## License

This project follows the upstream DeepSeek Harness license; see [`LICENSE`](LICENSE).
