# pitolet.com/vs-figma — page copy

Build this as a Pitolet document like the landing page (site/build.ts
pattern) so the page itself stays part of the pitch. Target keyword:
"figma alternative for developers".

---

## H1

Use Figma to draw. Use Pitolet to build for the web.

## Intro

Figma is excellent for general design work. Web interfaces are different: the
final layout lives in CSS. Pitolet starts there, using real DOM and CSS on the
canvas and exporting code from the same document.

## Comparison table

| | Figma | Pitolet |
|---|---|---|
| Layout | Auto layout, grid, and constraints in Figma's rendering model | Real flexbox and grid, rendered by the browser |
| Responsive design | Frames, variants, and responsive prototypes in the design model | One frame, cascading breakpoint overrides that emit media queries |
| Hover/focus states | Prototype interactions and component variants | Real `:hover` / `:focus` / `:active`, exported as CSS |
| Code output | Dev Mode, Code Connect, plugins, and agents translate the design model | Deterministic React + Tailwind v4, or plain HTML/CSS from the canvas style pipeline |
| File format | Proprietary, cloud-only | Readable JSON in your git repo |
| Coding agents | Remote MCP reads and writes; write is beta and client/seat dependent | Built-in read/write MCP with live, validated, undoable canvas edits |
| Design tokens | Styles/variables, exported via plugins | Tokens emit as Tailwind `@theme`; agents can edit them |
| Self-hosting | Not available | AGPL core: `npx pitolet` or one Docker container |
| Price for teams | Free starter; paid full design seats currently $16–$90/mo | Free tier · Pro $12/seat · self-host free |

Figma capabilities and USD pricing checked July 2026 against the official
[pricing page](https://www.figma.com/pricing/) and
[MCP documentation](https://developers.figma.com/docs/figma-mcp-server/).

## When Figma is still the better tool

Choose Figma for brand work, illustration, print, complex vector editing,
large multiplayer teams, or its plugin ecosystem. Pitolet has a narrower job:
designing interfaces that will become working web pages.

## How teams use it

- **Design engineers** design in the same primitives they ship: stacks,
  tokens, breakpoints. Export is a component, not a starting point.
- **AI-assisted teams** let Claude Code or Codex make the first pass
  (sections, variants, token sweeps) and review it on canvas, where every
  agent edit is visible and undoable.
- **Code review includes design.** Documents are JSON in the repo, so a
  design change is a diff next to the code it becomes, and `check_drift`
  flags when the two diverge.

## CTA block

Try it in one command: `npx pitolet` — or start free on app.pitolet.com.
The page you're reading is a Pitolet document, exported by Pitolet's
code generator. [See the source on GitHub]
