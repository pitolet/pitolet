# Show HN post

## Title

Show HN: Pitolet, a visual editor for interfaces made by coding agents

## Body

A coding agent would often get an interface close, but fixing the last visual
details was awkward. Another prompt could disturb parts that already worked,
and I did not want every small change to become a manual CSS edit.

I built Pitolet so I could open the result in a visual web editor. Claude Code
can stay connected over MCP, and its changes appear on the canvas as they
happen. They stay in the normal undo history.

The canvas itself is a web page. Layout uses CSS flexbox and grid, and
interaction states use CSS pseudo-classes. Pitolet exports React with Tailwind
or plain HTML with CSS from that document. Files are readable JSON and can
live in the repo beside the code.

Try it: `npx pitolet` (Node 22+), or the Docker one-liner in the README.
There's a 44-second demo video in the repo showing Claude Code adding a
section and changing a design token.

The core is AGPL-3.0. There's a hosted version (app.pitolet.com) with a free
tier; that code is in the same repo under a commercial license. The
pitolet.com landing page is a Pitolet document exported by the codegen, and
the source document sits beside the generated HTML in the repo.

The main gap is human multiplayer; there are no shared cursors yet. Grid
controls and nested component instances still need work. If the generated
code makes you rewrite something, please show me the case.

Repo: https://github.com/pitolet/pitolet

## Prepped answers (post these as replies, don't preload the body)

**Why AGPL?** If someone offers a modified core as a service, the AGPL
requires them to offer its users the corresponding source. Self-hosters can
run and modify it without publishing private changes unless they offer that
modified version as a service.

**Why a CLA?** The cloud edition uses the same core under a commercial
license. The CLA lets Pitolet accept a change for both editions. Contributors
sign it on their first PR. Anyone can still fork the AGPL core without signing.

**vs Penpot?** Penpot is a broad, open-source design platform. Pitolet has a
narrower focus on web interfaces made with coding agents. Its canvas uses DOM
and CSS, and MCP support is built into the server.

**vs Figma's MCP server?** Figma's remote MCP reads and writes native Figma
content. Pitolet agents edit a JSON document backed by DOM and CSS. Their
changes use the editor's undo history, and code export reads the same style
data as the canvas.

**Why not a Figma plugin?** A plugin would still translate from Figma's layout
model into CSS. Pitolet starts with DOM and CSS, so there is only one layout
system to maintain.

**Is my data locked in?** Documents are plain JSON files on disk
(`*.pitolet.json`), with the schema in `packages/schema`. The self-hosted
server exports complete React or HTML projects. The hosted editor can show and
copy generated React/Tailwind or HTML/CSS.
