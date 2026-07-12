# Pitolet

**Design web interfaces with real DOM and CSS, alongside your coding agent.**

[![Claude Code editing a Pitolet canvas live](marketing/gifs/pitolet-insert.gif)](pitolet-demo.mp4)

*Claude Code adds a section over MCP. You can watch the edit happen and undo it with ⌘Z. [Watch the 44-second demo.](pitolet-demo.mp4)*

Pitolet is a design tool for web interfaces. The canvas runs in the browser, so every layer uses real DOM and CSS: flexbox, grid, text wrapping, fonts, breakpoints, and interaction states. Exported code comes from that same document instead of a separate interpretation of it.

## Why Pitolet

| Figma | Pitolet |
|---|---|
| A separate layout model | Real flexbox and grid, rendered by the browser |
| Several frames for several widths | One frame with cascading breakpoint overrides |
| Interaction mockups and variants | Real `:hover`, `:focus`, and `:active` styles |
| Design-to-code translation | React, Tailwind, or HTML generated from the canvas document |
| Design files stored behind an API | Readable JSON files that can live in your repo |
| Agent access varies by tool and plan | Built-in read/write MCP with live, undoable edits |

## Quickstart

```bash
pnpm install
pnpm dev          # server on :4517, editor on :5173
```

Open http://localhost:5173. Pitolet creates a sample document in `./pitolet/`. It is ordinary JSON, so you can keep it in the repo and review it like any other file.

Production build:

```bash
pnpm build
node bin/pitolet.js    # serves the built editor + API + MCP on :4517
```

Or install the published CLI:

```bash
npm install -g pitolet
pitolet                # serves editor + API + MCP on :4517
```

## See it work

**Change one token; every bound element updates.**

![An agent recoloring a Pitolet document through its design tokens](marketing/gifs/pitolet-recolor.gif)

**Open the code panel; the same document is React and Tailwind.**

![A Pitolet document exported as React and Tailwind](marketing/gifs/pitolet-code.gif)

## Docker

Pre-built images are published to the GitHub Container Registry:

```bash
docker run -p 4517:4517 -v pitolet-data:/data \
  -e PITOLET_PASSWORD=change-me \
  ghcr.io/pitolet/pitolet
```

Documents persist in the `pitolet-data` volume (mounted at `/data`). To build the image yourself:

```bash
docker build -t pitolet .
docker run -p 4517:4517 -v pitolet-data:/data pitolet
```

## Connect your coding agent (MCP)

```bash
claude mcp add --transport http pitolet http://localhost:4517/mcp
```

Then, in Claude Code:

> *"In Pitolet, add a testimonial section to the Landing frame using the design tokens."*

### Import an existing site

Use the CLI when you already have a page and want it on the Pitolet canvas. Normal agent editing still happens over MCP. The import command runs locally, captures the page, and sends one responsive document to your own server or a cloud workspace:

```bash
# Self-hosted (no auth)
pitolet import http://localhost:3000 --to http://localhost:4517

# Pitolet Cloud (use a write-scoped agent token)
PITOLET_TOKEN=ptl_... pitolet import http://localhost:3000 \
  --to https://app.pitolet.com/w/your-workspace
```

By default, Pitolet captures the page at 375, 768, and 1440 pixels. The mobile styles become the base and wider layouts become breakpoint overrides. Images are copied into Pitolet. Regions it cannot edit safely—such as canvas, SVG, iframe, and video content—are kept as images and listed in the report.

Useful options:

```bash
pitolet import https://example.com/dashboard \
  --to http://localhost:4517 \
  --selector '#app' \
  --storage-state ./playwright-state.json \
  --wait-for '[data-ready=true]' \
  --report-dir ./import-report
```

The first import downloads a compatible Chromium build and caches it. Each run saves source, imported, and difference images for every width. The importer recreates appearance and responsive structure; it does not copy application logic, routing, event handlers, or live data.

Agent edits use the same validation and history as edits made in the UI. They appear on the open canvas, show a short highlight, and can be undone with ⌘Z.

**Read**: `list_documents`, `list_frames`, `get_node`, `get_selection`, `get_design_as_code`, `get_tokens`, `get_screenshot` (uses the open editor; falls back to headless Playwright if installed).
**Write**: `create_frame`, `insert_nodes`, `update_node`, `delete_nodes`, `set_tokens`, `set_selection`, `create_document`.
**Collaborate**: `add_comment` / `get_comments` / `resolve_comment`. The agent reads the notes you pin on nodes and can leave its own, threaded to the same node.
**Design system**: `import_design_system` merges your real `theme.css` / `globals.css` custom properties (colors, spacing, radius, shadows, fonts, type scale) into the document's tokens, so agent output uses your system rather than the defaults.
**Repo linking**: `export_project { annotate }` writes the project plus a `.pitolet-manifest.json` (per-file source frame + content hash) and, with `annotate`, stamps `data-pl-id` attributes and `// @pitolet` headers into the code. `check_drift` then reports, per file, whether the design changed, the file was hand-edited, both, or everything is in sync, so the agent knows what to reconcile.

