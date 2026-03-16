# Github Personal Assistant

Mac-hosted personal developer assistant with a React web client, a Rust daemon, local SQLite metadata, and GitHub Copilot conversations powered through ACP.

This project is intentionally built as a **single-user daemon** running on your Mac. The frontend is a remote shell for that daemon, not a multi-tenant SaaS app.

## Workspace

- `apps/client` -- static React web client and PWA shell
- `apps/daemon` -- Rust + Axum backend that exposes the app API and talks to Copilot over ACP
- `packages/shared` -- shared TypeScript API shapes used by the client

## Current architecture

### Single-user daemon-owner model

The app is designed around one durable daemon owner.

- the daemon owns the durable data
- app auth controls access to the daemon
- app auth does **not** decide data ownership
- switching auth modes should not fork or hide history

### App auth and Copilot runtime auth are separate

These are different concerns:

- **app auth** = how the frontend is allowed to use the daemon
- **Copilot runtime auth** = how the daemon itself talks to Copilot

App auth currently supports:

- `local`
- `github-device`
- `github-oauth`

Copilot runtime auth currently supports:

- logged-in local Copilot/GitHub user on the Mac
- explicit GitHub token override
- external Copilot CLI URL when configured

For this product, `APP_AUTH_MODE=local` is the recommended default.

## Current capabilities

- Single-user local auth with automatic session bootstrap plus optional GitHub device/OAuth sign-in
- Backend-advertised auth capabilities via `/api/auth/capabilities`
- Durable SQLite-backed app metadata for sessions, projects, threads, preferences, and attachments
- ACP session history used as the source of truth for chat replay, reasoning, tool activity, and usage
- Streaming chat route with Copilot errors surfaced inline
- Model listing and Copilot status endpoints
- Copilot session inspection and deletion endpoints
- Local file attachments stored on the Mac host
- Hosted frontend default daemon URL injection for GitHub Pages
- Service-worker cache fingerprinting so old app shells are invalidated on deploy
- Forced PWA shell updates so fresh deployments take over immediately

## Data and state

There are two persistence layers in this setup.

### 1. App-owned metadata

The daemon stores app-owned data under `APP_SUPPORT_DIR`, which defaults to:

- macOS: `~/Library/Application Support/github-personal-assistant/`
- Linux: `${XDG_DATA_HOME:-~/.local/share}/github-personal-assistant/`
- Windows: `%APPDATA%/github-personal-assistant/`

Important paths include:

- `data/assistant.sqlite` -- projects, threads, preferences, auth sessions, and attachment metadata
- `media/` -- uploaded attachment files

### 2. Copilot runtime state

The daemon talks to Copilot through ACP (`copilot --acp --stdio`). Transcript history is replayed from ACP sessions when the client loads a thread, so the Copilot runtime remains the source of truth for message content while SQLite stores only app-owned metadata.

## API surface

The Rust daemon serves the routes the frontend depends on, including:

- `/api/health`
- `/api/auth/*`
- `/api/projects`
- `/api/threads`
- `/api/chat/stream`
- `/api/chat/abort`
- `/api/attachments`
- `/api/models`
- `/api/copilot/status`
- `/api/copilot/preferences`

## Getting started

1. Install dependencies for the web packages:

```bash
pnpm install
```

2. Copy the environment file and fill in the values you want to use:

```bash
cp .env.example .env
```

3. Configure the daemon:

```bash
# Single-user app auth
APP_AUTH_MODE=local
DAEMON_OWNER_LOGIN=daemon

# Optional GitHub app auth
# github-device needs GITHUB_CLIENT_ID
# github-oauth also needs GITHUB_CLIENT_SECRET and GITHUB_CALLBACK_URL
GITHUB_CLIENT_ID=...

# Optional Copilot runtime overrides
COPILOT_USE_LOGGED_IN_USER=true
COPILOT_CLI_URL=
COPILOT_GITHUB_TOKEN=

# Optional remote/client access helpers
PUBLIC_API_URL=
TAILSCALE_API_URL=
REMOTE_ACCESS_MODE=local
SERVICE_ACCESS_TOKEN=
CLIENT_DEFAULT_API_URL=
EXPO_PUBLIC_SERVICE_ACCESS_TOKEN=
```

4. Start the daemon:

```bash
HOST=0.0.0.0 cargo run --manifest-path apps/daemon/Cargo.toml
```

5. Start the web client:

```bash
pnpm dev:client:web
```

This starts a small local static dev server that rebuilds the client when files change.

## Notes and operational details

- For Copilot auth on a Mac daemon, the default path is the logged-in local Copilot/GitHub user (`COPILOT_USE_LOGGED_IN_USER=true`).
- `COPILOT_GITHUB_TOKEN` only overrides that behavior.
- `APP_AUTH_MODE=local` is the recommended default for this single-user daemon.
- The frontend negotiates auth with the backend and creates a local session automatically in local mode.
- For GitHub device-flow app auth, set `APP_AUTH_MODE=github-device` and `GITHUB_CLIENT_ID`.
- For redirect-based GitHub OAuth app auth, set `APP_AUTH_MODE=github-oauth` plus `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and `GITHUB_CALLBACK_URL`.
- For hosted frontends such as GitHub Pages, set the repository Actions variable `CLIENT_DEFAULT_API_URL` to your Tailscale HTTPS URL so first load points at the daemon instead of `localhost`.
- The client stores session tokens per daemon origin and auth config version, so switching daemon URLs or auth modes does not reuse stale sessions.
- `TAILSCALE_API_URL` is the preferred static remote URL for this setup.
- `REMOTE_ACCESS_MODE` controls how the daemon advertises itself in `/api/health` (`local`, `tailscale`, or `public`).
- For direct Tailscale access, run the daemon with `HOST=0.0.0.0` and use `http://your-mac.tailnet-name.ts.net:4000`, or front it with `tailscale serve` for a stable HTTPS URL.

## GitHub Pages frontend

The React web client is exported statically and deployed to GitHub Pages. The workflow in `.github/workflows/deploy-pages.yml` builds `apps/client` and publishes it to Pages on every push to `main`.

The client is also configured as a PWA:

- the app shell is cached after first load
- the browser can install it like an app
- the app can detect when an update is waiting
- the UI can prompt the user to apply the update

For hosted frontends, the user can still override the daemon URL at runtime in connection settings without rebuilding the frontend.
