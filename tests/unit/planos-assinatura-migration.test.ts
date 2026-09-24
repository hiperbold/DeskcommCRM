import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATION_0908 = readFileSync(
  join(process.cwd(), "supabase/migrations/20260923130000_0908_planos_assinatura_estados.sql"),
  "utf8",
);
const BASELINE = readFileSync(join(process.cwd(), "supabase", "baseline.sql"), "utf8");

/**
 * Extrai o bloco 0908 do baseline: do marcador de início até (sem incluir) o
 * cabeçalho do PRÓXIMO bloco (`-- ---- `). Mesmo extrator das migrações
 * 0905/0906/0907 (tests/unit/planos-uso-migration.test.ts,
 * tests/unit/planos-carteira-migration.test.ts,
 * tests/unit/planos-bloqueio-migration.test.ts).
 */
function extraiBloco0908Baseline(): string {
  const marcadorInicio = "-- ---- pagamentos, estados e conferidor de vencimento da assinatura (migration 0908";
  const posicaoMarcador = BASELINE.indexOf(marcadorInicio);
  const fim = BASELINE.indexOf("\n-- ---- ", posicaoMarcador);
  return BASELINE.slice(posicaoMarcador, fim + 1);
}

/** Remove linhas de comentário (--) e linhas em branco, para comparar só o SQL. */
function removeComentariosEBrancas(sql: string): string {
  return sql
    .split("\n")
    .map((linha) => linha.trim())
    .filter((linha) => linha.length > 0 && !linha.startsWith("--"))
    .join("\n");
}

/** O corpo de uma função, do `create or replace` até o `$$;` que a fecha. */
function corpoDaFuncao(sql: string, nome: string): string {
  const inicio = sql.indexOf(`create or replace function public.${nome}(`);
  expect(inicio, `${nome} não encontrada`).toBeGreaterThan(-1);
  const fim = sql.indexOf("$$;", inicio);
  expect(fim, `$$; de ${nome} não encontrado`).toBeGreaterThan(-1);
  return sql.slice(inicio, fim);
}

describe("0908 pagamentos/estados/conferidor (Tarefa 1): posição e igualdade do bloco no baseline", () => {
  it("o bloco vem depois do bloco da 0907 e antes da VARREDURA anon", () => {
    const inicioBloco0907 = BASELINE.indexOf("-- ---- bloqueio do plano (migration 0907");
    const inicioBloco0908 = BASELINE.indexOf("-- ---- pagamentos, estados e conferidor de vencimento da assinatura (migration 0908");
    const varreduraAnon = BASELINE.lastIndexOf("-- ---- VARREDURA anon:");

    expect(inicioBloco0907).toBeGreaterThan(-1);
    expect(inicioBloco0908).toBeGreaterThan(-1);
    expect(varreduraAnon).toBeGreaterThan(-1);
    expect(inicioBloco0907).toBeLessThan(inicioBloco0908);
    expect(inicioBloco0908).toBeLessThan(varreduraAnon);
  });

  it("o SQL da migração 0908 e o SQL do bloco do baseline são iguais, ignorando comentários e linhas em branco", () => {
    const sqlMigracao = removeComentariosEBrancas(MIGRATION_0908);
    const sqlBloco = removeComentariosEBrancas(extraiBloco0908Baseline());
    expect(sqlBloco).toBe(sqlMigracao);
  });
});

