import { describe, expect, it } from "vitest";
import { blockLabel, fromForm, idFromName, providerLabel, repoFileFor, toForm } from "./reviewers";

describe("reviewers helpers", () => {
  it("derives the repo file from the id", () => {
    expect(repoFileFor("security")).toBe("SECURITY_REVIEW.md");
    expect(repoFileFor("perf-check")).toBe("PERF_CHECK_REVIEW.md");
    expect(repoFileFor("")).toBe("NAME_REVIEW.md");
  });

  it("derives an id from a name", () => {
    expect(idFromName("Security review!")).toBe("security-review");
    expect(idFromName("  --Perf  Check--")).toBe("perf-check");
    expect(idFromName("a".repeat(40)).length).toBe(32);
  });

  it("drops empty provider, model and files and splits globs per line", () => {
    const f = {
      ...toForm(),
      id: "security",
      name: "Security",
      repoFile: "SECURITY_REVIEW.md",
    };
    const r = fromForm(f, true);
    expect(r).toEqual({
      id: "security",
      type: "diff",
      name: "Security",
      enabled: true,
      instructions: "",
      repoFile: "SECURITY_REVIEW.md",
      blockAt: "major",
    });
    expect("provider" in r || "model" in r || "files" in r).toBe(false);
    const g = fromForm(
      {
        ...f,
        provider: "codex",
        model: " o3 ",
        files: "src/**\n\n  !src/**/*.test.ts  \n",
      },
      true,
    );
    expect(g.files).toEqual(["src/**", "!src/**/*.test.ts"]);
    expect(g.provider).toBe("codex");
    expect(g.model).toBe("o3");
  });

  it("keeps the type of an edited reviewer and round-trips the form", () => {
    const tester = {
      id: "tester",
      type: "tester" as const,
      name: "Tester",
      enabled: true,
      instructions: "x",
      repoFile: "TESTER.md",
      files: ["a", "b"],
      blockAt: "blocker" as const,
    };
    expect(fromForm(toForm(tester), false)).toEqual(tester);
  });

  it("labels provider and block-at", () => {
    expect(providerLabel({})).toBe("run default");
    expect(providerLabel({ provider: "claude" })).toBe("claude");
    expect(providerLabel({ provider: "claude", model: "opus" })).toBe("claude · opus");
    expect(providerLabel({ model: "opus" })).toBe("run default · opus");
    expect(blockLabel.never).toBe("never blocks");
  });
});
