# Newsletter submissions + reusable blurbs

## Console.dev (free listing — console.dev/submit)

- **Name:** Pitolet
- **What is it? (~10 words):** Open-source design tool with real DOM canvas
  and MCP agent editing.
- **Description (~50 words):** Pitolet is a design tool for web work. The
  canvas renders with the browser's layout engine, so designs are real
  flexbox/grid/hover and export as clean React + Tailwind. Documents are JSON
  in your repo. Coding agents connect over MCP and edit the canvas live,
  undoably. AGPL core, `npx pitolet`.
- **Why is it interesting?** Agent edits are live on the canvas, validated,
  and undoable, while the document itself remains real DOM/CSS that exports
  deterministically. The landing page is a Pitolet export, so the fidelity
  claim is verifiable.

## TLDR / general submission blurb (~25 words)

Pitolet: open-source design tool where the canvas is real DOM/CSS, files live
in git, and Claude Code edits designs live over MCP. `npx pitolet`.

## 50-word blurb

Pitolet is an open-source design tool for web work. Designs render with the
browser's own layout engine and export as clean React + Tailwind. Documents
are JSON in your repo. Coding agents connect over MCP to read and edit the
canvas live, undoable with ⌘Z. Free tier hosted, AGPL self-hosted.

## 100-word boilerplate (press/about)

Pitolet is an open-source design tool built for developers and AI coding
agents. Instead of approximating CSS the way traditional design tools do,
Pitolet's canvas renders with the browser's own layout engine: every element
is a real DOM node with real flexbox, grid, and hover states, and a
deterministic compiler exports the same document as React + Tailwind or plain
HTML/CSS. Documents are human-readable JSON files that live in a git repo.
Coding agents such as Claude Code connect over MCP to read designs, edit
them live on the canvas, and keep design and shipped code in sync. The core
is AGPL-3.0; a hosted version with team workspaces is available at
app.pitolet.com.

## MCP directory listing (Smithery / PulseMCP / Glama / mcp.so)

- **Name:** Pitolet
- **Category:** Design / Developer tools
- **Transport:** HTTP (`http://localhost:4517/mcp` locally; hosted endpoints
  per workspace on app.pitolet.com with scoped tokens)
- **Short description:** Read and write access to a live design canvas. 20
  tools: get_design_as_code, get_tokens, get_screenshot, insert_nodes,
  update_node, set_tokens, comments, project export with drift checking.
  Edits appear live in the open editor and are undoable.
- **Setup:** `npx pitolet` then
  `claude mcp add --transport http pitolet http://localhost:4517/mcp`
