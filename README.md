# Github Personal Assistant

Monorepo foundation for a fast, backend-managed GitHub Copilot experience with an Expo client and a Node API.

## Workspace

- `apps/client` — Expo app for web and Android
- `apps/api` — Express + TypeScript API prepared for GitHub OAuth and Copilot SDK sessions
- `packages/shared` — shared API and app types

## Getting started

1. Install dependencies:

```bash
pnpm install
```

2. Copy the environment file and fill in the GitHub OAuth values when you are ready:

```bash
cp .env.example .env
```

3. Start the API:

```bash
pnpm dev:api
```

4. Start the Expo app:

```bash
pnpm dev:client:web
```

For Android development, use:

```bash
pnpm dev:android
```

## Current capabilities

- Multi-project app shell
- Backend-managed model listing
- Streaming chat route with real Copilot errors surfaced inline
- GitHub device-flow sign-in foundation
- Shared session token flow between client and API
- Local file attachments stored on the Mac host
- PDF preprocessing with native text extraction plus OCR fallback for scanned/image-heavy PDFs
- Page-aware PDF context automatically injected into Copilot chat prompts

## Notes

- For real Copilot sessions, provide either `COPILOT_CLI_URL` or `COPILOT_GITHUB_TOKEN`.
- For GitHub device-flow sign-in, set `GITHUB_CLIENT_ID`. The secret and callback URL are only required if you also want the redirect-based OAuth flow.
- PDF preprocessing currently preserves page-level text and OCR output, but it is not yet fully layout-aware for complex tables, multi-column documents, or chart-heavy PDFs.
