import { describe, expect, it } from "vitest";
import { emptyForm, formErrors, formOf, optionLines, optionsOf, type RunOptionsForm } from "./runOptions";

const form = (patch: Partial<RunOptionsForm>): RunOptionsForm => ({ ...emptyForm(), ...patch });

describe("run options form", () => {
  it("accepts blanks and reports bad numbers and models", () => {
    expect(formErrors(emptyForm())).toEqual({});
    for (const c of ["0", "65", "1.5", "x", "1e2", "-1"]) expect(formErrors(form({ concurrency: c })).concurrency).toBe("Whole number from 1 to 64");
    expect(formErrors(form({ concurrency: " 64 " }))).toEqual({});
    expect(formErrors(form({ attempts: "0" })).attempts).toBe("Whole number, 1 or more");
    expect(formErrors(form({ fixPasses: "-1" })).fixPasses).toBe("Whole number, 0 or more");
    expect(formErrors(form({ fixPasses: "0", validationRounds: "0" }))).toEqual({});
    expect(formErrors(form({ validationRounds: "x" })).validationRounds).toBe("Whole number, 0 or more");
    expect(formErrors(form({ idleTimeout: "0.5" }))).toEqual({});
    expect(formErrors(form({ idleTimeout: "-1" })).idleTimeout).toBe("Number of minutes, 0 or more");
    expect(formErrors(form({ model: "--web" })).model).toBe("One word, not starting with -");
    expect(formErrors(form({ model: "a b" })).model).toBe("One word, not starting with -");
    expect(formErrors(form({ model: "opus" }))).toEqual({});
    expect(formErrors(form({ reviewModel: "--web" })).reviewModel).toBe("One word, not starting with -");
    expect(formErrors(form({ reviewModel: "o3", reviewProvider: "codex" }))).toEqual({});
  });

  it("sends only the set fields", () => {
    expect(optionsOf(emptyForm())).toEqual({});
    expect(
      optionsOf({
        humanReview: "off",
        merge: "off",
        model: " opus ",
        reviewProvider: "codex",
        reviewModel: " o3 ",
        concurrency: "4",
        attempts: "2",
        fixPasses: "0",
        validationRounds: "3",
        validateAt: "end",
        validateParallel: "on",
        idleTimeout: "1.5",
        extraArgs: " --foo bar ",
      }),
    ).toEqual({
      humanReview: false,
      merge: false,
      model: "opus",
      reviewProvider: "codex",
      reviewModel: "o3",
      concurrency: 4,
      attempts: 2,
      fixPasses: 0,
      validationRounds: 3,
      validateAt: "end",
      validateParallel: true,
      idleTimeoutMinutes: 1.5,
      extraArgs: "--foo bar",
    });
  });

  it("reads a saved options object, ignoring wrong types and unknown keys", () => {
    expect(formOf({ humanReview: true, merge: false, fixPasses: 2, junk: 1, attempts: "x" })).toEqual(
      form({ humanReview: "on", merge: "off", fixPasses: "2", attempts: "" }),
    );
    expect(formOf({ merge: true, validateAt: "end", validateAt2: "x", idleTimeoutMinutes: 3 })).toEqual(form({ validateAt: "end", idleTimeout: "3" }));
    expect(formOf({ reviewProvider: "codex", reviewModel: "o3" })).toEqual(form({ reviewProvider: "codex", reviewModel: "o3" }));
    expect(formOf({ reviewProvider: "nope", reviewModel: 3 })).toEqual(emptyForm());
    expect(formOf(undefined)).toEqual(emptyForm());
    expect(formOf("x")).toEqual(emptyForm());
  });

  it("prints one flag per line in the server's order", () => {
    expect(optionLines({ humanReview: true, merge: false, fixPasses: 2 })).toEqual(["--no-merge", "--human-review", "--fix-passes 2"]);
    expect(optionLines({ extraArgs: "  --a 'b c'  ", validateParallel: false })).toEqual(["--no-validate-parallel", "--a 'b c'"]);
    expect(optionLines({ concurrency: 2, reviewModel: "o3", model: "opus", reviewProvider: "codex" })).toEqual([
      "--model opus",
      "--review-provider codex",
      "--review-model o3",
      "--concurrency 2",
    ]);
    expect(optionLines({})).toEqual([]);
  });
});
