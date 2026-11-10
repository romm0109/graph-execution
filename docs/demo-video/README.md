# Demo video

`graph-execution-demo.mp4` (1920×1080, 30 fps, 85 s) shows what a run does: the task graph, parallel execution in worktrees merging into `graph/<run-id>`, and the review loop (validate → code reviewer + live tester → fixer → re-review → apply).

The numbers in it (durations, findings, line counts) are an illustrative run, not a benchmark.

The video is rendered from `demo.html`, a deterministic animation driven by `window.seek(t)`:

```bash
node docs/demo-video/render.mjs                       # writes docs/demo-video/graph-execution-demo.mp4 (needs Playwright + ffmpeg)
node docs/demo-video/render.mjs --stills 25,57 --dir /tmp/stills   # single frames for checking
```
