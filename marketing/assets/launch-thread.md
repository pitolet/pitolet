# Launch thread (X / Bluesky)

Post after the Show HN is live. Attach the demo video to tweet 1. Tweets 3
and 4 each get a GIF cut from the video (insert-with-glow; token recolor).
Keep replies on; the whole point is conversations with the MCP/Claude crowd.

**1.**
I built Pitolet, an open-source design tool for web interfaces. Claude Code can edit the canvas with you.

It connects over MCP, edits land on your canvas live, and ⌘Z undoes them.

44-second demo: [video]

**2.**
The canvas renders with the browser's own layout engine. You draw real
flexbox, real grid, real :hover states.

That's why the React + Tailwind it exports matches the canvas: the editor
and the codegen read the same style pipeline. There is no translation step
to get wrong.

**3.**
Here's Claude Code adding a section to my landing page.

It reads the frame and the design tokens first, then inserts nodes through
the same validated patch pipeline human edits use. The glow shows what it
touched. [GIF]

**4.**
Design tokens are live. One set_tokens call from the agent and every bound
element re-styles: buttons, links, borders. [GIF]

**5.**
Design files are JSON in your git repo. They diff. Your agent can read them
in CI without any design-tool API, and a check_drift tool tells you when
design and shipped code have diverged.

**6.**
The pitolet.com landing page is a Pitolet document exported by Pitolet. You can inspect the source and the generated page in the repo.

**7.**
Core is AGPL-3.0 — self-host with `npx pitolet` or one Docker command.
Hosted version has a free tier, $12/seat for teams.

Repo: github.com/pitolet/pitolet
HN thread: [link]
