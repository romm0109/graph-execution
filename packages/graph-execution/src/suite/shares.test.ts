import { describe, expect, it } from "vitest";
import { initialShares } from "./shares.js";

describe("initialShares", () => {
  it("splits the cap evenly, remainder to the first features", () => {
    expect(initialShares(4, 2)).toEqual([2, 2]);
    expect(initialShares(4, 3)).toEqual([2, 1, 1]);
  });
  it("starts only `concurrency` features with share 1 when there are more features", () => {
    expect(initialShares(2, 3)).toEqual([1, 1]);
    expect(initialShares(1, 5)).toEqual([1]);
  });
});
