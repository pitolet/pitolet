# Reddit posts (staggered across launch week, one per day)

Rules: each written for its subreddit, no cross-posting identical text, reply
to every comment in the first hours. Check each sub's self-promo rules the
day before posting.

---

## r/webdev

**Title:** I built an open-source design tool that exports real React +
Tailwind instead of absolute-positioned divs

**Body:**

Every design-to-code exporter I tried produces the same thing: a pile of
absolutely positioned divs with magic numbers. The root cause isn't the
exporter, it's that the design tool's layout model only approximates CSS.

So I built Pitolet, which hands layout to the browser itself. You draw with
flexbox and grid directly, hover states are real CSS
pseudo-classes, and breakpoints are cascading overrides on one frame instead
of five hand-synced artboards. The code generator and the canvas renderer
read the same style-resolution code, so the export matches the canvas by
construction. Output is semantic React + Tailwind v4, or plain HTML/CSS.

Documents are human-readable JSON in your repo. There's also an MCP server so
coding agents can read and edit designs, which turned out to be the feature I
use most.

`npx pitolet` to try it locally (Node 22+). Core is AGPL. I'd honestly like
to know where the codegen falls short of what you'd write by hand — that's
the bar I'm trying to clear.

Repo: https://github.com/pitolet/pitolet

---

## r/ClaudeAI

**Title:** I gave Claude Code write access to a design canvas over MCP

**Body:**

I wanted the coding agent to work in the same shippable design artifact, so I
built my design tool with an MCP server where Claude Code is a full participant:
20 tools covering
read (design-as-code, tokens, screenshots), write (insert nodes, edit styles,
set tokens), and collaboration (it reads comments you pin on nodes and can
reply).

The part that makes it feel sane instead of scary: agent edits go through the
same validated patch pipeline as human edits. They show up live on the open
canvas with a glow on whatever the agent touched, there's an "Agent editing"
badge while it works, and ⌘Z reverts its changes like any other edit.

Setup is two commands:

    npx pitolet
    claude mcp add --transport http pitolet http://localhost:4517/mcp

Then things like "add a testimonials section to the Landing frame using our
design tokens" just work, and you watch it happen. 44-second video in the
repo. Open source (AGPL). Curious what workflows people would want here —
design review by agents? Agents keeping design and code in sync? (There's a
check_drift tool that diffs both.)

Repo: https://github.com/pitolet/pitolet

---

## r/selfhosted

**Title:** Pitolet – self-hosted design tool (AGPL), single container, files
are plain JSON

**Body:**

I built a web design tool and the self-hosted story is the one I actually
care about, so posting it here.

- One container: `docker run -p 4517:4517 -v pitolet-data:/data
  -e PITOLET_PASSWORD=change-me ghcr.io/pitolet/pitolet`
- Or no container at all: `npx pitolet`
- Documents are human-readable `*.pitolet.json` files in a directory you
  control. Back them up, git them, edit them with scripts. No database.
- Auth is a shared password (constant-time compare, HMAC session cookie),
  suitable for a homelab or a small team behind a reverse proxy.
- AGPL-3.0 core. There's a hosted version, but nothing in the self-hosted
  build phones home or needs an account.

What it is: a Figma-style canvas editor for web design where everything you
draw is real DOM/CSS, with code export (React + Tailwind or HTML/CSS) and an
MCP server so coding agents can read and edit documents.

Happy to answer deployment questions. Compose file and a full VPS runbook are
in the repo.

Repo: https://github.com/pitolet/pitolet
