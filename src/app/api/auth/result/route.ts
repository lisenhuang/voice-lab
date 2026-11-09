import { NextRequest, NextResponse } from "next/server";
import { COOKIE, ORIGIN, takeLoginResult, cancelLogin } from "@/lib/oauth";
export const runtime = "nodejs";
export async function POST(request: NextRequest) {
  if (request.headers.get("origin") !== ORIGIN)
    return NextResponse.json({ error: "Invalid origin." }, { status: 403 });
  const result = takeLoginResult(request.cookies.get(COOKIE)?.value ?? "");
  const response = NextResponse.json(
    result ? { status: "complete", ...result } : { status: "pending" },
    { headers: { "Cache-Control": "no-store, max-age=0" } },
  );
  if (result)
    response.cookies.set(COOKIE, "", {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 0,
    });
  return response;
}
export async function DELETE(request: NextRequest) {
  if (request.headers.get("origin") !== ORIGIN)
    return NextResponse.json({ error: "Invalid origin." }, { status: 403 });
  cancelLogin(request.cookies.get(COOKIE)?.value ?? "");
  const response = NextResponse.json(
    { ok: true },
    { headers: { "Cache-Control": "no-store" } },
  );
  response.cookies.set(COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return response;
}
