# Reddit posts (staggered across launch week, one per day)

Rules: each written for its subreddit, no cross-posting identical text, reply
to every comment in the first hours. Check each sub's self-promo rules the
day before posting.

---

## r/webdev

**Title:** I built an open-source design tool that exports React +
Tailwind instead of absolute-positioned divs

**Body:**

The design-to-code exporters I tried leaned heavily on absolute positioning.
Their output was hard to continue working on as a normal web page. I wanted a
canvas that used CSS layout from the start.

Pitolet does that. Frames use flexbox or grid, and interaction states are CSS
pseudo-classes. Breakpoint changes are stored as overrides on one frame. The
same style resolver is used by the canvas and code generator. Output is React
with Tailwind v4 or plain HTML with CSS.

Documents are human-readable JSON in your repo. There's also an MCP server so
coding agents can read and edit designs, which turned out to be the feature I
use most.

`npx pitolet` to try it locally (Node 22+). The core is AGPL. I'd like to know
where the codegen falls short of what you would write by hand. That is the bar
I'm trying to clear.

Repo: https://github.com/pitolet/pitolet

---

## r/ClaudeAI

**Title:** I gave Claude Code write access to a design canvas over MCP

**Body:**

I wanted Claude Code to edit the interface I was looking at, not a separate
mockup. Pitolet's MCP server lets it inspect the page and change nodes or
styles. It can also read comments attached to layers.

Agent changes appear on the open canvas and stay in the normal undo history. A
short glow shows which layers changed.

Setup is two commands:

    npx pitolet
    claude mcp add --transport http pitolet http://localhost:4517/mcp

Then ask it to add a section or change a token and watch the result appear.
There is a 44-second demo in the repo. The core is AGPL-3.0.

I'm interested in where this would fit into other people's agent workflows.

Repo: https://github.com/pitolet/pitolet

---

## r/selfhosted

**Title:** Pitolet – self-hosted design tool (AGPL), single container, files
are plain JSON

**Body:**

I built a web design tool and the self-hosted story is the one I actually
care about, so posting it here.

- One container:

  ```sh
  docker run -p 4517:4517 -v pitolet-data:/data \
    -e PITOLET_PASSWORD=change-me \
    ghcr.io/pitolet/pitolet
  ```

- Or no container at all: `npx pitolet`
- Documents are human-readable `*.pitolet.json` files in a directory you
  control. Back them up, git them, edit them with scripts. No database.
- Auth is a shared password (constant-time compare, HMAC session cookie),
  suitable for a homelab or a small team behind a reverse proxy.
- AGPL-3.0 core. The self-hosted build needs no Pitolet account or hosted
  Pitolet service.

What it is: a Figma-style canvas editor for web design where everything you
draw is real DOM/CSS, with code export (React + Tailwind or HTML/CSS) and an
MCP server so coding agents can read and edit documents.

Happy to answer deployment questions. Compose file and a full VPS runbook are
in the repo.

Repo: https://github.com/pitolet/pitolet
