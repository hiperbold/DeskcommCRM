/**
 * Migration 0921 (D-142, fork Hiperbold): a anonimização LGPD alcança o que
 * sobrava do titular. Provado no Postgres real, nos dois caminhos que viram
 * `is_anonymized` (a cascata formal e o UPDATE do botão da ficha):
 *
 *   1. transcrição e leitura de mídia (`messages.media_derived_*`);
 *   2. notas do agente (`lead_notes`, com embedding) e da equipe (`conversation_notes`);
 *   3. trechos de base de conhecimento nascidos das conversas do titular (`ai_chunks`);
 *   4. `body_preview` nos eventos de mensagem (`event_log.payload`);
 *   5. o rastro do pedido da Nuvemshop (`webhook_events_log`, `lgpd_requests.request_payload`).
 *
 * O vizinho (outro contato, mesma organização) e o pedido de exportação ainda
 * aberto NÃO são tocados. A cura dos já anonimizados roda sobre o texto da
 * migration e poupa quem voltou a escrever depois de `anonymized_at`.
 *
 * Roda via `pnpm test:db tests/invariants/lgpd-anonimizacao-alcanca-o-que-sobrava.test.ts`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { sql } from "./psql-transporte";

const ORG = "09210000-0000-4000-8000-00000000000a";
const SESSAO = "09210000-0000-4000-8000-0000000000c5";
const VIA_TELA = "09210000-1111-4000-8000-000000000001";
const VIA_PEDIDO = "09210000-1111-4000-8000-000000000002";
const VIZINHO = "09210000-1111-4000-8000-000000000003";
const ANTIGO = "09210000-1111-4000-8000-000000000004";
const CONVERSA: Record<string, string> = {
  [VIA_TELA]: "09210000-2222-4000-8000-000000000001",
  [VIA_PEDIDO]: "09210000-2222-4000-8000-000000000002",
  [VIZINHO]: "09210000-2222-4000-8000-000000000003",
  [ANTIGO]: "09210000-2222-4000-8000-000000000004",
};
const FONTE = "09210000-3333-4000-8000-000000000001";
const VERSAO = "09210000-3333-4000-8000-000000000002";
const CLIENTE_LOJA: Record<string, string> = {
  [VIA_TELA]: "7001",
  [VIA_PEDIDO]: "7002",
  [VIZINHO]: "7003",
};
const LOG_DO_PEDIDO = "09210000-4444-4000-8000-000000000001";
const LOG_DO_VIZINHO = "09210000-4444-4000-8000-000000000002";
const EXPORT_ABERTO = "09210000-5555-4000-8000-000000000001";

const NOME = "Bruno Almeida Feliz";
const CPF = "52998224725";
const VETOR = `(select array_fill(0.1::real, array[1536])::vector)`;

const MIGRATION = readFileSync(
  join(
    process.cwd(),
    "supabase/migrations/20260930172000_0921_lgpd_anonimizacao_alcanca_o_que_sobrava.sql",
  ),
  "utf8",
);

beforeAll(() => {
  const porContato = [VIA_TELA, VIA_PEDIDO, VIZINHO]
    .map(
      (c) => `
    insert into public.contacts (id, organization_id, name, display_name, source, source_metadata)
      values ('${c}', '${ORG}', '${NOME}', '${NOME}', 'nuvemshop',
              '{"nuvemshop_customer_id":"${CLIENTE_LOJA[c]}"}'::jsonb);
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status)
      values ('${CONVERSA[c]}', '${ORG}', '${c}', '${SESSAO}', 'open');
    insert into public.messages
      (organization_id, conversation_id, channel_session_id, contact_id, type, direction, status, sent_via, body,
       media_derived_text, media_derived_status)
    values
      ('${ORG}', '${CONVERSA[c]}', '${SESSAO}', '${c}', 'audio', 'inbound', 'received', 'crm', 'audio',
       'sou ${NOME}, cpf ${CPF}, moro na Rua das Flores 10', 'ready');
    insert into public.lead_notes (organization_id, contact_id, headline, body, embedding)
      values ('${ORG}', '${c}', '${NOME} informou o CPF', 'CPF ${CPF}, mora na Rua das Flores', '[0.1,0.2]'::jsonb);
    insert into public.conversation_notes (organization_id, conversation_id, body, created_by_name)
      values ('${ORG}', '${CONVERSA[c]}', 'cliente ${NOME} pediu desconto', 'Atendente Ana');
    insert into public.ai_chunks
      (organization_id, knowledge_source_id, kb_version_id, position, content, content_hash, token_count, embedding, metadata)
      values ('${ORG}', '${FONTE}', '${VERSAO}', ${[VIA_TELA, VIA_PEDIDO, VIZINHO].indexOf(c)},
              'conversa com ${NOME}', 'h-${c}', 6, ${VETOR},
              '{"source_type":"conversas","conversation_id":"${CONVERSA[c]}"}'::jsonb);`,
    )
    .join("\n");
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG}', 'lgpd-sobrava-0921', 'LGPD Sobrava', 'LGPD Sobrava');
    insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
      values ('${SESSAO}', '${ORG}', 'lgpd-sobrava-0921', '\\x00'::bytea);
    insert into public.ai_knowledge_sources (id, organization_id, agent_id, source_type, name, status, is_active)
      values ('${FONTE}', '${ORG}', null, 'conversas', 'Conversas', 'ready', true);
    insert into public.ai_knowledge_versions (id, organization_id, agent_id, knowledge_source_id, version_number, status, is_active)
      values ('${VERSAO}', '${ORG}', null, '${FONTE}', 1, 'ready', true);
    ${porContato}

    insert into public.webhook_events_log (id, organization_id, provider, raw_body, payload_parsed, event_type, external_id)
      values ('${LOG_DO_PEDIDO}', '${ORG}', 'nuvemshop', '{"customer":{"id":7001,"name":"${NOME}"}}',
              '{"store_id":1,"customer":{"id":7001,"name":"${NOME}","email":"bruno@exemplo.com"}}'::jsonb,
              'customer/redact', 'ev-7001'),
             ('${LOG_DO_VIZINHO}', '${ORG}', 'nuvemshop', '{"customer":{"id":7003,"name":"Outra Pessoa"}}',
              '{"store_id":1,"customer":{"id":7003,"name":"Outra Pessoa"}}'::jsonb,
              'customer/redact', 'ev-7003');
    insert into public.lgpd_requests (organization_id, request_type, source, contact_id, external_customer_id, request_payload, due_at)
      values ('${ORG}', 'redact', 'nuvemshop', '${VIA_TELA}', '7001', '{"customer":{"id":7001,"name":"${NOME}"},"store_id":1}'::jsonb, now() + interval '15 days'),
             ('${ORG}', 'redact', 'nuvemshop', '${VIZINHO}', '7003', '{"customer":{"id":7003,"name":"Outra Pessoa"},"store_id":1}'::jsonb, now() + interval '15 days');
    update public.lgpd_requests set request_payload = request_payload || jsonb_build_object('webhook_log_id', '${LOG_DO_PEDIDO}')
     where contact_id = '${VIA_TELA}';
    insert into public.lgpd_requests (id, organization_id, request_type, source, contact_id, external_customer_id, request_payload, due_at)
      values ('${EXPORT_ABERTO}', '${ORG}', 'data_request', 'nuvemshop', '${VIA_TELA}', '7001',
              '{"customer":{"id":7001,"email":"bruno@exemplo.com"}}'::jsonb, now() + interval '7 days');
  `);
});

/** Tudo que, sobre este contato, ainda contém o nome, o CPF ou o rastro da mídia. */
function residuo(contato: string): string {
  const id = CLIENTE_LOJA[contato];
  return sql(`
    select string_agg(onde, ',' order by onde) from (
      select 'media_derived' as onde from public.messages
       where conversation_id = '${CONVERSA[contato]}'
         and (media_derived_text is not null or media_derived_status is not null)
      union
      select 'lead_notes' from public.lead_notes
       where contact_id = '${contato}'
         and (body ilike '%${CPF}%' or headline ilike '%Bruno%' or embedding is not null)
      union
      select 'conversation_notes' from public.conversation_notes
       where conversation_id = '${CONVERSA[contato]}' and body ilike '%Bruno%'
      union
      select 'ai_chunks' from public.ai_chunks
       where metadata->>'conversation_id' = '${CONVERSA[contato]}'
      union
      select 'event_log' from public.event_log
       where entity_kind = 'message' and payload->>'conversation_id' = '${CONVERSA[contato]}'
         and payload ? 'body_preview'
      union
      select 'webhook_events_log' from public.webhook_events_log
       where organization_id = '${ORG}' and payload_parsed->'customer'->>'id' = '${id}'
      union
      select 'webhook_raw_body' from public.webhook_events_log
       where organization_id = '${ORG}' and external_id = 'ev-${id}' and raw_body ilike '%customer%'
      union
      select 'lgpd_requests' from public.lgpd_requests
       where contact_id = '${contato}' and request_type = 'redact' and request_payload ? 'customer'
    ) r;
  `);
}

