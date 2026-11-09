import type { ChatMessage, Model, Session } from "./types";
import { readSavedSession, saveSession } from "./session-storage";
const API = "/api/openai";
const RESOURCE = "https://api.openai.com/v1";
// The user explicitly chose persistent frontend session storage.
let active: Session | null = null;
let revision = 0;
let refreshing: Promise<string> | null = null;
export function setSession(session: Session | null, persist = true) {
  revision++;
  active = session;
  refreshing = null;
  if (persist) saveSession(session);
}
export function restoreSession() {
  const session = readSavedSession();
  setSession(session, false);
  return session;
}
export function getSession() {
  return active;
}
export async function accessToken() {
  if (!active) throw new Error("Connect your ChatGPT account first.");
  if (active.expiresAt > Date.now() + 60_000) return active.accessToken;
  if (refreshing) return refreshing;
  const current = active,
    expected = revision;
  const renew = async () => {
    if (expected !== revision)
      throw new Error("Session changed during renewal.");
    // Another tab may have rotated the refresh token while this tab waited for the lock.
    const saved = readSavedSession();
    if (
      saved?.clientId === current.clientId &&
      saved.subject === current.subject &&
      saved.expiresAt > current.expiresAt
    ) {
      Object.assign(current, saved);
      active = current;
      if (current.expiresAt > Date.now() + 60_000) return current.accessToken;
    }
    const response = await fetch(`${API}/refresh`, {
      method: "POST",
      credentials: "omit",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: current.clientId,
        refresh_token: current.refreshToken,
        resource: RESOURCE,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok)
      throw new Error(
        `Session renewal failed (${response.status}). Reconnect your account.`,
      );
    const data = await response.json();
    if (
      !data.access_token ||
      !data.refresh_token ||
      !Number.isFinite(data.expires_in) ||
      data.expires_in <= 0
    )
      throw new Error("Session renewal returned incomplete credentials.");
    if (expected !== revision)
      throw new Error("Session changed during renewal.");
    active = {
      ...current,
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      idToken: data.id_token ?? current.idToken,
      expiresAt: Date.now() + data.expires_in * 1000,
    };
    saveSession(active);
    return active.accessToken;
  };
  refreshing = Promise.resolve(
    typeof navigator !== "undefined" && navigator.locks
      ? navigator.locks.request("voice-lab-session-renewal", renew)
      : renew(),
  ).finally(() => {
    if (expected === revision) refreshing = null;
  });
  return refreshing;
}
export async function disconnect() {
  const current = active;
  setSession(null);
  if (!current) return;
  const response = await fetch(`${API}/revoke`, {
    method: "POST",
    credentials: "omit",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      token: current.refreshToken,
      token_type_hint: "refresh_token",
      client_id: current.clientId,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok)
    throw new Error(
      "Cleared locally. Remote sign-out was not confirmed; disconnect Voice Lab in ChatGPT settings.",
    );
}
export async function models(): Promise<Model[]> {
  const response = await fetch(`${API}/models`, {
    credentials: "omit",
    cache: "no-store",
    headers: { Authorization: `Bearer ${await accessToken()}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok)
    throw new Error(
      `Could not load your models (${response.status}). Try refreshing the model list.`,
    );
  const data = await response.json();
  const items: Array<{
    slug?: string;
    display_name?: string;
    visibility?: string;
    default_reasoning_level?: string;
    supported_reasoning_levels?: Array<{
      effort?: unknown;
      description?: unknown;
    }>;
  }> = data.models ?? [];
  return items
    .filter((x) => x.visibility === "list" && typeof x.slug === "string")
    .map((x) => ({
      slug: x.slug!,
      display_name: x.display_name ?? x.slug!,
      default_reasoning_level: x.default_reasoning_level,
      supported_reasoning_levels: (Array.isArray(x.supported_reasoning_levels)
        ? x.supported_reasoning_levels
        : []
      )
        .filter(
          (level) =>
            typeof level?.effort === "string" && level.effort.length > 0,
        )
        .map((level) => ({
          effort: level.effort as string,
          description:
            typeof level.description === "string" ? level.description : "",
        })),
    }))
    .map((model) => {
      // The subscription catalog omits "none" for these documented Responses models.
      // Verified gpt-6-luna + none through this subscription endpoint on 2026-11-09.
      // https://developers.openai.com/api/docs/guides/latest-model
      const supportsNone = [
        "gpt-6-luna",
        "gpt-6-sol",
        "gpt-6.1-terra",
      ].includes(model.slug);
      if (
        supportsNone &&
        !model.supported_reasoning_levels.some(
          (level) => level.effort === "none",
        )
      ) {
        model.supported_reasoning_levels.unshift({
          effort: "none",
          description: "No reasoning step; best suited to quick conversation.",
        });
      }
      return model;
    });
}
export function reasoningFor(model: Model | undefined, preferred = ""): string {
  const levels = model?.supported_reasoning_levels ?? [];
  for (const effort of [preferred, "none", model?.default_reasoning_level]) {
    if (effort && levels.some((level) => level.effort === effort))
      return effort;
  }
  return levels[0]?.effort ?? "";
}
export function reasoningLabel(effort: string): string {
  const labels: Record<string, string> = {
    none: "None",
    minimal: "Minimal",
    low: "Low",
    medium: "Medium",
    high: "High",
    xhigh: "Extra high",
    max: "Maximum",
    ultra: "Ultra",
  };
  return labels[effort] ?? effort;
}
export async function* parseSSE(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<Record<string, unknown>> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done
        ? decoder.decode()
        : decoder.decode(value, { stream: true });
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const block = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const data = block
          .split(/\r?\n/)
          .filter((x) => x.startsWith("data:"))
          .map((x) => x.slice(5).trimStart())
          .join("\n");
        if (data && data !== "[DONE]") yield JSON.parse(data);
      }
      if (done) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export async function respond(
  messages: ChatMessage[],
  model: string,
  signal: AbortSignal,
  onText: (text: string) => void,
  reasoningEffort?: string,
) {
  const response = await fetch(`${API}/responses`, {
    method: "POST",
    credentials: "omit",
    signal,
    headers: {
      Authorization: `Bearer ${await accessToken()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}),
      store: false,
      stream: true,
      instructions:
        "You are a friendly conversational partner in a voice call. Keep replies natural, clear and usually under three sentences. Use plain spoken text without markdown, tables or emojis. Do not claim to have tools you do not have.",
      input: messages
        .filter((x) => !x.failed && x.text.trim())
        .map((x) => ({ role: x.role, content: x.text })),
    }),
  });
  if (!response.ok)
    throw new Error(
      `OpenAI request failed (${response.status}). ${response.status === 429 ? "Your plan may have reached its usage limit." : "Check your account access and try again."}`,
    );
  if (!response.body) throw new Error("OpenAI returned no response stream.");
  let completed = false;
  for await (const event of parseSSE(response.body)) {
    if (
      event.type === "response.output_text.delta" &&
      typeof event.delta === "string"
    )
      onText(event.delta);
    if (event.type === "response.completed") completed = true;
    if (
      ["response.failed", "response.incomplete", "error"].includes(
        String(event.type),
      )
    )
      throw new Error(
        "OpenAI could not complete this reply. Your plan may be unavailable or at its usage limit.",
      );
  }
  if (!completed)
    throw new Error("The connection ended before the reply was complete.");
}
export function splitSpeech(
  text: string,
  flush = false,
  maxChunk = 240,
): { chunks: string[]; remaining: string } {
  const chunks: string[] = [];
  let remaining = text;
  while (true) {
    const match = /[.!?](?:\s|$)|\n/.exec(remaining);
    if (
      !match ||
      (!flush &&
        match.index + match[0].length === remaining.length &&
        !/\s$/.test(match[0]))
    )
      break;
    const end = match.index + match[0].length;
    const part = remaining.slice(0, end).trim();
    remaining = remaining.slice(end);
    if (part) chunks.push(part);
  }
  // Bound long unpunctuated responses so speech can begin before the full reply.
  while (remaining.length > maxChunk) {
    let end = remaining.lastIndexOf(" ", maxChunk - 20);
    if (end < 1) end = maxChunk - 20;
    chunks.push(remaining.slice(0, end).trim());
    remaining = remaining.slice(end).trimStart();
  }
  if (flush && remaining.trim()) {
    chunks.push(remaining.trim());
    remaining = "";
  }
  return { chunks, remaining };
}
