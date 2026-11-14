import { describe, expect, it } from "vitest";
import { countLine, defaultBranchName, repoOfWorkspace, repoPath, sessionLabel, stateLabel, workspacesFromSessions } from "./sessions";
import type { SessionInfo } from "./types";

const session = (over: Partial<SessionInfo> = {}): SessionInfo => ({
  id: "s1",
  repo: { forge: "github", owner: "octo", name: "hello" },
  workspaceId: "github~octo~hello",
  branch: "gm/admin-20261113-abcd",
  state: "live",
  startedAt: "2026-11-13T10:00:00Z",
  terminals: [],
  ...over,
});

describe("sessions helpers", () => {
  it("repoPath and sessionLabel", () => {
    expect(repoPath({ forge: "github", owner: "octo", name: "hello" })).toBe("octo/hello");
    expect(sessionLabel(session(), [])).toBe("octo/hello");
    expect(sessionLabel(session({ projectId: "p1" }), [{ id: "p1", name: "Platform" }])).toBe("Platform");
  });

  it("defaultBranchName uses the local date and 4 chars of [a-z0-9]", () => {
    const name = defaultBranchName("admin", new Date(2026, 10, 3, 23, 59));
    expect(name).toMatch(/^gm\/admin-20261103-[a-z0-9]{4}$/);
    expect(defaultBranchName("u", new Date(2026, 0, 1), () => 0)).toBe("gm/u-20260101-aaaa");
    expect(defaultBranchName("u", new Date(2026, 0, 1), () => 0.9999)).toBe("gm/u-20260101-9999");
  });

  it("stateLabel shows ending as saving", () => {
    expect(stateLabel("ending")).toBe("saving");
    expect(stateLabel("save-failed")).toBe("save-failed");
    expect(stateLabel("live")).toBe("live");
  });

  it("countLine only with a limit", () => {
    expect(countLine(2, 3)).toBe("2 of 3 repositories open");
    expect(countLine(2, null)).toBeUndefined();
  });

  it("workspacesFromSessions", () => {
    expect(workspacesFromSessions([session(), session({ id: "s2" })])).toEqual([
      { id: "github~octo~hello", forge: "github", fullPath: "octo/hello", path: "", branch: "gm/admin-20261113-abcd", dirty: false, remoteUrl: "", fromSession: true },
    ]);
  });

  it("repoOfWorkspace parses workspace ids", () => {
    expect(repoOfWorkspace("github~octo~hello")).toEqual({ forge: "github", owner: "octo", name: "hello" });
    expect(repoOfWorkspace("gitlab~g~sub~n")).toEqual({ forge: "gitlab", owner: "g/sub", name: "n" });
    expect(repoOfWorkspace("project~x")).toBeUndefined();
  });
});
