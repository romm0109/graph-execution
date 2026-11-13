import { describe, expect, it } from "vitest";
import { PROJECT_NAME, projectDirOf, projectIdOf, repoNamesOf } from "./projects.js";
import type { Workspace } from "./workspaces.js";

const ws = (rel: string): Workspace => {
  const parts = rel.split("/");
  return { id: parts.join("~"), path: `/ws/${rel}`, rel, forge: parts[0]!, fullPath: parts.slice(1).join("/") };
};

describe("project names", () => {
  it("makes the id from the name", () => {
    expect(projectIdOf("Billing_v2")).toBe("billing-v2");
    expect(projectIdOf("billing")).toBe("billing");
  });

  it("accepts letters, digits, - and _ only", () => {
    expect(PROJECT_NAME.test("Billing_v2-x")).toBe(true);
    for (const bad of ["", "bad name!", "a.b", "a~b", "a/b", "x".repeat(65)]) expect(PROJECT_NAME.test(bad)).toBe(false);
  });

  it("puts the folder under .projects", () => {
    expect(projectDirOf("/ws", "billing").replaceAll("\\", "/")).toMatch(/\/ws\/\.projects\/billing$/);
  });
});

describe("repoNamesOf", () => {
  it("numbers a clash in the order given", () => {
    const names = repoNamesOf([ws("github/octo/api"), ws("github/other/api"), ws("github/third/API")]);
    expect([...names]).toEqual([
      ["github~octo~api", "api"],
      ["github~other~api", "api-2"],
      ["github~third~API", "API-3"],
    ]);
  });

  it("replaces the characters the engine does not allow", () => {
    expect(repoNamesOf([ws("github/octo/my.app")]).get("github~octo~my.app")).toBe("my-app");
  });

  it("keeps the names given, and gives new ones around them", () => {
    const names = repoNamesOf(
      [ws("github/third/api"), ws("github/other/api"), ws("github/octo/api")],
      new Map([
        ["github~other~api", "api-2"],
        ["github~octo~api", "api"],
      ]),
    );
    expect(names.get("github~octo~api")).toBe("api");
    expect(names.get("github~other~api")).toBe("api-2");
    expect(names.get("github~third~api")).toBe("api-3");
  });
});
