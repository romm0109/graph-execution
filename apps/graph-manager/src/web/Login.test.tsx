// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import Login from "./pages/Login";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** fetch: `/api/auth/info` answers `{ host }`, `/api/auth/login` answers `login()`. */
function stubFetch(login: () => Response, info: () => Response = () => json({ host: "dev-vm-01" })) {
  const fetchMock = vi.fn(async (url: string) => (url === "/api/auth/info" ? info() : login()));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("Login", () => {
  it("renders the form with the host from /api/auth/info", async () => {
    stubFetch(() => new Response(null, { status: 204 }));
    render(<Login onLogin={() => {}} />);
    expect(screen.getByTestId("page-login")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "graph-manager" })).toBeTruthy();
    expect(screen.getByLabelText("Admin password")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Log in" })).toBeTruthy();
    expect((await screen.findByTestId("login-host")).textContent).toBe("dev-vm-01");
    expect(screen.getByText("GM_PASSWORD")).toBeTruthy();
  });

  it("shows no host while /api/auth/info fails", async () => {
    const fetchMock = stubFetch(
      () => new Response(null, { status: 204 }),
      () => json({ error: "nope" }, 500),
    );
    render(<Login onLogin={() => {}} />);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/auth/info", expect.anything()));
    expect(screen.queryByTestId("login-host")).toBeNull();
  });

  it("shows an error on 401", async () => {
    const fetchMock = stubFetch(() => json({ error: "wrong password" }, 401));
    const onLogin = vi.fn();
    render(<Login onLogin={onLogin} />);
    fireEvent.change(screen.getByLabelText("Admin password"), { target: { value: "nope" } });
    fireEvent.click(screen.getByRole("button", { name: "Log in" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Wrong password.");
    expect(screen.getByLabelText("Admin password").getAttribute("aria-invalid")).toBe("true");
    expect(onLogin).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/login", expect.objectContaining({ method: "POST", body: JSON.stringify({ password: "nope" }) }));
  });

  it("shows the rate limit with Retry-After in minutes on 429", async () => {
    stubFetch(() => json({ error: "too many failed logins; try again later" }, 429, { "retry-after": "130" }));
    render(<Login onLogin={() => {}} />);
    fireEvent.change(screen.getByLabelText("Admin password"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Log in" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Too many attempts. Try again in 3 minutes.");
  });

  it("calls onLogin on success", async () => {
    stubFetch(() => new Response(null, { status: 204 }));
    const onLogin = vi.fn();
    render(<Login onLogin={onLogin} />);
    fireEvent.change(screen.getByLabelText("Admin password"), { target: { value: "pw" } });
    fireEvent.click(screen.getByRole("button", { name: "Log in" }));
    await vi.waitFor(() => expect(onLogin).toHaveBeenCalled());
  });
});
