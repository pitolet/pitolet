# Newsletter submissions and short descriptions

## Console.dev

- **Name:** Pitolet
- **What is it? (~10 words):** A visual editor for interfaces made by coding
  agents.
- **Description (~50 words):** Pitolet gives you a visual way to fix an
  interface made by a coding agent. The agent can keep editing over MCP while
  you work on the page. The canvas uses DOM and CSS, and it exports React with
  Tailwind or plain HTML with CSS. Run the AGPL core with `npx pitolet`.
- **Why is it interesting?** Agent changes appear on the open canvas and stay
  in the normal undo history. Pitolet files are readable JSON that can live in
  the same repo as the exported code.

## TLDR / general submission blurb (~25 words)

Pitolet is a visual editor for fixing interfaces made by coding agents. Claude
Code can keep editing the page over MCP. `npx pitolet`.

## 50-word blurb

Pitolet lets you fix an agent-built interface in a visual editor. Claude Code
can stay connected over MCP, and its changes appear on the canvas. Documents
are JSON files in your repo and export to React with Tailwind or plain HTML
with CSS. The core is AGPL-3.0.

## 100-word boilerplate (press/about)

Pitolet is a visual editor for interfaces made by coding agents. Open the page
on the canvas, adjust it yourself, and let the agent keep working over MCP.
Agent changes appear as they happen and can be undone in the editor. The
canvas uses DOM and CSS, and the document exports to React with Tailwind or
plain HTML with CSS. Pitolet files are readable JSON that can live in a git
repo. The core is AGPL-3.0. A hosted version is available at app.pitolet.com.

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
