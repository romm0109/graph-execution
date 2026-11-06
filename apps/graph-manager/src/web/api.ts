/** An HTTP error from the graph-manager API: the status and the server's `error` text. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly error: string,
  ) {
    super(error);
    this.name = "ApiError";
  }
}

export const LOGOUT_EVENT = "gm:logout";

/** Calls the API with JSON. Throws `ApiError` on a non-2xx answer; a 401 also dispatches `gm:logout` on window. */
export async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (!headers.has("accept")) headers.set("accept", "application/json");
  const res = await fetch(path, { credentials: "same-origin", ...init, headers });
  const text = await res.text();
  let body: unknown = undefined;
  if (text !== "") {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!res.ok) {
    if (res.status === 401) window.dispatchEvent(new Event(LOGOUT_EVENT));
    const message =
      body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
        ? (body as { error: string }).error
        : res.statusText || `HTTP ${res.status}`;
    throw new ApiError(res.status, message);
  }
  return body as T;
}

/** `api` with a JSON body. */
export function post<T = unknown>(path: string, body?: unknown, method = "POST"): Promise<T> {
  return api<T>(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
}
