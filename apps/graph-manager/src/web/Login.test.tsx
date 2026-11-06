// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import Login from "./pages/Login";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Login", () => {
  it("renders the form", () => {
    render(<Login onLogin={() => {}} />);
    expect(screen.getByLabelText("Password")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Log in" })).toBeTruthy();
  });

  it("shows an error on 401", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "wrong password" }), { status: 401, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const onLogin = vi.fn();
    render(<Login onLogin={onLogin} />);
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "nope" } });
    fireEvent.click(screen.getByRole("button", { name: "Log in" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Wrong password.");
    expect(onLogin).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/login", expect.objectContaining({ method: "POST", body: JSON.stringify({ password: "nope" }) }));
  });

  it("calls onLogin on success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    const onLogin = vi.fn();
    render(<Login onLogin={onLogin} />);
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "pw" } });
    fireEvent.click(screen.getByRole("button", { name: "Log in" }));
    await vi.waitFor(() => expect(onLogin).toHaveBeenCalled());
  });
});
