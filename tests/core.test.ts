import { test } from "node:test";
import assert from "node:assert/strict";
import { begin, consume, transactions, safeScriptJSON } from "../src/lib/oauth";
import {
  parseSSE,
  splitSpeech,
  respond,
  setSession,
  accessToken,
  getSession,
  models,
  reasoningFor,
} from "../src/lib/openai";
import type { Session } from "../src/lib/types";
const host = "urn:uuid:12345678-1234-4234-8234-123456789abc";
function callback(state: string) {
  return new URLSearchParams({
    state,
    code: "test-code",
    client_id: "oaiapp_test",
  });
}
test("OAuth binds PKCE, nonce and exact loopback callback; state is one-use", () => {
  const { id, url } = begin(host);
  const u = new URL(url);
  const state = u.searchParams.get("state")!;
  assert.equal(
    u.searchParams.get("redirect_uri"),
    "http://127.0.0.1:1455/auth/callback",
  );
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  assert.ok(u.searchParams.get("nonce"));
  assert.equal(u.searchParams.get("client_id"), "dynamic_agent_client");
  const result = consume(id, callback(state));
  assert.equal(result.clientId, "oaiapp_test");
  assert.ok(result.t.verifier);
  assert.throws(() => consume(id, callback(state)));
});
test("OAuth rejects missing, mismatched, expired, duplicate and substituted state/client", () => {
  let result = begin(host);
  assert.throws(() => consume(result.id, callback("wrong")));
  result = begin(host);
  transactions.get(result.id)!.created = 0;
  assert.throws(() =>
    consume(
      result.id,
      callback(new URL(result.url).searchParams.get("state")!),
    ),
  );
  result = begin(host);
  let p = callback(new URL(result.url).searchParams.get("state")!);
  p.append("state", "another");
  assert.throws(() => consume(result.id, p));
  result = begin(host, { clientId: "oaiapp_previous", subject: "sub" });
  p = callback(new URL(result.url).searchParams.get("state")!);
  assert.throws(() => consume(result.id, p));
  result = begin(host);
  p = callback(new URL(result.url).searchParams.get("state")!);
  p.set("client_id", "dynamic_agent_client");
  assert.throws(() => consume(result.id, p));
});
test("callback JSON cannot break out of the nonce script", () => {
  assert.ok(
    !safeScriptJSON({ email: "</script><script>alert(1)</script>" }).includes(
      "<",
    ),
  );
});
test("SSE handles arbitrary byte boundaries, UTF-8 and CRLF", async () => {
  const bytes = new TextEncoder().encode(
    ': ping\r\n\r\ndata: {"type":"response.output_text.delta","delta":"你好"}\r\n\r\ndata: {"type":"response.completed"}\n\n',
  );
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      if (i < bytes.length) c.enqueue(bytes.slice(i, (i += 1)));
      else c.close();
    },
  });
  const events = [];
  for await (const event of parseSSE(stream)) events.push(event);
  assert.equal(events.length, 2);
  assert.equal(events[0].delta, "你好");
});
test("speech splitting preserves tails, flushes final text and bounds unpunctuated text", () => {
  assert.deepEqual(splitSpeech("Hello. Next sentence"), {
    chunks: ["Hello."],
    remaining: "Next sentence",
  });
  assert.deepEqual(splitSpeech("Hello."), { chunks: [], remaining: "Hello." });
  assert.deepEqual(splitSpeech("Hello.", true), {
    chunks: ["Hello."],
    remaining: "",
  });
  const text = "word ".repeat(200);
  const r = splitSpeech(text, true);
  assert.ok(r.chunks.every((x) => x.length <= 240));
  assert.equal(r.chunks.join(" "), text.trim());
});
const session: Session = {
  accessToken: "test-access",
  refreshToken: "test-refresh",
  idToken: "test-id",
  clientId: "oaiapp_test",
  subject: "subject",
  email: "test@example.com",
  expiresAt: Date.now() + 3600000,
  scopes: ["chatgpt.tokens.use.direct"],
};
test("browser Responses relays its own OAuth token, mandatory flags, and rejects truncated streams", async () => {
  const original = globalThis.fetch;
  setSession(session);
  try {
    globalThis.fetch = async (url, init) => {
      assert.equal(url, "/api/openai/responses");
      const body = JSON.parse(String(init?.body));
      assert.equal(body.stream, true);
      assert.equal(body.store, false);
      assert.equal(init?.credentials, "omit");
      assert.equal(
        (init?.headers as Record<string, string>).Authorization,
        "Bearer test-access",
      );
      return new Response(
        'data: {"type":"response.output_text.delta","delta":"Hello"}\n\n',
      );
    };
    let text = "";
    await assert.rejects(
      respond(
        [{ id: "1", role: "user", text: "Hi" }],
        "available-model",
        new AbortController().signal,
        (x) => (text += x),
      ),
      /before the reply was complete/,
    );
    assert.equal(text, "Hello");
    globalThis.fetch = async () =>
      new Response('data: {"type":"response.failed"}\n\n');
    await assert.rejects(
      respond([], "model", new AbortController().signal, () => {}),
      /could not complete/,
    );
  } finally {
    globalThis.fetch = original;
    setSession(null);
  }
});
test("refresh is serialized and cannot resurrect a disconnected session", async () => {
  const original = globalThis.fetch;
  let count = 0;
  let release!: () => void;
  const barrier = new Promise<void>((r) => (release = r));
  setSession({ ...session, expiresAt: 0 });
  try {
    globalThis.fetch = async () => {
      count++;
      await barrier;
      return Response.json({
        access_token: "new",
        refresh_token: "rotated",
        expires_in: 3600,
      });
    };
    const first = accessToken(),
      second = accessToken();
    setSession(null);
    release();
    await Promise.all([
      assert.rejects(first, /Session changed/),
      assert.rejects(second, /Session changed/),
    ]);
    assert.equal(count, 1);
    assert.equal(getSession(), null);
  } finally {
    globalThis.fetch = original;
    setSession(null);
  }
});
test("model picker preserves only account-visible models and server ordering", async () => {
  const original = globalThis.fetch;
  setSession(session);
  try {
    globalThis.fetch = async () =>
      Response.json({
        models: [
          { slug: "b", display_name: "Second", visibility: "list" },
          { slug: "hidden", visibility: "hidden" },
          { slug: "a", display_name: "First", visibility: "list" },
        ],
      });
    assert.deepEqual(
      (await models()).map((x) => x.slug),
      ["b", "a"],
    );
  } finally {
    globalThis.fetch = original;
    setSession(null);
  }
});