const TUDO = "ai_chunks,conversation_notes,event_log,lead_notes,lgpd_requests,media_derived,webhook_events_log,webhook_raw_body";

describe("0921: anonimizar alcança o que sobrava do titular", () => {
  it("ANTES: o titular está nos oito lugares (controle positivo)", () => {
    // O gatilho de mensagem grava o evento sozinho: sem este controle, "o
    // body_preview sumiu" passaria por um evento que nunca existiu.
    for (const c of [VIA_TELA, VIA_PEDIDO]) {
      const lugares = residuo(c).split(",");
      expect(lugares).toContain("event_log");
      expect(lugares).toContain("media_derived");
      expect(lugares).toContain("lead_notes");
      expect(lugares).toContain("conversation_notes");
      expect(lugares).toContain("ai_chunks");
    }
    expect(residuo(VIA_TELA)).toBe(TUDO);
  });

  it("pela TELA: o UPDATE do botão limpa os oito lugares", () => {
    sql(`
      update public.contacts set
        name = null, display_name = 'Contato Anonimizado #09210000',
        email = null, phone_number = null, cpf_encrypted = null, cpf_hash = null, birthdate = null,
        source_metadata = '{}'::jsonb,
        is_anonymized = true, anonymized_at = now(), updated_at = now()
      where organization_id = '${ORG}' and id = '${VIA_TELA}';
    `);
    expect(residuo(VIA_TELA)).toBe("");
  });

  it("pelo PEDIDO formal: a cascata chega ao mesmo resultado", () => {
    sql(`select public.fn_lgpd_cascade_redact_contact('${ORG}', '${VIA_PEDIDO}', null);`);
    // O pedido do VIA_PEDIDO não existe em lgpd_requests nem em webhook_events_log:
    // o que a cascata precisa limpar aqui é o que o contato carrega.
    const sobra = residuo(VIA_PEDIDO).split(",").filter((l) => l && l !== "webhook_events_log" && l !== "webhook_raw_body");
    expect(sobra).toEqual([]);
  });

  it("a linha das mensagens, das notas e do evento fica; só o conteúdo sai", () => {
    expect(
      sql(`select count(*) from public.messages where conversation_id = '${CONVERSA[VIA_TELA]}';`),
    ).toBe("1");
    expect(sql(`select body from public.lead_notes where contact_id = '${VIA_TELA}';`)).toBe("[nota anonimizada]");
    expect(
      sql(`select body || '|' || created_by_name from public.conversation_notes where conversation_id = '${CONVERSA[VIA_TELA]}';`),
    ).toBe("[nota anonimizada]|Atendente Ana");
    expect(
      sql(`select count(*) from public.event_log where entity_kind = 'message' and payload->>'conversation_id' = '${CONVERSA[VIA_TELA]}';`),
    ).toBe("1");
    expect(
      sql(`select count(*) from public.webhook_events_log where id = '${LOG_DO_PEDIDO}' and raw_body = '[redigido]';`),
    ).toBe("1");
  });

  it("o VIZINHO, o webhook dele e o pedido de exportação aberto não são tocados", () => {
    expect(residuo(VIZINHO)).toBe(TUDO);
    expect(
      sql(`select count(*) from public.webhook_events_log where id = '${LOG_DO_VIZINHO}' and raw_body ilike '%Outra Pessoa%';`),
    ).toBe("1");
    expect(
      sql(`select request_payload->'customer'->>'email' from public.lgpd_requests where id = '${EXPORT_ABERTO}';`),
    ).toBe("bruno@exemplo.com");
  });

  it("edição normal do contato NÃO redige", () => {
    sql(`update public.contacts set display_name = 'Bruno A. Feliz' where id = '${VIZINHO}';`);
    expect(residuo(VIZINHO)).toBe(TUDO);
  });
});

