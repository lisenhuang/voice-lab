import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Session } from "./types";

export const ORIGIN = "http://127.0.0.1:1455";
export const ISSUER = "https://auth.openai.com";
export const RESOURCE = "https://api.openai.com/v1";
export const REDIRECT = `${ORIGIN}/auth/callback`;
export const COOKIE = "voice_lab_login";
export const SCOPES =
  "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
export type Transaction = {
  state: string;
  verifier: string;
  nonce: string;
  clientId?: string;
  subject?: string;
  created: number;
};
// Ephemeral, one-time transactions only. No subscription tokens are retained here.
export type LoginResult = { session?: Session; error?: string };
const globalStore = globalThis as typeof globalThis & {
  voiceTransactions?: Map<string, Transaction>;
  voiceResults?: Map<string, LoginResult>;
};
export const transactions = (globalStore.voiceTransactions ??= new Map());
const results = (globalStore.voiceResults ??= new Map());
export function finishLogin(id: string, result: LoginResult) {
  if (!id) return;
  results.set(id, result);
  setTimeout(() => results.delete(id), 120_000).unref();
}
export function takeLoginResult(id: string) {
  const result = results.get(id);
  results.delete(id);
  return result;
}
export function cancelLogin(id: string) {
  transactions.delete(id);
  results.delete(id);
}
const random = () => randomBytes(32).toString("base64url");
export function constantEqual(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function begin(
  hostId: string,
  registration?: { clientId: string; subject: string },
) {
  if (!/^urn:uuid:[0-9a-f-]{36}$/i.test(hostId))
    throw new Error("Invalid host identifier.");
  if (
    registration &&
    (!/^oaiapp_[a-zA-Z0-9_-]+$/.test(registration.clientId) ||
      !registration.subject)
  )
    throw new Error("Invalid saved registration.");
  for (const [key, t] of transactions)
    if (Date.now() - t.created > 600_000) transactions.delete(key);
  if (transactions.size > 100)
    throw new Error("Too many sign-in attempts. Please wait.");
  const id = random();
  const t: Transaction = {
    state: random(),
    nonce: random(),
    verifier: random(),
    created: Date.now(),
    clientId: registration?.clientId,
    subject: registration?.subject,
  };
  transactions.set(id, t);
  setTimeout(() => transactions.delete(id), 600_000).unref();
  const url = new URL(`${ISSUER}/api/accounts/authorize`);
  const params: Record<string, string> = {
    client_id: t.clientId ?? "dynamic_agent_client",
    ext_agent_host_id: hostId,
    response_type: "code",
    redirect_uri: REDIRECT,
    scope: SCOPES,
    resource: RESOURCE,
    state: t.state,
    nonce: t.nonce,
    code_challenge_method: "S256",
    code_challenge: createHash("sha256").update(t.verifier).digest("base64url"),
  };
  if (!t.clientId) params.agent_name_hint = "Voice Lab";
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  return { id, url: url.toString() };
}
export function consume(id: string, params: URLSearchParams) {
  const t = transactions.get(id);
  transactions.delete(id);
  if (!t || Date.now() - t.created > 600_000)
    throw new Error("Sign-in expired. Please try again.");
  for (const k of ["state", "code", "client_id", "error"])
    if (params.getAll(k).length > 1)
      throw new Error("Ambiguous sign-in callback.");
  if (!constantEqual(t.state, params.get("state") ?? ""))
    throw new Error("Sign-in could not be verified.");
  if (params.has("error"))
    throw new Error("Sign-in was not completed. Please try again.");
  const clientId = params.get("client_id") ?? t.clientId;
  if (
    !clientId ||
    clientId === "dynamic_agent_client" ||
    (t.clientId && t.clientId !== clientId)
  )
    throw new Error("Unexpected client registration.");
  const code = params.get("code");
  if (!code) throw new Error("Missing authorization code.");
  return { t, clientId, code };
}
const jwks = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`));
export async function exchange(
  t: Transaction,
  clientId: string,
  code: string,
): Promise<Session> {
  const response = await fetch(`${ISSUER}/api/accounts/oauth/token`, {
    method: "POST",
    cache: "no-store",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      code_verifier: t.verifier,
      redirect_uri: REDIRECT,
      resource: RESOURCE,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok)
    throw new Error(
      `Token exchange failed (${response.status}). Please sign in again.`,
    );
  const data = await response.json();
  if (
    !data.id_token ||
    !data.access_token ||
    !data.refresh_token ||
    !Number.isFinite(data.expires_in) ||
    data.expires_in <= 0 ||
    String(data.token_type).toLowerCase() !== "bearer"
  )
    throw new Error("OpenAI returned incomplete credentials.");
  const { payload } = await jwtVerify(data.id_token, jwks, {
    issuer: ISSUER,
    audience: clientId,
    requiredClaims: ["sub", "exp", "iat", "nonce"],
  });
  if (
    payload.nonce !== t.nonce ||
    !payload.sub ||
    (t.subject && t.subject !== payload.sub)
  )
    throw new Error("Account identity could not be verified.");
  const scopes = String(data.scope ?? "").split(" ");
  if (!scopes.includes("chatgpt.tokens.use.direct"))
    throw new Error(
      "ChatGPT plan access was not granted. Sign in again and enable plan usage.",
    );
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    idToken: data.id_token,
    clientId,
    subject: payload.sub,
    email:
      typeof payload.email === "string" ? payload.email : "ChatGPT account",
    expiresAt: Date.now() + data.expires_in * 1000,
    scopes,
  };
}
export function safeScriptJSON(value: unknown) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
