# Contributing to Pitolet

## Dev setup

```bash
corepack enable          # pnpm 11 (pinned in package.json)
pnpm install
pnpm dev                 # server on :4517 + editor (Vite) on :5173
```

```bash
pnpm test                # vitest from the repo root: schema, codegen, server (WS + MCP e2e), editor
pnpm lint                # ESLint over source, tests, scripts, and config
pnpm audit:prod          # fail on high/critical production advisories
pnpm typecheck           # strict TS across all packages
pnpm format:check        # Prettier check for source, tests, scripts, and workflows
pnpm build               # editor + publishable server package
pnpm check:site          # generated site files are current
pnpm qa:site             # landing/legal pages: screenshots, links, overflow, axe
pnpm qa:editor           # production editor: edit, sync, reload, and axe
pnpm check:package       # pack, install, import, and boot the npm artifact
UPDATE_GOLDEN=1 pnpm vitest run --project codegen   # regenerate golden files intentionally
```

Requires Node 22+.

## Conventions

- **TypeScript strict, everywhere.** No `any` escapes without a comment explaining why.
- Send every document change through `dispatchEdit` in the editor or
  `DocumentStore.applyRecipe` on the server. These paths validate, broadcast,
  and record changes for undo. Do not mutate document state directly.
- `packages/schema/src/resolve.ts` and `css.ts` define how styles resolve. The
  canvas and code generator both use them. Do not add another style
  implementation elsewhere.
- Match the surrounding code's idiom, naming, and comment density.

## Pull requests

- `pnpm verify` passes. Run `pnpm qa:site` too when the public site changes.
- New behavior gets a test; golden-file changes are intentional and explained.
- UI changes include a screenshot.

## Contributor License Agreement

First-time contributors sign the CLA through the bot on their first PR.
Pitolet uses the core in both its AGPL and cloud editions, so contributions
must be licensed for both.
