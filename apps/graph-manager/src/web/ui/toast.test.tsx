// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TOAST_MS, ToastProvider, useToast } from "./toast";

function Shower({ sticky, onDismiss }: { sticky?: boolean; onDismiss?: () => void }) {
  const toast = useToast();
  return (
    <button type="button" onClick={() => toast.show({ tone: "live", text: "hi", ...(sticky ? { sticky } : {}), ...(onDismiss ? { onDismiss } : {}) })}>
      show
    </button>
  );
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ToastProvider", () => {
  it("hides a toast after TOAST_MS", () => {
    vi.useFakeTimers();
    render(
      <ToastProvider>
        <Shower />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText("show"));
    expect(screen.getByText("hi")).toBeTruthy();
    expect(screen.queryByLabelText("Dismiss")).toBeNull();
    act(() => vi.advanceTimersByTime(TOAST_MS + 1));
    expect(screen.queryByText("hi")).toBeNull();
  });

  it("keeps a sticky toast until its × is pressed", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(
      <ToastProvider>
        <Shower sticky onDismiss={onDismiss} />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText("show"));
    act(() => vi.advanceTimersByTime(TOAST_MS * 10));
    expect(screen.getByText("hi")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Dismiss"));
    expect(screen.queryByText("hi")).toBeNull();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
