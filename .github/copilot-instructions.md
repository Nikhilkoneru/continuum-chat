# Copilot Instructions for github-personal-assistant

## Deployment Checklist

After every code change, always complete these steps:

1. **Type-check web packages**: `pnpm exec tsc -p apps/client/tsconfig.build.json --noEmit` and `pnpm --filter @github-personal-assistant/shared typecheck`
2. **Build daemon**: `cargo build --manifest-path apps/daemon/Cargo.toml`
3. **Build client**: `node apps/client/scripts/build.mjs` -- this regenerates `dist/`, `service-worker.js`, and the build version hash
4. **Restart backend**: Kill old process on port 4000, then start `HOST=0.0.0.0 apps/daemon/target/debug/gpa-daemon`
5. **Verify backend**: `curl -s http://localhost:4000/api/health`
6. **Sync lockfile**: If `pnpm-lock.yaml` changed, regenerate with `npx pnpm@10.26.1 install` (CI uses pnpm 10.26.1; local may be pnpm 9 which produces incompatible lockfiles)
7. **Commit and push**: Always `git add -A && git commit && git push` -- this triggers GitHub Pages deployment via `.github/workflows/deploy-pages.yml`
8. **Verify deployment**: Check that the Pages workflow run completed successfully

**Never skip steps 3 and 7** -- the client must be rebuilt (for service worker version) and pushed (for Pages deployment) on every change.
**Always run step 6** when `pnpm-lock.yaml` is in the changeset -- CI will fail with `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH` otherwise.

## Architecture

- **Monorepo**: pnpm workspaces for the web packages plus a Rust daemon in `apps/daemon`
- **Backend**: Rust + Axum daemon. It talks to GitHub Copilot through ACP by spawning `copilot --acp --stdio`.
- **Client**: React SPA built with a custom `scripts/build.mjs` (no bundler). Served as static files from GitHub Pages.
- **Shared types**: `packages/shared/src/index.ts` -- TypeScript contract used by the client and mirrored by daemon JSON responses.
- **Database**: SQLite via `rusqlite`, stored under `APP_SUPPORT_DIR/data/assistant.sqlite`.
- **Copilot runtime**: ACP session history is the source of truth for transcript replay; SQLite stores app-owned metadata.

## Backend

- Runs on port 4000 (from `.env`)
- Must bind to `0.0.0.0` (not `127.0.0.1`) for Tailscale access: `HOST=0.0.0.0`
- Build command: `cargo build --manifest-path apps/daemon/Cargo.toml`
- Dev command: `cargo run --manifest-path apps/daemon/Cargo.toml`
- Start command after build: `HOST=0.0.0.0 apps/daemon/target/debug/gpa-daemon`
- Tailscale IP for this machine: check `tailscale status`

## Client / PWA

- Service worker version is a content hash generated at build time
- SW registration URL includes the version: `service-worker.js?v=HASH`
- `updateViaCache: 'none'` ensures browser always checks for a new worker
- Build version injected into `index.html` as `window.__GPA_BUILD_VERSION__`

## Key Patterns

- **Concurrent streaming**: Multiple chats can stream simultaneously (`streamingChatIds` is a `Set<string>`)
- **Hybrid persistence**: ACP sessions = source of truth for messages. SQLite = metadata only (threads, projects, attachments, preferences)
- **Thread detail hydration**: `GET /api/threads/:id` replays ACP session history and returns the full `ThreadDetail` payload expected by the client
