// This page is served from two different hosts depending on who's loading
// it: a human's own browser opens http://localhost:5173 (backend reachable
// at localhost:3000, via Docker's published port), while the Playwright
// suite's headless browser runs INSIDE the workbench container and
// navigates to http://frontend:5173 (the compose network's own service
// name) — from there, "localhost" is the workbench container's own
// loopback, not the app container, so a hardcoded localhost:3000 silently
// fails every fetch. Derive the backend host from whichever hostname this
// page was actually loaded from, same "rewrite to compose service names"
// idea admin/server.ts's discovery route already applies to descriptor URLs
// for the identical reason.
//
// "backend", not "app": Chrome silently tries to upgrade a bare hostname
// "app" to HTTPS with no fallback, because "app" is also a real, Google-
// owned gTLD that's HSTS-preloaded at the registry level — it doesn't know
// this is just a local compose service name. "backend" is docker-
// compose.yml's network alias for the exact same app container, added
// specifically to dodge this collision.
const API_HOST = window.location.hostname === 'frontend' ? 'backend' : 'localhost';
const API_BASE_URL = `http://${API_HOST}:3000`;

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.message ?? `Request failed: ${res.status}`);
  }

  if (res.status === 204) return undefined as T;
  return res.json();
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, data: unknown) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(data) }),
  patch: <T>(path: string, data: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(data) }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};