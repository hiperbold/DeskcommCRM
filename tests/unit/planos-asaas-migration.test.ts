import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATION_0909 = readFileSync(
  join(process.cwd(), "supabase/migrations/20260924140000_0909_planos_asaas.sql"),
  "utf8",
);
const BASELINE = readFileSync(join(process.cwd(), "supabase", "baseline.sql"), "utf8");

/**
 * Extrai o bloco 0909 do baseline: do marcador de início até (sem incluir) o
 * cabeçalho do PRÓXIMO bloco (`-- ---- `). Mesmo extrator das migrações
 * 0905/0906/0907/0908 (tests/unit/planos-*-migration.test.ts).
 */
function extraiBloco0909Baseline(): string {
  const marcadorInicio = "-- ---- cobrança pelo Asaas: tabelas (migration 0909";
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

describe("0909 cobrança pelo Asaas (Tarefas 1 e 2): posição e igualdade do bloco no baseline", () => {
  it("o bloco vem depois do bloco da 0908 e antes da VARREDURA anon", () => {
    const inicioBloco0908 = BASELINE.indexOf(
      "-- ---- pagamentos, estados e conferidor de vencimento da assinatura (migration 0908",
    );
    const inicioBloco0909 = BASELINE.indexOf("-- ---- cobrança pelo Asaas: tabelas (migration 0909");
    const varreduraAnon = BASELINE.lastIndexOf("-- ---- VARREDURA anon:");

    expect(inicioBloco0908).toBeGreaterThan(-1);
    expect(inicioBloco0909).toBeGreaterThan(-1);
    expect(varreduraAnon).toBeGreaterThan(-1);
    expect(inicioBloco0908).toBeLessThan(inicioBloco0909);
    expect(inicioBloco0909).toBeLessThan(varreduraAnon);
  });

  it("o SQL da migração 0909 e o SQL do bloco do baseline são iguais, ignorando comentários e linhas em branco", () => {
    const sqlMigracao = removeComentariosEBrancas(MIGRATION_0909);
    const sqlBloco = removeComentariosEBrancas(extraiBloco0909Baseline());
    expect(sqlBloco).toBe(sqlMigracao);
  });

  it("nenhum travessão (U+2014) na migração nem no bloco do baseline", () => {
    const travessao = String.fromCharCode(8212);
    expect(MIGRATION_0909).not.toContain(travessao);
    expect(extraiBloco0909Baseline()).not.toContain(travessao);
  });
});

describe("0909: billing_customers (decisão 16)", () => {
  it("colunas e checks: ambiente, formato do asaas_customer_id, dois únicos", () => {
    for (const sql of [MIGRATION_0909, BASELINE]) {
      expect(sql).toMatch(/create table if not exists public\.billing_customers \(/);
      expect(sql).toMatch(
        /constraint billing_customers_ambiente_check check \(ambiente in \('sandbox', 'producao'\)\)/,
      );
      expect(sql).toMatch(
        /constraint billing_customers_asaas_customer_id_formato check \(asaas_customer_id ~ '\^cus_\[A-Za-z0-9\]\{1,64\}\$'\)/,
      );
      expect(sql).toMatch(
        /constraint billing_customers_organization_ambiente_unique unique \(organization_id, ambiente\)/,
      );
      expect(sql).toMatch(
        /constraint billing_customers_ambiente_asaas_customer_id_unique unique \(ambiente, asaas_customer_id\)/,
      );
    }
  });

  it("organization_id em cascata; criado_por SEM chave estrangeira", () => {
    const corpo = MIGRATION_0909.slice(
      MIGRATION_0909.indexOf("create table if not exists public.billing_customers"),
      MIGRATION_0909.indexOf("create table if not exists public.billing_orders"),
    );
    expect(corpo).toMatch(/organization_id uuid not null references public\.organizations\(id\) on delete cascade,/);
    expect(corpo).not.toMatch(/criado_por uuid references/);
  });
});

describe("0909: billing_orders (decisões 2, 6, 11, 25)", () => {
  it("external_reference é coluna GERADA a partir do id, e única", () => {
    for (const sql of [MIGRATION_0909, BASELINE]) {
      expect(sql).toMatch(
        /external_reference text generated always as \('HC:ord:' \|\| id::text\) stored,/,
      );
      expect(sql).toMatch(/constraint billing_orders_external_reference_unique unique \(external_reference\)/);
    }
  });

  it("status aceita processando, e o vocabulário fechado completo", () => {
    for (const sql of [MIGRATION_0909, BASELINE]) {
      expect(sql).toMatch(
        /constraint billing_orders_status_check check \(\s*\n\s*status in \('criado', 'processando', 'aguardando_pagamento', 'inconclusivo', 'pago', 'vencido', 'cancelado', 'falhou', 'estornado'\)\s*\n\s*\),/,
      );
    }
  });

  it("índice único parcial de pedido aberto inclui processando (decisão 25)", () => {
    for (const sql of [MIGRATION_0909, BASELINE]) {
      expect(sql).toMatch(
        /create unique index if not exists billing_orders_aberto_por_tipo_unique\s*\n\s*on public\.billing_orders \(organization_id, tipo\)\s*\n\s*where status in \('criado', 'aguardando_pagamento', 'inconclusivo', 'processando'\);/,
      );
    }
  });

  it("checks de coerência por tipo: assinatura exige plan_id/ciclo e proíbe pacote_id/tokens, e vice-versa", () => {
    for (const sql of [MIGRATION_0909, BASELINE]) {
      expect(sql).toMatch(
        /constraint billing_orders_coerencia_assinatura check \(\s*\n\s*tipo <> 'assinatura' or \(plan_id is not null and ciclo is not null and pacote_id is null and tokens is null\)\s*\n\s*\),/,
      );
      expect(sql).toMatch(
        /constraint billing_orders_coerencia_pacote check \(\s*\n\s*tipo <> 'pacote_tokens' or \(pacote_id is not null and tokens is not null and plan_id is null and ciclo is null\)\s*\n\s*\)/,
      );
    }
  });

  it("(organization_id, chave) único (decisão 11)", () => {
    for (const sql of [MIGRATION_0909, BASELINE]) {
      expect(sql).toMatch(
        /constraint billing_orders_organization_chave_unique unique \(organization_id, chave\)/,
      );
    }
  });

  it("asaas_payment_id, asaas_subscription_id e invoice_url: únicos parciais (só quando preenchidos, sem CHECK de formato aqui)", () => {
    for (const sql of [MIGRATION_0909, BASELINE]) {
      expect(sql).toMatch(
        /create unique index if not exists billing_orders_asaas_payment_id_unique\s*\n\s*on public\.billing_orders \(asaas_payment_id\)\s*\n\s*where asaas_payment_id is not null;/,
      );
      expect(sql).toMatch(
        /create unique index if not exists billing_orders_asaas_subscription_id_unique\s*\n\s*on public\.billing_orders \(asaas_subscription_id\)\s*\n\s*where asaas_subscription_id is not null;/,
      );
      expect(sql).toMatch(
        /create unique index if not exists billing_orders_invoice_url_unique\s*\n\s*on public\.billing_orders \(invoice_url\)\s*\n\s*where invoice_url is not null;/,
      );
    }
    const corpoOrders = MIGRATION_0909.slice(
      MIGRATION_0909.indexOf("create table if not exists public.billing_orders"),
      MIGRATION_0909.indexOf(");", MIGRATION_0909.indexOf("create table if not exists public.billing_orders")),
    );
    expect(corpoOrders).not.toMatch(/asaas_payment_id text check/);
    expect(corpoOrders).not.toMatch(/asaas_subscription_id text check/);
  });

  it("amount_cents positivo; metodo só CREDIT_CARD/PIX", () => {
    for (const sql of [MIGRATION_0909, BASELINE]) {
      expect(sql).toMatch(/constraint billing_orders_amount_cents_positivo check \(amount_cents > 0\)/);
      expect(sql).toMatch(/constraint billing_orders_metodo_check check \(metodo in \('CREDIT_CARD', 'PIX'\)\)/);
    }
  });

  it("trg_billing_orders_updated_at existe (mesmo padrão de billing_contracts/billing_settings)", () => {
    for (const sql of [MIGRATION_0909, BASELINE]) {
      expect(sql).toMatch(/drop trigger if exists trg_billing_orders_updated_at on public\.billing_orders;/);
      expect(sql).toMatch(
        /create trigger trg_billing_orders_updated_at\s*\n\s*before update on public\.billing_orders\s*\n\s*for each row execute function public\.fn_set_updated_at\(\);/,
      );
    }
  });
});

describe("0909: asaas_webhook_events (decisões 19, 20, 21)", () => {
  it("event_id único com tamanho 1..100; event_type com formato fechado", () => {
    for (const sql of [MIGRATION_0909, BASELINE]) {
      expect(sql).toMatch(/constraint asaas_webhook_events_event_id_unique unique \(event_id\)/);
      expect(sql).toMatch(
        /constraint asaas_webhook_events_event_id_tamanho check \(char_length\(event_id\) between 1 and 100\)/,
      );
      expect(sql).toMatch(
        /constraint asaas_webhook_events_event_type_formato check \(event_type ~ '\^\[A-Z_\]\{3,64\}\$'\)/,
      );
    }
  });

  it("resultado: vocabulário fechado com os oito valores da decisão 3/19", () => {
    for (const sql of [MIGRATION_0909, BASELINE]) {
      expect(sql).toMatch(
        /constraint asaas_webhook_events_resultado_check check \(\s*\n\s*resultado in \('aplicado', 'ja_aplicado', 'ignorado', 'outro_app', 'sem_vinculo', 'divergente', 'aguardando', 'erro'\)\s*\n\s*\),/,
      );
    }
  });

  it("lease_token e lease_expira_em existem (decisão 20)", () => {
    for (const sql of [MIGRATION_0909, BASELINE]) {
      expect(sql).toMatch(/lease_token uuid,/);
      expect(sql).toMatch(/lease_expira_em timestamptz,/);
    }
  });

  it("organization_id SEM chave estrangeira, de propósito", () => {
    const corpo = MIGRATION_0909.slice(
      MIGRATION_0909.indexOf("create table if not exists public.asaas_webhook_events"),
      MIGRATION_0909.indexOf(
        ");",
        MIGRATION_0909.indexOf("create table if not exists public.asaas_webhook_events"),
      ),
    );
    expect(corpo).toMatch(/organization_id uuid,/);
    expect(corpo).not.toMatch(/organization_id uuid references/);
  });

  it("índice dos pendentes por proxima_tentativa_em onde resultado = aguardando", () => {
    for (const sql of [MIGRATION_0909, BASELINE]) {
      expect(sql).toMatch(
        /create index if not exists asaas_webhook_events_pendentes_idx\s*\n\s*on public\.asaas_webhook_events \(proxima_tentativa_em\)\s*\n\s*where resultado = 'aguardando';/,
      );
    }
  });
});

describe("0909: billing_contracts.asaas_assinatura_encerrada_em (decisão 22)", () => {
  it("coluna nova, nullable, sem default", () => {
    for (const sql of [MIGRATION_0909, BASELINE]) {
      expect(sql).toMatch(
        /alter table public\.billing_contracts add column if not exists asaas_assinatura_encerrada_em timestamptz;/,
      );
    }
  });
});

describe("0909: billing_payments (decisões 8, 9)", () => {
  it("order_id: FK para billing_orders, on delete set null (não cascade)", () => {
    for (const sql of [MIGRATION_0909, BASELINE]) {
      expect(sql).toMatch(
        /alter table public\.billing_payments add column if not exists order_id uuid references public\.billing_orders\(id\) on delete set null;/,
      );
    }
  });

  it("origem: not null default manual, CHECK manual/asaas", () => {
    for (const sql of [MIGRATION_0909, BASELINE]) {
      expect(sql).toMatch(
        /alter table public\.billing_payments add column if not exists origem text not null default 'manual';/,
      );
      expect(sql).toMatch(/alter table public\.billing_payments drop constraint if exists billing_payments_origem_check;/);
      expect(sql).toMatch(
        /alter table public\.billing_payments add constraint billing_payments_origem_check check \(origem in \('manual', 'asaas'\)\);/,
      );
    }
  });

  it("CHECK de status recriado (drop + add) com os cinco valores do vocabulário Asaas", () => {
    for (const sql of [MIGRATION_0909, BASELINE]) {
      expect(sql).toMatch(
        /alter table public\.billing_payments drop constraint if exists billing_payments_status_check;/,
      );
      expect(sql).toMatch(
        /alter table public\.billing_payments add constraint billing_payments_status_check check \(\s*\n\s*status in \('RECEIVED_IN_CASH', 'CONFIRMED', 'RECEIVED', 'REFUNDED', 'CHARGEBACK_REQUESTED'\)\s*\n\s*\);/,
      );
    }
  });

  it("billing_period_start/end perdem NOT NULL, e o CHECK só permite nulo com origem=asaas", () => {
    for (const sql of [MIGRATION_0909, BASELINE]) {
      expect(sql).toMatch(
        /alter table public\.billing_payments alter column billing_period_start drop not null;/,
      );
      expect(sql).toMatch(
        /alter table public\.billing_payments alter column billing_period_end drop not null;/,
      );
      expect(sql).toMatch(
        /alter table public\.billing_payments drop constraint if exists billing_payments_periodo_check;/,
      );
      expect(sql).toMatch(
        /alter table public\.billing_payments add constraint billing_payments_periodo_check check \(\s*\n\s*\(billing_period_start is null\) = \(billing_period_end is null\)\s*\n\s*and \(billing_period_start is not null or origem = 'asaas'\)\s*\n\s*\);/,
      );
    }
  });

  it("índice de estorna_pagamento_id recriado (drop + create), restrito a status = REFUNDED (decisão 9)", () => {
    for (const sql of [MIGRATION_0909, BASELINE]) {
      expect(sql).toMatch(/drop index if exists billing_payments_estorna_pagamento_id_unique;/);
      expect(sql).toMatch(
        /create unique index if not exists billing_payments_estorna_pagamento_id_unique\s*\n\s*on public\.billing_payments \(estorna_pagamento_id\)\s*\n\s*where estorna_pagamento_id is not null and status = 'REFUNDED';/,
      );
    }
  });
});

describe("0909: billing_settings.compra_pelo_cliente (decisão 18)", () => {
  it("boolean not null default false", () => {
    for (const sql of [MIGRATION_0909, BASELINE]) {
      expect(sql).toMatch(
        /alter table public\.billing_settings add column if not exists compra_pelo_cliente boolean not null default false;/,
      );
    }
  });
});

describe("0909: comentário de topo já não diz 'só as Tarefas 1 e 2'", () => {
  it("o comentário de topo da migração menciona as Tarefas 1 a 6", () => {
    expect(MIGRATION_0909).not.toMatch(/traz só as Tarefas 1 e 2/);
    expect(MIGRATION_0909).not.toMatch(/Tarefas 1 a 5 da fase/);
    expect(MIGRATION_0909).toMatch(/Tarefas 1 a 6/);
  });
});

describe("0909: fn_billing_protege_assinatura_asaas + trg_billing_protege_assinatura_asaas (decisão 22)", () => {
  it("a função raise exception quando asaas_subscription_id preenchido e o marcador nulo, e SEMPRE devolve old (nunca null)", () => {
    for (const sql of [MIGRATION_0909, extraiBloco0909Baseline()]) {
      const inicio = sql.indexOf("create or replace function public.fn_billing_protege_assinatura_asaas()");
      expect(inicio, "fn_billing_protege_assinatura_asaas não encontrada").toBeGreaterThan(-1);
      const fim = sql.indexOf("$$;", inicio);
      const corpo = sql.slice(inicio, fim);
      expect(corpo).toMatch(/security definer/);
      expect(corpo).toMatch(/set search_path = public, pg_temp/);
      expect(corpo).toMatch(
        /if old\.asaas_subscription_id is not null and old\.asaas_assinatura_encerrada_em is null then\s*\n\s*raise exception 'billing_cancele_no_asaas_antes' using errcode = '22023';\s*\n\s*end if;/,
      );
      expect(corpo).toMatch(/return old;/);
      expect(corpo).not.toMatch(/return null;/);
    }
  });

  it("é BEFORE DELETE em billing_contracts (drop trigger if exists + create trigger)", () => {
    for (const sql of [MIGRATION_0909, BASELINE]) {
      expect(sql).toMatch(
        /drop trigger if exists trg_billing_protege_assinatura_asaas on public\.billing_contracts;/,
      );
      expect(sql).toMatch(
        /create trigger trg_billing_protege_assinatura_asaas\s*\n\s*before delete on public\.billing_contracts\s*\n\s*for each row execute function public\.fn_billing_protege_assinatura_asaas\(\);/,
      );
    }
  });

  it("revoga execute de public/anon/authenticated e concede só a service_role", () => {
    for (const sql of [MIGRATION_0909, BASELINE]) {
      expect(sql).toMatch(
        /revoke execute on function public\.fn_billing_protege_assinatura_asaas\(\) from public, anon, authenticated;/,
      );
      expect(sql).toMatch(
        /grant execute on function public\.fn_billing_protege_assinatura_asaas\(\) to service_role;/,
      );
    }
  });

  it("agent_worker (se a role existir) perde execute na função de gatilho", () => {
    for (const sql of [MIGRATION_0909, extraiBloco0909Baseline()]) {
      expect(sql).toMatch(
        /revoke execute on function public\.fn_billing_protege_assinatura_asaas\(\) from agent_worker/,
      );
    }
  });
});

describe("0909: grants das três tabelas novas (Tarefa 2)", () => {
  const TABELAS = ["billing_customers", "billing_orders", "asaas_webhook_events"] as const;

  it("RLS ligada nas três, sem nenhuma policy criada por esta migração", () => {
    for (const sql of [MIGRATION_0909, BASELINE]) {
      for (const tabela of TABELAS) {
        expect(sql).toMatch(new RegExp(`alter table public\\.${tabela} enable row level security;`));
      }
    }
    for (const tabela of TABELAS) {
      expect(MIGRATION_0909).not.toMatch(new RegExp(`create policy[^;]*on public\\.${tabela}`));
    }
  });

  it("revoke all de anon/authenticated nas três", () => {
    for (const sql of [MIGRATION_0909, BASELINE]) {
      for (const tabela of TABELAS) {
        expect(sql).toMatch(new RegExp(`revoke all on public\\.${tabela} from anon, authenticated;`));
      }
    }
  });

  it("service_role só select nas três (revoke insert/update/delete/truncate logo depois do grant select)", () => {
    for (const sql of [MIGRATION_0909, BASELINE]) {
      for (const tabela of TABELAS) {
        expect(sql).toMatch(new RegExp(`grant select on public\\.${tabela} to service_role;`));
        expect(sql).toMatch(
          new RegExp(`revoke insert, update, delete, truncate on public\\.${tabela} from service_role;`),
        );
      }
    }
  });

  it("agent_worker (se a role existir) perde select/insert/update/delete/truncate nas três, num único bloco condicional", () => {
    for (const sql of [MIGRATION_0909, extraiBloco0909Baseline()]) {
      expect(sql).toMatch(/if exists \(select 1 from pg_roles where rolname = 'agent_worker'\) then/);
      expect(sql).toMatch(
        /revoke select, insert, update, delete, truncate on public\.billing_customers, public\.billing_orders, public\.asaas_webhook_events from agent_worker/,
      );
    }
  });
});

describe("0909: nenhuma chamada real ao Asaas (restrição fixa 1 da fase)", () => {
  it("a migração não referencia URL de API nem chave do Asaas", () => {
    expect(MIGRATION_0909).not.toMatch(/api\.asaas\.com/);
    expect(MIGRATION_0909).not.toMatch(/api-sandbox\.asaas\.com/);
    expect(MIGRATION_0909).not.toMatch(/aact_/);
  });
});

// ============================================================================
// TAREFA 3: pedido, cliente e chaves.
// ============================================================================

describe("0909 Tarefa 3: as sete funções existem, com a assinatura do plano, em security definer", () => {
  const FUNCOES: Array<{ nome: string; assinatura: string }> = [
    { nome: "fn_billing_definir_compra_pelo_cliente", assinatura: "(boolean, uuid)" },
    { nome: "fn_billing_definir_a_venda", assinatura: "(text, boolean, uuid)" },
    {
      nome: "fn_billing_criar_pedido",
      assinatura: "(uuid, text, text, text, text, text, text, uuid, uuid)",
    },
    { nome: "fn_billing_pedido_tomar", assinatura: "(uuid, uuid)" },
    { nome: "fn_billing_vincular_cliente_asaas", assinatura: "(uuid, text, text)" },
    {
      nome: "fn_billing_pedido_registrar_cobranca",
      assinatura: "(uuid, uuid, text, text, text)",
    },
    { nome: "fn_billing_pedido_marcar", assinatura: "(uuid, uuid, text, text)" },
  ];

  it.each(FUNCOES)("$nome$assinatura existe na migração e no bloco do baseline, com security definer e search_path fixo", ({ nome, assinatura }) => {
    for (const sql of [MIGRATION_0909, extraiBloco0909Baseline()]) {
      const criacao = new RegExp(`create or replace function public\\.${nome}\\(`);
      expect(sql, `${nome} não encontrada`).toMatch(criacao);

      const inicio = sql.indexOf(`create or replace function public.${nome}(`);
      const fim = sql.indexOf("\n$$;", inicio);
      const corpo = sql.slice(inicio, fim);
      expect(corpo, `${nome} sem security definer`).toMatch(/security definer/);
      expect(corpo, `${nome} sem search_path fixo`).toMatch(/set search_path = public, pg_temp/);

      const assinaturaEscapada = assinatura.replace(/[()]/g, (c) => `\\${c}`);
      expect(sql, `${nome}${assinatura} não tem revoke de public/anon/authenticated`).toMatch(
        new RegExp(`revoke execute on function public\\.${nome}${assinaturaEscapada} from public, anon, authenticated;`),
      );
      expect(sql, `${nome}${assinatura} não tem grant só a service_role`).toMatch(
        new RegExp(`grant execute on function public\\.${nome}${assinaturaEscapada} to service_role;`),
      );
    }
  });

  it("agent_worker (se a role existir) perde execute nas sete funções, num único bloco condicional", () => {
    for (const sql of [MIGRATION_0909, extraiBloco0909Baseline()]) {
      // Âncora pelo comentário da seção 16 (único: "sete funções da\n--
      // Tarefa 3"), não pelo último "if exists" do arquivo: a Tarefa 4
      // (seção 23, abaixo) acrescentou um QUARTO bloco condicional de
      // agent_worker depois deste, e lastIndexOf passaria a pegar o dela.
      const ancora = sql.indexOf("perde execute nas sete funções da");
      expect(ancora, "comentário da seção 16 (Tarefa 3) não encontrado").toBeGreaterThan(-1);
      const inicio = sql.indexOf("if exists (select 1 from pg_roles where rolname = 'agent_worker') then", ancora);
      expect(inicio, "bloco condicional de agent_worker da Tarefa 3 não encontrado").toBeGreaterThan(-1);
      const fim = sql.indexOf("$$;", inicio);
      const corpo = sql.slice(inicio, fim);
      for (const { nome } of FUNCOES) {
        expect(corpo, `${nome} não está no revoke de agent_worker da Tarefa 3`).toContain(`public.${nome}(`);
      }
    }
  });
});

describe("0909 Tarefa 3: fn_billing_criar_pedido, as seis mensagens de recusa do plano e a ordem das travas (decisão 12)", () => {
  it("as seis mensagens próprias existem no corpo da função", () => {
    const inicio = MIGRATION_0909.indexOf("create or replace function public.fn_billing_criar_pedido(");
    const fim = MIGRATION_0909.indexOf("\n$$;", inicio);
    const corpo = MIGRATION_0909.slice(inicio, fim);

    for (const mensagem of [
      "billing_compra_desligada",
      "billing_plano_fora_de_venda",
      "billing_preco_nao_definido",
      "billing_metodo_invalido_para_oferta",
      "billing_ja_tem_assinatura_asaas",
      "billing_pedido_aberto_existe",
      "billing_chave_com_valores_diferentes",
    ]) {
      expect(corpo, `mensagem ${mensagem} ausente de fn_billing_criar_pedido`).toContain(mensagem);
    }
  });

  it("lê billing_settings SEM for share nem for update (decisão 12)", () => {
    const inicio = MIGRATION_0909.indexOf("create or replace function public.fn_billing_criar_pedido(");
    const fim = MIGRATION_0909.indexOf("\n$$;", inicio);
    const corpo = MIGRATION_0909.slice(inicio, fim);

    const leituraSettings = corpo.match(/select compra_pelo_cliente into v_compra_pelo_cliente\s*\n\s*from public\.billing_settings\s*\n\s*where id = 1;/);
    expect(leituraSettings, "a leitura de billing_settings deveria existir, sem for share/for update").not.toBeNull();
  });

  it("usa só o advisory lock billing_assinatura:<org> (a segunda trava da ordem fixa, decisão 12), nunca billing:<org>", () => {
    const inicio = MIGRATION_0909.indexOf("create or replace function public.fn_billing_criar_pedido(");
    const fim = MIGRATION_0909.indexOf("\n$$;", inicio);
    const corpo = MIGRATION_0909.slice(inicio, fim);

    expect(corpo).toMatch(/pg_advisory_xact_lock\(hashtextextended\('billing_assinatura:' \|\| p_org::text, 0\)\)/);
    expect(corpo).not.toMatch(/pg_advisory_xact_lock\(hashtextextended\('billing:' \|\| p_org::text, 0\)\)/);
  });

  it("devolve proxima_cobranca_em (decisão 26)", () => {
    const inicio = MIGRATION_0909.indexOf("create or replace function public.fn_billing_criar_pedido(");
    const fim = MIGRATION_0909.indexOf("\n$$;", inicio);
    const corpo = MIGRATION_0909.slice(inicio, fim);

    expect(corpo).toMatch(/at time zone 'America\/Sao_Paulo'\)::date/);
    expect(corpo).toContain("'proxima_cobranca_em', v_proxima_cobranca_em");
  });
});

describe("0909 Tarefa 3: fn_billing_pedido_tomar é a posse atômica pelo próprio update, sem advisory lock (decisão 25)", () => {
  it("o update condicional está presente, e nenhum pg_advisory_xact_lock aparece no corpo", () => {
    const inicio = MIGRATION_0909.indexOf("create or replace function public.fn_billing_pedido_tomar(");
    const fim = MIGRATION_0909.indexOf("\n$$;", inicio);
    const corpo = MIGRATION_0909.slice(inicio, fim);

    expect(corpo).toMatch(
      /update public\.billing_orders\s*\n\s*set status = 'processando'\s*\n\s*where id = p_pedido and organization_id = p_org and status in \('criado', 'inconclusivo'\)/,
    );
    expect(corpo).not.toMatch(/pg_advisory_xact_lock/);
  });
});

describe("0909 Tarefa 3: fn_billing_vincular_cliente_asaas usa billing:<org>, a primeira trava da ordem fixa (decisão 12)", () => {
  it("o advisory lock é billing:<org>, não billing_assinatura:<org>", () => {
    const inicio = MIGRATION_0909.indexOf("create or replace function public.fn_billing_vincular_cliente_asaas(");
    const fim = MIGRATION_0909.indexOf("\n$$;", inicio);
    const corpo = MIGRATION_0909.slice(inicio, fim);

    expect(corpo).toMatch(/pg_advisory_xact_lock\(hashtextextended\('billing:' \|\| p_org::text, 0\)\)/);
    expect(corpo).not.toMatch(/pg_advisory_xact_lock\(hashtextextended\('billing_assinatura:' \|\| p_org::text, 0\)\)/);
  });

  it("42501 é o código de outra organização, 22023 o de vínculo diferente na mesma organização", () => {
    const inicio = MIGRATION_0909.indexOf("create or replace function public.fn_billing_vincular_cliente_asaas(");
    const fim = MIGRATION_0909.indexOf("\n$$;", inicio);
    const corpo = MIGRATION_0909.slice(inicio, fim);

    expect(corpo).toMatch(/raise exception 'billing_organizacao_ja_tem_outro_cliente_asaas' using errcode = '22023';/);
    expect(corpo).toMatch(/raise exception 'billing_cliente_asaas_de_outra_organizacao' using errcode = '42501';/);
  });
});

describe("0909 Tarefa 3: fn_billing_pedido_registrar_cobranca amarra invoice_url ao ambiente do PRÓPRIO pedido (decisão 6, risco de redirecionamento aberto)", () => {
  it("formatos ^pay_ e ^sub_, e a URL comparada contra v_pedido.ambiente (nunca uma variável global)", () => {
    const inicio = MIGRATION_0909.indexOf("create or replace function public.fn_billing_pedido_registrar_cobranca(");
    const fim = MIGRATION_0909.indexOf("\n$$;", inicio);
    const corpo = MIGRATION_0909.slice(inicio, fim);

    expect(corpo).toContain("p_asaas_payment_id !~ '^pay_'");
    expect(corpo).toContain("p_asaas_subscription_id !~ '^sub_'");
    expect(corpo).toMatch(/v_pedido\.ambiente = 'sandbox' and p_invoice_url !~ '\^https:\/\/sandbox\\\.asaas\\\.com\/'/);
    expect(corpo).toMatch(/v_pedido\.ambiente = 'producao' and p_invoice_url !~/);
  });
});

describe("0909 Tarefa 3: fn_billing_pedido_marcar nunca a partir de pago", () => {
  // Correção (revisão F5, item 7): PARTE 7 redefine esta função (inconclusivo
  // só a partir de processando); ancora na ÚLTIMA definição (CLAUDE.md, item
  // 10; tests/unit/sonda-do-baseline-ancora-na-ultima-definicao.test.ts), a
  // que o banco realmente instala.
  it("só inconclusivo/falhou/cancelado, e recusa a partir de pago", () => {
    const inicio = MIGRATION_0909.lastIndexOf("create or replace function public.fn_billing_pedido_marcar(");
    const fim = MIGRATION_0909.indexOf("\n$$;", inicio);
    const corpo = MIGRATION_0909.slice(inicio, fim);

    expect(corpo).toMatch(/p_status not in \('inconclusivo', 'falhou', 'cancelado'\)/);
    expect(corpo).toMatch(/if v_pedido\.status = 'pago' then\s*\n\s*raise exception 'billing_pedido_ja_pago'/);
  });

  it("PARTE 7 (item 7): inconclusivo só a partir de processando", () => {
    const inicio = MIGRATION_0909.lastIndexOf("create or replace function public.fn_billing_pedido_marcar(");
    const fim = MIGRATION_0909.indexOf("\n$$;", inicio);
    const corpo = MIGRATION_0909.slice(inicio, fim);
    expect(corpo).toMatch(
      /if p_status = 'inconclusivo' and v_pedido\.status <> 'processando' then\s*\n\s*raise exception 'billing_pedido_nao_esta_processando'/,
    );
  });
});

// ============================================================================
// TAREFA 4: registrar, reservar com lease, falha, reprocessar, podar.
// ============================================================================

describe("0909 Tarefa 4: as seis peças existem, com a assinatura do plano, em security definer", () => {
  const FUNCOES_TAREFA_4: Array<{ nome: string; assinatura: string; temGrant: boolean }> = [
    { nome: "fn_billing_asaas_registrar_evento", assinatura: "(text, text, text, text, text, jsonb)", temGrant: true },
    { nome: "fn_billing_asaas_reservar_eventos", assinatura: "(integer, integer)", temGrant: true },
    { nome: "fn_billing_asaas_lease_e_meu", assinatura: "(uuid, uuid)", temGrant: false },
    { nome: "fn_billing_asaas_registrar_falha", assinatura: "(uuid, uuid, text)", temGrant: true },
    { nome: "fn_billing_asaas_reprocessar_evento", assinatura: "(uuid, uuid)", temGrant: true },
    { nome: "fn_billing_asaas_podar_eventos", assinatura: "(integer)", temGrant: true },
  ];

  it.each(FUNCOES_TAREFA_4)(
    "$nome$assinatura existe na migração e no bloco do baseline, com security definer e search_path fixo",
    ({ nome, assinatura, temGrant }) => {
      for (const sql of [MIGRATION_0909, extraiBloco0909Baseline()]) {
        const criacao = new RegExp(`create or replace function public\\.${nome}\\(`);
        expect(sql, `${nome} não encontrada`).toMatch(criacao);

        const inicio = sql.indexOf(`create or replace function public.${nome}(`);
        const fimCorpo = nome === "fn_billing_asaas_lease_e_meu" ? sql.indexOf("$$;", inicio) : sql.indexOf("\n$$;", inicio);
        const corpo = sql.slice(inicio, fimCorpo);
        expect(corpo, `${nome} sem security definer`).toMatch(/security definer/);
        expect(corpo, `${nome} sem search_path fixo`).toMatch(/set search_path = public, pg_temp/);

        const assinaturaEscapada = assinatura.replace(/[()]/g, (c) => `\\${c}`);
        if (temGrant) {
          expect(sql, `${nome}${assinatura} não tem revoke de public/anon/authenticated`).toMatch(
            new RegExp(`revoke execute on function public\\.${nome}${assinaturaEscapada} from public, anon, authenticated;`),
          );
          expect(sql, `${nome}${assinatura} não tem grant só a service_role`).toMatch(
            new RegExp(`grant execute on function public\\.${nome}${assinaturaEscapada} to service_role;`),
          );
        } else {
          // fn_billing_asaas_lease_e_meu: o revoke inclui service_role
          // explicitamente (este banco tem alter default privileges que
          // concede EXECUTE a service_role por padrão, o mesmo mecanismo do
          // agent_worker); sem isso a função ficaria executável de graça.
          expect(sql, `${nome}${assinatura} não tem revoke de public/anon/authenticated/service_role`).toMatch(
            new RegExp(`revoke execute on function public\\.${nome}${assinaturaEscapada} from public, anon, authenticated, service_role;`),
          );
          expect(sql, `${nome}${assinatura} é interna e NÃO deveria ter grant a service_role`).not.toMatch(
            new RegExp(`grant execute on function public\\.${nome}${assinaturaEscapada} to service_role;`),
          );
        }
      }
    },
  );

  it("agent_worker (se a role existir) perde execute nas seis funções, num único bloco condicional", () => {
    for (const sql of [MIGRATION_0909, extraiBloco0909Baseline()]) {
      // Âncora pelo comentário da seção 23 (único: "seis funções da\n--
      // Tarefa 4"), não pelo último "if exists" do arquivo: a Tarefa 5
      // (seção 30, abaixo) acrescentou um QUINTO bloco condicional de
      // agent_worker depois deste, e lastIndexOf passaria a pegar o dela
      // (mesmo ajuste já feito para a Tarefa 3, acima).
      const ancora = sql.indexOf("perde execute nas seis funções da");
      expect(ancora, "comentário da seção 23 (Tarefa 4) não encontrado").toBeGreaterThan(-1);
      const inicio = sql.indexOf("if exists (select 1 from pg_roles where rolname = 'agent_worker') then", ancora);
      expect(inicio, "bloco condicional de agent_worker da Tarefa 4 não encontrado").toBeGreaterThan(-1);
      const fim = sql.indexOf("$$;", inicio);
      const corpo = sql.slice(inicio, fim);
      for (const { nome } of FUNCOES_TAREFA_4) {
        expect(corpo, `${nome} não está no revoke de agent_worker da Tarefa 4`).toContain(`public.${nome}(`);
      }
    }
  });
});

describe("0909 Tarefa 4: fn_billing_asaas_registrar_evento, idempotência e quarentena (decisão 19/M6)", () => {
  // Correção (revisão F5, item 8): PARTE 7 redefine esta função (prefixo
  // reservado conc:/quarentena: do webhook); ancora na ÚLTIMA definição.
  const corpo = (() => {
    const inicio = MIGRATION_0909.lastIndexOf("create or replace function public.fn_billing_asaas_registrar_evento(");
    const fim = MIGRATION_0909.indexOf("\n$$;", inicio);
    return MIGRATION_0909.slice(inicio, fim);
  })();

  it("PARTE 7 (item 8): prefixo reservado conc:/quarentena: do webhook vai para quarentena", () => {
    expect(corpo).toMatch(
      /p_origem = 'webhook' and \(p_event_id like 'conc:%' or p_event_id like 'quarentena:%'\)/,
    );
  });

  it("on conflict (event_id) do nothing (evento repetido guardado uma vez só)", () => {
    expect(corpo).toMatch(/on conflict \(event_id\) do nothing/);
  });

  it("checa o formato de event_id (1..100) e de event_type (^[A-Z_]{3,64}$) antes de inserir", () => {
    expect(corpo).toMatch(/char_length\(p_event_id\) < 1 or char_length\(p_event_id\) > 100/);
    expect(corpo).toMatch(/p_event_type !~ '\^\[A-Z_\]\{3,64\}\$'/);
  });

  it("teto de 64 KB (65536 bytes) medido no payload", () => {
    expect(corpo).toMatch(/octet_length\(p_payload::text\) > 65536/);
  });

  it("quarentena grava resultado erro, payload CORTADO (jsonb_build_object, nunca o original) e devolve sucesso", () => {
    expect(corpo).toMatch(/v_resultado := 'erro';/);
    expect(corpo).toMatch(/v_payload := jsonb_build_object\('quarentena', true, 'motivo', v_erro_codigo\);/);
    // O retorno (jsonb_build_object com 'novo') não lança exceção nenhuma no
    // caminho de quarentena: nenhum "raise exception" depois do bloco "if
    // v_quarentena then".
    const trechoQuarentena = corpo.slice(corpo.indexOf("if v_quarentena then"));
    expect(trechoQuarentena).not.toMatch(/raise exception/);
  });

  it("erro_codigo cortado em 200 caracteres no insert", () => {
    expect(corpo).toMatch(/left\(v_erro_codigo, 200\)/);
  });
});

describe("0909 Tarefa 4: fn_billing_asaas_reservar_eventos, skip locked e lease (decisão 20)", () => {
  const corpo = (() => {
    const inicio = MIGRATION_0909.indexOf("create or replace function public.fn_billing_asaas_reservar_eventos(");
    const fim = MIGRATION_0909.indexOf("\n$$;", inicio);
    return MIGRATION_0909.slice(inicio, fim);
  })();

  it("for update skip locked, só resultado = aguardando", () => {
    expect(corpo).toMatch(/for update skip locked/);
    expect(corpo).toMatch(/aw\.resultado = 'aguardando'/);
  });

  it("proxima_tentativa_em vencido (nulo ou passado) e lease vencido ou nulo", () => {
    expect(corpo).toMatch(/aw\.proxima_tentativa_em is null or aw\.proxima_tentativa_em <= now\(\)/);
    expect(corpo).toMatch(/aw\.lease_expira_em is null or aw\.lease_expira_em < now\(\)/);
  });

  it("grava lease_token novo (gen_random_uuid) com validade p_lease_segundos", () => {
    expect(corpo).toMatch(/lease_token = gen_random_uuid\(\)/);
    expect(corpo).toMatch(/lease_expira_em = now\(\) \+ \(p_lease_segundos \|\| ' seconds'\)::interval/);
  });

  it("p_lease_segundos tem default 300 na assinatura", () => {
    const assinatura = MIGRATION_0909.slice(
      MIGRATION_0909.indexOf("create or replace function public.fn_billing_asaas_reservar_eventos("),
      MIGRATION_0909.indexOf(")\nreturns table"),
    );
    expect(assinatura).toMatch(/p_lease_segundos integer default 300/);
  });
});

describe("0909 Tarefa 4: fn_billing_asaas_lease_e_meu, interna e sem grant a service_role", () => {
  it("confere lease_token igual e lease_expira_em no futuro", () => {
    const inicio = MIGRATION_0909.indexOf("create or replace function public.fn_billing_asaas_lease_e_meu(");
    const fim = MIGRATION_0909.indexOf("$$;", inicio);
    const corpo = MIGRATION_0909.slice(inicio, fim);
    expect(corpo).toMatch(/lease_token = p_lease_token/);
    expect(corpo).toMatch(/lease_expira_em > now\(\)/);
  });
});

describe("0909 Tarefa 4: fn_billing_asaas_registrar_falha, lease alheio recusado e backoff (decisão 20)", () => {
  const corpo = (() => {
    const inicio = MIGRATION_0909.indexOf("create or replace function public.fn_billing_asaas_registrar_falha(");
    const fim = MIGRATION_0909.indexOf("\n$$;", inicio);
    return MIGRATION_0909.slice(inicio, fim);
  })();

  it("recusa quando o lease não é mais o do chamador", () => {
    expect(corpo).toMatch(
      /if p_lease_token is null or v_evento\.lease_token is distinct from p_lease_token then\s*\n\s*raise exception 'billing_lease_invalido' using errcode = '22023';/,
    );
  });

  it("tentativas + 1, vira erro na décima (tentativas >= 10)", () => {
    expect(corpo).toMatch(/v_tentativas := v_evento\.tentativas \+ 1;/);
    expect(corpo).toMatch(/if v_tentativas >= 10 then\s*\n\s*v_resultado := 'erro';/);
  });

  it("backoff now() + least(2^tentativas minutos, 6 horas)", () => {
    expect(corpo).toMatch(/least\(\s*\n\s*power\(2::double precision, v_tentativas::double precision\) \* interval '1 minute',\s*\n\s*interval '6 hours'\s*\n\s*\)/);
  });

  it("erro_codigo cortado em 200 caracteres", () => {
    expect(corpo).toMatch(/erro_codigo = left\(p_codigo, 200\)/);
  });
});

describe("0909 Tarefa 4: fn_billing_asaas_reprocessar_evento, a partir de erro (PARTE 7, item 12: também sem_vinculo)", () => {
  // Correção (revisão F5, item 12): PARTE 7 redefine esta função (aceita
  // também sem_vinculo); ancora na ÚLTIMA definição, a que vale de verdade.
  it("recusa fora de resultado = erro/sem_vinculo, e zera tentativas/proxima_tentativa_em/erro_codigo/lease", () => {
    const inicio = MIGRATION_0909.lastIndexOf("create or replace function public.fn_billing_asaas_reprocessar_evento(");
    const fim = MIGRATION_0909.indexOf("\n$$;", inicio);
    const corpo = MIGRATION_0909.slice(inicio, fim);

    expect(corpo).toMatch(
      /if v_evento\.resultado not in \('erro', 'sem_vinculo'\) then\s*\n\s*raise exception 'billing_evento_nao_esta_em_erro' using errcode = '22023';/,
    );
    expect(corpo).toMatch(/tentativas = 0,/);
    expect(corpo).toMatch(/proxima_tentativa_em = now\(\),/);
    expect(corpo).toMatch(/erro_codigo = null,/);
    expect(corpo).toMatch(/lease_token = null,/);
  });
});

describe("0909 Tarefa 4: fn_billing_asaas_podar_eventos, payload vira {} e marca payload_podado_em (decisão 21/N38)", () => {
  it("where payload_podado_em is null and recebido_em mais velho que p_dias", () => {
    const inicio = MIGRATION_0909.indexOf("create or replace function public.fn_billing_asaas_podar_eventos(");
    const fim = MIGRATION_0909.indexOf("\n$$;", inicio);
    const corpo = MIGRATION_0909.slice(inicio, fim);

    expect(corpo).toMatch(/set payload = '\{\}'::jsonb,/);
    expect(corpo).toMatch(/payload_podado_em = now\(\)/);
    expect(corpo).toMatch(/where payload_podado_em is null\s*\n\s*and recebido_em < now\(\) - \(p_dias \|\| ' days'\)::interval;/);
    expect(corpo).toMatch(/get diagnostics v_quantos = row_count;/);
  });
});

// ============================================================================
// TAREFA 5: pagamento, período, troca de plano, pacote.
// ============================================================================

describe("0909 Tarefa 5: asaas_webhook_events.alarme e billing_contract_eventos.tipo ganham a peça nova", () => {
  it("alarme text nullable existe", () => {
    for (const sql of [MIGRATION_0909, BASELINE]) {
      expect(sql).toMatch(/alter table public\.asaas_webhook_events add column if not exists alarme text;/);
    }
  });

  it("billing_contract_eventos_tipo_check é recriado (drop + add) com 'plano' incluído (B6)", () => {
    for (const sql of [MIGRATION_0909, BASELINE]) {
      expect(sql).toMatch(
        /alter table public\.billing_contract_eventos drop constraint if exists billing_contract_eventos_tipo_check;/,
      );
      expect(sql).toMatch(
        /alter table public\.billing_contract_eventos add constraint billing_contract_eventos_tipo_check check \(\s*\n\s*tipo in \('estado', 'periodo', 'cancelar_no_fim', 'conferidor', 'plano'\)\s*\n\s*\);/,
      );
    }
  });
});

describe("0909 Tarefa 5: as quatro peças existem, com a assinatura do plano, em security definer", () => {
  const FUNCOES_TAREFA_5: Array<{ nome: string; assinatura: string; temGrant: boolean }> = [
    { nome: "fn_billing_asaas_periodo_do_ciclo", assinatura: "(date, text)", temGrant: false },
    { nome: "fn_billing_asaas_rotear_pagamento", assinatura: "(text, text, text, text)", temGrant: false },
    { nome: "fn_billing_asaas_aplicar_pagamento", assinatura: "(jsonb, text)", temGrant: false },
    { nome: "fn_billing_asaas_aplicar_evento", assinatura: "(uuid, uuid, jsonb)", temGrant: true },
  ];

  it.each(FUNCOES_TAREFA_5)(
    "$nome$assinatura existe na migração e no bloco do baseline, com security definer e search_path fixo",
    ({ nome, assinatura, temGrant }) => {
      for (const sql of [MIGRATION_0909, extraiBloco0909Baseline()]) {
        const criacao = new RegExp(`create or replace function public\\.${nome}\\(`);
        expect(sql, `${nome} não encontrada`).toMatch(criacao);

        const inicio = sql.indexOf(`create or replace function public.${nome}(`);
        const fim = sql.indexOf("\n$$;", inicio);
        const corpo = sql.slice(inicio, fim);
        expect(corpo, `${nome} sem security definer`).toMatch(/security definer/);
        expect(corpo, `${nome} sem search_path fixo`).toMatch(/set search_path = public, pg_temp/);

        const assinaturaEscapada = assinatura.replace(/[()]/g, (c) => `\\${c}`);
        if (temGrant) {
          expect(sql, `${nome}${assinatura} não tem revoke de public/anon/authenticated`).toMatch(
            new RegExp(`revoke execute on function public\\.${nome}${assinaturaEscapada} from public, anon, authenticated;`),
          );
          expect(sql, `${nome}${assinatura} não tem grant só a service_role`).toMatch(
            new RegExp(`grant execute on function public\\.${nome}${assinaturaEscapada} to service_role;`),
          );
        } else {
          // Interna (fn_billing_asaas_periodo_do_ciclo, fn_billing_asaas_
          // rotear_pagamento, fn_billing_asaas_aplicar_pagamento): revoke
          // inclui service_role explicitamente (achado da Tarefa 4: este
          // banco concede EXECUTE em função nova a service_role por
          // privilégio padrão), e NENHUM grant a ninguém.
          expect(sql, `${nome}${assinatura} não tem revoke de public/anon/authenticated/service_role`).toMatch(
            new RegExp(`revoke execute on function public\\.${nome}${assinaturaEscapada} from public, anon, authenticated, service_role;`),
          );
          expect(sql, `${nome}${assinatura} é interna e NÃO deveria ter grant a service_role`).not.toMatch(
            new RegExp(`grant execute on function public\\.${nome}${assinaturaEscapada} to service_role;`),
          );
        }
      }
    },
  );

  it("agent_worker (se a role existir) perde execute nas quatro funções, num único bloco condicional", () => {
    for (const sql of [MIGRATION_0909, extraiBloco0909Baseline()]) {
      // Âncora pelo comentário da seção 30 (único: "perde execute nas quatro
      // peças da\n-- Tarefa 5"), não pelo último "if exists" do arquivo: a
      // Tarefa 6 (seção 37, abaixo) acrescentou um SEXTO bloco condicional de
      // agent_worker depois deste, e lastIndexOf passaria a pegar o dela
      // (mesmo ajuste já feito para as Tarefas 3 e 4, acima).
      const ancora = sql.indexOf("perde execute nas quatro peças da");
      expect(ancora, "comentário da seção 30 (Tarefa 5) não encontrado").toBeGreaterThan(-1);
      const inicio = sql.indexOf("if exists (select 1 from pg_roles where rolname = 'agent_worker') then", ancora);
      expect(inicio, "bloco condicional de agent_worker da Tarefa 5 não encontrado").toBeGreaterThan(-1);
      const fim = sql.indexOf("$$;", inicio);
      const corpo = sql.slice(inicio, fim);
      for (const { nome } of FUNCOES_TAREFA_5) {
        expect(corpo, `${nome} não está no revoke de agent_worker da Tarefa 5`).toContain(`public.${nome}(`);
      }
    }
  });
});

describe("0909 Tarefa 5: fn_billing_asaas_periodo_do_ciclo (decisão 5)", () => {
  const corpo = (() => {
    const inicio = MIGRATION_0909.indexOf("create or replace function public.fn_billing_asaas_periodo_do_ciclo(");
    const fim = MIGRATION_0909.indexOf("\n$$;", inicio);
    return MIGRATION_0909.slice(inicio, fim);
  })();

  it("início = p_due às 00h de America/Sao_Paulo", () => {
    expect(corpo).toMatch(/periodo_inicio := p_due::timestamp at time zone 'America\/Sao_Paulo';/);
  });

  it("fim = (p_due + intervalo do Postgres, sem clamp manual) + 1 dia, às 00h de SP", () => {
    expect(corpo).toMatch(/v_fim_data := \(p_due \+ v_intervalo\)::date \+ 1;/);
    expect(corpo).toMatch(/periodo_fim := v_fim_data::timestamp at time zone 'America\/Sao_Paulo';/);
  });

  it("é IMMUTABLE (função pura)", () => {
    const inicio = MIGRATION_0909.indexOf("create or replace function public.fn_billing_asaas_periodo_do_ciclo(");
    const fimAssinatura = MIGRATION_0909.indexOf("language plpgsql", inicio);
    const assinatura = MIGRATION_0909.slice(inicio, fimAssinatura + "language plpgsql\nimmutable".length);
    expect(assinatura).toMatch(/immutable/);
  });
});

describe("0909 Tarefa 5: fn_billing_asaas_rotear_pagamento (decisão 6; PARTE 7, itens 3 e 10)", () => {
  // Correção (revisão F5, itens 3 e 10): PARTE 7 redefine esta função; ancora
  // na ÚLTIMA definição (CLAUDE.md, item 10).
  const corpo = (() => {
    const inicio = MIGRATION_0909.lastIndexOf("create or replace function public.fn_billing_asaas_rotear_pagamento(");
    const fim = MIGRATION_0909.indexOf("\n$$;", inicio);
    return MIGRATION_0909.slice(inicio, fim);
  })();

  it("(a) pedido não pago pela assinatura antes do contrato (primeiro pagamento tem prioridade sobre renovação)", () => {
    const posPedido = corpo.indexOf("categoria := 'pedido';");
    const posRenovacao = corpo.indexOf("categoria := 'renovacao';");
    expect(posPedido).toBeGreaterThan(-1);
    expect(posRenovacao).toBeGreaterThan(-1);
    expect(posPedido).toBeLessThan(posRenovacao);
  });

  it("PARTE 7 (item 3): toda busca de pedido exclui pago, estornado E falhou (nunca acha um pedido já honrado, estornado ou que falhou)", () => {
    const ocorrencias = corpo.match(/status not in \('pago', 'estornado', 'falhou'\)/g) ?? [];
    expect(ocorrencias.length).toBeGreaterThanOrEqual(3);
  });

  it("PARTE 7 (item 10): a busca de renovação por assinatura exige o MESMO ambiente do contrato", () => {
    expect(corpo).toMatch(
      /where asaas_subscription_id = p_subscription and asaas_ambiente = p_ambiente;/,
    );
  });

  it("prefixo diferente de HC: vira outro_app; nada casou vira sem_vinculo", () => {
    expect(corpo).toMatch(/p_external_reference !~ '\^HC:'/);
    expect(corpo).toContain("categoria := 'outro_app';");
    expect(corpo).toContain("categoria := 'sem_vinculo';");
  });

  it("é STABLE (só lê, nenhuma trava)", () => {
    const inicio = MIGRATION_0909.lastIndexOf("create or replace function public.fn_billing_asaas_rotear_pagamento(");
    const fimAssinatura = MIGRATION_0909.indexOf("language plpgsql", inicio);
    const assinatura = MIGRATION_0909.slice(inicio, fimAssinatura + "language plpgsql\nstable".length);
    expect(assinatura).toMatch(/stable/);
    expect(corpo).not.toMatch(/for update/);
    expect(corpo).not.toMatch(/pg_advisory_xact_lock/);
  });
});

describe("0909 Tarefa 5: fn_billing_asaas_aplicar_pagamento (decisões 4 a 8, 12, 26, 27; PARTE 7, itens 4, 5, 10, 11, 13)", () => {
  // Correção (revisão F5): PARTE 7 redefine esta função; ancora na ÚLTIMA
  // definição (CLAUDE.md, item 10), a que o banco realmente instala.
  const corpo = (() => {
    const inicio = MIGRATION_0909.lastIndexOf("create or replace function public.fn_billing_asaas_aplicar_pagamento(");
    const fim = MIGRATION_0909.indexOf("\n$$;", inicio);
    return MIGRATION_0909.slice(inicio, fim);
  })();

  it("idempotência por asaas_payment_id ANTES e DEPOIS das travas (duas ocorrências de billing_payments where asaas_payment_id)", () => {
    const ocorrencias = corpo.match(/from public\.billing_payments\s*\n\s*where asaas_payment_id = v_payment_id;/g) ?? [];
    expect(ocorrencias.length).toBe(2);
  });

  it("travas na ordem fixa da decisão 12: billing:<org> antes de billing_assinatura:<org>, antes do for update no contrato", () => {
    const posBilling = corpo.indexOf("pg_advisory_xact_lock(hashtextextended('billing:' || v_org::text, 0))");
    const posAssinatura = corpo.indexOf("pg_advisory_xact_lock(hashtextextended('billing_assinatura:' || v_org::text, 0))");
    const posForUpdate = corpo.indexOf("where organization_id = v_org\n    for update;");
    expect(posBilling).toBeGreaterThan(-1);
    expect(posAssinatura).toBeGreaterThan(posBilling);
    expect(posForUpdate).toBeGreaterThan(posAssinatura);
  });

  it("roteamento chamado duas vezes para decidir a organização a travar (antes e depois das travas, decisão 12/B5), mais uma terceira vez (PARTE 7, item 11) só para achar organization_id quando sandbox não concede", () => {
    const ocorrencias = corpo.match(/fn_billing_asaas_rotear_pagamento\(/g) ?? [];
    expect(ocorrencias.length).toBe(3);
  });

  it("cliente confirmado tem que casar com billing_customers da mesma organização e ambiente, senão divergente", () => {
    expect(corpo).toMatch(/from public\.billing_customers\s*\n\s*where organization_id = v_org and ambiente = p_ambiente;/);
    expect(corpo).toContain("'resultado', 'divergente'");
  });

  it("valor: coalesce(originalValue, value), menor recusa, maior concede com alarme divergente_valor", () => {
    expect(corpo).toMatch(/\(p_confirmacao->>'originalValue'\)::numeric,\s*\n\s*\(p_confirmacao->>'value'\)::numeric/);
    expect(corpo).toMatch(/if v_valor_cents < v_esperado_cents then/);
    expect(corpo).toMatch(/if v_valor_cents > v_esperado_cents then\s*\n\s*v_alarmes := v_alarmes \|\| 'divergente_valor'::text;/);
  });

  it("pedido fora do estado aberto ganha o alarme pago_fora_do_prazo (decisão 4/A1)", () => {
    expect(corpo).toMatch(
      /if v_pedido\.status not in \('criado', 'aguardando_pagamento', 'inconclusivo', 'processando'\) then\s*\n\s*v_alarmes := v_alarmes \|\| 'pago_fora_do_prazo'::text;/,
    );
  });

  it("ORDEM FIXA (decisão 8/B1): insert em billing_payments dentro de begin/exception, unique_violation vira ja_aplicado", () => {
    const ocorrencias = corpo.match(/exception when unique_violation then\s*\n\s*return jsonb_build_object\('resultado', 'ja_aplicado'/g) ?? [];
    expect(ocorrencias.length).toBe(3);
  });

  it("pacote de tokens: período nulo no insert, credita via fn_billing_creditar_tokens com o valor do pedido (não o pago)", () => {
    expect(corpo).toMatch(/null, null, v_chave, 'Asaas: pacote de tokens'/);
    expect(corpo).toMatch(
      /fn_billing_creditar_tokens\(v_org, v_pedido\.tokens, v_pedido\.id, v_pedido\.amount_cents, 'Asaas', null\)/,
    );
  });

  it("Pix anual: início = greatest(current_period_end, paymentDate), fim = início + 1 ano + 1 dia (decisão 5; PARTE 7, item 13: paymentDate nulo usa o início do dia em SP, nunca now())", () => {
    expect(corpo).toMatch(
      /if v_pedido\.metodo = 'PIX' and v_pedido\.ciclo = 'yearly' then/,
    );
    expect(corpo).toMatch(
      /v_periodo_inicio := greatest\(\s*\n\s*v_contract\.current_period_end,\s*\n\s*coalesce\(\s*\n\s*\(nullif\(p_confirmacao->>'paymentDate', ''\)\)::date,\s*\n\s*\(now\(\) at time zone 'America\/Sao_Paulo'\)::date\s*\n\s*\)::timestamp at time zone 'America\/Sao_Paulo'\s*\n\s*\);/,
    );
    expect(corpo).toMatch(/v_periodo_fim := v_periodo_inicio \+ interval '1 year' \+ interval '1 day';/);
  });

  it("current_period_end = greatest(atual, fim): evento velho nunca encurta (decisão 5/B9)", () => {
    const ocorrencias = corpo.match(/v_novo_fim := greatest\(v_contract\.current_period_end, v_periodo_fim\);/g) ?? [];
    expect(ocorrencias.length).toBe(2);
  });

  it("primeiro pagamento troca plan_id/cycle/gateway/asaas_subscription_id/cancel_at_period_end (decisão 8)", () => {
    expect(corpo).toMatch(
      /set plan_id = v_pedido\.plan_id,\s*\n\s*cycle = v_pedido\.ciclo,\s*\n\s*gateway = 'asaas',\s*\n\s*asaas_subscription_id = coalesce\(v_subscription, v_contract\.asaas_subscription_id\),/,
    );
    expect(corpo).toMatch(/cancel_at_period_end = false,/);
  });

  it("renovação com assinatura ACTIVE confirmada desliga cancel_at_period_end (decisão 10/M3)", () => {
    expect(corpo).toMatch(
      /cancel_at_period_end = case when coalesce\(p_confirmacao->>'assinatura_status', ''\) = 'ACTIVE' then false else cancel_at_period_end end/,
    );
  });

  it("cada mudança de estado, período ou plano grava billing_contract_eventos com motivo pay_ (B6)", () => {
    const ocorrencias = corpo.match(/'pay_primeiro_pagamento'/g) ?? [];
    const ocorrenciasRenovacao = corpo.match(/'pay_renovacao'/g) ?? [];
    expect(ocorrencias.length).toBeGreaterThanOrEqual(3);
    expect(ocorrenciasRenovacao.length).toBeGreaterThanOrEqual(2);
    expect(corpo).toMatch(/'plano', v_plan_id_anterior::text, v_pedido\.plan_id::text, 'pay_primeiro_pagamento'/);
  });

  it("pedido vira pago com pago_em, contract_id vem do contrato já travado", () => {
    const ocorrencias = corpo.match(/set status = 'pago', pago_em = now\(\) where id = v_pedido\.id;/g) ?? [];
    expect(ocorrencias.length).toBe(2);
  });
});

describe("0909 Tarefa 5 (dead: superseded pela Tarefa 6, abaixo): fn_billing_asaas_aplicar_evento tinha tarefa_6_pendente na PRIMEIRA definição", () => {
  it("a PRIMEIRA definição (Tarefa 5) ainda está no arquivo, mas é morta desde a Tarefa 6", () => {
    // sonda-do-baseline: primeira-de-proposito, mede de propósito a definição MORTA da Tarefa 5 (a que ainda dizia tarefa_6_pendente), controle de que a Tarefa 6 SUBSTITUIU o corpo, não só acrescentou uma peça nova.
    const inicio = MIGRATION_0909.indexOf("create or replace function public.fn_billing_asaas_aplicar_evento(");
    const fim = MIGRATION_0909.indexOf("\n$$;", inicio);
    const corpoMorto = MIGRATION_0909.slice(inicio, fim);
    expect(corpoMorto).toContain("'tarefa_6_pendente'");

    const ultima = MIGRATION_0909.lastIndexOf("create or replace function public.fn_billing_asaas_aplicar_evento(");
    expect(ultima, "fn_billing_asaas_aplicar_evento devia ter uma SEGUNDA definição (Tarefa 6)").toBeGreaterThan(inicio);
  });
});

/** O corpo da ÚLTIMA definição de uma função (create or replace até o $$; que a fecha). */
function corpoDaUltimaDefinicao(sql: string, nome: string): string {
  const inicio = sql.lastIndexOf(`create or replace function public.${nome}(`);
  expect(inicio, `${nome} não encontrada`).toBeGreaterThan(-1);
  const fim = sql.indexOf("$$;", inicio);
  expect(fim, `$$; de ${nome} não encontrado`).toBeGreaterThan(-1);
  return sql.slice(inicio, fim);
}

describe("0909 Tarefa 6: fn_billing_asaas_aplicar_evento REDEFINIDA (decisão 20, última definição)", () => {
  it("confere o lease via fn_billing_asaas_lease_e_meu e recusa com billing_lease_invalido", () => {
    for (const sql of [MIGRATION_0909, BASELINE]) {
      const corpo = corpoDaUltimaDefinicao(sql, "fn_billing_asaas_aplicar_evento");
      expect(corpo).toMatch(
        /if not public\.fn_billing_asaas_lease_e_meu\(p_evento, p_lease_token\) then\s*\n\s*raise exception 'billing_lease_invalido' using errcode = '22023';/,
      );
    }
  });

  it("evento de dinheiro (pagamento, estorno ou fim de assinatura) sem confirmação fica aguardando", () => {
    const corpo = corpoDaUltimaDefinicao(MIGRATION_0909, "fn_billing_asaas_aplicar_evento");
    const trechos = corpo.split(/if p_confirmacao is null then\s*\n\s*v_resultado := 'aguardando';/);
    // três ramos (pagamento, estorno, fim de assinatura), logo duas quebras.
    expect(trechos.length).toBe(4);
  });

  it("begin/exception interno em cada um dos três despachos: falha vira resultado=erro, sem propagar a exceção (PARTE 7, item 6: falha transitória vira aguardando antes do when others)", () => {
    const corpo = corpoDaUltimaDefinicao(MIGRATION_0909, "fn_billing_asaas_aplicar_evento");
    expect(corpo).toMatch(/v_aplicacao := public\.fn_billing_asaas_aplicar_pagamento\(p_confirmacao, v_evento\.ambiente\);/);
    expect(corpo).toMatch(/v_aplicacao := public\.fn_billing_asaas_aplicar_estorno\(v_evento\.event_type, p_confirmacao, v_evento\.ambiente\);/);
    expect(corpo).toMatch(
      /v_aplicacao := public\.fn_billing_asaas_aplicar_fim_da_assinatura\(v_evento\.event_type, p_confirmacao, v_evento\.ambiente\);/,
    );
    // Correção (revisão F5, item 6): cada begin/exception ganhou um WHEN
    // específico para falha TRANSITÓRIA (lock_not_available, deadlock_
    // detected, serialization_failure), que vira aguardando (retentativa com
    // backoff) ANTES do when others (falha de verdade, erro imediato); por
    // isso "when others then\n v_resultado := 'erro';" deixou de vir logo
    // depois de "exception" (agora vem depois do primeiro WHEN).
    const quantasTransitorias = (
      corpo.match(/when lock_not_available or deadlock_detected or serialization_failure then\s*\n\s*v_resultado := 'aguardando';/g) ?? []
    ).length;
    expect(quantasTransitorias).toBe(3);
    const quantasExceptions = (corpo.match(/when others then\s*\n\s*v_resultado := 'erro';/g) ?? []).length;
    expect(quantasExceptions).toBe(3);
  });

  it("já NÃO despacha estorno/chargeback/PAYMENT_OVERDUE/PAYMENT_DELETED/fim de assinatura como tarefa_6_pendente", () => {
    const corpo = corpoDaUltimaDefinicao(MIGRATION_0909, "fn_billing_asaas_aplicar_evento");
    expect(corpo).not.toContain("tarefa_6_pendente");
    expect(corpo).toContain("'PAYMENT_REFUNDED'");
    expect(corpo).toContain("'PAYMENT_CHARGEBACK_REQUESTED'");
    expect(corpo).toContain("'PAYMENT_PARTIALLY_REFUNDED'");
    expect(corpo).toContain("'PAYMENT_AWAITING_CHARGEBACK_REVERSAL'");
    expect(corpo).toContain("'PAYMENT_OVERDUE'");
    expect(corpo).toContain("'PAYMENT_DELETED'");
    expect(corpo).toContain("'SUBSCRIPTION_DELETED'");
    expect(corpo).toContain("'SUBSCRIPTION_INACTIVATED'");
    expect(corpo).toContain("'SUBSCRIPTION_UPDATED'");
  });

  it("libera o lease no fim (lease_token/lease_expira_em nulos)", () => {
    const corpo = corpoDaUltimaDefinicao(MIGRATION_0909, "fn_billing_asaas_aplicar_evento");
    expect(corpo).toMatch(/lease_token = null,\s*\n\s*lease_expira_em = null\s*\n\s*where id = p_evento;/);
  });

  it("grants: mesma ACL da Tarefa 5 (create or replace não reseta grant/revoke)", () => {
    for (const sql of [MIGRATION_0909, BASELINE]) {
      expect(sql).toMatch(
        /revoke execute on function public\.fn_billing_asaas_aplicar_evento\(uuid, uuid, jsonb\) from public, anon, authenticated;/,
      );
      expect(sql).toMatch(
        /grant execute on function public\.fn_billing_asaas_aplicar_evento\(uuid, uuid, jsonb\) to service_role;/,
      );
    }
  });
});

describe("0909 Tarefa 6: fn_billing_asaas_aplicar_estorno (decisão 9, N31, N32, N43, M2)", () => {
  const corpo = (() => {
    for (const sql of [MIGRATION_0909, BASELINE]) {
      const c = corpoDaUltimaDefinicao(sql, "fn_billing_asaas_aplicar_estorno");
      expect(c).toMatch(/security definer/);
      expect(c).toMatch(/set search_path = public, pg_temp/);
    }
    return corpoDaUltimaDefinicao(MIGRATION_0909, "fn_billing_asaas_aplicar_estorno");
  })();

  it("PAYMENT_PARTIALLY_REFUNDED e PAYMENT_AWAITING_CHARGEBACK_REVERSAL só alarmam, sem insert em billing_payments", () => {
    const ramo = corpo.slice(
      corpo.indexOf("if p_evento_tipo in ('PAYMENT_PARTIALLY_REFUNDED'"),
      corpo.indexOf("if p_evento_tipo not in ('PAYMENT_REFUNDED'"),
    );
    expect(ramo).toMatch(/'parcialmente_estornado'/);
    expect(ramo).toMatch(/'reversao_de_chargeback'/);
    expect(ramo).not.toMatch(/insert into public\.billing_payments/);
  });

  it("a chave do estorno inclui o status (chargeback e estorno do mesmo pagamento não colidem no único (organization_id, chave))", () => {
    expect(corpo).toMatch(/v_chave_estorno := md5\('HC:asaas:refund:' \|\| v_payment_id \|\| ':' \|\| v_status_novo\)::uuid;/);
  });

  it("o estorno em si nunca grava asaas_payment_id nem período (decisão 9: não mexe em período nem em tokens)", () => {
    const insercaoEstorno = corpo.slice(corpo.lastIndexOf("insert into public.billing_payments"));
    expect(insercaoEstorno).toMatch(
      /v_org, v_contract_id, null, v_valor_cents, v_status_novo, now\(\),\s*\n\s*null, null, v_chave_estorno,/,
    );
  });

  it("M2: sem linha original local, insere o original SEM chamar fn_billing_creditar_tokens nem update em billing_contracts", () => {
    expect(corpo).toMatch(/Asaas: original reconstituido pelo estorno \(M2\)/);
    expect(corpo).not.toMatch(/fn_billing_creditar_tokens/);
    expect(corpo).not.toMatch(/update public\.billing_contracts/);
  });

  it("decisão 9: o pedido (quando houver) passa a estornado", () => {
    expect(corpo).toMatch(
      /update public\.billing_orders set status = 'estornado' where id = v_pedido_id and status <> 'estornado';/,
    );
  });

  it("interna: nenhum grant, nem a service_role", () => {
    for (const sql of [MIGRATION_0909, BASELINE]) {
      expect(sql).toMatch(
        /revoke execute on function public\.fn_billing_asaas_aplicar_estorno\(text, jsonb, text\) from public, anon, authenticated, service_role;/,
      );
      expect(sql).not.toMatch(/grant execute on function public\.fn_billing_asaas_aplicar_estorno/);
    }
  });
});

describe("0909 Tarefa 6: fn_billing_asaas_aplicar_fim_da_assinatura (decisão 10, 22; N39)", () => {
  const corpo = corpoDaUltimaDefinicao(MIGRATION_0909, "fn_billing_asaas_aplicar_fim_da_assinatura");

  it("PAYMENT_OVERDUE só confirma com status OVERDUE, e marca o pedido vencido (A1; PARTE 7, item 4: alarme por TIPO de pedido)", () => {
    expect(corpo).toMatch(/if coalesce\(p_confirmacao->>'status', ''\) <> 'OVERDUE' then/);
    expect(corpo).toMatch(/update public\.billing_orders set status = 'vencido' where id = v_pedido\.id;/);
    // Correção (revisão F5, item 4): o alarme não é mais sempre remover_
    // cobranca_pendente; pedido de ASSINATURA avisa remover_assinatura_
    // pendente (N39), só o pedido AVULSO continua com remover_cobranca_
    // pendente.
    expect(corpo).toMatch(
      /'alarme', case when v_pedido\.tipo = 'assinatura' then 'remover_assinatura_pendente' else 'remover_cobranca_pendente' end,/,
    );
  });

  it("PAYMENT_DELETED só confirma com removida = true, e cancela o pedido", () => {
    expect(corpo).toMatch(/v_removida := coalesce\(\(p_confirmacao->>'removida'\)::boolean, false\);\s*\n\s*if not v_removida then/);
    expect(corpo).toMatch(/update public\.billing_orders set status = 'cancelado' where id = v_pedido\.id;/);
  });

  it("nenhum dos dois (OVERDUE/DELETED) mexe em billing_contracts", () => {
    const ramoPedidos = corpo.slice(0, corpo.indexOf("if p_evento_tipo not in ('SUBSCRIPTION_DELETED'"));
    expect(ramoPedidos).not.toMatch(/update public\.billing_contracts/);
  });

  it("o marcador asaas_assinatura_encerrada_em só é gravado quando DELETED ou removida (M3: INACTIVE puro não marca)", () => {
    expect(corpo).toMatch(
      /asaas_assinatura_encerrada_em = case\s*\n\s*when p_evento_tipo = 'SUBSCRIPTION_DELETED' or v_removida then coalesce\(v_contract\.asaas_assinatura_encerrada_em, now\(\)\)\s*\n\s*else v_contract\.asaas_assinatura_encerrada_em\s*\n\s*end/,
    );
  });

  it("SUBSCRIPTION_UPDATED com status ACTIVE desliga cancel_at_period_end (M3)", () => {
    expect(corpo).toMatch(
      /if coalesce\(v_status, ''\) <> 'ACTIVE' then\s*\n\s*return jsonb_build_object\('resultado', 'ignorado',/,
    );
    expect(corpo).toMatch(/update public\.billing_contracts set cancel_at_period_end = false where id = v_contract\.id;/);
  });

  it("cancela pedido aberto daquela assinatura (SUBSCRIPTION_DELETED/INACTIVATED confirmados)", () => {
    expect(corpo).toMatch(
      /update public\.billing_orders\s*\n\s*set status = 'cancelado'\s*\n\s*where organization_id = v_org\s*\n\s*and asaas_subscription_id = v_subscription_id\s*\n\s*and status in \('criado', 'aguardando_pagamento', 'inconclusivo', 'processando'\);/,
    );
  });

  it("interna: nenhum grant, nem a service_role", () => {
    for (const sql of [MIGRATION_0909, BASELINE]) {
      expect(sql).toMatch(
        /revoke execute on function public\.fn_billing_asaas_aplicar_fim_da_assinatura\(text, jsonb, text\) from public, anon, authenticated, service_role;/,
      );
      expect(sql).not.toMatch(/grant execute on function public\.fn_billing_asaas_aplicar_fim_da_assinatura/);
    }
  });
});

describe("0909 Tarefa 6: fn_billing_asaas_marcar_assinatura_encerrada (decisão 22, função pública)", () => {
  it("recusa assinatura diferente da gravada no contrato, e é idempotente com o marcador já preenchido", () => {
    const corpo = corpoDaUltimaDefinicao(MIGRATION_0909, "fn_billing_asaas_marcar_assinatura_encerrada");
    expect(corpo).toMatch(
      /if v_contract\.asaas_subscription_id is distinct from p_asaas_subscription_id then\s*\n\s*raise exception 'billing_assinatura_nao_confere' using errcode = '22023';/,
    );
    expect(corpo).toMatch(/if v_contract\.asaas_assinatura_encerrada_em is not null then\s*\n\s*return jsonb_build_object\('ja_registrado', true,/);
    expect(corpo).toMatch(/asaas_assinatura_encerrada_em = now\(\)/);
  });

  it("grant só para service_role", () => {
    for (const sql of [MIGRATION_0909, BASELINE]) {
      expect(sql).toMatch(
        /revoke execute on function public\.fn_billing_asaas_marcar_assinatura_encerrada\(uuid, text, uuid\) from public, anon, authenticated;/,
      );
      expect(sql).toMatch(
        /grant execute on function public\.fn_billing_asaas_marcar_assinatura_encerrada\(uuid, text, uuid\) to service_role;/,
      );
    }
  });
});

describe("0909 Tarefa 6 (B2): fn_billing_estornar_pagamento RECRIADA exige origem = 'manual'", () => {
  it("a ÚLTIMA definição recusa origem diferente de manual, e ainda tem as checagens da 0908", () => {
    const corpo = corpoDaUltimaDefinicao(MIGRATION_0909, "fn_billing_estornar_pagamento");
    expect(corpo).toMatch(
      /if v_pagamento\.origem <> 'manual' then\s*\n\s*raise exception 'billing_pagamento_nao_e_manual' using errcode = '22023';/,
    );
    expect(corpo).toMatch(/if v_pagamento\.organization_id <> p_org then/);
    expect(corpo).toMatch(/if v_pagamento\.status <> 'RECEIVED_IN_CASH' then/);
    expect(corpo).not.toMatch(/update public\.billing_contracts/);
  });

  it("a checagem de origem vem DEPOIS do controle de organização (42501) e ANTES da idempotência pela chave", () => {
    const corpo = corpoDaUltimaDefinicao(MIGRATION_0909, "fn_billing_estornar_pagamento");
    const posOrg = corpo.indexOf("billing_pagamento_de_outra_organizacao");
    const posOrigem = corpo.indexOf("billing_pagamento_nao_e_manual");
    const posChave = corpo.indexOf("select * into v_existente");
    expect(posOrg).toBeGreaterThan(-1);
    expect(posOrigem).toBeGreaterThan(posOrg);
    expect(posChave).toBeGreaterThan(posOrigem);
  });

  it("grants inalterados (service_role só)", () => {
    for (const sql of [MIGRATION_0909, BASELINE]) {
      expect(sql).toMatch(
        /revoke execute on function public\.fn_billing_estornar_pagamento\(uuid, uuid, uuid, text, uuid\) from public, anon, authenticated;/,
      );
      expect(sql).toMatch(
        /grant execute on function public\.fn_billing_estornar_pagamento\(uuid, uuid, uuid, text, uuid\) to service_role;/,
      );
    }
  });
});

describe("0909 Tarefa 6 (M4): fn_billing_mudar_estado RECRIADA recusa cancelada manual com assinatura Asaas viva", () => {
  it("a ÚLTIMA definição recusa quando asaas_subscription_id preenchido e o marcador nulo, e ainda tem as regras da 0908", () => {
    const corpo = corpoDaUltimaDefinicao(MIGRATION_0909, "fn_billing_mudar_estado");
    expect(corpo).toMatch(
      /if p_estado = 'cancelada' then\s*\n\s*-- M4[\s\S]{0,220}if v_contract\.asaas_subscription_id is not null and v_contract\.asaas_assinatura_encerrada_em is null then\s*\n\s*raise exception 'billing_cancele_no_asaas_antes' using errcode = '22023';/,
    );
    // as regras da 0908 continuam: qualquer estado -> cancelada depois da checagem nova.
    expect(corpo).toMatch(/v_permitido := true;/);
    expect(corpo).toMatch(/raise exception 'billing_estado_sem_periodo_vigente' using errcode = '22023';/);
    expect(corpo).toMatch(/raise exception 'billing_avaliacao_sem_data_futura' using errcode = '22023';/);
  });

  it("grants inalterados (service_role só)", () => {
    for (const sql of [MIGRATION_0909, BASELINE]) {
      expect(sql).toMatch(
        /revoke execute on function public\.fn_billing_mudar_estado\(uuid, text, text, uuid\) from public, anon, authenticated;/,
      );
      expect(sql).toMatch(
        /grant execute on function public\.fn_billing_mudar_estado\(uuid, text, text, uuid\) to service_role;/,
      );
    }
  });
});

describe("0909 Tarefa 6: agent_worker perde execute nas peças novas (bloco condicional)", () => {
  it("as três peças novas estão no bloco condicional", () => {
    for (const sql of [MIGRATION_0909, extraiBloco0909Baseline()]) {
      expect(sql).toMatch(
        /revoke execute on function '\s*\n\s*\|\| 'public\.fn_billing_asaas_aplicar_estorno\(text, jsonb, text\), '\s*\n\s*\|\| 'public\.fn_billing_asaas_aplicar_fim_da_assinatura\(text, jsonb, text\), '\s*\n\s*\|\| 'public\.fn_billing_asaas_marcar_assinatura_encerrada\(uuid, text, uuid\) '\s*\n\s*\|\| 'from agent_worker';/,
      );
    }
  });
});

describe("0909 Tarefa 6 (M8): sentinela pre_roteamento:outro_app e backoff do aguardando", () => {
  const corpo = corpoDaUltimaDefinicao(MIGRATION_0909, "fn_billing_asaas_aplicar_evento");

  it("p_confirmacao = {\"pre_roteamento\":\"outro_app\"} fecha outro_app ANTES de qualquer despacho por event_type", () => {
    expect(corpo).toMatch(
      /if p_confirmacao is not null and p_confirmacao = '\{"pre_roteamento":"outro_app"\}'::jsonb then\s*\n\s*v_resultado := 'outro_app';/,
    );
    // vem antes do primeiro "elsif v_evento.event_type in" (o despacho normal).
    const posSentinela = corpo.indexOf("p_confirmacao = '{\"pre_roteamento\":\"outro_app\"}'::jsonb");
    const posDespacho = corpo.indexOf("elsif v_evento.event_type in ('PAYMENT_CONFIRMED'");
    expect(posSentinela).toBeGreaterThan(-1);
    expect(posDespacho).toBeGreaterThan(posSentinela);
  });

  it("todo aguardando ganha backoff (tentativas + 1, now() + least(2^tentativas minutos, 6 horas)), e vira erro na décima", () => {
    expect(corpo).toMatch(/if v_resultado = 'aguardando' then\s*\n\s*v_tentativas := v_evento\.tentativas \+ 1;/);
    expect(corpo).toMatch(/if v_tentativas >= 10 then\s*\n\s*v_resultado := 'erro';/);
    expect(corpo).toMatch(
      /proxima_tentativa_em = case\s*\n\s*when v_resultado = 'aguardando' then now\(\) \+ least\(\s*\n\s*power\(2::double precision, v_tentativas::double precision\) \* interval '1 minute',\s*\n\s*interval '6 hours'\s*\n\s*\)\s*\n\s*else null\s*\n\s*end,/,
    );
    expect(corpo).toMatch(/tentativas = v_tentativas,/);
  });

  it("proxima_tentativa_em volta a null para todo resultado que não é aguardando (terminal, sai do índice dos pendentes)", () => {
    expect(corpo).toMatch(/else null\s*\n\s*end,\s*\n\s*processado_em = now\(\),/);
  });
});

describe("0909 Tarefa 6: nenhum travessão nas peças novas", () => {
  it("o trecho da Tarefa 6 não usa travessão (U+2014)", () => {
    const travessao = String.fromCharCode(8212);
    const inicioParte6 = MIGRATION_0909.indexOf("PARTE 6 (Tarefa 6)");
    expect(inicioParte6).toBeGreaterThan(-1);
    expect(MIGRATION_0909.slice(inicioParte6)).not.toContain(travessao);
  });
});
