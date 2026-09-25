"use server";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { audit } from "@/lib/audit";
import { ipDoCliente } from "@/lib/http/ip-do-cliente";

export async function signOut(): Promise<void> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const hdrs = await headers();
  await supabase.auth.signOut();

  // Clear active_org cookie too.
  const store = await cookies();
  store.delete("active_org");

  if (user) {
    await audit({
      action: "auth.logout",
      actorUserId: user.id,
      requestId: hdrs.get("x-request-id"),
      // D-036: o primeiro salto do `x-forwarded-for` é forjável pelo cliente;
      // `ipDoCliente` lê o salto confiável (ver `lib/http/ip-do-cliente.ts`).
      ip: ipDoCliente(hdrs),
      userAgent: hdrs.get("user-agent") ?? null,
    });
  }

  redirect("/login");
}
