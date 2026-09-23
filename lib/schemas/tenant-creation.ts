import { z } from "zod";
import { interfaceSettingsSchema, interfaceTemDestino } from "@/lib/navigation/interface";

/** Mesmo vocabulário no formulário e no limite HTTP. */
export const tenantCreationFields = {
  display_name: z.string().trim().min(2).max(120),
  slug: z
    .string()
    .min(2)
    .max(40)
    .regex(/^[a-z0-9-]+$/, "Apenas letras minúsculas, números e hífens"),
  legal_name: z.string().max(255).optional(),
  cnpj: z.string().max(18).optional(),
  // Campo legado (organizations.settings.plan): aposentado como fonte de plano
  // na Tarefa 6 da fase F1 dos planos de assinatura
  // (hiperbold/planos/fase-F1-tarefas.md, decisão de desenho 12). Opcional e
  // sem valor padrão para o formulário de criação não oferecer mais nada aqui;
  // toda organização nova nasce no plano Ilimitado pelo gatilho do banco. A
  // rota da API continua aceitando o campo para não quebrar quem já chama.
  plan: z.enum(["standard", "pro", "enterprise"]).optional(),
  owner_interface_settings: interfaceSettingsSchema.optional(),
  owner_email: z.string().trim().email(),
};
export const createTenantSchema = z
  .object(tenantCreationFields)
  .refine(
    (v) => !v.owner_interface_settings || interfaceTemDestino(v.owner_interface_settings, "admin"),
    { message: "Selecione ao menos uma área de trabalho.", path: ["owner_interface_settings"] },
  );
