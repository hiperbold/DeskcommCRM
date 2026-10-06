import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { loadEnv } from "@/lib/agent-engine/env";
import { TETO_DE_TURNOS_POR_CONTATO_POR_HORA_PADRAO } from "@/lib/ai/elegibilidade/laco-de-robos";

/**
 * D-158: o padrão do disjuntor de turnos de IA por contato por hora é 60 (conversa humana
 * intensa não cai nele; laço entre robôs passa disso em minutos). Os três lugares onde o número
 * mora precisam dizer a mesma coisa: o schema do ambiente, a constante de reserva do drain e do
 * turno, e o modelo `.env.example` que o instalador copia.
 */
const AMBIENTE_MINIMO = {
  NODE_ENV: "test",
  NEXT_PUBLIC_SUPABASE_URL: "https://teste.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-teste",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-teste",
  SUPABASE_DB_URL: "postgresql://teste:teste@localhost:5432/teste",
} as NodeJS.ProcessEnv;

describe("disjuntor de turnos de IA por contato por hora: padrão 60", () => {
  it("sem a variável no ambiente, o worker lê 60", () => {
    expect(loadEnv({ ...AMBIENTE_MINIMO }).AI_MAX_TURNS_PER_CONTACT_PER_HOUR).toBe(60);
  });

  it("a constante de reserva do drain e do turno também é 60", () => {
    expect(TETO_DE_TURNOS_POR_CONTATO_POR_HORA_PADRAO).toBe(60);
  });

  it("o .env.example traz o mesmo número, e o valor explícito continua mandando (0 desliga)", () => {
    const modelo = readFileSync(join(process.cwd(), ".env.example"), "utf8");
    const linha = modelo.match(/^AI_MAX_TURNS_PER_CONTACT_PER_HOUR=(\d*)$/m);
    expect(linha?.[1]).toBe("60");

    expect(loadEnv({ ...AMBIENTE_MINIMO, AI_MAX_TURNS_PER_CONTACT_PER_HOUR: linha?.[1] ?? "" }).AI_MAX_TURNS_PER_CONTACT_PER_HOUR).toBe(60);
    expect(loadEnv({ ...AMBIENTE_MINIMO, AI_MAX_TURNS_PER_CONTACT_PER_HOUR: "0" }).AI_MAX_TURNS_PER_CONTACT_PER_HOUR).toBe(0);
  });
});
