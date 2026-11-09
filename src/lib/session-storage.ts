import type { Session } from "./types";
export const SESSION_KEY = "voice-lab-session-v1";
export function readSavedSession(): Session | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const value = JSON.parse(localStorage.getItem(SESSION_KEY) ?? "null");
    if (
      !value ||
      ![
        "accessToken",
        "refreshToken",
        "idToken",
        "clientId",
        "subject",
        "email",
      ].every((key) => typeof value[key] === "string" && value[key]) ||
      !Number.isFinite(value.expiresAt) ||
      !Array.isArray(value.scopes) ||
      !value.scopes.every((scope: unknown) => typeof scope === "string")
    )
      return null;
    return value as Session;
  } catch {
    return null;
  }
}
export function saveSession(session: Session | null) {
  if (
    typeof localStorage === "undefined" ||
    typeof localStorage.setItem !== "function"
  )
    return;
  if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  else localStorage.removeItem(SESSION_KEY);
}
