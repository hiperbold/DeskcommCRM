/**
 * EPIC-09 Team & Permissions — Zod schemas for invite, accept, role change, and api token.
 *
 * Roles are stored as `text` with a check constraint (not enum) on
 * `user_organizations.role` per project doctrine — keep this list in sync
 * with the DB constraint when adding/removing roles.
 */
import { z } from "zod";
import { interfaceSettingsSchema, interfaceTemDestino } from "@/lib/navigation/interface";

export const ROLES = ["viewer", "agent", "manager", "admin"] as const;
export type Role = (typeof ROLES)[number];

export const inviteMemberSchema = z.object({
  invitations: z
    .array(
      z
        .object({
          email: z.string().email(),
          role: z.enum(ROLES),
          interface_settings: interfaceSettingsSchema.optional(),
        })
        .refine((v) => !v.interface_settings || interfaceTemDestino(v.interface_settings, v.role), {
          message: "Selecione ao menos uma área permitida ao papel.",
          path: ["interface_settings"],
        }),
    )
    .min(1)
    .max(20),
});
export type InviteMemberInput = z.infer<typeof inviteMemberSchema>;

export const acceptInviteSchema = z.object({
  token: z.string().min(20),
});
export type AcceptInviteInput = z.infer<typeof acceptInviteSchema>;

export const changeRoleSchema = z.object({
  role: z.enum(ROLES),
});
export type ChangeRoleInput = z.infer<typeof changeRoleSchema>;

/**
 * Escopos que uma pessoa pode conceder ao criar uma chave (D-101). Lista
 * fechada: `actor:ai_agent` e `agent_run:<uuid>` marcam AUTORIA de agente de IA e
 * só o runtime os grava (token efêmero); com texto livre, um admin forjava a
 * autoria de um agente. É o mesmo catálogo da tela (`ApiTokensClient`) mais os
 * papéis (`role:`), que o autenticador lê em `lib/mcp/auth.ts`.
 */
export const ESCOPOS_DE_CHAVE_DE_API = [
  "mcp:read",
  "mcp:write",
  "contacts:read",
  "contacts:write",
  "leads:read",
  "leads:write",
  "messages:read",
  "messages:write",
  "messages:on_behalf",
  "audit:read",
  ...ROLES.map((r) => `role:${r}`),
] as const;

export const createApiTokenSchema = z.object({
  name: z.string().min(2).max(100),
  scopes: z.array(z.enum(ESCOPOS_DE_CHAVE_DE_API)).min(1).max(30),
  expires_in_days: z.coerce.number().int().min(1).max(365).optional(),
});
export type CreateApiTokenInput = z.infer<typeof createApiTokenSchema>;
