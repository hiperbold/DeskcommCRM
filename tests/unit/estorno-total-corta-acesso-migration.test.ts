import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Migration 0916 (D-086, fork Hiperbold): o estorno TOTAL no Asaas corta o acesso e
 * os tokens. Este arquivo cobre a FORMA: migration e baseline dizem a mesma coisa, no
 * lugar certo, com as garantias de segurança das funções, e a rota do cron injeta a
 * auditoria. O COMPORTAMENTO em banco (contrato encerrado, recompra liberada, livro-caixa,
 * idempotência) é provado por `tests/invariants/estorno-total-corta-acesso-e-tokens.test.ts`
 * (`pnpm test:db`).
 */

const MIGRATION = readFileSync(
  join(process.cwd(), "supabase/migrations/20260930140000_0916_estorno_total_do_asaas_corta_acesso_e_tokens.sql"),
  "utf8",
);
const BASELINE = readFileSync(join(process.cwd(), "supabase/baseline.sql"), "utf8");
const MANIFEST = readFileSync(join(process.cwd(), "supabase/migrations/MANIFEST.md"), "utf8");
const ROTA = readFileSync(join(process.cwd(), "app/api/v1/cron/processar-eventos-asaas/route.ts"), "utf8");

const MARCADOR_0915 = "-- ---- endereço próprio e chave de um ponto de IA só são gravados pelo servidor (migration 0915";
const MARCADOR_0916 = "-- ---- estorno total pelo Asaas corta o acesso e os tokens (migration 0916";

function extraiBloco(marcador: string): string {
  const inicio = BASELINE.lastIndexOf(marcador);
  const fim = BASELINE.indexOf("\n-- ---- ", inicio + marcador.length);
  return BASELINE.slice(inicio, fim + 1);
}

function semComentariosEBrancas(sql: string): string {
  return sql
    .split("\n")
    .map((linha) => linha.trim())
    .filter((linha) => linha.length > 0 && !linha.startsWith("--"))
    .join("\n");
}

function corpoDaFuncao(sql: string, nome: string): string {
  const inicio = sql.lastIndexOf(`create or replace function public.${nome}(`);
  expect(inicio, `${nome} não encontrada`).toBeGreaterThan(-1);
  return sql.slice(inicio, sql.indexOf("\n$$;", inicio));
}

describe("0916: posição e igualdade", () => {
  it("o bloco do baseline vem depois do da 0915 e antes da VARREDURA anon", () => {
    const inicio0915 = BASELINE.indexOf(MARCADOR_0915);
    const inicio0916 = BASELINE.lastIndexOf(MARCADOR_0916);
    const varreduraAnon = BASELINE.lastIndexOf("-- ---- VARREDURA anon:");
    expect(inicio0915).toBeGreaterThan(-1);
    expect(inicio0916).toBeGreaterThan(-1);
    expect(inicio0915).toBeLessThan(inicio0916);
    expect(inicio0916).toBeLessThan(varreduraAnon);
  });

  it("o bloco aparece uma vez só", () => {
    expect(BASELINE.split(MARCADOR_0916).length - 1).toBe(1);
  });

  it("o SQL da migração e o do bloco do baseline são iguais, ignorando comentários e linhas em branco", () => {
    expect(semComentariosEBrancas(extraiBloco(MARCADOR_0916))).toBe(semComentariosEBrancas(MIGRATION));
  });

  it("está registrada no MANIFEST, depois da 0915", () => {
    expect(MANIFEST).toMatch(/\| `20260930140000` \| `0916_estorno_total_do_asaas_corta_acesso_e_tokens` \|/);
    expect(MANIFEST.indexOf("`0915_ai_binding")).toBeLessThan(MANIFEST.indexOf("`0916_estorno_total"));
  });

  it("nenhuma linha da migração nem do bloco usa travessão (U+2014)", () => {
    const travessao = String.fromCharCode(0x2014);
    for (const texto of [MIGRATION, extraiBloco(MARCADOR_0916)]) {
      expect(texto.split("\n").filter((linha) => linha.includes(travessao))).toEqual([]);
    }
  });

  it("só função, revoke e grant: reaplicável com o app no ar, sem tabela, constraint, índice, gatilho nem reescrita de linha", () => {
    const codigo = semComentariosEBrancas(MIGRATION);
    expect(codigo).not.toMatch(/alter table/);
    expect(codigo).not.toMatch(/create table/);
    expect(codigo).not.toMatch(/create (unique )?index/);
    expect(codigo).not.toMatch(/create (or replace )?trigger/);
    expect(codigo).not.toMatch(/drop (trigger|table|constraint)/);
    expect(codigo).not.toMatch(/add constraint/);
    expect(codigo).not.toMatch(/\bdelete from\b/);
  });
});

