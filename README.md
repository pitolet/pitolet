# Pitolet

**Fix the interfaces your coding agent builds.**

[![Claude Code editing a Pitolet canvas live](marketing/gifs/pitolet-insert.gif)](pitolet-demo.mp4)

_Claude Code adds a section through MCP. The change appears on the canvas and can be undone with ⌘Z. [Watch the 44-second demo.](pitolet-demo.mp4)_

Pitolet opens an agent-built interface on a canvas where you can adjust it
directly. Your agent reads or edits the same document over MCP. The canvas
uses DOM and CSS.

Pitolet documents are readable JSON files that can live in your repo. Pitolet
exports them as React with Tailwind or plain HTML with CSS.

## What stays editable

Supported DOM remains editable on the canvas, including layout, type, colours,
breakpoints, and interaction states. Code export reads those values from the
document.

For a feature-by-feature comparison, see
[Pitolet vs Figma](https://pitolet.com/vs-figma/).

## Quickstart

```bash
pnpm install
pnpm dev          # server on :4517, editor on :5173
```

Open http://localhost:5173. The sample document is stored as JSON in
`./pitolet/`, where it can be committed with the rest of the project.

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

Editing a token updates every element bound to it.

![An agent recoloring a Pitolet document through its design tokens](marketing/gifs/pitolet-recolor.gif)

The code panel shows the React and Tailwind generated from the document.

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
docker run -p 4517:4517 -v pitolet-data:/data \
  -e PITOLET_PASSWORD=change-me \
  pitolet
```

## Connect an agent over MCP

Start Pitolet, then give this to your coding agent:

```text
Connect this project to Pitolet over MCP.

Endpoint: http://localhost:4517/mcp

No token is needed for this local server. Verify the connection by listing the Pitolet documents.
```

For manual setup:

```bash
# Codex
codex mcp add pitolet --url http://localhost:4517/mcp

# Claude Code
claude mcp add --transport http pitolet http://localhost:4517/mcp
```

Cursor users can add the same endpoint as a Streamable HTTP server in
`.cursor/mcp.json`.

Once it is connected, ask the agent to work in the open Pitolet document:

```text
Use Pitolet for this page: a settings page for my app.

Create a new Pitolet document with a clear name and build the page there. Keep it responsive. I want to edit it in Pitolet while you work.
```

For example, in Claude Code:

```text
In Pitolet, add a testimonial section to the Landing frame using the design tokens.
```

### Import an existing site

`pitolet import` captures a page on your machine and creates a Pitolet
document on a local server or cloud workspace. Use MCP for normal agent edits
after the import.

```bash
# Self-hosted (no auth)
pitolet import http://localhost:3000 --to http://localhost:4517

# Pitolet Cloud (use a write-scoped agent token)
PITOLET_TOKEN=ptl_... pitolet import http://localhost:3000 \
  --to https://app.pitolet.com/w/your-workspace
```

By default, Pitolet checks the page at 375, 768, and 1440 pixels. It uses the
mobile result as the base and stores wider layouts as breakpoint overrides.
Images are copied into Pitolet. Unsupported areas remain visible as image
nodes, and the report identifies each one. This applies to canvas, SVG,
iframes, video, and other content that Pitolet cannot edit safely.

Useful options:

```bash
pitolet import https://example.com/dashboard \
  --to http://localhost:4517 \
  --selector '#app' \
  --storage-state ./playwright-state.json \
  --wait-for '[data-ready=true]' \
  --report-dir ./import-report
```

The first import downloads and caches a compatible Chromium build. Each run
saves the source capture, the imported result, and a difference image for
every width. Import does not copy application logic, routing, event handlers,
or live data.

Agent edits use the same validation and history as edits made in the UI. They
appear on the open canvas with a short highlight and can be undone with ⌘Z.

### What agents can do

- Read documents with `list_documents`, `list_frames`, `get_node`,
  `get_selection`, `get_design_as_code`, `get_tokens`, and `get_screenshot`.
- Write with `create_frame`, `insert_nodes`, `update_node`, `delete_nodes`,
  `set_tokens`, `set_selection`, and `create_document`.
- Work with comments through `add_comment`, `get_comments`, and
  `resolve_comment`.
- Import CSS custom properties from `theme.css` or `globals.css` with
  `import_design_system`.
- Export a project and its `.pitolet-manifest.json` with `export_project`.
  `check_drift` reports whether each design or code file changed.

`get_screenshot` uses the open editor when one is available. Otherwise, it
uses the Chromium build cached by the import command. Screenshot requests do
not download a browser, so run an import first if Chromium is missing.

## The editor

- **Canvas and tools:** Wheel to pan, ⌘ or pinch to zoom, and hold Space to
  drag. `V` selects, `F` draws a frame, `R` draws a box, and `T` adds text.
- **Inspector and tokens:** Edit CSS layout and appearance from the inspector.
  Values can be linked to document tokens.
- **Breakpoints and states:** Choose a width or interaction state from the top
  bar. The selected frame updates to show it.
- **Components and comments:** Turn a subtree into a component with ⌘⌥K.
  Comments are attached to layers and shared with connected agents.
- **Preview and code:** Press ⌘↩ to preview generated code or ⌘J to inspect and
  export it. Press ⌘K for other commands.

## Architecture

Pitolet is a TypeScript pnpm workspace:

```
packages/schema    document types, validation, and style resolution
packages/codegen   React/Tailwind and HTML/CSS code generation
packages/server    document storage, WebSocket sync, assets, and MCP
packages/editor    React canvas, inspector, and undo history
packages/ui        shared UI components
```

Canvas rendering and code generation both call `resolveStyles` before
`styleToCssProps`.

## Development

```bash
pnpm test        # vitest: schema, codegen (golden files), server (WS + MCP e2e), editor
pnpm lint        # ESLint: TypeScript correctness and React hook rules
pnpm audit:prod  # production dependency advisories
pnpm typecheck   # strict TS across all packages
pnpm format:check
pnpm build
pnpm check:site  # generated landing files match site/build.ts
pnpm qa:site     # responsive screenshots, internal links, and axe
pnpm qa:editor   # production editor edit/persistence flow and axe
pnpm check:package # install and boot the exact npm tarball
UPDATE_GOLDEN=1 pnpm vitest run --project codegen   # regenerate golden files intentionally
```

Documents live in `./pitolet/*.pitolet.json`. The server watches that directory
and reloads connected editors when a file changes.

## Pitolet Cloud

[app.pitolet.com](https://app.pitolet.com) is the hosted version. It provides
team workspaces, scoped agent tokens, read-only share links, and version
history. Each workspace has its own MCP endpoint, so an agent can connect
without a local server or tunnel. The cloud code lives in
[apps/cloud](apps/cloud) under a commercial license.

The [pitolet.com](https://pitolet.com) landing page is a Pitolet document exported from [site/](site).

## License

Everything under `packages/` is licensed under [AGPL-3.0](LICENSE). You may
use, self-host, and modify it. If you run a modified version as a network
service, the AGPL requires you to make those changes available.

Code under `apps/cloud` is source-visible and commercially licensed. Only the
Pitolet maintainers may run it in production.

Contributors sign a one-time
[CLA](CONTRIBUTING.md#contributor-license-agreement) because changes to the
core are used in both editions.
