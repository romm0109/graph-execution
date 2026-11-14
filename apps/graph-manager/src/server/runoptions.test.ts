import { describe, expect, it } from "vitest";
import { ExtraArgsError, contentArgs, optionArgs, runOptionsSchema, splitExtraArgs, startArgs } from "./runoptions.js";

const base = { tasksDir: "diamond", spec: "spec.md", provider: "fake" };
const head = ["diamond", "--spec", "spec.md", "--provider", "fake"];

describe("optionArgs / startArgs", () => {
  it("sends no flag for absent options", () => {
    expect(optionArgs({})).toEqual([]);
    expect(startArgs(base)).toEqual([...head, "--web"]);
  });

  it("builds the KAN-89 acceptance example", () => {
    expect(startArgs({ ...base, options: { humanReview: true, merge: false, fixPasses: 2 } })).toEqual([
      ...head,
      "--no-merge",
      "--human-review",
      "--fix-passes",
      "2",
      "--web",
    ]);
  });

  it("puts every option in the fixed order, extra arguments last before --web", () => {
    const options = {
      merge: false,
      humanReview: false,
      model: "opus",
      concurrency: 5,
      attempts: 1,
      fixPasses: 0,
      validationRounds: 2,
      validateAt: "end" as const,
      validateParallel: false,
      idleTimeoutMinutes: 0.5,
      extraArgs: "--foo bar",
    };
    expect(startArgs({ ...base, options })).toEqual([
      ...head,
      ..."--no-merge --no-human-review --model opus --concurrency 5 --attempts 1 --fix-passes 0 --validation-rounds 2 --validate-at end --no-validate-parallel --idle-timeout 0.5 --foo bar --web".split(
        " ",
      ),
    ]);
  });

  it("sends nothing for merge: true and --validate-parallel for validateParallel: true", () => {
    expect(optionArgs({ merge: true })).toEqual([]);
    expect(optionArgs({ validateParallel: true })).toEqual(["--validate-parallel"]);
  });
});

describe("splitExtraArgs", () => {
  it("splits with shell-style quoting", () => {
    expect(splitExtraArgs("--model 'a b'")).toEqual(["--model", "a b"]);
    expect(splitExtraArgs("  ")).toEqual([]);
    expect(splitExtraArgs(undefined)).toEqual([]);
  });

  it.each([
    ["--web", "--web"],
    ["--spec x.md", "--spec"],
    ["--spec=x.md", "--spec"],
    ["--resume", "--resume"],
    ["--run x", "--run"],
    ["--provider claude", "--provider"],
    ["--web-serve", "--web-serve"],
    ["--help", "--help"],
    ["--sandbox", "--sandbox"],
    ["--reviewers r.json", "--reviewers"],
    ["other-tasks", "other-tasks"],
  ])("refuses %s", (value, name) => {
    expect(() => splitExtraArgs(value)).toThrow(ExtraArgsError);
    expect(() => splitExtraArgs(value)).toThrow(`extra arguments: ${name} is set by graph-manager`);
  });

  it("reports bad quoting as an ExtraArgsError", () => {
    expect(() => splitExtraArgs("'unterminated")).toThrow(ExtraArgsError);
    expect(() => splitExtraArgs("'unterminated")).toThrow("extra arguments: unterminated single quote");
  });
});

describe("runOptionsSchema", () => {
  it.each([{ nope: 1 }, { concurrency: 65 }, { attempts: 0 }, { fixPasses: -1 }, { idleTimeoutMinutes: -1 }, { validateAt: "sometimes" }, { model: "--web" }])(
    "refuses %j",
    (value) => {
      expect(runOptionsSchema.safeParse(value).success).toBe(false);
    },
  );

  it("accepts a valid set", () => {
    expect(runOptionsSchema.safeParse({ model: "claude-opus-5-5", idleTimeoutMinutes: 0.5 }).success).toBe(true);
  });
});

describe("contentArgs", () => {
  it("builds a start from content", () => {
    expect(contentArgs({ content: "/d/inputs/x/content.md", gate: "approve", provider: "fake" })).toEqual([
      "--content",
      "/d/inputs/x/content.md",
      "--provider",
      "fake",
      "--web",
    ]);
    expect(
      contentArgs({ content: "c.md", refs: "r.json", gate: "auto", provider: "claude", options: { model: "opus", extraArgs: "--attempts 2" } }),
    ).toEqual(["--content", "c.md", "--refs", "r.json", "--no-plan-gate", "--provider", "claude", "--model", "opus", "--attempts", "2", "--web"]);
  });

  it("refuses the plan flags in the extra arguments", () => {
    for (const flag of ["--content", "--refs", "--no-plan-gate", "--approve-plan", "--replan"]) {
      expect(() => splitExtraArgs(`${flag} x`)).toThrow(ExtraArgsError);
    }
  });
});
