import { NextRequest, NextResponse } from "next/server";
import { begin, COOKIE, ORIGIN } from "@/lib/oauth";
export const runtime = "nodejs";
export async function POST(request: NextRequest) {
  if (request.headers.get("origin") !== ORIGIN)
    return NextResponse.json(
      { error: "Open this app at http://127.0.0.1:1455." },
      { status: 403 },
    );
  try {
    const body = await request.json();
    const { id, url } = begin(body.hostId, body.registration);
    const response = NextResponse.json(
      { url },
      { headers: { "Cache-Control": "no-store" } },
    );
    response.cookies.set(COOKIE, id, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 600,
    });
    return response;
  } catch {
    return NextResponse.json(
      {
        error: "Could not start sign-in. Clear the saved account or try again.",
      },
      { status: 400 },
    );
  }
}
