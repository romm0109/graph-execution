// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialog, Drawer, EmptyState, ForgeChip, Icon, Progress, Segmented, SkeletonRows, StatusBadge, ToastProvider, useToast } from "./index";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("StatusBadge", () => {
  it("renders the tone, glyph and label", () => {
    const { container } = render(
      <>
        <StatusBadge kind="run" value="running" />
        <StatusBadge kind="task" value="pending" label="queued" />
        <StatusBadge kind="run" value="failed" />
      </>,
    );
    const badges = container.querySelectorAll(".badge");
    expect(badges[0]?.getAttribute("data-tone")).toBe("live");
    expect(badges[0]?.className).toBe("badge tone-live");
    expect(badges[0]?.textContent).toBe("running");
    expect(badges[0]?.querySelector("[data-glyph]")?.getAttribute("data-glyph")).toBe("pulse");
    expect(badges[1]?.getAttribute("data-tone")).toBe("mute");
    expect(badges[1]?.textContent).toBe("queued");
    expect(badges[2]?.getAttribute("data-tone")).toBe("bad");
    expect(badges[2]?.textContent).toBe("failed");
  });
});

describe("ConfirmDialog", () => {
  function Harness({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          open
        </button>
        <ConfirmDialog
          open={open}
          title="Delete workspace octo/hello?"
          body="This removes the clone."
          confirmLabel="Delete"
          tone="danger"
          onConfirm={onConfirm}
          onCancel={() => {
            onCancel();
            setOpen(false);
          }}
        />
      </>
    );
  }

  it("is a labelled modal dialog; Esc cancels and focus returns to the opener", () => {
    const onCancel = vi.fn();
    render(<Harness onConfirm={() => {}} onCancel={onCancel} />);
    const opener = screen.getByRole("button", { name: "open" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Delete workspace octo/hello?" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement?.textContent).toContain("Cancel");
    expect(screen.getByText("Esc").tagName).toBe("KBD");
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("calls onConfirm on its button and keeps Tab inside", () => {
    const onConfirm = vi.fn();
    render(<Harness onConfirm={onConfirm} onCancel={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "open" }));
    const confirm = screen.getByRole("button", { name: "Delete" });
    confirm.focus();
    fireEvent.keyDown(confirm, { key: "Tab" });
    expect(document.activeElement?.textContent).toContain("Cancel");
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

describe("Drawer", () => {
  it("closes on Esc and on its close button", () => {
    const onClose = vi.fn();
    render(
      <Drawer open title="Start run" onClose={onClose} footer={<button type="button">Start</button>}>
        <input aria-label="Spec" />
      </Drawer>,
    );
    expect(screen.getByRole("dialog", { name: "Start run" })).toBeTruthy();
    fireEvent.keyDown(document.body, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("renders the agent entrance and the badge when asked", () => {
    render(<Drawer open title="Start run" onClose={() => {}} entrance="agent" badge="x" testId="d" />);
    const d = screen.getByTestId("d");
    expect(d.classList.contains("drawer-agent")).toBe(true);
    expect(screen.getByTestId("drawer-badge").textContent).toBe("x");
  });

  it("has neither by default", () => {
    render(<Drawer open title="Start run" onClose={() => {}} testId="d" />);
    expect(screen.getByTestId("d").className).toBe("drawer");
    expect(screen.queryByTestId("drawer-badge")).toBeNull();
  });
});

describe("Segmented", () => {
  it("is a radiogroup and calls onChange", () => {
    const onChange = vi.fn();
    render(
      <Segmented
        ariaLabel="Provider"
        value="claude"
        onChange={onChange}
        options={[
          { value: "claude", label: "claude" },
          { value: "codex", label: "codex" },
        ]}
      />,
    );
    expect(screen.getByRole("radiogroup", { name: "Provider" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "claude" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("radio", { name: "codex" }));
    expect(onChange).toHaveBeenCalledWith("codex");
    fireEvent.keyDown(screen.getByRole("radio", { name: "claude" }), { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith("codex");
  });
});

describe("small components", () => {
  it("render", () => {
    const { container } = render(
      <>
        <ForgeChip forge="gitlab" />
        <SkeletonRows rows={3} />
        <EmptyState title="No runs yet" body="Start one." action={<button type="button">Start run</button>} />
        <Progress value={1.5} tone="ok" />
        <Icon name="logo" />
        <Icon name="runs" title="Runs" />
      </>,
    );
    expect(screen.getByText("GITLAB")).toBeTruthy();
    expect(container.querySelectorAll(".skeleton-row")).toHaveLength(3);
    expect(screen.getByText("No runs yet")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("100");
    expect(screen.getByRole("img", { name: "Runs" })).toBeTruthy();
  });
});

describe("toasts", () => {
  function Shower({ onAction }: { onAction?: () => void }) {
    const toast = useToast();
    return (
      <button type="button" onClick={() => toast.show({ tone: "ok", text: "Cloned octo/cli", action: { label: "Open terminal", to: "/terminals?workspace=1", onClick: onAction } })}>
        show
      </button>
    );
  }

  it("show() renders the text and the action, which navigates; it auto-dismisses after 6 s", () => {
    vi.useFakeTimers();
    const onAction = vi.fn();
    const onPop = vi.fn();
    window.addEventListener("popstate", onPop);
    render(
      <ToastProvider>
        <Shower onAction={onAction} />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "show" }));
    const toast = screen.getByRole("status");
    expect(toast.textContent).toContain("Cloned octo/cli");
    fireEvent.click(screen.getByRole("button", { name: "Open terminal" }));
    expect(onAction).toHaveBeenCalled();
    expect(window.location.pathname + window.location.search).toBe("/terminals?workspace=1");
    expect(onPop).toHaveBeenCalled();
    expect(screen.queryByRole("status")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "show" }));
    expect(screen.getByRole("status")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(6000);
    });
    expect(screen.queryByRole("status")).toBeNull();
    window.removeEventListener("popstate", onPop);
  });

  it("useToast outside a provider is a no-op", () => {
    render(<Shower />);
    expect(() => fireEvent.click(screen.getByRole("button", { name: "show" }))).not.toThrow();
  });
});
