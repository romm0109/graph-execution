import { describe, expect, it } from "vitest";
import { isSecretPath, parsePorcelainZ, selectSaveFiles } from "./secrets.js";

describe("session secrets", () => {
  it("skips secret files by basename", () => {
    for (const p of [".env", "config/.env.local", "certs/a.pem", "a.key", "~/.ssh/id_rsa", "id_rsa.pub"]) expect(isSecretPath(p), p).toBe(true);
    for (const p of ["src/env.ts", ".envrc", "README.md"]) expect(isSecretPath(p), p).toBe(false);
  });

  it("parses porcelain -z output, renames included", () => {
    const out = " M src/a.ts\0?? .env\0R  new name.ts\0old name.ts\0A  b.pem\0";
    expect(parsePorcelainZ(out)).toEqual(["src/a.ts", ".env", "new name.ts", "b.pem"]);
    expect(parsePorcelainZ("")).toEqual([]);
  });

  it("selects the files to stage", () => {
    expect(selectSaveFiles(["a.txt", ".env", "k.pem", "src/env.ts"])).toEqual({ add: ["a.txt", "src/env.ts"], skipped: [".env", "k.pem"] });
  });
});
