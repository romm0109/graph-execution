import { describe, expect, it } from "vitest";
import { DEFAULT_BOX, SPEC_BOX_KEY, clampBox, defaultBox, loadBox, nextWatch, saveBox, type SpecWatch } from "./specPane";

const spec = (path: string, mtimeMs: number) => ({ path, mtimeMs });

const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
};

describe("nextWatch", () => {
  it("the first answer sets the baseline to the newest mtime and opens nothing", () => {
    const r = nextWatch({}, [spec("docs/prd/a.md", 100), spec("docs/prd/b.md", 300)]);
    expect(r.open).toBeUndefined();
    expect(r.watch.baseline).toBe(300);
    expect(r.watch.latest).toEqual(spec("docs/prd/b.md", 300));
  });

  it("an empty first answer sets the baseline to 0, so the first spec written opens", () => {
    const first = nextWatch({}, []);
    expect(first).toEqual({ watch: { baseline: 0, latest: undefined } });
    expect(nextWatch(first.watch, [spec("docs/prd/new.md", 5)]).open).toBe("docs/prd/new.md");
  });

  it("opens the newest spec once its mtime passes the baseline, only once per change", () => {
    let w: SpecWatch = nextWatch({}, [spec("docs/prd/a.md", 100)]).watch;
    let r = nextWatch(w, [spec("docs/prd/a.md", 100)]);
    expect(r.open).toBeUndefined();
    r = nextWatch(r.watch, [spec("docs/prd/a.md", 200)]);
    expect(r.open).toBe("docs/prd/a.md");
    expect(r.watch.baseline).toBe(200);
    w = r.watch;
    r = nextWatch(w, [spec("docs/prd/a.md", 200)]);
    expect(r.open).toBeUndefined();
    // Another spec being written opens that one.
    r = nextWatch(r.watch, [spec("docs/prd/b.md", 250), spec("docs/prd/a.md", 200)]);
    expect(r.open).toBe("docs/prd/b.md");
  });

  it("a fresh watch (switching workspace) starts over with a baseline", () => {
    const r = nextWatch({}, [spec("docs/prd/z.md", 999)]);
    expect(r.open).toBeUndefined();
  });

  it("keeps the baseline when the newest spec is deleted", () => {
    const w = nextWatch({}, [spec("docs/prd/a.md", 100), spec("docs/prd/b.md", 300)]).watch;
    const r = nextWatch(w, [spec("docs/prd/a.md", 100)]);
    expect(r.open).toBeUndefined();
    expect(r.watch.baseline).toBe(300);
  });
});

describe("clampBox", () => {
  const view = { w: 1000, h: 600 };
  it("keeps a box that fits", () => {
    expect(clampBox({ x: 100, y: 50, w: 400, h: 300 }, view)).toEqual({ x: 100, y: 50, w: 400, h: 300 });
  });
  it("grows a box to 320×200 at least", () => {
    expect(clampBox({ x: 0, y: 0, w: 10, h: 10 }, view)).toEqual({ x: 0, y: 0, w: 320, h: 200 });
  });
  it("moves a box back inside the view", () => {
    expect(clampBox({ x: 900, y: 550, w: 400, h: 300 }, view)).toEqual({ x: 600, y: 300, w: 400, h: 300 });
    expect(clampBox({ x: -50, y: -20, w: 400, h: 300 }, view)).toEqual({ x: 0, y: 0, w: 400, h: 300 });
  });
  it("shrinks a box larger than the view, and fills a view smaller than the minimum", () => {
    expect(clampBox({ x: 10, y: 10, w: 2000, h: 2000 }, view)).toEqual({ x: 0, y: 0, w: 1000, h: 600 });
    expect(clampBox({ x: 10, y: 10, w: 400, h: 300 }, { w: 200, h: 150 })).toEqual({ x: 0, y: 0, w: 200, h: 150 });
  });
  it("the default box is on the right, 44 % wide and 70 % high, 16 px from the edges", () => {
    expect(defaultBox(view)).toEqual({ x: 1000 - 440 - 16, y: 16, w: 440, h: 420 });
    expect(defaultBox(view, 42)).toEqual({ x: 544, y: 58, w: 440, h: 420 });
    expect(DEFAULT_BOX).toEqual(defaultBox({ w: 1280, h: 800 }));
  });
});

describe("loadBox / saveBox", () => {
  it("round-trips the box", () => {
    const s = memory();
    saveBox({ x: 1, y: 2, w: 330, h: 240 }, s);
    expect(JSON.parse(s.m.get(SPEC_BOX_KEY)!)).toEqual({ x: 1, y: 2, w: 330, h: 240 });
    expect(loadBox(s)).toEqual({ x: 1, y: 2, w: 330, h: 240 });
  });
  it("bad JSON or a wrong shape gives no box (the default is used)", () => {
    for (const raw of ["{not json", "null", "[]", '{"x":1,"y":2,"w":"3","h":4}', '"box"']) {
      const s = memory();
      s.m.set(SPEC_BOX_KEY, raw);
      expect(loadBox(s)).toBeUndefined();
    }
    expect(loadBox(memory())).toBeUndefined();
    expect(loadBox(undefined)).toBeUndefined();
  });
  it("a throwing storage is ignored", () => {
    expect(() => saveBox(DEFAULT_BOX, { setItem: () => { throw new Error("quota"); } })).not.toThrow();
    expect(loadBox({ getItem: () => { throw new Error("denied"); } })).toBeUndefined();
  });
});