test("reasoning follows model capabilities, including none only when advertised", () => {
  const model = {
    slug: "a",
    display_name: "A",
    default_reasoning_level: "medium",
    supported_reasoning_levels: [
      { effort: "low", description: "Fast" },
      { effort: "medium", description: "Balanced" },
    ],
  };
  assert.equal(reasoningFor(model, "none"), "medium");
  assert.equal(reasoningFor(model, "low"), "low");
  assert.equal(
    reasoningFor({
      ...model,
      supported_reasoning_levels: [
        { effort: "none", description: "Off" },
        ...model.supported_reasoning_levels,
      ],
    }),
    "none",
  );
  assert.equal(
    reasoningFor({ ...model, supported_reasoning_levels: [] }, "high"),
    "",
  );
});
test("catalog retains live reasoning metadata and Responses sends the selected effort", async () => {
  const original = globalThis.fetch;
  setSession(session);
  try {
    globalThis.fetch = async (_url, init) => {
      assert.equal(init?.cache, "no-store");
      return Response.json({
        models: [
          {
            slug: "test",
            visibility: "list",
            default_reasoning_level: "low",
            supported_reasoning_levels: [
              { effort: "none", description: "No reasoning" },
              { effort: "low", description: "Fast" },
              { effort: 13 },
            ],
          },
        ],
      });
    };
    const [model] = await models();
    assert.equal(model.default_reasoning_level, "low");
    assert.deepEqual(
      model.supported_reasoning_levels.map((x) => x.effort),
      ["none", "low"],
    );
    let expected: string | undefined = "none";
    globalThis.fetch = async (_url, init) => {
      assert.deepEqual(
        JSON.parse(String(init?.body)).reasoning,
        expected ? { effort: expected } : undefined,
      );
      return new Response('data: {"type":"response.completed"}\n\n');
    };
    await respond(
      [],
      model.slug,
      new AbortController().signal,
      () => {},
      "none",
    );
    expected = "high";
    await respond(
      [],
      model.slug,
      new AbortController().signal,
      () => {},
      "high",
    );
    expected = undefined;
    await respond([], model.slug, new AbortController().signal, () => {});
  } finally {
    globalThis.fetch = original;
    setSession(null);
  }
});