describe("0916: o livro-caixa continua só de acréscimo", () => {
  for (const [nome, sql] of [
    ["migração", MIGRATION],
    ["bloco do baseline", extraiBloco(MARCADOR_0916)],
  ] as const) {
    it(`${nome}: nenhum update nem delete em billing_token_ledger; só insert com on conflict do nothing`, () => {
      const codigo = semComentariosEBrancas(sql);
      expect(codigo).not.toMatch(/update public\.billing_token_ledger/);
      expect(codigo).not.toMatch(/delete from public\.billing_token_ledger/);
      const inserts = codigo.match(/insert into public\.billing_token_ledger/g) ?? [];
      const conflitos = codigo.match(/on conflict \(organization_id, chave\) do nothing/g) ?? [];
      expect(inserts.length).toBeGreaterThanOrEqual(5);
      expect(conflitos.length).toBe(inserts.length);
    });
  }
});

describe("0916: o que as funções fazem", () => {
  for (const [nome, sql] of [
    ["migração", MIGRATION],
    ["bloco do baseline", extraiBloco(MARCADOR_0916)],
  ] as const) {
    describe(nome, () => {
      it("aplicar_estorno só chama o corte no PAYMENT_REFUNDED, sem tocar o chargeback, e isola a falha inesperada", () => {
        const corpo = corpoDaFuncao(sql, "fn_billing_asaas_aplicar_estorno");
        expect(corpo).toMatch(/if p_evento_tipo = 'PAYMENT_REFUNDED' then\s+begin\s+v_corte := public\.fn_billing_asaas_cortar_por_estorno_total\(/);
        // M1: a falha mantém o pedido de remoção da assinatura do período vigente.
        expect(corpo).toMatch(/v_corte := v_corte \|\| ',remover_assinatura_pendente';/);
        expect(corpo).toMatch(/fn_billing_asaas_estorno_do_periodo_vigente\(\s+v_org, v_payment_id, v_periodo_inicio_original, v_periodo_fim_original/);
        expect(corpo).toMatch(/when lock_not_available or deadlock_detected or serialization_failure then\s+raise;/);
        expect(corpo).toMatch(/v_corte := 'estorno_corte_falhou';/);
        expect(corpo).toMatch(/when 'PAYMENT_REFUNDED' then 'estorno_confirmado' \|\| coalesce\(',' \|\| v_corte, ''\)/);
        expect(corpo).toMatch(/else 'chargeback_confirmado'/);
        // o corte vem DEPOIS de gravar a linha REFUNDED e de marcar o pedido.
        expect(corpo.indexOf("returning id into v_estorno_id")).toBeLessThan(corpo.indexOf("fn_billing_asaas_cortar_por_estorno_total"));
        expect(corpo.indexOf("set status = 'estornado'")).toBeLessThan(corpo.indexOf("fn_billing_asaas_cortar_por_estorno_total"));
        // estorno reconstruído pelo próprio estorno (M2) não concedeu nada.
        expect(corpo).toMatch(/not v_reconstruido/);
      });

      it("o corte cancela o contrato, registra cada mudança e zera o plano por lançamento negativo", () => {
        const corpo = corpoDaFuncao(sql, "fn_billing_asaas_cortar_por_estorno_total");
        expect(corpo).toMatch(/set status = 'cancelada',\s+current_period_end = v_fim_novo,\s+cancel_at_period_end = true/);
        expect(corpo).toMatch(/'estorno_asaas'/);
        expect(corpo).toMatch(/'ajuste:estorno-plano:'/);
        expect(corpo).toMatch(/'ajuste:estorno:' \|\| p_pedido_id::text/);
        expect(corpo).toMatch(/'remover_assinatura_pendente'/);
        expect(corpo).toMatch(/'estorno_cortou_acesso'/);
        expect(corpo).toMatch(/'estorno_removeu_tokens_do_pacote'/);
        // Quem estornou não tem carência: bloqueio_a_partir_de vai para now() no mesmo update
        // (só antecipa, nunca adia) e a mudança deixa evento 'carencia' com motivo estorno_asaas.
        expect(corpo).toMatch(/v_carencia_nova := least\(coalesce\(v_contract\.bloqueio_a_partir_de, now\(\)\), now\(\)\);/);
        expect(corpo).toMatch(/cancel_at_period_end = true,\s+bloqueio_a_partir_de = v_carencia_nova\s+where id = v_contract\.id;/);
        expect(corpo).toMatch(/'carencia', v_contract\.bloqueio_a_partir_de::text, v_carencia_nova::text, 'estorno_asaas'/);
        // O marcador NÃO é gravado aqui: só o processador grava, depois do DELETE confirmado.
        expect(corpo).not.toMatch(/asaas_assinatura_encerrada_em\s*=/);
        // Ordem das travas: billing_tokens vem depois das duas travas que o chamador já segura.
        expect(corpo).not.toMatch(/billing_assinatura:/);
      });

      it("garantir_concessoes não concede o plano a contrato cancelada e reconcede por corte", () => {
        const corpo = corpoDaFuncao(sql, "fn_billing_garantir_concessoes");
        expect(corpo).toMatch(/if p_ciclo < public\.fn_billing_ciclo_de\(now\(\)\) then\s+return;/);
        // M4: cancelada não recebe nada, nem o plano nem os adicionais (o return vem antes dos dois).
        expect(corpo).toMatch(/if v_status is not distinct from 'cancelada' then\s+return;\s+end if;/);
        expect(corpo.indexOf("return;\n  end if;\n\n  -- Ilimitado")).toBeGreaterThan(-1);
        expect(corpo.indexOf("is not distinct from 'cancelada'")).toBeLessThan(corpo.indexOf("from public.billing_token_adicionais"));
        expect(corpo).toMatch(/'ajuste:reconcessao-plano:'/);
        expect(corpo).toMatch(/'plano:' \|\| to_char\(p_ciclo, 'YYYY-MM-DD'\)/);
        expect(corpo).toMatch(/from public\.billing_token_adicionais/);
      });

      it("B1: create, comment e revoke das três funções internas novas vão dentro de UM begin ... commit, sem janela de execute para anon/authenticated", () => {
        const codigo = semComentariosEBrancas(sql);
        const begin = codigo.indexOf("begin;" + String.fromCharCode(10));
        const commit = codigo.indexOf(String.fromCharCode(10) + "commit;");
        expect(begin).toBeGreaterThan(-1);
        expect(commit).toBeGreaterThan(begin);
        const dentro = codigo.slice(begin, commit);
        for (const nome of [
          "fn_billing_asaas_estorno_do_periodo_vigente",
          "fn_billing_asaas_cortar_por_estorno_total",
          "fn_billing_asaas_devolver_carencia",
        ]) {
          const create = dentro.indexOf(`create or replace function public.${nome}(`);
          const revoke = dentro.indexOf(`revoke execute on function public.${nome}(`);
          expect(create, `${nome}: create fora do begin/commit`).toBeGreaterThan(-1);
          expect(revoke, `${nome}: revoke fora do begin/commit`).toBeGreaterThan(create);
          expect(dentro).toContain(`comment on function public.${nome}(`);
        }
        // Nenhuma outra transação explícita no bloco.
        expect(codigo.match(/^begin;$/gm)?.length).toBe(1);
        expect(codigo.match(/^commit;$/gm)?.length).toBe(1);
      });

      it("A1: corta só o período vigente; cobrança antiga devolve estorno_de_periodo_antigo e não remove a assinatura", () => {
        const corpo = corpoDaFuncao(sql, "fn_billing_asaas_cortar_por_estorno_total");
        expect(corpo).toMatch(/if not public\.fn_billing_asaas_estorno_do_periodo_vigente\(p_org, p_payment_id, p_periodo_inicio, p_periodo_fim\) then\s+return 'estorno_de_periodo_antigo';/);
        // o pedido de remoção só é montado DEPOIS da checagem de vigência
        expect(corpo.indexOf("fn_billing_asaas_estorno_do_periodo_vigente(p_org")).toBeLessThan(
          corpo.indexOf("array_append(v_alarmes, 'remover_assinatura_pendente')"),
        );
        const vigente = corpoDaFuncao(sql, "fn_billing_asaas_estorno_do_periodo_vigente");
        expect(vigente).toMatch(/v_fim is not distinct from p_periodo_fim/);
        expect(vigente).toMatch(/p\.billing_period_end > p_periodo_fim/);
      });

      it("B3: as quantidades retiradas saem do livro-caixa, não da carteira, e a carteira é realinhada", () => {
        const corpo = corpoDaFuncao(sql, "fn_billing_asaas_cortar_por_estorno_total");
        expect(corpo).not.toMatch(/select creditado - consumido/);
        expect(corpo).toMatch(/set creditado = v_creditado_real - v_retirar/);
        expect(corpo).toMatch(/v_retirar := greatest\(v_creditado_real - v_consumido_real, 0\);/);
        expect(corpo).toMatch(/v_retirar := least\(coalesce\(v_tokens_pacote, 0\), greatest\(v_creditado_real - v_consumido_real, 0\)\);/);
      });

      it("B6: o pagamento que reativa a conta devolve a carência, nos dois ramos de aplicar_pagamento", () => {
        const corpo = corpoDaFuncao(sql, "fn_billing_asaas_aplicar_pagamento");
        const chamadas = corpo.match(/if v_estado_anterior = 'cancelada' and v_novo_status = 'ativa' then\s+perform public\.fn_billing_asaas_devolver_carencia\(v_org, v_contract\.id\);/g) ?? [];
        expect(chamadas).toHaveLength(2);
        const devolver = corpoDaFuncao(sql, "fn_billing_asaas_devolver_carencia");
        expect(devolver).toMatch(/v_motivo is distinct from 'estorno_asaas'/);
        expect(devolver).toMatch(/if v_modo = 'bloquear' then\s+perform public\.fn_billing_dar_carencia\(p_contract_id, v_dias\);/);
      });

      it("a função de corte é interna (deny-all, agent_worker revogado) e aplicar_estorno mantém o deny-all", () => {
        const codigo = semComentariosEBrancas(sql);
        for (const assinatura of [
          "fn_billing_asaas_cortar_por_estorno_total(uuid, text, text, uuid, timestamptz, timestamptz, boolean)",
          "fn_billing_asaas_estorno_do_periodo_vigente(uuid, text, timestamptz, timestamptz)",
          "fn_billing_asaas_devolver_carencia(uuid, uuid)",
        ]) {
          expect(codigo).toContain(
            `revoke execute on function public.${assinatura} from public, anon, authenticated, service_role;`,
          );
          expect(codigo).toContain(`comment on function public.${assinatura} is`);
        }
        expect(codigo).toMatch(/execute 'revoke execute on function public\.fn_billing_asaas_estorno_do_periodo_vigente\(uuid, text, timestamptz, timestamptz\), public\.fn_billing_asaas_cortar_por_estorno_total\(uuid, text, text, uuid, timestamptz, timestamptz, boolean\), public\.fn_billing_asaas_devolver_carencia\(uuid, uuid\) from agent_worker'/);
        expect(codigo).toMatch(/revoke execute on function public\.fn_billing_asaas_aplicar_pagamento\(jsonb, text\) from public, anon, authenticated, service_role;/);
        expect(codigo).toMatch(
          /revoke execute on function public\.fn_billing_asaas_aplicar_estorno\(text, jsonb, text\) from public, anon, authenticated, service_role;/,
        );
        expect(codigo).toMatch(/revoke execute on function public\.fn_billing_garantir_concessoes\(uuid, date\) from public, anon, authenticated;/);
        expect(codigo).toMatch(/grant execute on function public\.fn_billing_garantir_concessoes\(uuid, date\) to service_role;/);
        for (const nome of [
          "fn_billing_asaas_estorno_do_periodo_vigente",
          "fn_billing_asaas_devolver_carencia",
          "fn_billing_asaas_aplicar_pagamento",
          "fn_billing_asaas_cortar_por_estorno_total",
          "fn_billing_asaas_aplicar_estorno",
          "fn_billing_garantir_concessoes",
        ]) {
          expect(corpoDaFuncao(sql, nome)).toMatch(/security definer\s+set search_path = public, pg_temp/);
        }
      });
    });
  }
});

describe("0916: o processador audita e a rota injeta a auditoria", () => {
  it("o cron de eventos passa audit ao processador", () => {
    expect(ROTA).toMatch(/import \{ audit \} from "@\/lib\/audit";/);
    expect(ROTA).toMatch(/processarEventosAsaas\(\{ db, asaas, config, logger, auditar: audit \}\)/);
  });
});
