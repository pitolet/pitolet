# Contributing to Pitolet

## Dev setup

```bash
corepack enable          # pnpm 11 (pinned in package.json)
pnpm install
pnpm dev                 # server on :4517 + editor (Vite) on :5173
```

```bash
pnpm test                # vitest from the repo root: schema, codegen, server (WS + MCP e2e), editor
pnpm typecheck           # strict TS across all packages
UPDATE_GOLDEN=1 pnpm vitest run --project codegen   # regenerate golden files intentionally
```

Requires Node 22+.

## Conventions

- **TypeScript strict, everywhere.** No `any` escapes without a comment explaining why.
- **All document mutations flow through the patch pipeline**: `dispatchEdit` (editor) or `DocumentStore.applyRecipe` (server/MCP). Never mutate document state directly. The pipeline is what validates each change, broadcasts it, and makes it undoable.
- **`packages/schema/src/resolve.ts` + `css.ts` are the single source of style truth.** The canvas and the code generator both consume them, so editor pixels and generated code can't drift. Don't reimplement style semantics anywhere else.
- Match the surrounding code's idiom, naming, and comment density.

## Pull requests

- Tests green (`pnpm test`) and typecheck clean (`pnpm typecheck`).
- New behavior gets a test; golden-file changes are intentional and explained.
- UI changes include a screenshot.

## Contributor License Agreement

First-time contributors sign a CLA via the bot on their first PR. It takes one click and you won't be asked again. Pitolet is AGPL-3.0 open core with a commercially licensed cloud edition, and the CLA is what lets your contribution ship in both. Without it we couldn't accept changes to the core at all.
