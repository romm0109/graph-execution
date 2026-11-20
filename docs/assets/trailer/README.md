# graph-execution trailer

Source of `docs/assets/graph-execution-trailer.mp4` (53 s, 1920×1080, 30 fps). Everything is drawn on a canvas, frame by frame, and the soundtrack is synthesized.

```bash
cd docs/assets/trailer
node music.js                                   # writes music.wav
node render.js ../graph-execution-trailer.mp4   # needs Playwright's Chromium and ffmpeg
```

Open `scene.html` in a browser to preview it live (`scene.html?t=20` starts at 20 s).
