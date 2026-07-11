# Show HN post

## Title (pick one, ≤80 chars)

1. Show HN: Pitolet – open-source design tool your coding agent can edit over MCP
2. Show HN: Pitolet – a design tool where the canvas is real DOM and agents can write to it
3. Show HN: I built a Figma alternative that Claude Code can edit live

Option 1 is the safest: names the category, the license, and the differentiator.

## Body

I've spent the last while building Pitolet, a design tool for web work. Two
things make it different from Figma and friends:

The canvas renders with the browser's own layout engine. Every element you
draw is a real DOM node with real CSS: actual flexbox and grid, real text
wrapping, real `:hover` states. Because the editor and the code generator both
read from the same style-resolution pipeline, what you see on the canvas and
the React + Tailwind (or plain HTML/CSS) it exports can't drift apart.

The second thing: coding agents are first-class users. Pitolet ships an MCP
server with 20 tools, so Claude Code (or any MCP client) can read the design
as code, inspect tokens, and also write: insert nodes, edit styles, change
tokens, leave comments. Agent edits go through the same validated patch
pipeline as human edits, show up live on the open canvas with a glow, and are
undoable with ⌘Z. Documents are human-readable JSON that lives in your repo
and diffs cleanly.

Try it: `npx pitolet` (Node 22+), or the Docker one-liner in the README.
There's a 44-second demo video in the repo showing Claude Code adding a
section and re-theming the doc.

The core is AGPL-3.0. There's a hosted version (app.pitolet.com) with a free
tier; that code is in the same repo under a commercial license. The
pitolet.com landing page is itself a Pitolet document exported by the codegen,
which is the closest thing I have to a fidelity proof.

Known gaps I'm working on: no multiplayer cursors between humans yet (agent
presence works), grid editing beyond column count is thin, and nested
component instances are limited. I'd genuinely like to hear where the codegen
output falls short of what you'd write by hand.

Repo: https://github.com/pitolet/pitolet

## Prepped answers (post these as replies, don't preload the body)

**Why AGPL?** So a cloud vendor can't take the core and sell it as a service
without contributing back. For self-hosters nothing changes: run it, modify
it, keep your changes private as long as you don't offer it as a service to
others.

**Why a CLA?** The cloud edition ships the same core under a commercial
license, and the CLA is what makes a contribution usable in both. One click on
the first PR. If that's a dealbreaker I understand, and the AGPL fork right
always exists.

**vs Penpot?** Penpot is a Figma-style editor that happens to be open source;
it still has the translate-to-code step. Pitolet's bet is different: designs
run in the browser from the first click, and the agent integration is the
primary workflow, not a plugin.

**vs Figma's MCP server?** Figma's remote MCP now reads and writes native
Figma content, which is good progress. Pitolet's distinction is the artifact:
the agent edits real DOM/CSS through the same validated, undoable pipeline
humans use, the file is readable JSON in your repo, and the same style pipeline
drives both the canvas and deterministic code export.

**Why not a Figma plugin?** The fidelity problem is structural. Figma's layout
model approximates CSS, so anything that exports code from it is translating
between two systems that don't quite line up. Starting from the DOM removes
the translation instead of improving it.

**Is my data locked in?** Documents are plain JSON files on disk
(`*.pitolet.json`), schema in `packages/schema`. Export to React/HTML at any
time. The hosted version can export everything too.
