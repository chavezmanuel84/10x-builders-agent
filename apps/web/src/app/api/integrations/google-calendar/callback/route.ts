import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServerClient, upsertIntegration, encrypt } from "@agents/db";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const error = searchParams.get("error");

  if (error) {
    return NextResponse.redirect(
      `${origin}/settings?google_calendar=error&reason=${error}`
    );
  }

  const cookieHeader = request.headers.get("cookie") ?? "";
  const storedState = cookieHeader
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith("google_calendar_oauth_state="))
    ?.split("=")[1];

  if (!code || !state || state !== storedState) {
    return NextResponse.redirect(
      `${origin}/settings?google_calendar=error&reason=state_mismatch`
    );
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.redirect(`${origin}/login`);
  }

  const redirectUri = `${origin}/api/integrations/google-calendar/callback`;

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  const tokenData = await tokenRes.json();

  if (tokenData.error || !tokenData.access_token) {
    console.error("Google Calendar token exchange failed:", tokenData);
    return NextResponse.redirect(
      `${origin}/settings?google_calendar=error&reason=token_exchange`
    );
  }

  const tokensPayload = JSON.stringify({
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    expiry_date: Date.now() + (tokenData.expires_in ?? 3600) * 1000,
  });

  const encryptedTokens = encrypt(tokensPayload);

  const scopes = tokenData.scope
    ? (tokenData.scope as string).split(" ")
    : [
        "https://www.googleapis.com/auth/calendar.readonly",
        "https://www.googleapis.com/auth/calendar.events",
      ];

  const db = createServerClient();
  await upsertIntegration(db, user.id, "google_calendar", scopes, encryptedTokens);

  const response = NextResponse.redirect(
    `${origin}/settings?google_calendar=connected`
  );
  response.cookies.delete("google_calendar_oauth_state");
  return response;
}
