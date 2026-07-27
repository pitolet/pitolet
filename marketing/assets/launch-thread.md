# Launch thread (X / Bluesky)

Post after the Show HN is live. Attach the demo video to tweet 1. Tweets 3
and 4 each get a GIF cut from the video (insert-with-glow; token recolor).
Keep replies on; the whole point is conversations with the MCP/Claude crowd.

**1.**
I built Pitolet because tweaking an interface from Claude Code kept turning
into another prompt or a manual CSS edit.

Pitolet opens the result in a visual editor. Claude stays connected over MCP,
and ⌘Z undoes its changes.

44-second demo: [video]

**2.**
The canvas is a web page. Its layout uses CSS flexbox and grid, and the hover
states are CSS too. Pitolet exports React and Tailwind from that document.

**3.**
Here's Claude Code adding a section to my landing page.

The change appears on the canvas while Claude works. The glow shows what it
touched. [GIF]

**4.**
Claude can edit design tokens too. Here, one colour change updates every
linked element. [GIF]

**5.**
Pitolet files are readable JSON, so they can sit next to the code in git.
`check_drift` reports when the document and exported project no longer match.

**6.**
The pitolet.com landing page is a Pitolet document exported by Pitolet. You can inspect the source and the generated page in the repo.

**7.**
The core is AGPL-3.0. Self-host it with `npx pitolet` or Docker.
Hosted version has a free tier, $12/seat for teams.

Repo: github.com/pitolet/pitolet
HN thread: [link]
