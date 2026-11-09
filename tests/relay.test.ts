import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { GET, POST } from "../src/app/api/openai/[operation]/route";
const origin = "http://127.0.0.1:1455";
const context = (operation: string) => ({
  params: Promise.resolve({ operation }),
});
test("relay rejects foreign origins, missing credentials and unknown upstreams", async () => {
  assert.equal(
    (
      await GET(
        new NextRequest(`${origin}/api/openai/models`, {
          headers: {
            Origin: "https://evil.example",
            Authorization: "Bearer fake-fixture",
          },
        }),
        context("models"),
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await GET(
        new NextRequest(`${origin}/api/openai/models`),
        context("models"),
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await GET(
        new NextRequest(`${origin}/api/openai/unknown`),
        context("unknown"),
      )
    ).status,
    404,
  );
});
test("relay forwards the request token and streams without caching or upstream cookies", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init) => {
      assert.equal(url, "https://api.openai.com/v1/responses");
      assert.equal(
        new Headers(init?.headers).get("Authorization"),
        "Bearer fixture-only",
      );
      assert.equal(init?.cache, "no-store");
      assert.equal(init?.redirect, "error");
      return new Response('data: {"type":"response.completed"}\n\n', {
        headers: {
          "content-type": "text/event-stream",
          "set-cookie": "upstream-cookie=not-forwarded",
        },
      });
    };
    const result = await POST(
      new NextRequest(`${origin}/api/openai/responses`, {
        method: "POST",
        headers: {
          Origin: origin,
          Authorization: "Bearer fixture-only",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "fixture",
          stream: true,
          store: false,
          input: [],
        }),
      }),
      context("responses"),
    );
    assert.equal(result.status, 200);
    assert.equal(result.headers.get("set-cookie"), null);
    assert.match(result.headers.get("cache-control")!, /no-store/);
    assert.match(await result.text(), /response.completed/);
  } finally {
    globalThis.fetch = original;
  }
});
test("relay refuses persistent/nonstreaming chat and non-refresh grants", async () => {
  const request = new NextRequest(`${origin}/api/openai/responses`, {
    method: "POST",
    headers: { Origin: origin, Authorization: "Bearer fixture-only" },
    body: JSON.stringify({
      store: true,
      stream: false,
      input: [],
      model: "fixture",
    }),
  });
  assert.equal((await POST(request, context("responses"))).status, 400);
  const refresh = new NextRequest(`${origin}/api/openai/refresh`, {
    method: "POST",
    headers: { Origin: origin },
    body: "client_id=fixture&grant_type=authorization_code&code=fixture",
  });
  assert.equal((await POST(refresh, context("refresh"))).status, 400);
});
