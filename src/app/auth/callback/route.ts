import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import {
  consume,
  exchange,
  COOKIE,
  finishLogin,
  safeScriptJSON,
  type LoginResult,
} from "@/lib/oauth";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  let message: LoginResult;
  const id = request.cookies.get(COOKIE)?.value ?? "";
  try {
    const { t, clientId, code } = consume(id, request.nextUrl.searchParams);
    message = { session: await exchange(t, clientId, code) };
  } catch (error) {
    message = {
      error: error instanceof Error ? error.message : "Sign-in failed.",
    };
  }
  finishLogin(id, message);
  const nonce = randomBytes(18).toString("base64");
  // The originating tab collects a one-use result. No dependency on window.opener,
  // which identity providers can sever via Cross-Origin-Opener-Policy.
  const status =
    message.error ??
    "Sign-in complete. Return to Voice Lab. You can close this window.";
  const html = `<!doctype html><html><head><meta name="referrer" content="no-referrer"><title>Voice Lab sign-in</title><style nonce="${nonce}">body{font:16px system-ui;background:#f7f7f4;color:#333;padding:48px;line-height:1.7}h1{font-size:24px}a{color:#7561c9}</style></head><body><h1>Voice Lab</h1><p id="status"></p><script nonce="${nonce}">history.replaceState(null,'','/auth/callback');document.getElementById('status').textContent=${safeScriptJSON(status)};</script></body></html>`;
  const response = new NextResponse(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, max-age=0",
      "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'`,
      "Referrer-Policy": "no-referrer",
    },
  });
  return response;
}