describe("0908: billing_payments (decisão 1)", () => {
  it("SÓ DE ACRÉSCIMO: RLS ligada, nenhum grant para anon/authenticated, service_role só select+insert", () => {
    for (const sql of [MIGRATION_0908, BASELINE]) {
      expect(sql).toMatch(/alter table public\.billing_payments enable row level security;/);
      expect(sql).toMatch(/revoke all on public\.billing_payments from anon, authenticated;/);
      expect(sql).toMatch(/grant select, insert on public\.billing_payments to service_role;/);
      expect(sql).toMatch(/revoke update, delete, truncate on public\.billing_payments from service_role;/);
    }
  });

  it("não tem NENHUM gatilho BEFORE UPDATE/DELETE (nem em toda a migração)", () => {
    expect(MIGRATION_0908).not.toMatch(/before (update|delete) on public\.billing_payments/);
    expect(MIGRATION_0908).not.toMatch(/before insert or update on public\.billing_payments/);
  });

  it("nenhuma policy para authenticated (as telas leem pelo servidor)", () => {
    expect(MIGRATION_0908).not.toMatch(/create policy[^;]*on public\.billing_payments/);
  });

  it("asaas_payment_id: único só quando preenchido (índice parcial)", () => {
    for (const sql of [MIGRATION_0908, BASELINE]) {
      expect(sql).toMatch(
        /create unique index if not exists billing_payments_asaas_payment_id_unique\s*\n\s*on public\.billing_payments \(asaas_payment_id\)\s*\n\s*where asaas_payment_id is not null;/,
      );
    }
  });

  it("(organization_id, chave) único; chave é uuid", () => {
    expect(MIGRATION_0908).toMatch(/chave uuid not null,/);
    expect(MIGRATION_0908).toMatch(
      /constraint billing_payments_org_chave_unique unique \(organization_id, chave\)/,
    );
  });

  it("gross_cents é inteiro positivo (o CHECK, não só o comentário)", () => {
    expect(MIGRATION_0908).toMatch(/gross_cents integer not null,/);
    expect(MIGRATION_0908).toMatch(
      /constraint billing_payments_gross_cents_positivo check \(gross_cents > 0\)/,
    );
  });

  it("status: vocabulário fechado RECEIVED_IN_CASH / REFUNDED", () => {
    expect(MIGRATION_0908).toMatch(
      /constraint billing_payments_status_check check \(status in \('RECEIVED_IN_CASH', 'REFUNDED'\)\)/,
    );
  });

  it("organization_id em cascata; contract_id referencia billing_contracts", () => {
    expect(MIGRATION_0908).toMatch(
      /organization_id uuid not null references public\.organizations\(id\) on delete cascade,/,
    );
    expect(MIGRATION_0908).toMatch(
      /contract_id uuid not null references public\.billing_contracts\(id\)/,
    );
  });

  it("criado_por SEM chave estrangeira (mesmo racional do livro-caixa de tokens, 0906)", () => {
    expect(MIGRATION_0908).not.toMatch(/criado_por uuid references/);
  });
});

const FUNCOES_0908 = [
  "fn_billing_registrar_pagamento(uuid, date, integer, uuid, text, uuid)",
  "fn_billing_estornar_pagamento(uuid, uuid, uuid, text, uuid)",
  "fn_billing_corrigir_periodo(uuid, date, text, uuid)",
  "fn_billing_mudar_estado(uuid, text, text, uuid)",
  "fn_billing_cancelar_no_fim_do_periodo(uuid, boolean, uuid)",
  "fn_billing_conferir_vencimento(uuid)",
] as const;

describe("0908: padrão de segurança das seis funções novas", () => {
  it("todas são security definer com search_path fixo em public, pg_temp", () => {
    for (const sql of [MIGRATION_0908, BASELINE]) {
      for (const assinatura of FUNCOES_0908) {
        const nome = assinatura.slice(0, assinatura.indexOf("("));
        const inicio = sql.indexOf(`create or replace function public.${nome}(`);
        expect(inicio, `${nome} não encontrada`).toBeGreaterThan(-1);
        const trecho = sql.slice(inicio, inicio + 500);
        expect(trecho).toMatch(/security definer/);
        expect(trecho).toMatch(/set search_path = public, pg_temp/);
      }
    }
  });

  it("todas revogam execute de public/anon/authenticated e concedem só a service_role", () => {
    for (const sql of [MIGRATION_0908, BASELINE]) {
      for (const assinatura of FUNCOES_0908) {
        const nome = assinatura.slice(0, assinatura.indexOf("("));
        const chamada = assinatura.slice(assinatura.indexOf("("));
        const escapado = chamada.replace(/[().,]/g, (c) => `\\${c}`).replace(/ /g, "\\s*");
        const regexRevoke = new RegExp(
          `revoke execute on function public\\.${nome}${escapado} from public, anon, authenticated`,
        );
        const regexGrant = new RegExp(`grant execute on function public\\.${nome}${escapado} to service_role`);
        expect(sql, `${nome}: revoke ausente`).toMatch(regexRevoke);
        expect(sql, `${nome}: grant ausente`).toMatch(regexGrant);
      }
    }
  });

  it("o bloco da role agent_worker revoga select/insert na tabela e execute das seis funções", () => {
    for (const sql of [MIGRATION_0908, extraiBloco0908Baseline()]) {
      expect(sql).toMatch(/if exists \(select 1 from pg_roles where rolname = 'agent_worker'\) then/);
      expect(sql).toMatch(/revoke select, insert on public\.billing_payments from agent_worker/);
      for (const assinatura of FUNCOES_0908) {
        const nome = assinatura.slice(0, assinatura.indexOf("("));
        expect(sql).toMatch(new RegExp(`public\\.${nome}\\(`));
      }
      expect(sql).toMatch(
        /revoke execute on function public\.fn_billing_registrar_pagamento\(uuid, date, integer, uuid, text, uuid\), public\.fn_billing_estornar_pagamento\(uuid, uuid, uuid, text, uuid\), public\.fn_billing_corrigir_periodo\(uuid, date, text, uuid\), public\.fn_billing_mudar_estado\(uuid, text, text, uuid\), public\.fn_billing_cancelar_no_fim_do_periodo\(uuid, boolean, uuid\), public\.fn_billing_conferir_vencimento\(uuid\) from agent_worker/,
      );
    }
  });
});

