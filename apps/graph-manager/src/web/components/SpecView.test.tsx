// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import mermaid from "mermaid";
import { SpecView } from "./SpecView";

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async (_id: string, src: string) => {
      if (src.includes("BROKEN")) throw new Error("Parse error");
      return { svg: '<svg data-testid="mmd"></svg>' };
    }),
  },
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const ok = "```mermaid\ngraph TD\nA-->B\n```\n";
const broken = "```mermaid\nBROKEN graph\n```\n";

describe("SpecView", () => {
  it("renders the markdown and draws a mermaid block", async () => {
    render(<SpecView text={`# Goals\n\n${ok}`} theme="light" />);
    expect(screen.getByRole("heading", { name: "Goals" })).toBeTruthy();
    await screen.findByTestId("mmd");
    expect(screen.getByTestId("spec-view").querySelector(".spec-mermaid-ok")).toBeTruthy();
  });

  it("shows an error for a broken block while the valid one still renders", async () => {
    render(<SpecView text={`${broken}\ntext\n\n${ok}`} theme="light" />);
    expect(await screen.findByText("Diagram error: Parse error")).toBeTruthy();
    await screen.findByTestId("mmd");
    expect(screen.getByText("BROKEN graph")).toBeTruthy();
  });

  it("initializes mermaid strictly with the dark theme", async () => {
    render(<SpecView text={ok} theme="dark" />);
    await screen.findByTestId("mmd");
    expect(mermaid.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ startOnLoad: false, securityLevel: "strict", theme: "dark" }),
    );
  });

  it("replaces the content when the text changes", async () => {
    const { rerender } = render(<SpecView text="# First" theme="light" />);
    expect(screen.getByRole("heading", { name: "First" })).toBeTruthy();
    rerender(<SpecView text={`# Second\n\n${ok}`} theme="light" />);
    expect(screen.queryByRole("heading", { name: "First" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Second" })).toBeTruthy();
    await screen.findByTestId("mmd");
    await waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(1));
  });
});
