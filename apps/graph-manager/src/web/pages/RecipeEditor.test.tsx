// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SandboxRecipe, ToolchainInfo } from "../types";
import { PREVIEW_DEBOUNCE_MS, RecipeEditor } from "./RecipeEditor";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const TOOLCHAINS: ToolchainInfo[] = [
  { id: "python", name: "Python", snippet: "RUN apt-get install -y python3" },
  { id: "java", name: "Java", snippet: "RUN apt-get install -y default-jdk-headless" },
  { id: "go", name: "Go", snippet: "COPY --from=golang:1-bookworm /usr/local/go /usr/local/go" },
  { id: "rust", name: "Rust", snippet: "RUN curl https://sh.rustup.rs | sh" },
  { id: "ruby", name: "Ruby", snippet: "RUN apt-get install -y ruby-full" },
  { id: "php", name: "PHP", snippet: "RUN apt-get install -y php-cli" },
  { id: "cpp", name: "C/C++", snippet: "RUN apt-get install -y build-essential" },
];
const IDS = TOOLCHAINS.map((t) => t.id);
const DEFAULT_RECIPE: SandboxRecipe = {
  base: "node:24-bookworm",
  toolchains: TOOLCHAINS.map((t) => ({ id: t.id, enabled: false, snippet: t.snippet })),
  extraLines: "",
};

type Preview = { dockerfile: string; image: string; error?: string };

function stub(answer: (recipe: SandboxRecipe) => Preview = (r) => ({ dockerfile: `FROM ${r.base}`, image: "gm-sandbox:abc" })) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/sandbox/dockerfile" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { recipe: SandboxRecipe };
      return json(200, answer(body.recipe));
    }
    return json(404, { error: "not found" });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const previewCalls = (fetchMock: ReturnType<typeof stub>) =>
  fetchMock.mock.calls.filter(([u]) => u === "/api/sandbox/dockerfile").map(([, i]) => (JSON.parse(String(i?.body)) as { recipe: SandboxRecipe }).recipe);

/** The editor with its recipe held in state, like a parent form. `changes` records every `onChange`. */
function Harness({ initial = DEFAULT_RECIPE, changes }: { initial?: SandboxRecipe; changes: SandboxRecipe[] }) {
  const [recipe, setRecipe] = useState(initial);
  return (
    <RecipeEditor
      recipe={recipe}
      toolchains={TOOLCHAINS}
      onChange={(r) => {
        changes.push(r);
        setRecipe(r);
      }}
    />
  );
}