describe("0908: fn_billing_registrar_pagamento (decisão 2)", () => {
  it("valida p_valor_cents, p_chave e p_fim antes de qualquer trabalho, todos 22023", () => {
    const corpo = corpoDaFuncao(MIGRATION_0908, "fn_billing_registrar_pagamento");
    expect(corpo).toMatch(
      /if p_valor_cents is null or p_valor_cents <= 0 then\s*\n\s*raise exception 'billing_valor_invalido' using errcode = '22023';/,
    );
    expect(corpo).toMatch(
      /if p_chave is null then\s*\n\s*raise exception 'billing_chave_obrigatoria' using errcode = '22023';/,
    );
    expect(corpo).toMatch(
      /if p_fim is null then\s*\n\s*raise exception 'billing_fim_obrigatorio' using errcode = '22023';/,
    );
  });

  it("trava por organização (billing_assinatura:<org>) e prende a linha do contrato (for update)", () => {
    const corpo = corpoDaFuncao(MIGRATION_0908, "fn_billing_registrar_pagamento");
    expect(corpo).toMatch(
      /perform pg_advisory_xact_lock\(hashtextextended\('billing_assinatura:' \|\| p_org::text, 0\)\);/,
    );
    expect(corpo).toMatch(
      /from public\.billing_contracts\s*\n\s*where organization_id = p_org\s*\n\s*for update;/,
    );
    expect(corpo).toMatch(/if not found then\s*\n\s*raise exception 'billing_contrato_nao_encontrado' using errcode = 'P0002';/);
  });

  it("fim = fim do dia p_fim em America/Sao_Paulo (limite exclusivo, dia seguinte às 00:00 SP)", () => {
    const corpo = corpoDaFuncao(MIGRATION_0908, "fn_billing_registrar_pagamento");
    expect(corpo).toMatch(
      /v_periodo_fim := \(p_fim \+ 1\)::timestamp at time zone 'America\/Sao_Paulo';/,
    );
  });

  it("início = greatest(current_period_end, now())", () => {
    const corpo = corpoDaFuncao(MIGRATION_0908, "fn_billing_registrar_pagamento");
    expect(corpo).toMatch(/v_referencia := greatest\(v_contract\.current_period_end, now\(\)\);/);
  });

  it("idempotência pela chave vem ANTES da validação de fim posterior (reenvio legítimo não pode ser recusado)", () => {
    const corpo = corpoDaFuncao(MIGRATION_0908, "fn_billing_registrar_pagamento");
    const posIdempotencia = corpo.indexOf("where organization_id = p_org and chave = p_chave;");
    const posValidacaoFim = corpo.indexOf("if v_periodo_fim <= v_referencia then");
    expect(posIdempotencia).toBeGreaterThan(-1);
    expect(posValidacaoFim).toBeGreaterThan(posIdempotencia);
  });

  it("mesma chave e mesmos valores devolve ja_registrado=true; valores diferentes é 22023", () => {
    const corpo = corpoDaFuncao(MIGRATION_0908, "fn_billing_registrar_pagamento");
    expect(corpo).toMatch(
      /if v_existente\.gross_cents = p_valor_cents and v_existente\.billing_period_end = v_periodo_fim then\s*\n\s*return jsonb_build_object\(\s*\n\s*'ja_registrado', true,/,
    );
    expect(corpo).toMatch(/raise exception 'billing_chave_com_valores_diferentes' using errcode = '22023';/);
  });

  it("fim que não é posterior à referência é 22023", () => {
    const corpo = corpoDaFuncao(MIGRATION_0908, "fn_billing_registrar_pagamento");
    expect(corpo).toMatch(
      /if v_periodo_fim <= v_referencia then\s*\n\s*raise exception 'billing_fim_anterior_ao_periodo_atual' using errcode = '22023';/,
    );
  });

  it("insere RECEIVED_IN_CASH com asaas_payment_id nulo, e volta o contrato para ativa sem mexer em cancel_at_period_end", () => {
    const corpo = corpoDaFuncao(MIGRATION_0908, "fn_billing_registrar_pagamento");
    expect(corpo).toMatch(
      /p_org, v_contract\.id, null, p_valor_cents, 'RECEIVED_IN_CASH',/,
    );
    expect(corpo).toMatch(
      /update public\.billing_contracts\s*\n\s*set current_period_start = v_referencia,\s*\n\s*current_period_end = v_periodo_fim,\s*\n\s*status = 'ativa'\s*\n\s*where id = v_contract\.id;/,
    );
    expect(corpo).not.toMatch(/cancel_at_period_end\s*=/);
  });
});

describe("0908: fn_billing_estornar_pagamento (decisão 2)", () => {
  it("pagamento não encontrado é P0002; de outra organização é 42501", () => {
    const corpo = corpoDaFuncao(MIGRATION_0908, "fn_billing_estornar_pagamento");
    expect(corpo).toMatch(
      /if not found then\s*\n\s*raise exception 'billing_pagamento_nao_encontrado' using errcode = 'P0002';/,
    );
    expect(corpo).toMatch(
      /if v_pagamento\.organization_id <> p_org then\s*\n\s*raise exception 'billing_pagamento_de_outra_organizacao' using errcode = '42501';/,
    );
  });

  it("grava REFUNDED com o mesmo gross_cents/período do original, e NÃO faz update em billing_contracts", () => {
    const corpo = corpoDaFuncao(MIGRATION_0908, "fn_billing_estornar_pagamento");
    expect(corpo).toMatch(
      /p_org, v_pagamento\.contract_id, null, v_pagamento\.gross_cents, 'REFUNDED',/,
    );
    expect(corpo).toMatch(
      /now\(\), v_pagamento\.billing_period_start, v_pagamento\.billing_period_end, p_chave, p_nota, p_actor/,
    );
    expect(corpo).not.toMatch(/update public\.billing_contracts/);
  });

  it("só estorna pagamento que ainda está RECEIVED_IN_CASH", () => {
    const corpo = corpoDaFuncao(MIGRATION_0908, "fn_billing_estornar_pagamento");
    expect(corpo).toMatch(
      /if v_pagamento\.status <> 'RECEIVED_IN_CASH' then\s*\n\s*raise exception 'billing_pagamento_nao_pode_ser_estornado' using errcode = '22023';/,
    );
  });
});

describe("0908: fn_billing_corrigir_periodo (decisão 2)", () => {
  it("exige p_motivo (nulo ou vazio é 22023)", () => {
    const corpo = corpoDaFuncao(MIGRATION_0908, "fn_billing_corrigir_periodo");
    expect(corpo).toMatch(
      /if p_motivo is null or btrim\(p_motivo\) = '' then\s*\n\s*raise exception 'billing_motivo_obrigatorio' using errcode = '22023';/,
    );
  });

  it("só mexe em current_period_end (não toca current_period_start nem status)", () => {
    const corpo = corpoDaFuncao(MIGRATION_0908, "fn_billing_corrigir_periodo");
    expect(corpo).toMatch(
      /update public\.billing_contracts\s*\n\s*set current_period_end = v_periodo_fim\s*\n\s*where id = v_contract\.id;/,
    );
    expect(corpo).not.toMatch(/set current_period_start/);
    expect(corpo).not.toMatch(/set status/);
  });
});

describe("0908: fn_billing_mudar_estado (decisão 3, as transições)", () => {
  it("estado fora do vocabulário fechado é 22023", () => {
    const corpo = corpoDaFuncao(MIGRATION_0908, "fn_billing_mudar_estado");
    expect(corpo).toMatch(
      /if p_estado not in \('avaliacao', 'ativa', 'atrasada', 'suspensa', 'cancelada'\) then\s*\n\s*raise exception 'billing_estado_invalido' using errcode = '22023';/,
    );
  });

  it("qualquer estado -> cancelada, sem condição", () => {
    const corpo = corpoDaFuncao(MIGRATION_0908, "fn_billing_mudar_estado");
    expect(corpo).toMatch(/if p_estado = 'cancelada' then\s*\n\s*-- Qualquer estado vira cancelada, sem condição\.\s*\n\s*v_permitido := true;/);
  });

  it("ativa -> atrasada/suspensa; atrasada/suspensa só saem de ativa por esta função", () => {
    const corpo = corpoDaFuncao(MIGRATION_0908, "fn_billing_mudar_estado");
    expect(corpo).toMatch(
      /elsif p_estado in \('atrasada', 'suspensa'\) then[\s\S]{0,150}v_permitido := coalesce\(v_contract\.status = 'ativa', false\);/,
    );
  });

  it("atrasada/suspensa/cancelada -> ativa só com período vigente (preenchido e no futuro)", () => {
    const corpo = corpoDaFuncao(MIGRATION_0908, "fn_billing_mudar_estado");
    expect(corpo).toMatch(
      /elsif p_estado = 'ativa' then\s*\n\s*v_permitido := coalesce\(\s*\n\s*v_contract\.status in \('atrasada', 'suspensa', 'cancelada'\)\s*\n\s*and v_contract\.current_period_end is not null\s*\n\s*and v_contract\.current_period_end > now\(\),\s*\n\s*false\s*\n\s*\);/,
    );
    expect(corpo).toMatch(/raise exception 'billing_estado_sem_periodo_vigente' using errcode = '22023';/);
  });

  it("avaliacao reusa current_period_end já existente (não pode ser nulo)", () => {
    const corpo = corpoDaFuncao(MIGRATION_0908, "fn_billing_mudar_estado");
    expect(corpo).toMatch(
      /elsif p_estado = 'avaliacao' then\s*\n\s*-- Reusa o current_period_end já existente[^\n]*\n\s*v_permitido := coalesce\(v_contract\.current_period_end is not null, false\);/,
    );
  });

  it("toda condição de v_permitido passa por coalesce(..., false) antes do raise", () => {
    const corpo = corpoDaFuncao(MIGRATION_0908, "fn_billing_mudar_estado");
    expect(corpo).toMatch(/if not coalesce\(v_permitido, false\) then/);
  });

  it("transição não permitida (fora da lista) é 22023", () => {
    const corpo = corpoDaFuncao(MIGRATION_0908, "fn_billing_mudar_estado");
    expect(corpo).toMatch(/raise exception 'billing_transicao_nao_permitida' using errcode = '22023';/);
  });
});

describe("0908: fn_billing_cancelar_no_fim_do_periodo (decisão 3)", () => {
  it("só liga/desliga cancel_at_period_end; p_sim obrigatório", () => {
    const corpo = corpoDaFuncao(MIGRATION_0908, "fn_billing_cancelar_no_fim_do_periodo");
    expect(corpo).toMatch(
      /if p_sim is null then\s*\n\s*raise exception 'billing_sim_obrigatorio' using errcode = '22023';/,
    );
    expect(corpo).toMatch(
      /update public\.billing_contracts\s*\n\s*set cancel_at_period_end = p_sim\s*\n\s*where id = v_contract\.id;/,
    );
    expect(corpo).not.toMatch(/set status/);
  });
});

describe("0908: fn_billing_conferir_vencimento (decisão 4, o conferidor)", () => {
  it("é VOLATILE, returns text, e devolve null quando a organização não tem contrato/período", () => {
    const inicio = MIGRATION_0908.indexOf("create or replace function public.fn_billing_conferir_vencimento(");
    const trecho = MIGRATION_0908.slice(inicio, inicio + 300);
    expect(trecho).toMatch(/returns text/);
    expect(trecho).toMatch(/\bvolatile\b/);
    const corpo = corpoDaFuncao(MIGRATION_0908, "fn_billing_conferir_vencimento");
    expect(corpo).toMatch(/if not found or v_current_period_end is null then\s*\n\s*-- [^\n]*\n\s*return null;/);
  });

  it("NÃO pega o advisory lock billing_assinatura:<org> (a técnica aqui é o update atômico, não o lock)", () => {
    const corpo = corpoDaFuncao(MIGRATION_0908, "fn_billing_conferir_vencimento");
    expect(corpo).not.toMatch(/pg_advisory_xact_lock/);
  });

  it("ordem fixa: (a) cancelada, (b) atrasada, (c) suspensa, cada uma um UPDATE atômico com WHERE lido da tabela", () => {
    const corpo = corpoDaFuncao(MIGRATION_0908, "fn_billing_conferir_vencimento");
    const posCancelada = corpo.indexOf("set status = 'cancelada'");
    const posAtrasada = corpo.indexOf("set status = 'atrasada'");
    const posSuspensa = corpo.indexOf("set status = 'suspensa'");
    expect(posCancelada).toBeGreaterThan(-1);
    expect(posAtrasada).toBeGreaterThan(posCancelada);
    expect(posSuspensa).toBeGreaterThan(posAtrasada);

    // (a) cancel_at_period_end + período vencido, nunca reafirma cancelada.
    expect(corpo).toMatch(
      /where organization_id = p_org\s*\n\s*and status <> 'cancelada'\s*\n\s*and coalesce\(cancel_at_period_end, false\)\s*\n\s*and current_period_end <= now\(\)\s*\n\s*returning status into v_estado_novo;/,
    );
    // (b) ativa/avaliacao vencidos.
    expect(corpo).toMatch(
      /where organization_id = p_org\s*\n\s*and status in \('ativa', 'avaliacao'\)\s*\n\s*and current_period_end <= now\(\)\s*\n\s*returning status into v_estado_novo;/,
    );
    // (c) atrasada além da carência do plano.
    expect(corpo).toMatch(
      /where organization_id = p_org\s*\n\s*and status = 'atrasada'\s*\n\s*and current_period_end \+ \(v_grace_days \|\| ' days'\)::interval <= now\(\)\s*\n\s*returning status into v_estado_novo;/,
    );

    // Cada UPDATE é seguido de "if found then return" antes do próximo passo.
    const ocorrencias = [...corpo.matchAll(/returning status into v_estado_novo;\s*\n\s*if found then\s*\n\s*return v_estado_novo;\s*\n\s*end if;/g)];
    expect(ocorrencias.length).toBe(3);
  });

  it("grace_days vem do plano (join com billing_plans), não de um valor fixo", () => {
    const corpo = corpoDaFuncao(MIGRATION_0908, "fn_billing_conferir_vencimento");
    expect(corpo).toMatch(/join public\.billing_plans bp on bp\.id = bc\.plan_id/);
  });

  it("erro interno não propaga: begin/exception devolve null com raise warning (erro numa organização não para a rodada)", () => {
    // corpoDaFuncao corta no PRIMEIRO "$$;" (o fecho de verdade desta
    // função): o bloco exception precisa estar DENTRO desse trecho, então o
    // "end;" final (sem "$$;" depois, que ficou de fora do corte de
    // propósito) é a prova de que o exception é da PRÓPRIA função, não de um
    // bloco "do $$ ... $$;" solto em outro lugar do arquivo.
    const corpoCompleto = corpoDaFuncao(MIGRATION_0908, "fn_billing_conferir_vencimento");
    expect(corpoCompleto).toMatch(/exception\s*\n\s*when others then/);
    expect(corpoCompleto).toMatch(/raise warning 'billing_conferir_vencimento_falhou: organizacao=%, sqlerrm=%', p_org, sqlerrm;/);
    expect(corpoCompleto).toMatch(/return null;\s*\nend;\s*$/);
  });
});

describe("0908: modo continua 'avisar' por padrão, esta migração não liga nada sozinha", () => {
  it("a migração 0908 nunca escreve em billing_settings.modo (nenhum 'set modo =' fora de comentário)", () => {
    expect(MIGRATION_0908).not.toMatch(/set modo\s*=/);
    expect(MIGRATION_0908).not.toMatch(/insert into public\.billing_settings/);
    expect(MIGRATION_0908).not.toMatch(/update public\.billing_settings/);
  });
});
