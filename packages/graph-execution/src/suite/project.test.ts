import { realpathSync } from "node:fs";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { addRepoTasks, withProject } from "../__fixtures__/suite.js";
import { loadProject, ProjectError } from "./project.js";

const link = (target: string, at: string): Promise<void> => symlink(target, at, process.platform === "win32" ? "junction" : "dir");
const writeManifest = (dir: string, repos: { name: string; path: string }[], name = "billing"): Promise<void> =>
  writeFile(path.join(dir, "project.json"), JSON.stringify({ name, repos }));
const problemsOf = async (dir: string): Promise<string[]> => {
  const err = await loadProject(dir).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ProjectError);
  return (err as ProjectError).problems;
};

describe("loadProject", () => {
  it("returns real paths, tasks and specs only for repos with tasks, and the test plan only when present", () =>
    withProject(["api", "web"], async (p) => {
      await addRepoTasks(p.dir, "api", ["api1"]);
      const project = await loadProject(p.dir);
      expect(project.dir).toBe(realpathSync.native(p.dir));
      expect(project.name).toBe("billing");
      expect(project.contract).toBe(path.join(p.dir, "contract.md"));
      expect(project.testPlan).toBeUndefined();
      expect(project.repos).toEqual([
        { name: "api", path: p.repos.api, tasksDir: path.join(p.dir, "tasks", "api"), spec: path.join(p.dir, "specs", "api.md") },
        { name: "web", path: p.repos.web },
      ]);
      await writeFile(
        path.join(p.dir, "test-plan.json"),
        JSON.stringify({ cases: [{ id: "P1", title: "works", steps: ["run it"], expected: "ok", priority: "must" }] }),
      );
      expect((await loadProject(p.dir)).testPlan).toBe(path.join(p.dir, "test-plan.json"));
    }));

  it("accepts an absolute repo path", () =>
    withProject(["api", "web"], async (p) => {
      await addRepoTasks(p.dir, "api", ["api1"]);
      await writeManifest(p.dir, [{ name: "api", path: p.repos.api! }, { name: "web", path: "repos/web" }]);
      expect((await loadProject(p.dir)).repos.map((r) => r.path)).toEqual([p.repos.api, p.repos.web]);
    }));

  it("refuses a project with one repo", () =>
    withProject(["api"], async (p) => {
      await addRepoTasks(p.dir, "api", ["api1"]);
      expect(await problemsOf(p.dir)).toContain("repos: at least 2 repos");
    }));

  it("refuses a bad name and duplicate names", () =>
    withProject(["api", "web"], async (p) => {
      await addRepoTasks(p.dir, "api", ["api1"]);
      await writeManifest(p.dir, [{ name: "a p i", path: "repos/api" }, { name: "web", path: "repos/web" }]);
      expect(await problemsOf(p.dir)).toContain("repos.0.name: use letters, digits, - and _");
      await writeManifest(p.dir, [{ name: "api", path: "repos/api" }, { name: "api", path: "repos/web" }]);
      expect(await problemsOf(p.dir)).toContain('repos.1.name: duplicate repo name "api"');
    }));

  it("reports a field error together with the repo checks it would hide", () =>
    withProject(["api", "web"], async (p) => {
      await addRepoTasks(p.dir, "api", ["api1"]);
      await writeManifest(p.dir, [{ name: "a pi", path: "repos/api" }, { name: "web", path: "nope" }], "bad name");
      const problems = await problemsOf(p.dir);
      expect(problems).toContain("name: use letters, digits, - and _");
      expect(problems).toContain("repos.0.name: use letters, digits, - and _");
      expect(problems).toContain("repos.1.path: nope does not exist");
      await writeManifest(p.dir, [{ name: "api", path: "repos/api" }, { name: "api", path: "repos/web" }], "bad name");
      expect(await problemsOf(p.dir)).toEqual(expect.arrayContaining(["name: use letters, digits, - and _", 'repos.1.name: duplicate repo name "api"']));
    }));

  it("refuses a path that does not exist, is not a git root, or is the project folder", () =>
    withProject(["api", "web"], async (p) => {
      await addRepoTasks(p.dir, "api", ["api1"]);
      await mkdir(path.join(p.repos.web!, "sub"));
      await writeManifest(p.dir, [
        { name: "api", path: "repos/nope" },
        { name: "web", path: "repos/web/sub" },
        { name: "self", path: "." },
      ]);
      const problems = await problemsOf(p.dir);
      expect(problems).toEqual(
        expect.arrayContaining([
          "repos.0.path: repos/nope does not exist",
          "repos.1.path: repos/web/sub is not the root of a git checkout",
          "repos.2.path: . is the project folder itself",
        ]),
      );
    }));

  it("refuses two entries that resolve to the same repo", () =>
    withProject(["api", "web"], async (p) => {
      await addRepoTasks(p.dir, "api", ["api1"]);
      await link(p.repos.api!, path.join(p.dir, "repos", "again"));
      await writeManifest(p.dir, [
        { name: "api", path: "repos/api" },
        { name: "web", path: "repos/web" },
        { name: "again", path: "repos/again" },
      ]);
      expect(await problemsOf(p.dir)).toEqual(["repos.2.path: repos/again is the same repo as api"]);
    }));

  it("refuses a missing contract, tasks without a spec and a task folder of no repo, all at once", () =>
    withProject(["api", "web"], async (p) => {
      await addRepoTasks(p.dir, "api", ["api1"]);
      await addRepoTasks(p.dir, "other", ["o1"]);
      await rm(path.join(p.dir, "specs", "api.md"));
      await rm(path.join(p.dir, "contract.md"));
      const err = await loadProject(p.dir).catch((e: unknown) => e as ProjectError);
      expect(err).toBeInstanceOf(ProjectError);
      expect((err as ProjectError).message).toMatch(/^Invalid project .*\/project\.json:\n {2}- /);
      expect((err as ProjectError).problems).toEqual(
        expect.arrayContaining([
          "specs/api.md is missing (tasks/api/ exists)",
          "contract.md is missing",
          "tasks/other/ matches no repo in project.json",
        ]),
      );
    }));

  it("refuses a project in which no repo has tasks", () =>
    withProject(["api", "web"], async (p) => {
      await expect(loadProject(p.dir)).rejects.toMatchObject({
        problems: ["no repo has a tasks/<name>/ folder: nothing to change"],
      });
    }));

  it("reports a bad test plan, a missing folder, a missing project.json and bad JSON", () =>
    withProject(["api", "web"], async (p) => {
      await addRepoTasks(p.dir, "api", ["api1"]);
      await writeFile(path.join(p.dir, "test-plan.json"), "{}");
      expect((await problemsOf(p.dir))[0]).toMatch(/^test-plan\.json: /);
      expect((await problemsOf(path.join(p.dir, "nope")))[0]).toMatch(/^project folder not found: /);
      expect((await problemsOf(p.repos.api!))[0]).toMatch(/^no project\.json in /);
      await writeFile(path.join(p.dir, "project.json"), "{");
      expect((await problemsOf(p.dir))[0]).toMatch(/^invalid JSON in project\.json: /);
    }));
});
