# Demo video voiceover

Target: 44 seconds, with a short pause between each product beat.

- ElevenLabs voice ID: `Qggl4b0xRMiqOwhPtVWT`
- Model: `eleven_v3`
- Settings: natural stability `0.5`, similarity `0.75`, style `0`, speaker
  boost on; delivery is directed with inline emotion tags
- Generated narration: `../audio/pitolet-demo-voiceover.mp3` (27.56s)
- Final mux: `../../pitolet-demo.mp4`; the narration beats begin at 0.7s,
  7.5s, 18s, 27s, 32s, and 37s

## Music and sound design

- Music source: `chill1.wav` (first 44.47s, source file kept outside the repo)
- Music treatment: normalized to -25 LUFS before ducking, with a 1.5s fade-in
  and 2.47s fade-out
- Voice treatment: normalized to -16 LUFS; the music ducks automatically under
  every narration beat
- UI cues: soft tonal accents at 24s (insert), 29.5s (token update), and 36.8s
  (code reveal)
- Final audio: stereo AAC at 48kHz, -16.9 LUFS integrated, -3.9 dB true peak
- Existing baked-in callouts remain unchanged; no duplicate labels were added

> [warmly] Meet Pitolet — where design and code finally share the same canvas.
>
> [confident] Ask your coding agent for a change... and watch it appear live,
> using your real design system.
>
> [with quiet satisfaction] Change one token, and the whole page responds.
>
> [slightly excited] Then open the code: the design is already a working React
> interface.
>
> [assured] No handoff. No translation. Just one artifact, from first idea to
> production.
