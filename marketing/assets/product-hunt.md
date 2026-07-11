# Product Hunt listing

**Name:** Pitolet

**Tagline (≤60 chars):** Design in real DOM, ship React, let your agent edit

**Topics:** Design Tools, Developer Tools, Open Source, Artificial Intelligence

**Description (≤260 chars):**
Pitolet is an open-source design tool for web work. The canvas renders real
DOM and CSS, documents are JSON in your git repo, and coding agents like
Claude Code connect over MCP to read and edit designs live. Exports clean
React + Tailwind.

**Gallery:** lead with the demo video (voiceover version), then stills:
agent-glow insert moment, token recolor before/after, code panel, landing
page with "this page is a Pitolet document" callout.

**First comment (maker):**

Hi PH — solo builder here.

Pitolet started from two frustrations. Design tools approximate CSS, so
everything you draw has to be translated to code later, and the translation
is where fidelity dies. And now that coding agents do a lot of the building,
their design changes often land in a design-only model that still has to be
translated before it can ship.

So Pitolet renders the canvas with the browser's own layout engine (what you
draw is real flexbox, grid, hover states), and it ships an MCP server so your
coding agent works in the same document you do. The agent's edits appear on
your canvas as they happen, with a glow so you can see what it touched, and
⌘Z undoes them like any other edit. Design files are readable JSON that live
in your repo and diff in git.

The pitolet.com landing page is a Pitolet document exported by Pitolet's own
code generator — that's the fidelity claim, verifiable in the repo.

Free tier on the hosted version, $12/seat for teams, or self-host the
AGPL core with `npx pitolet`. I'll be here all day for questions.
