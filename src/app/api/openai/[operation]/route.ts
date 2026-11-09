import { NextRequest, NextResponse } from "next/server";
import { ORIGIN, RESOURCE, ISSUER } from "@/lib/oauth";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ operation: string }> };
const noStore = { "Cache-Control": "no-store, max-age=0" };

async function relay(request: NextRequest, context: Context) {
  const origin = request.headers.get("origin");
  if (
    (origin && origin !== ORIGIN) ||
    request.headers.get("sec-fetch-site") === "cross-site"
  )
    return NextResponse.json(
      { error: "Cross-origin requests are not allowed." },
      { status: 403, headers: noStore },
    );
  const { operation } = await context.params;
  const routes: Record<string, { url: string; method: string }> = {
    models: { url: `${RESOURCE}/models`, method: "GET" },
    responses: { url: `${RESOURCE}/responses`, method: "POST" },
    refresh: { url: `${ISSUER}/api/accounts/oauth/token`, method: "POST" },
    revoke: { url: `${ISSUER}/api/accounts/oauth/revoke`, method: "POST" },
  };
  const target = routes[operation];
  if (!target)
    return NextResponse.json(
      { error: "Unknown operation." },
      { status: 404, headers: noStore },
    );
  if (request.method !== target.method)
    return NextResponse.json(
      { error: "Method not allowed." },
      { status: 405, headers: noStore },
    );
  const headers = new Headers();
  let body: string | undefined;
  if (operation === "models" || operation === "responses") {
    const authorization = request.headers.get("authorization");
    if (!authorization?.startsWith("Bearer ") || authorization.length < 10)
      return NextResponse.json(
        { error: "Sign in first." },
        { status: 401, headers: noStore },
      );
    // Credentials are forwarded for this request only. Never store or log them.
    headers.set("Authorization", authorization);
  }
  if (request.method === "POST") {
    body = await request.text();
    if (body.length > 1_000_000)
      return NextResponse.json(
        { error: "Request too large." },
        { status: 413, headers: noStore },
      );
    if (operation === "responses") {
      try {
        const parsed = JSON.parse(body);
        if (
          parsed.store !== false ||
          parsed.stream !== true ||
          !Array.isArray(parsed.input) ||
          typeof parsed.model !== "string"
        )
          throw new Error();
      } catch {
        return NextResponse.json(
          { error: "Invalid streaming request." },
          { status: 400, headers: noStore },
        );
      }
      headers.set("Content-Type", "application/json");
    } else {
      const form = new URLSearchParams(body);
      if (!form.get("client_id"))
        return NextResponse.json(
          { error: "Missing client registration." },
          { status: 400, headers: noStore },
        );
      if (operation === "refresh") {
        if (
          form.get("grant_type") !== "refresh_token" ||
          !form.get("refresh_token")
        )
          return NextResponse.json(
            { error: "Invalid renewal request." },
            { status: 400, headers: noStore },
          );
        body = new URLSearchParams({
          grant_type: "refresh_token",
          client_id: form.get("client_id")!,
          refresh_token: form.get("refresh_token")!,
          resource: RESOURCE,
        }).toString();
      } else {
        if (!form.get("token"))
          return NextResponse.json(
            { error: "Missing session token." },
            { status: 400, headers: noStore },
          );
        body = new URLSearchParams({
          client_id: form.get("client_id")!,
          token: form.get("token")!,
          token_type_hint: "refresh_token",
        }).toString();
      }
      headers.set("Content-Type", "application/x-www-form-urlencoded");
    }
  }
  try {
    const upstream = await fetch(target.url, {
      method: target.method,
      headers,
      body,
      cache: "no-store",
      redirect: "error",
      signal: request.signal,
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        ...noStore,
        "Content-Type":
          upstream.headers.get("content-type") ?? "application/json",
        "X-Accel-Buffering": "no",
        "X-Voice-Lab-Transport": "same-origin-relay",
      },
    });
  } catch {
    return NextResponse.json(
      { error: "Could not reach OpenAI. Please retry." },
      { status: 502, headers: noStore },
    );
  }
}
export const GET = relay;
export const POST = relay;
