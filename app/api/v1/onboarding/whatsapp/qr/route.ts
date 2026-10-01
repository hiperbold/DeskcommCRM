import { loadOnboardingChannel } from "@/lib/channels/onboarding-session";
import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";

/**
 * Proxy WAHA's QR endpoint so the browser can <img src="..." /> without
 * exposing the API key.
 *
 * WAHA exposes: GET /api/{session}/auth/qr?format=image → image/png bytes.
 */
export async function GET() {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  // D-092: gate único (papel efetivo e MFA da sessão), não só a RLS. D-120: o QR religa o
  // número da empresa em outro aparelho, então só admin, como o POST da `session` ao lado.
  const authz = await requireRole("admin", { resource: "channel_sessions", allowPlatformAdmin: true });
  if (!authz.ok) return authz.response;
  const activeOrg = authz.org;

  const baseUrl = process.env.WAHA_API_BASE_URL;
  const apiKey = process.env.WAHA_API_KEY;
  if (!baseUrl || !apiKey || apiKey === "dev_plaintext_change_me") {
    return new NextResponse(null, { status: 503 });
  }

  const channel = await loadOnboardingChannel(await createClient(), activeOrg.orgId);
  if (!channel || channel.archived_at) return new NextResponse(null, { status: 404 });
  const sessionName = channel.waha_session_name;
  const upstream = await fetch(
    `${baseUrl}/api/${encodeURIComponent(sessionName)}/auth/qr?format=image`,
    { headers: { "X-Api-Key": apiKey }, cache: "no-store" },
  );
  if (!upstream.ok) {
    return new NextResponse(null, {
      status: upstream.status,
      headers: { "x-waha-status": String(upstream.status) },
    });
  }

  const ct = upstream.headers.get("content-type") ?? "image/png";
  const buf = await upstream.arrayBuffer();
  return new NextResponse(buf, {
    status: 200,
    headers: {
      "content-type": ct,
      "cache-control": "no-store, max-age=0",
    },
  });
}