`get_screenshot` without an open editor falls back to headless Chromium if Playwright is present (`pnpm add -D playwright && npx playwright install chromium`); it is a pure optional dependency, never required.

## The editor

- **Canvas**: infinite, 60fps pan/zoom (wheel pans, ⌘/pinch zooms, space-drag). Frames are artboards, and everything inside flows with real CSS.
- **Tools**: `V` select · `F` frame · `R` box · `T` text. Double-click to descend into a tree, double-click text to edit inline. Drag layers to reorder or reparent with live flex drop indicators, or drop image files straight onto the canvas.
- **Inspector**: Framer-style Stack vocabulary over real CSS. Direction, alignment, gap, padding/margin, sizing with `auto`/`fill`/`%`/`px`, typography (Google Fonts, variable weights), fills, gradients, borders, radius, shadows, opacity, overflow, absolute positioning. Every field can bind to a design token (◈).
- **Tokens**: colors, spacing, radius, type scale. Editing a token reflows the whole canvas live and re-emits as Tailwind `@theme` variables.
- **Components**: ⌘⌥K componentizes a subtree. Instances take variant props and per-node overrides, and codegen emits a real typed React component.
- **Breakpoints & states**: pick a context in the top bar (Base · sm · md · lg · xl · :hover…) and edits record into that layer. Duplicate a frame at 375px to see the cascade side by side.
- **Collaboration**: leave comments on any node, from the inspector Comments section or a canvas pin, and your coding agent reads them and can reply. The top bar shows an "Agent editing" badge, an activity feed of who changed what, and a document switcher for multiple `.pitolet.json` files.
- **Preview (⌘↩)**: the frame rendered from generated code in an iframe, so hover states and media queries are real.
- **Code panel (⌘J)**: live React+Tailwind or HTML+CSS for the selection, plus one-click full-project export (`theme.css`, `components/`, `frames/`).
- **⌘K**: command palette with everything above.

## Architecture

pnpm monorepo, TypeScript strict throughout:

```
packages/schema    the contract: flat node map, token-aware StyleDecl, zod validation,
                   style cascade (resolve.ts) and CSS emission (css.ts) — the single
                   source of style truth shared by canvas rendering AND codegen
packages/codegen   deterministic compiler → React+Tailwind v4 / HTML+CSS
                   (token utilities, scale snapping, arbitrary-value fallback)
packages/server    authoritative document store (validated Immer patches, monotonic revs),
                   WebSocket sync, disk persistence (.pitolet.json), asset store, MCP endpoint
packages/editor    React 19 SPA: DOM canvas (one transformed world container),
                   screen-space overlays, transient-rAF interactions (zero React
                   renders during drags), Zustand + patch-based undo/redo
packages/ui        Pitolet's own design system (dark, token-driven — dogfooded)
```

Editor pixels and generated code can't drift, because both derive from the same `resolveStyles` → `styleToCssProps` pipeline.

## Development

```bash
pnpm test        # vitest: schema, codegen (golden files), server (WS + MCP e2e), editor
pnpm typecheck   # strict TS across all packages
UPDATE_GOLDEN=1 pnpm vitest run --project codegen   # regenerate golden files intentionally
```

Documents live in `./pitolet/*.pitolet.json`. Edit them externally (git checkout, scripts, agents writing JSON) and the server hot-reloads every connected editor.

## Pitolet Cloud

[app.pitolet.com](https://app.pitolet.com) is the hosted version. It adds team workspaces, scoped agent tokens, read-only share links, and version history. Each workspace has a stable MCP endpoint, so your agent can connect without a local server or tunnel. The free tier is available without self-hosting; the cloud code lives in [apps/cloud](apps/cloud) under a commercial license.

The [pitolet.com](https://pitolet.com) landing page is a Pitolet document exported from [site/](site).

## License

Pitolet's core — everything under `packages/` — is licensed under [AGPL-3.0](LICENSE): free to use, self-host, and modify forever. If you run a modified version as a network service, the AGPL requires you to share your changes.

Code under `apps/cloud` (the hosted platform: accounts, billing, workspaces) is source-visible but commercially licensed — it may not be run in production except by the Pitolet maintainers.

Contributions require a one-time [CLA](CONTRIBUTING.md#contributor-license-agreement) so your work can ship in both editions.