describe("0921: a cura dos já anonimizados", () => {
  it("limpa o que o gatilho antigo deixou e poupa o que veio depois de anonymized_at", () => {
    sql(`
      insert into public.contacts (id, organization_id, name, display_name, source, source_metadata)
        values ('${ANTIGO}', '${ORG}', '${NOME}', '${NOME}', 'whatsapp', '{}'::jsonb);
      insert into public.conversations (id, organization_id, contact_id, channel_session_id, status, created_at)
        values ('${CONVERSA[ANTIGO]}', '${ORG}', '${ANTIGO}', '${SESSAO}', 'open', now() - interval '3 hours');
      insert into public.messages
        (organization_id, conversation_id, channel_session_id, contact_id, type, direction, status, sent_via, body, media_derived_text, media_derived_status, created_at)
      values ('${ORG}', '${CONVERSA[ANTIGO]}', '${SESSAO}', '${ANTIGO}', 'audio', 'inbound', 'received', 'crm', 'audio', 'sou ${NOME}', 'ready', now() - interval '2 hours');
      insert into public.lead_notes (organization_id, contact_id, headline, body, embedding, created_at)
        values ('${ORG}', '${ANTIGO}', '${NOME}', 'CPF ${CPF}', '[0.1]'::jsonb, now() - interval '2 hours');
      insert into public.ai_chunks
        (organization_id, knowledge_source_id, kb_version_id, position, content, content_hash, token_count, embedding, metadata)
        values ('${ORG}', '${FONTE}', '${VERSAO}', 10, 'conversa antiga', 'h-antigo', 6, ${VETOR},
                '{"conversation_id":"${CONVERSA[ANTIGO]}"}'::jsonb);
      -- Anonimizado ANTES da 0921, sem o gatilho novo: o gatilho antigo não tocava estas colunas.
      alter table public.contacts disable trigger user;
      update public.contacts set name = null, is_anonymized = true, anonymized_at = now() - interval '1 hour'
       where id = '${ANTIGO}';
      alter table public.contacts enable trigger user;
      -- Depois da anonimização o contato religou e escreveu de novo: mensagem e nota NOVAS.
      insert into public.messages
        (organization_id, conversation_id, channel_session_id, contact_id, type, direction, status, sent_via, body, media_derived_text, media_derived_status)
      values ('${ORG}', '${CONVERSA[ANTIGO]}', '${SESSAO}', '${ANTIGO}', 'audio', 'inbound', 'received', 'crm', 'audio', 'voltei', 'ready');
    `);

    // O bloco `do` da migration, no ponto onde ele começa.
    const cura = MIGRATION.slice(MIGRATION.indexOf("do $cura_0921$"));
    sql(cura);
    sql(cura); // idempotente

    expect(
      sql(`select count(*) from public.messages where conversation_id = '${CONVERSA[ANTIGO]}' and media_derived_text = 'sou ${NOME}';`),
    ).toBe("0");
    expect(
      sql(`select count(*) from public.messages where conversation_id = '${CONVERSA[ANTIGO]}' and media_derived_text = 'voltei' and media_derived_status = 'ready';`),
    ).toBe("1");
    expect(sql(`select body from public.lead_notes where contact_id = '${ANTIGO}';`)).toBe("[nota anonimizada]");
    expect(
      sql(`select count(*) from public.ai_chunks where metadata->>'conversation_id' = '${CONVERSA[ANTIGO]}';`),
    ).toBe("0");
  });
});
