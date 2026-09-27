import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATION_0908 = readFileSync(
  join(process.cwd(), "supabase/migrations/20260923130000_0908_planos_assinatura_estados.sql"),
  "utf8",
);
const MIGRATION_0905 = readFileSync(
  join(process.cwd(), "supabase/migrations/20260923100000_0905_planos_uso_e_trava.sql"),
  "utf8",
);
const BASELINE = readFileSync(join(process.cwd(), "supabase", "baseline.sql"), "utf8");

/** Bloco 0905 do baseline (mesmo extrator de tests/unit/planos-uso-migration.test.ts). */
function extraiBloco0905Baseline(): string {
  const marcadorInicio = "-- ---- uso dos planos e trava (migration 0905";
  const posicaoMarcador = BASELINE.indexOf(marcadorInicio);
  const fim = BASELINE.indexOf("\n-- ---- ", posicaoMarcador);
  return BASELINE.slice(posicaoMarcador, fim + 1);
}

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

  it("o bloco da role agent_worker revoga select/insert/update/delete/truncate na tabela (correção revisão F4, item 1: a versão original deixava update/delete de pé) e execute das seis funções", () => {
    for (const sql of [MIGRATION_0908, extraiBloco0908Baseline()]) {
      expect(sql).toMatch(/if exists \(select 1 from pg_roles where rolname = 'agent_worker'\) then/);
      expect(sql).toMatch(
        /revoke select, insert, update, delete, truncate on public\.billing_payments, public\.billing_contract_eventos from agent_worker/,
      );
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

  it("avaliacao reusa current_period_end já existente e exige FUTURO (correção revisão F4, item 2)", () => {
    const corpo = corpoDaFuncao(MIGRATION_0908, "fn_billing_mudar_estado");
    expect(corpo).toMatch(
      /elsif p_estado = 'avaliacao' then\s*\n\s*-- Reusa o current_period_end já existente[^\n]*\n[\s\S]*?v_permitido := coalesce\(\s*\n\s*v_contract\.current_period_end is not null and v_contract\.current_period_end > now\(\),\s*\n\s*false\s*\n\s*\);/,
    );
    expect(corpo).toMatch(/raise exception 'billing_avaliacao_sem_data_futura' using errcode = '22023';/);
  });

  it("ativa -> ativa com período vigente é sucesso sem mudança (correção revisão F4, item 3); com período vencido mantém o erro atual", () => {
    const corpo = corpoDaFuncao(MIGRATION_0908, "fn_billing_mudar_estado");
    expect(corpo).toMatch(
      /if p_estado = 'ativa' and v_contract\.status = 'ativa'\s*\n\s*and coalesce\(v_contract\.current_period_end > now\(\), false\)\s*\n\s*then\s*\n\s*return jsonb_build_object\('estado_anterior', 'ativa', 'estado_novo', 'ativa'\);/,
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

  it("ordem fixa: (a) cancelada, (b) atrasada, (c) suspensa, cada uma um CTE select...for update + update...from atômico com WHERE lido da tabela (correção revisão F4, item 4: vira CTE para capturar o status ANTERIOR)", () => {
    const corpo = corpoDaFuncao(MIGRATION_0908, "fn_billing_conferir_vencimento");
    const posCancelada = corpo.indexOf("set status = 'cancelada'");
    const posAtrasada = corpo.indexOf("set status = 'atrasada'");
    const posSuspensa = corpo.indexOf("set status = 'suspensa'");
    expect(posCancelada).toBeGreaterThan(-1);
    expect(posAtrasada).toBeGreaterThan(posCancelada);
    expect(posSuspensa).toBeGreaterThan(posAtrasada);

    // (a) cancel_at_period_end + período vencido, nunca reafirma cancelada.
    expect(corpo).toMatch(
      /where organization_id = p_org\s*\n\s*and status <> 'cancelada'\s*\n\s*and coalesce\(cancel_at_period_end, false\)\s*\n\s*and current_period_end <= now\(\)\s*\n\s*for update/,
    );
    // (b) ativa/avaliacao vencidos.
    expect(corpo).toMatch(
      /where organization_id = p_org\s*\n\s*and status in \('ativa', 'avaliacao'\)\s*\n\s*and current_period_end <= now\(\)\s*\n\s*for update/,
    );
    // (c) atrasada além da carência do plano.
    expect(corpo).toMatch(
      /where organization_id = p_org\s*\n\s*and status = 'atrasada'\s*\n\s*and current_period_end \+ \(v_grace_days \|\| ' days'\)::interval <= now\(\)\s*\n\s*for update/,
    );

    // As três CTEs escritoras devolvem status_antigo/status_novo.
    const ocorrenciasCte = [
      ...corpo.matchAll(/returning alvo\.status_antigo, bc\.status as status_novo/g),
    ];
    expect(ocorrenciasCte.length).toBe(3);

    // Cada SELECT INTO é seguido de "if found then" gravando o evento em
    // billing_contract_eventos (correção revisão F4, item 4: tipo=conferidor,
    // de/para=status_anterior/novo, motivo=conferidor, actor=null) e SÓ DEPOIS
    // chamando fn_billing_avisar_assinatura antes de devolver.
    const ocorrencias = [
      ...corpo.matchAll(
        /select status_antigo, status_novo into v_estado_anterior, v_estado_novo from atualizado;\s*\n\s*if found then\s*\n\s*insert into public\.billing_contract_eventos \(organization_id, contract_id, tipo, de, para, motivo, actor\)\s*\n\s*values \(p_org, v_contract_id, 'conferidor', v_estado_anterior, v_estado_novo, 'conferidor', null\);\s*\n(?:\s*--[^\n]*\n)*\s*perform public\.fn_billing_avisar_assinatura\(p_org\);\s*\n\s*return v_estado_novo;\s*\n\s*end if;/g,
      ),
    ];
    expect(ocorrencias.length).toBe(3);
  });

  it("Tarefa 2, decisão 9: o passo diário sem mudança de estado nenhuma TAMBÉM chama fn_billing_avisar_assinatura, antes do return null final", () => {
    const corpo = corpoDaFuncao(MIGRATION_0908, "fn_billing_conferir_vencimento");
    expect(corpo).toMatch(
      /perform public\.fn_billing_avisar_assinatura\(p_org\);\s*\n\s*return null;\s*\nexception/,
    );
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

// ============================================================================
// Tarefa 2: modo leitura da conta suspensa.
// ============================================================================

describe("0908 Tarefa 2: fn_billing_modo_leitura (decisão 5)", () => {
  it("é security definer, stable, com search_path fixo, revoga de public/anon/authenticated e concede a service_role", () => {
    for (const sql of [MIGRATION_0908, BASELINE]) {
      const inicio = sql.indexOf("create or replace function public.fn_billing_modo_leitura(");
      expect(inicio, "fn_billing_modo_leitura não encontrada").toBeGreaterThan(-1);
      const trecho = sql.slice(inicio, inicio + 400);
      expect(trecho).toMatch(/returns boolean/);
      expect(trecho).toMatch(/\bstable\b/);
      expect(trecho).toMatch(/security definer/);
      expect(trecho).toMatch(/set search_path = public, pg_temp/);
      expect(sql).toMatch(
        /revoke execute on function public\.fn_billing_modo_leitura\(uuid\) from public, anon, authenticated;/,
      );
      expect(sql).toMatch(
        /grant execute on function public\.fn_billing_modo_leitura\(uuid\) to service_role;/,
      );
    }
  });

  it("também concede execute a agent_worker, DE PROPÓSITO fora do bloco de revoke (mesmo padrão de fn_billing_ia_pode_responder, 0907)", () => {
    for (const sql of [MIGRATION_0908, BASELINE]) {
      expect(sql).toMatch(
        /grant execute on function public\.fn_billing_modo_leitura\(uuid\) to agent_worker/,
      );
    }
    // A prova de que fica FORA: nenhum bloco "revoke execute ... from
    // agent_worker" desta migração lista fn_billing_modo_leitura.
    const blocosRevokeAgentWorker = [
      ...MIGRATION_0908.matchAll(/revoke execute on function ([^;]+) from agent_worker/g),
    ].map((m) => m[1]);
    for (const lista of blocosRevokeAgentWorker) {
      expect(lista).not.toMatch(/fn_billing_modo_leitura/);
    }
  });

  it("lê o modo ANTES de qualquer outra coisa: devolve false sem tocar billing_contracts quando o modo não é bloquear", () => {
    const corpo = corpoDaFuncao(MIGRATION_0908, "fn_billing_modo_leitura");
    const posLeituraModo = corpo.indexOf("select modo into v_modo from public.billing_settings where id = 1;");
    const posSaidaCedo = corpo.indexOf("if v_modo is distinct from 'bloquear' then");
    const posLeituraContrato = corpo.indexOf("from public.billing_contracts bc");
    expect(posLeituraModo).toBeGreaterThan(-1);
    expect(posSaidaCedo).toBeGreaterThan(posLeituraModo);
    expect(posLeituraContrato).toBeGreaterThan(posSaidaCedo);
  });

  it("a condição final é coalesce(..., false): carência preenchida e vencida E status in (suspensa, cancelada)", () => {
    const corpo = corpoDaFuncao(MIGRATION_0908, "fn_billing_modo_leitura");
    expect(corpo).toMatch(
      /return coalesce\(\s*\n\s*v_bloqueio_a_partir_de is not null\s*\n\s*and v_bloqueio_a_partir_de <= now\(\)\s*\n\s*and v_status in \('suspensa', 'cancelada'\),\s*\n\s*false\s*\n\s*\);/,
    );
  });
});

describe("0908 Tarefa 2: recusa por modo leitura nos quatro gatilhos de criação (decisão 7), idêntica em 0905 e no baseline", () => {
  const GATILHOS = [
    "fn_billing_trava_crm_pipelines",
    "fn_billing_trava_crm_stages",
    "fn_billing_trava_webhook_sources",
    "fn_billing_trava_team_invites",
  ] as const;
  // Quantas vezes cada gatilho chama fn_billing_bloqueia (decisão 3/0907):
  // funis tem 3 (insert + desarquivar-funil + desarquivar-etapas), etapas tem
  // 3 (insert + desarquivar + mover de pipeline), webhook tem 2 (insert +
  // ativar), convites tem 1 (transição para pendente). A recusa por modo
  // leitura (decisão 7) acompanha CADA uma dessas chamadas, na mesma
  // transição.
  const OCORRENCIAS_ESPERADAS: Record<(typeof GATILHOS)[number], number> = {
    fn_billing_trava_crm_pipelines: 3,
    fn_billing_trava_crm_stages: 3,
    fn_billing_trava_webhook_sources: 2,
    fn_billing_trava_team_invites: 1,
  };

  it("cada gatilho tem o número certo de checagens de modo leitura, nenhuma delas dentro de bloco exception (nenhuma das quatro funções tem 'exception when others')", () => {
    for (const sql of [MIGRATION_0905, extraiBloco0905Baseline()]) {
      for (const nome of GATILHOS) {
        const corpo = corpoDaFuncao(sql, nome);
        expect(corpo, `${nome}: não pode ter bloco exception (o PT402 precisa propagar)`).not.toMatch(
          /exception\s*\n\s*when others/,
        );
        const ocorrencias = [
          ...corpo.matchAll(
            /if public\.fn_billing_modo_leitura\(new\.organization_id\) then\s*\n\s*raise exception 'Conta suspensa' using errcode = 'PT402', detail = 'assinatura_suspensa';\s*\n\s*end if;/g,
          ),
        ];
        expect(ocorrencias.length, `${nome}: número de checagens de modo leitura`).toBe(
          OCORRENCIAS_ESPERADAS[nome],
        );
      }
    }
  });

  it("cada checagem de modo leitura vem IMEDIATAMENTE antes da checagem de bloqueio de teto, na mesma transição (mesmo número de ocorrências das duas)", () => {
    for (const sql of [MIGRATION_0905, extraiBloco0905Baseline()]) {
      for (const nome of GATILHOS) {
        const corpo = corpoDaFuncao(sql, nome);
        const modoLeitura = [...corpo.matchAll(/fn_billing_modo_leitura\(new\.organization_id\)/g)].length;
        const bloqueio = [...corpo.matchAll(/fn_billing_bloqueia\(new\.organization_id,/g)].length;
        expect(modoLeitura, `${nome}: modo leitura x bloqueio de teto`).toBe(bloqueio);
      }
    }
  });

  it("o SQL dos quatro gatilhos é idêntico entre a migração 0905 e o bloco do baseline (ignorando comentários e linhas em branco)", () => {
    for (const nome of GATILHOS) {
      const corpoMigracao = removeComentariosEBrancas(corpoDaFuncao(MIGRATION_0905, nome));
      const corpoBaseline = removeComentariosEBrancas(corpoDaFuncao(extraiBloco0905Baseline(), nome));
      expect(corpoBaseline).toBe(corpoMigracao);
    }
  });
});

describe("0908 Tarefa 2: ausência da recusa por modo leitura em leads, aceite de convite e conexões (decisão 7)", () => {
  const MIGRATION_0907 = readFileSync(
    join(process.cwd(), "supabase/migrations/20260923120500_0907_planos_bloqueio.sql"),
    "utf8",
  );

  it("fn_billing_bloqueia_crm_leads (0907): criar/reabrir lead NUNCA chama fn_billing_modo_leitura (N23)", () => {
    for (const sql of [MIGRATION_0907, BASELINE]) {
      const corpo = corpoDaFuncao(sql, "fn_billing_bloqueia_crm_leads");
      expect(corpo).not.toMatch(/fn_billing_modo_leitura/);
    }
  });

  it("fn_billing_trava_user_organizations (0905): o ACEITE de convite (transição para ativo) NUNCA chama fn_billing_modo_leitura", () => {
    for (const sql of [MIGRATION_0905, BASELINE]) {
      const corpo = corpoDaFuncao(sql, "fn_billing_trava_user_organizations");
      expect(corpo).not.toMatch(/fn_billing_modo_leitura/);
    }
  });

  it("fn_billing_trava_channel_sessions (0905): conectar/reconectar NUNCA chama fn_billing_modo_leitura (o chat nunca para)", () => {
    for (const sql of [MIGRATION_0905, BASELINE]) {
      const corpo = corpoDaFuncao(sql, "fn_billing_trava_channel_sessions");
      expect(corpo).not.toMatch(/fn_billing_modo_leitura/);
    }
  });
});

describe("0908 Tarefa 2: billing_assinatura nas três proteções de agent_inbox_items (decisão 9), idêntico em 0905 e no baseline", () => {
  it("as duas policies RESTRICTIVE (insert/delete) vetam ref_kind = billing_assinatura, ao lado de billing_limite/billing_carteira", () => {
    for (const sql of [MIGRATION_0905, extraiBloco0905Baseline()]) {
      expect(sql).toMatch(
        /create policy billing_agent_inbox_items_insert on public\.agent_inbox_items[\s\S]*?with check \(ref_kind is null or ref_kind not in \('billing_limite', 'billing_carteira', 'billing_assinatura'\)\);/,
      );
      expect(sql).toMatch(
        /create policy billing_agent_inbox_items_delete on public\.agent_inbox_items[\s\S]*?using \(ref_kind is null or ref_kind not in \('billing_limite', 'billing_carteira', 'billing_assinatura'\)\);/,
      );
    }
  });

  it("o gatilho de update (fn_billing_trava_agent_inbox_items_update) trava billing_assinatura junto com billing_limite/billing_carteira", () => {
    for (const sql of [MIGRATION_0905, extraiBloco0905Baseline()]) {
      const corpo = corpoDaFuncao(sql, "fn_billing_trava_agent_inbox_items_update");
      expect(corpo).toMatch(
        /old\.ref_kind in \('billing_limite', 'billing_carteira', 'billing_assinatura'\) or new\.ref_kind in \('billing_limite', 'billing_carteira', 'billing_assinatura'\)/,
      );
    }
  });
});

describe("0908 Tarefa 2: fn_billing_avisar_assinatura (decisão 9)", () => {
  it("é volatile, security definer, com search_path fixo, revoga de public/anon/authenticated e concede só a service_role (fora do bloco de execute do agent_worker)", () => {
    for (const sql of [MIGRATION_0908, BASELINE]) {
      const inicio = sql.indexOf("create or replace function public.fn_billing_avisar_assinatura(");
      expect(inicio, "fn_billing_avisar_assinatura não encontrada").toBeGreaterThan(-1);
      const trecho = sql.slice(inicio, inicio + 300);
      expect(trecho).toMatch(/returns void/);
      expect(trecho).toMatch(/\bvolatile\b/);
      expect(trecho).toMatch(/security definer/);
      expect(sql).toMatch(
        /revoke execute on function public\.fn_billing_avisar_assinatura\(uuid\) from public, anon, authenticated;/,
      );
      expect(sql).toMatch(
        /grant execute on function public\.fn_billing_avisar_assinatura\(uuid\) to service_role;/,
      );
      expect(sql).toMatch(
        /revoke execute on function public\.fn_billing_avisar_assinatura\(uuid\) from agent_worker/,
      );
    }
  });

  it("nunca lança: begin/exception PRÓPRIO devolve sem propagar (raise warning)", () => {
    const corpoCompleto = corpoDaFuncao(MIGRATION_0908, "fn_billing_avisar_assinatura");
    expect(corpoCompleto).toMatch(/exception\s*\n\s*when others then/);
    expect(corpoCompleto).toMatch(/raise warning 'billing_avisar_assinatura_falhou: organizacao=%, sqlerrm=%', p_org, sqlerrm;/);
  });

  it("aviso de entrada em atrasada: dedup 'assinatura:atrasada:<período>', kind=other, ref_kind=billing_assinatura, ref_id=organization_id", () => {
    const corpo = corpoDaFuncao(MIGRATION_0908, "fn_billing_avisar_assinatura");
    expect(corpo).toMatch(/values \(p_org, 'assinatura:atrasada:' \|\| v_periodo_fmt\)/);
    expect(corpo).toMatch(/on conflict \(organization_id, chave\) do nothing;/);
    expect(corpo).toMatch(/get diagnostics v_linhas = row_count;/);
    expect(corpo).toMatch(
      /values \(p_org, 'other', 'warn', v_titulo, v_corpo, 'billing_assinatura', p_org\);/,
    );
  });

  it("aviso de três dias antes: chave própria 'atrasada_aviso_3_dias', SÓ quando grace_days > 3 E a ameaça é real, contados da data REAL (correção segunda rodada F4, item 1: era v_data_suspensao, a prevista pelo plano, não greatest(prevista, bloqueio_a_partir_de))", () => {
    const corpo = corpoDaFuncao(MIGRATION_0908, "fn_billing_avisar_assinatura");
    expect(corpo).toMatch(/if v_ameaca_real and v_grace_days > 3 and now\(\) >= v_data_suspensao_real - interval '3 days' then/);
    expect(corpo).toMatch(/'assinatura:atrasada_aviso_3_dias:' \|\| v_periodo_fmt/);
  });

  it("v_data_suspensao_real = greatest(data prevista pelo plano, bloqueio_a_partir_de), calculada só quando a ameaça é real (correção segunda rodada F4, item 1)", () => {
    const corpo = corpoDaFuncao(MIGRATION_0908, "fn_billing_avisar_assinatura");
    expect(corpo).toMatch(/v_data_suspensao_real := greatest\(v_data_suspensao, v_bloqueio_a_partir_de\);/);
  });

  it("dedup pela data em America/Sao_Paulo, não no fuso da sessão (correção revisão F4, item 6)", () => {
    const corpo = corpoDaFuncao(MIGRATION_0908, "fn_billing_avisar_assinatura");
    expect(corpo).toMatch(
      /v_periodo_fmt := to_char\(v_current_period_end at time zone 'America\/Sao_Paulo', 'YYYY-MM-DD'\);/,
    );
  });

  it("textos de atrasada/suspensa só afirmam o efeito do modo leitura quando ele vale ou vai valer (correção revisão F4, item 7)", () => {
    const corpo = corpoDaFuncao(MIGRATION_0908, "fn_billing_avisar_assinatura");
    // atrasada: v_ameaca_real = modo bloquear E carência definida (mesmas
    // duas primeiras condições de fn_billing_bloqueia/fn_billing_modo_leitura).
    expect(corpo).toMatch(
      /v_ameaca_real := coalesce\(v_modo = 'bloquear' and v_bloqueio_a_partir_de is not null, false\);/,
    );
    expect(corpo).toMatch(/'O pagamento da assinatura está em atraso\. Regularize com o suporte\.'/);
    // suspensa: usa fn_billing_modo_leitura(p_org) diretamente (status já é suspensa).
    expect(corpo).toMatch(/if public\.fn_billing_modo_leitura\(p_org\) then/);
    expect(corpo).toMatch(/'A assinatura está suspensa por falta de pagamento\. Regularize com o suporte\.'/);
  });

  it("aviso de suspensão: chave 'assinatura:suspensa:<período>'; aviso de cancelamento: chave 'assinatura:cancelada:<período>'", () => {
    const corpo = corpoDaFuncao(MIGRATION_0908, "fn_billing_avisar_assinatura");
    expect(corpo).toMatch(/'assinatura:suspensa:' \|\| v_periodo_fmt/);
    expect(corpo).toMatch(/'assinatura:cancelada:' \|\| v_periodo_fmt/);
  });

  it("a data REAL da suspensão (v_data_suspensao_real) é formatada em America/Sao_Paulo, DD/MM/YYYY (sem nome de mês, correção segunda rodada F4, item 1: era v_data_suspensao, a prevista)", () => {
    const corpo = corpoDaFuncao(MIGRATION_0908, "fn_billing_avisar_assinatura");
    expect(corpo).toMatch(
      /to_char\(v_data_suspensao_real at time zone 'America\/Sao_Paulo', 'DD\/MM\/YYYY'\)/,
    );
    expect(corpo).not.toMatch(/'Month'|janeiro|fevereiro/);
  });

  it("chamada só por fn_billing_conferir_vencimento (é volatile, sem gatilho nenhum apontando para ela)", () => {
    expect(MIGRATION_0908).not.toMatch(/execute function public\.fn_billing_avisar_assinatura/);
  });
});

describe("0908 Tarefa 2 (achado da Tarefa 1): estorno duplo fechado por estorna_pagamento_id", () => {
  it("billing_payments ganha a coluna estorna_pagamento_id, sem chave estrangeira, com índice único parcial", () => {
    for (const sql of [MIGRATION_0908, BASELINE]) {
      expect(sql).toMatch(/alter table public\.billing_payments add column if not exists estorna_pagamento_id uuid;/);
      expect(sql).not.toMatch(/estorna_pagamento_id uuid references/);
      expect(sql).toMatch(
        /create unique index if not exists billing_payments_estorna_pagamento_id_unique\s*\n\s*on public\.billing_payments \(estorna_pagamento_id\)\s*\n\s*where estorna_pagamento_id is not null;/,
      );
    }
  });

  it("fn_billing_estornar_pagamento recusa 22023 quando o pagamento original já foi estornado por QUALQUER chave", () => {
    const corpo = corpoDaFuncao(MIGRATION_0908, "fn_billing_estornar_pagamento");
    expect(corpo).toMatch(
      /if exists \(\s*\n\s*select 1 from public\.billing_payments\s*\n\s*where organization_id = p_org and estorna_pagamento_id = p_pagamento\s*\n\s*\) then\s*\n\s*raise exception 'billing_pagamento_ja_estornado' using errcode = '22023';\s*\n\s*end if;/,
    );
  });

  it("esta checagem vem ANTES da checagem de status RECEIVED_IN_CASH (que sozinha não detecta o segundo estorno, pois o status ORIGINAL nunca muda)", () => {
    const corpo = corpoDaFuncao(MIGRATION_0908, "fn_billing_estornar_pagamento");
    const posEstornoDuplo = corpo.indexOf("billing_pagamento_ja_estornado");
    const posStatusCheck = corpo.indexOf("billing_pagamento_nao_pode_ser_estornado");
    expect(posEstornoDuplo).toBeGreaterThan(-1);
    expect(posStatusCheck).toBeGreaterThan(posEstornoDuplo);
  });

  it("grava estorna_pagamento_id = p_pagamento na linha REFUNDED", () => {
    const corpo = corpoDaFuncao(MIGRATION_0908, "fn_billing_estornar_pagamento");
    expect(corpo).toMatch(/chave, nota, criado_por,\s*\n\s*estorna_pagamento_id/);
    expect(corpo).toMatch(/p_chave, p_nota, p_actor,\s*\n\s*p_pagamento\s*\n\s*\)/);
  });
});

// ============================================================================
// Tarefa 3: catálogo de pacotes de tokens e D-046 (hiperbold/DEBITO.md).
// ============================================================================

describe("0908 Tarefa 3: posição da Parte 3 (depois da Parte 2, antes da VARREDURA anon)", () => {
  it("PARTE 3 vem depois do bloco de agent_worker de fn_billing_avisar_assinatura e antes da VARREDURA anon", () => {
    const inicioParte3 = BASELINE.indexOf("-- PARTE 3 (Tarefa 3): catálogo de pacotes de tokens vendidos na mão");
    const inicioParte2AgentWorker = BASELINE.indexOf(
      "revoke execute on function public.fn_billing_avisar_assinatura(uuid) from agent_worker",
    );
    const varreduraAnon = BASELINE.lastIndexOf("-- ---- VARREDURA anon:");
    expect(inicioParte3).toBeGreaterThan(-1);
    expect(inicioParte2AgentWorker).toBeGreaterThan(-1);
    expect(inicioParte3).toBeGreaterThan(inicioParte2AgentWorker);
    expect(inicioParte3).toBeLessThan(varreduraAnon);
  });

  it("o SQL da Parte 3 é igual entre a migração 0908 e o bloco do baseline (ignorando comentários e linhas em branco)", () => {
    const sqlMigracao = removeComentariosEBrancas(
      MIGRATION_0908.slice(MIGRATION_0908.indexOf("-- PARTE 3 (Tarefa 3)")),
    );
    const sqlBloco = removeComentariosEBrancas(
      extraiBloco0908Baseline().slice(extraiBloco0908Baseline().indexOf("-- PARTE 3 (Tarefa 3)")),
    );
    expect(sqlBloco).toBe(sqlMigracao);
  });
});

describe("0908 Tarefa 3: billing_token_pacotes (decisão 10)", () => {
  it("colunas: codigo único no formato de billing_plans.code, tokens positivo, preco_cents nulo ou não negativo, ativo", () => {
    for (const sql of [MIGRATION_0908, BASELINE]) {
      expect(sql).toMatch(/constraint billing_token_pacotes_codigo_unique unique \(codigo\)/);
      expect(sql).toMatch(
        /constraint billing_token_pacotes_codigo_formato check \(codigo ~ '\^\[a-z\]\[a-z0-9_\]\{1,30\}\$'\)/,
      );
      expect(sql).toMatch(/constraint billing_token_pacotes_tokens_positivo check \(tokens > 0\)/);
      expect(sql).toMatch(
        /constraint billing_token_pacotes_preco_cents_nao_negativo check \(preco_cents is null or preco_cents >= 0\)/,
      );
      expect(sql).toMatch(/ativo boolean not null default true,/);
    }
  });

  it("RLS ligada, nenhum grant para anon/authenticated, service_role com select+insert+update e SEM delete/truncate", () => {
    for (const sql of [MIGRATION_0908, BASELINE]) {
      expect(sql).toMatch(/alter table public\.billing_token_pacotes enable row level security;/);
      expect(sql).toMatch(/revoke all on public\.billing_token_pacotes from anon, authenticated;/);
      expect(sql).toMatch(/grant select, insert, update on public\.billing_token_pacotes to service_role;/);
      expect(sql).toMatch(/revoke delete, truncate on public\.billing_token_pacotes from service_role;/);
    }
  });

  it("nenhuma policy para authenticated (a tela lê pelo servidor) e nenhum semear de pacote (N9, nenhum preço inventado)", () => {
    const parte3 = MIGRATION_0908.slice(MIGRATION_0908.indexOf("-- PARTE 3 (Tarefa 3)"));
    expect(parte3).not.toMatch(/create policy[^;]*on public\.billing_token_pacotes/);
    expect(parte3).not.toMatch(/insert into public\.billing_token_pacotes/);
  });

  it("agent_worker perde select/insert/update/delete/truncate na tabela (correção revisão F4, item 1: a versão original deixava delete de pé)", () => {
    for (const sql of [MIGRATION_0908, extraiBloco0908Baseline()]) {
      expect(sql).toMatch(
        /revoke select, insert, update, delete, truncate on public\.billing_token_pacotes from agent_worker/,
      );
    }
  });
});

describe("0908 Tarefa 3: fn_billing_creditar_pacote (decisão 10)", () => {
  it("é security definer, volatile, com search_path fixo, revoga de public/anon/authenticated e concede só a service_role", () => {
    for (const sql of [MIGRATION_0908, BASELINE]) {
      const inicio = sql.indexOf("create or replace function public.fn_billing_creditar_pacote(");
      expect(inicio, "fn_billing_creditar_pacote não encontrada").toBeGreaterThan(-1);
      const trecho = sql.slice(inicio, inicio + 400);
      expect(trecho).toMatch(/returns jsonb/);
      expect(trecho).toMatch(/\bvolatile\b/);
      expect(trecho).toMatch(/security definer/);
      expect(trecho).toMatch(/set search_path = public, pg_temp/);
      expect(sql).toMatch(
        /revoke execute on function public\.fn_billing_creditar_pacote\(uuid, uuid, integer, uuid, text, uuid\) from public, anon, authenticated;/,
      );
      expect(sql).toMatch(
        /grant execute on function public\.fn_billing_creditar_pacote\(uuid, uuid, integer, uuid, text, uuid\) to service_role;/,
      );
    }
  });

  it("pacote inexistente é P0002; pacote inativo é 22023 (coalesce(..., false))", () => {
    const corpo = corpoDaFuncao(MIGRATION_0908, "fn_billing_creditar_pacote");
    expect(corpo).toMatch(/if not found then\s*\n\s*raise exception 'billing_pacote_nao_encontrado' using errcode = 'P0002';/);
    expect(corpo).toMatch(
      /if not coalesce\(v_pacote\.ativo, false\) then\s*\n\s*raise exception 'billing_pacote_inativo' using errcode = '22023';/,
    );
  });

  it("valor = preco_cents do catálogo, senão p_valor_cents; os dois ausentes é 22023 (N9)", () => {
    const corpo = corpoDaFuncao(MIGRATION_0908, "fn_billing_creditar_pacote");
    expect(corpo).toMatch(/v_valor_cents := coalesce\(v_pacote\.preco_cents, p_valor_cents\);/);
    expect(corpo).toMatch(
      /if v_valor_cents is null then\s*\n\s*raise exception 'billing_valor_obrigatorio' using errcode = '22023';/,
    );
  });

  it("delega para fn_billing_creditar_tokens (0906) com os tokens do pacote", () => {
    const corpo = corpoDaFuncao(MIGRATION_0908, "fn_billing_creditar_pacote");
    expect(corpo).toMatch(
      /v_credito := public\.fn_billing_creditar_tokens\(p_org, v_pacote\.tokens, p_chave, v_valor_cents, p_nota, p_actor\);/,
    );
  });

  it("agent_worker perde execute em fn_billing_creditar_pacote", () => {
    for (const sql of [MIGRATION_0908, extraiBloco0908Baseline()]) {
      expect(sql).toMatch(
        /revoke execute on function public\.fn_billing_creditar_pacote\(uuid, uuid, integer, uuid, text, uuid\) from agent_worker/,
      );
    }
  });
});

describe("0908 Tarefa 3: D-046 fechado (hiperbold/DEBITO.md)", () => {
  it("api_audit_log ganha a policy RESTRICTIVE for insert to authenticated with check (false), sem editar a policy do autor", () => {
    for (const sql of [MIGRATION_0908, BASELINE]) {
      expect(sql).toMatch(
        /create policy api_audit_log_insert_authenticated_restritiva on public\.api_audit_log\s*\n\s*as restrictive\s*\n\s*for insert to authenticated\s*\n\s*with check \(false\);/,
      );
    }
    // A policy do autor continua no baseline, intocada (mesmo texto de sempre).
    expect(BASELINE).toMatch(
      /CREATE POLICY "audit_log_insert_tenant_member" ON "public"\."api_audit_log" FOR INSERT TO "authenticated" WITH CHECK/,
    );
  });

  it("agent_worker perde select, insert, update, delete e truncate em api_audit_log (correção revisão F4, item 1: a versão original deixava select/insert de pé, e nenhum código lê/escreve a tabela pela conexão do worker)", () => {
    for (const sql of [MIGRATION_0908, extraiBloco0908Baseline()]) {
      expect(sql).toMatch(/revoke select, insert, update, delete, truncate on public\.api_audit_log from agent_worker/);
    }
  });
});
