// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskGraph } from "./TaskGraph";

afterEach(() => cleanup());

const graph = {
  nodes: [
    { id: "1", title: "Base", status: "merged" },
    { id: "2", title: "A", status: "failed" },
    { id: "3", title: "B", status: "merged" },
    { id: "4", title: "Join", status: "pending" },
  ],
  edges: [
    ["1", "2"],
    ["1", "3"],
    ["2", "4"],
    ["3", "4"],
  ] as [string, string][],
  layers: [["1"], ["2", "3"], ["4"]],
};

describe("TaskGraph", () => {
  it("draws one curve per edge and puts the nodes in layer columns", () => {
    const { container } = render(<TaskGraph graph={graph} />);
    const paths = container.querySelectorAll("path.graph-edge");
    expect(paths).toHaveLength(4);
    for (const p of paths) expect(p.getAttribute("d")).toMatch(/^M[\d.]+ [\d.]+ C/);
    // The edge out of a failed task is drawn in the bad tone.
    expect(container.querySelector('path[data-from="2"]')?.getAttribute("class")).toContain("graph-edge-bad");
    expect(screen.getAllByText(/^LAYER \d$/).map((e) => e.textContent)).toEqual(["LAYER 0", "LAYER 1", "LAYER 2"]);
    const left = (id: string) => parseFloat(screen.getByTestId(`graph-node-${id}`).style.left);
    expect(left("1")).toBeLessThan(left("2"));
    expect(left("2")).toBe(left("3"));
    expect(left("3")).toBeLessThan(left("4"));
    expect(screen.getByTestId("graph-node-2").dataset.layer).toBe("1");
    expect(screen.getByTestId("graph-node-4").getAttribute("class")).toContain("status-pending");
  });

  it("takes the status from the task rows and reports clicks", () => {
    const onSelect = vi.fn();
    render(<TaskGraph graph={graph} tasks={[{ id: "4", title: "Join", status: "running", attempts: 1, deps: [] }]} onSelect={onSelect} compact />);
    expect(screen.getByTestId("graph-node-4").textContent).toContain("running");
    fireEvent.click(screen.getByTestId("graph-node-4"));
    expect(onSelect).toHaveBeenCalledWith("4");
  });
});
