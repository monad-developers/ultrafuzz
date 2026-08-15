export const DASHBOARD_SESSION_HEADER = "x-ultrafuzz-session";
export const DASHBOARD_SESSION_STORAGE_KEY = "ultrafuzz.dashboard.session";

const SESSION_TOKEN_PATTERN = /^[a-f0-9]{64}$/u;

export interface DashboardSessionLocation {
  hash: string;
  pathname: string;
  search: string;
}

/**
 * Consume the launch-only URL fragment without ever sending it to the server.
 * The fragment is removed from browser history and the token remains scoped to
 * this tab through sessionStorage so a refresh can reconnect.
 */
export function bootstrapDashboardSessionToken(
  location: DashboardSessionLocation = window.location,
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> = window.sessionStorage,
  replaceUrl: (url: string) => void = (url) => window.history.replaceState(null, "", url)
): string | null {
  const fragment = new URLSearchParams(location.hash.replace(/^#/u, ""));
  const launchedToken = fragment.get("session");
  if (location.hash !== "") replaceUrl(`${location.pathname}${location.search}`);

  if (launchedToken !== null) {
    if (!isDashboardSessionToken(launchedToken)) {
      safeRemove(storage);
      return null;
    }
    try {
      storage.setItem(DASHBOARD_SESSION_STORAGE_KEY, launchedToken);
    } catch {
      // The in-memory return value still authenticates this page load.
    }
    return launchedToken;
  }

  try {
    const stored = storage.getItem(DASHBOARD_SESSION_STORAGE_KEY);
    if (stored !== null && isDashboardSessionToken(stored)) return stored;
  } catch {
    return null;
  }
  safeRemove(storage);
  return null;
}

export function dashboardAuthenticatedHeaders(sessionToken: string, headers: HeadersInit = {}): Headers {
  if (!isDashboardSessionToken(sessionToken)) throw new Error("Dashboard session token is invalid.");
  const authenticated = new Headers(headers);
  authenticated.set(DASHBOARD_SESSION_HEADER, sessionToken);
  return authenticated;
}

export function isDashboardSessionToken(value: string): boolean {
  return SESSION_TOKEN_PATTERN.test(value);
}

function safeRemove(storage: Pick<Storage, "removeItem">): void {
  try {
    storage.removeItem(DASHBOARD_SESSION_STORAGE_KEY);
  } catch {
    // An unavailable storage backend does not weaken token validation.
  }
}
