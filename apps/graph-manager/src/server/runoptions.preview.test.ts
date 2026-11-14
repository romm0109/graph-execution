import { describe, expect, it } from "vitest";
import { commandPreview } from "../web/pages/StartRunDrawer";
import type { RunOptionsBody } from "../web/runOptions";
import { startArgs } from "./runoptions.js";

const words = (preview: string): string[] => preview.replace(/ \\\n/g, " ").split(/\s+/).filter(Boolean).slice(1);

describe("the Start run preview matches the server's argv", () => {
  const cases: RunOptionsBody[] = [
    {
      humanReview: true,
      merge: false,
      model: "opus",
      concurrency: 3,
      attempts: 2,
      fixPasses: 1,
      validationRounds: 4,
      validateAt: "task",
      validateParallel: false,
      idleTimeoutMinutes: 1.5,
      extraArgs: "--foo bar",
    },
    {},
    { humanReview: false, validateParallel: true, merge: true },
  ];
  for (const options of cases) {
    it(JSON.stringify(options), () => {
      expect(words(commandPreview("diamond", "spec.md", "fake", options))).toEqual(startArgs({ tasksDir: "diamond", spec: "spec.md", provider: "fake", options }));
    });
  }
});
