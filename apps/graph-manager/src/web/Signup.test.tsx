// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import SetPassword from "./pages/SetPassword";
import Signup from "./pages/Signup";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.pushState({}, "", "/");
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function stubFetch(answer: () => Response) {
  const fetchMock = vi.fn(async (url: string) => (url === "/api/auth/info" ? json({ host: "dev-vm-01", signup: true }) : answer()));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function fill(fields: Record<string, string>) {
  for (const [label, value] of Object.entries(fields)) fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

describe("Signup", () => {
  it("checks that the passwords match before sending", async () => {
    const fetchMock = stubFetch(() => new Response(null, { status: 204 }));
    render(<Signup onLogin={() => {}} />);
    expect(screen.getByTestId("page-signup")).toBeTruthy();
    fill({ Username: "alice", Password: "alice-secret", "Repeat password": "alice-secreT" });
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Passwords don't match.");
    expect(fetchMock.mock.calls.some(([u]) => u === "/api/auth/signup")).toBe(false);
  });

  it("shows the server's error", async () => {
    stubFetch(() => json({ error: "username taken" }, 409));
    const onLogin = vi.fn();
    render(<Signup onLogin={onLogin} />);
    fill({ Username: "alice", Password: "alice-secret", "Repeat password": "alice-secret" });
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect((await screen.findByRole("alert")).textContent).toBe("username taken");
    expect(onLogin).not.toHaveBeenCalled();
  });

  it("signs up and calls onLogin", async () => {
    const fetchMock = stubFetch(() => new Response(null, { status: 204 }));
    const onLogin = vi.fn();
    render(<Signup onLogin={onLogin} />);
    fill({ Username: "alice", "Display name": "Alice", Password: "alice-secret", "Repeat password": "alice-secret" });
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    await vi.waitFor(() => expect(onLogin).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/signup",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ username: "alice", displayName: "Alice", password: "alice-secret" }) }),
    );
  });
});

describe("SetPassword", () => {
  it("sends the token from the URL and calls onLogin", async () => {
    window.history.pushState({}, "", "/set-password?token=abc_123");
    const fetchMock = stubFetch(() => new Response(null, { status: 204 }));
    const onLogin = vi.fn();
    render(<SetPassword onLogin={onLogin} />);
    expect(screen.getByTestId("page-set-password")).toBeTruthy();
    fill({ Password: "dana-secret-1", "Repeat password": "dana-secret-1" });
    fireEvent.click(screen.getByRole("button", { name: "Set password" }));
    await vi.waitFor(() => expect(onLogin).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/set-password",
      expect.objectContaining({ body: JSON.stringify({ token: "abc_123", password: "dana-secret-1" }) }),
    );
  });

  it("explains an expired or used link", async () => {
    window.history.pushState({}, "", "/set-password?token=old");
    stubFetch(() => json({ error: "link expired or used" }, 400));
    render(<SetPassword onLogin={() => {}} />);
    fill({ Password: "dana-secret-1", "Repeat password": "dana-secret-1" });
    fireEvent.click(screen.getByRole("button", { name: "Set password" }));
    expect((await screen.findByRole("alert")).textContent).toBe("This link has expired or was already used. Ask for a new one.");
  });
});
