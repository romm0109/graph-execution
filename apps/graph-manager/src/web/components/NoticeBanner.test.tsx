// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NoticeBanner } from "./NoticeBanner";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function mockNotices(answer: () => Response) {
  const fetchMock = vi.fn(async (url: string) => (url === "/api/notices" ? answer() : json({ error: "nope" }, 404)));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const TEXT = "Your session on octo/hello was closed after 15 minutes idle. Changes were saved to branch gm/backup/abc.";

describe("NoticeBanner", () => {
  it("shows each notice and Dismiss hides it", async () => {
    const fetchMock = mockNotices(() =>
      json({
        notices: [
          { id: "n1", text: TEXT, createdAt: "2026-11-14T00:00:00Z" },
          { id: "n2", text: "Second notice", createdAt: "2026-11-14T00:00:01Z" },
        ],
      }),
    );
    render(<NoticeBanner />);
    await waitFor(() => expect(screen.getAllByTestId("notice-banner")).toHaveLength(2));
    expect(fetchMock).toHaveBeenCalledWith("/api/notices", expect.anything());
    const first = screen.getAllByTestId("notice-banner")[0]!;
    expect(first.getAttribute("role")).toBe("status");
    expect(first.textContent).toContain(TEXT);
    fireEvent.click(screen.getAllByRole("button", { name: "Dismiss" })[0]!);
    expect(screen.queryByText(TEXT)).toBeNull();
    expect(screen.getAllByTestId("notice-banner")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId("notice-banner")).toBeNull();
  });

  it("renders nothing without notices", async () => {
    const fetchMock = mockNotices(() => json({ notices: [] }));
    const { container } = render(<NoticeBanner />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 10));
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing when the request fails or the answer has no array", async () => {
    mockNotices(() => json({ error: "nope" }, 500));
    const failed = render(<NoticeBanner />);
    await new Promise((r) => setTimeout(r, 10));
    expect(failed.container.innerHTML).toBe("");
    cleanup();
    mockNotices(() => json({ notices: "x" }));
    const odd = render(<NoticeBanner />);
    await new Promise((r) => setTimeout(r, 10));
    expect(odd.container.innerHTML).toBe("");
  });
});