const el = <T extends HTMLElement = HTMLElement>(id: string) => screen.getByTestId(id) as T;
const rowIds = () => Array.from(el("recipe-toolchains").querySelectorAll("li")).map((li) => li.dataset.testid);

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("RecipeEditor", () => {
  it("renders the 7 toolchains in recipe order, all unchecked for the default", async () => {
    stub();
    render(<Harness changes={[]} />);
    expect(rowIds()).toEqual(IDS.map((id) => `toolchain-${id}`));
    for (const id of IDS) expect(el<HTMLInputElement>(`toolchain-${id}-enabled`).checked).toBe(false);
    expect(el("toolchain-cpp").textContent).toContain("C/C++");
    expect(el<HTMLInputElement>("recipe-base").value).toBe("node:24-bookworm");
    await waitFor(() => expect(el("recipe-dockerfile").textContent).toBe("FROM node:24-bookworm"));
  });

  it("ticking a box calls onChange with the toolchain enabled, without mutating the recipe", () => {
    stub();
    const changes: SandboxRecipe[] = [];
    const initial = structuredClone(DEFAULT_RECIPE);
    render(<Harness initial={initial} changes={changes} />);
    fireEvent.click(el("toolchain-python-enabled"));
    expect(changes).toHaveLength(1);
    expect(changes[0]?.toolchains.find((t) => t.id === "python")?.enabled).toBe(true);
    expect(changes[0]?.toolchains.filter((t) => t.enabled)).toHaveLength(1);
    expect(initial).toEqual(DEFAULT_RECIPE);
    expect(el<HTMLInputElement>("toolchain-python-enabled").checked).toBe(true);
  });

  it("an edited snippet shows `edited` and Reset to default restores it", () => {
    stub();
    const changes: SandboxRecipe[] = [];
    render(<Harness changes={changes} />);
    expect(screen.queryByTestId("toolchain-python-edited")).toBeNull();
    expect(el<HTMLButtonElement>("toolchain-python-reset").disabled).toBe(true);
    expect(screen.queryByTestId("toolchain-python-snippet")).toBeNull();
    fireEvent.click(el("toolchain-python-edit"));
    expect(el("toolchain-python-edit").getAttribute("aria-expanded")).toBe("true");
    fireEvent.change(el("toolchain-python-snippet"), { target: { value: "RUN apt-get install -y python3 python3-dev" } });
    expect(el("toolchain-python-edited").textContent).toBe("edited");
    expect(el<HTMLButtonElement>("toolchain-python-reset").disabled).toBe(false);
    fireEvent.click(el("toolchain-python-reset"));
    expect(changes.at(-1)?.toolchains[0]?.snippet).toBe(TOOLCHAINS[0]?.snippet);
    expect(screen.queryByTestId("toolchain-python-edited")).toBeNull();
    expect(el<HTMLButtonElement>("toolchain-python-reset").disabled).toBe(true);
    fireEvent.click(el("toolchain-python-edit"));
    expect(screen.queryByTestId("toolchain-python-snippet")).toBeNull();
  });

  it("Move up / Move down reorder the rows, are disabled at the ends and keep focus on the moved row", () => {
    stub();
    const changes: SandboxRecipe[] = [];
    render(<Harness changes={changes} />);
    expect(el<HTMLButtonElement>("toolchain-python-up").disabled).toBe(true);
    expect(el<HTMLButtonElement>("toolchain-cpp-down").disabled).toBe(true);
    expect(el("toolchain-rust-up").getAttribute("aria-label")).toBe("Move Rust up");
    el("toolchain-rust-up").focus();
    fireEvent.click(el("toolchain-rust-up"));
    expect(changes.at(-1)?.toolchains.map((t) => t.id)).toEqual(["python", "java", "rust", "go", "ruby", "php", "cpp"]);
    expect(rowIds()).toEqual(["python", "java", "rust", "go", "ruby", "php", "cpp"].map((id) => `toolchain-${id}`));
    expect(document.activeElement).toBe(el("toolchain-rust-up"));
    fireEvent.click(el("toolchain-php-down"));
    expect(rowIds().slice(-2)).toEqual(["toolchain-cpp", "toolchain-php"]);
    // php is now last: its Move down is disabled, so the focus falls back to its Move up.
    expect(el<HTMLButtonElement>("toolchain-php-down").disabled).toBe(true);
    expect(document.activeElement).toBe(el("toolchain-php-up"));
  });

  it("disables every control when disabled", () => {
    stub();
    render(<RecipeEditor recipe={DEFAULT_RECIPE} toolchains={TOOLCHAINS} onChange={() => {}} disabled />);
    expect(el<HTMLInputElement>("recipe-base").disabled).toBe(true);
    expect(el<HTMLTextAreaElement>("recipe-extra").disabled).toBe(true);
    for (const id of IDS) {
      for (const c of ["enabled", "edit", "reset", "up", "down"]) expect(el<HTMLButtonElement>(`toolchain-${id}-${c}`).disabled).toBe(true);
    }
  });

  it("previews once on mount, then once 300 ms after the last edit, and shows the error", async () => {
    const fetchMock = stub((r) => ({
      dockerfile: `FROM ${r.base}\n${r.extraLines}`,
      image: "gm-sandbox:abc",
      ...(r.toolchains[0]?.snippet.startsWith("FROM") ? { error: "toolchains.python: FROM is not allowed; use COPY --from=<image>" } : {}),
    }));
    render(<Harness changes={[]} />);
    await waitFor(() => expect(previewCalls(fetchMock)).toHaveLength(1));
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.click(el("toolchain-python-edit"));
    for (const v of ["F", "FR", "FRO", "FROM", "FROM ubuntu"]) {
      fireEvent.change(el("toolchain-python-snippet"), { target: { value: v } });
      act(() => vi.advanceTimersByTime(100));
    }
    expect(previewCalls(fetchMock)).toHaveLength(1);
    act(() => vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS));
    await waitFor(() => expect(previewCalls(fetchMock)).toHaveLength(2));
    expect(previewCalls(fetchMock)[1]?.toolchains[0]?.snippet).toBe("FROM ubuntu");
    await waitFor(() => expect(el("recipe-error").textContent).toBe("toolchains.python: FROM is not allowed; use COPY --from=<image>"));
    expect(el("recipe-dockerfile").textContent).toBe("FROM node:24-bookworm\n");
  });

  it("ignores a stale preview answer", async () => {
    const resolvers: ((r: Response) => void)[] = [];
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((resolve) => {
          const recipe = (JSON.parse(String(init?.body)) as { recipe: SandboxRecipe }).recipe;
          resolvers.push(() => resolve(json(200, { dockerfile: `FROM ${recipe.base}`, image: "x" })));
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<Harness changes={[]} />);
    fireEvent.change(el("recipe-base"), { target: { value: "node:22" } });
    act(() => vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS));
    expect(resolvers).toHaveLength(2);
    // The newer answer arrives first, then the mount's stale one.
    await act(async () => {
      resolvers[1]?.(json(200, {}));
      await Promise.resolve();
    });
    await waitFor(() => expect(el("recipe-dockerfile").textContent).toBe("FROM node:22"));
    await act(async () => {
      resolvers[0]?.(json(200, {}));
      await Promise.resolve();
    });
    expect(el("recipe-dockerfile").textContent).toBe("FROM node:22");
  });

  it("shows a failed preview request", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(500, { error: "boom" })),
    );
    render(<RecipeEditor recipe={DEFAULT_RECIPE} toolchains={TOOLCHAINS} onChange={() => {}} />);
    await waitFor(() => expect(el("recipe-error").textContent).toBe("Couldn't preview the Dockerfile: boom"));
  });
});
