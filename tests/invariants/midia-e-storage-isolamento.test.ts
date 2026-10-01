/**
 * Migration 0919 (D-099, D-110, D-149, fork Hiperbold): o que um membro grava não
 * alcança o arquivo de outra empresa. Provado no Postgres real, como `authenticated`
 * com o JWT do usuário:
 *
 *   1. D-099: viewer não insere, atualiza nem apaga em `storage_redaction_queue`
 *      (a linha enfileirava o apagamento de arquivo de outra empresa), mas lê a fila
 *      da própria organização; o dono do banco (caminho do app) segue gravando;
 *   2. D-149: `messages.media_storage_path` só aceita o prefixo
 *      `{organização}/{conversa}/` normalizado, no insert e na troca do valor;
 *      `..`, `//`, barra invertida, `%` e outra organização são recusados;
 *      linha antiga com caminho fora do prefixo continua atualizável por outra coluna;
 *   3. D-110: `ai-policy` não tem policy de escrita para authenticated, e a leitura
 *      de `lgpd-exports` é só do admin da organização.
 *
 * Roda via `pnpm test:db tests/invariants/midia-e-storage-isolamento.test.ts`.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { motivoDoErro, sql } from "./psql-transporte";

const ORG = "09190001-a5aa-4000-8000-000000000001";
const OUTRA_ORG = "09190001-a5aa-4000-8000-000000000002";
const VIEWER = "09190001-b0b0-4000-8000-000000000001";
const AGENT = "09190001-b0b0-4000-8000-000000000002";
const ADMIN = "09190001-b0b0-4000-8000-000000000003";
const CONTATO = "09190001-c0c0-4000-8000-000000000001";
const SESSAO = "09190001-c0c0-4000-8000-000000000002";
const CONVERSA = "09190001-c0c0-4000-8000-000000000003";
const MSG_ANTIGA = "09190001-d0d0-4000-8000-000000000001";

function como(usuario: string, corpo: string): string {
  return sql(`
    set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${usuario}","role":"authenticated","aal":"aal2"}', false);
    ${corpo}
  `);
}

function recusado(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return motivoDoErro(err);
  }
  return "";
}

function mensagem(id: string, caminho: string): string {
  return `insert into public.messages (id, organization_id, conversation_id, channel_session_id, contact_id,
      type, direction, status, sent_via, media_storage_path)
    values ('${id}', '${ORG}', '${CONVERSA}', '${SESSAO}', '${CONTATO}', 'image', 'inbound', 'delivered',
      'external_device', ${caminho === "NULL" ? "NULL" : `'${caminho}'`});`;
}

const PREFIXO = `${ORG}/${CONVERSA}`;

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${VIEWER}', 'viewer-0919@invariant.test'),
      ('${AGENT}', 'agent-0919@invariant.test'),
      ('${ADMIN}', 'admin-0919@invariant.test')
      on conflict (id) do nothing;

    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG}', 'midia-0919-a', 'Midia 0919 A', 'Midia 0919 A'),
      ('${OUTRA_ORG}', 'midia-0919-b', 'Midia 0919 B', 'Midia 0919 B')
      on conflict (id) do nothing;

    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${VIEWER}', '${ORG}', 'viewer', now()),
      ('${AGENT}', '${ORG}', 'agent', now()),
      ('${ADMIN}', '${ORG}', 'admin', now())
      on conflict do nothing;

    insert into public.contacts (id, organization_id, name, phone_number)
      values ('${CONTATO}', '${ORG}', 'Cliente 0919', '+5511900000919') on conflict (id) do nothing;
    insert into public.channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
      values ('${SESSAO}', '${ORG}', 'midia-919', 'WORKING', '\\x00'::bytea) on conflict (id) do nothing;
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status, is_group)
      values ('${CONVERSA}', '${ORG}', '${CONTATO}', '${SESSAO}', 'open', false) on conflict (id) do nothing;

    -- Linha ANTIGA com caminho fora do prefixo (merge de conversas da 0027): entra
    -- com o gatilho desligado só neste fixture.
    alter table public.messages disable trigger trg_messages_media_path_insert;
    ${mensagem(MSG_ANTIGA, `${ORG}/conversa-antiga/arquivo.jpg`)}
    alter table public.messages enable trigger trg_messages_media_path_insert;

    -- A leitura de lgpd-exports precisa de grant em storage.objects para o teste
    -- distinguir pela POLICY (o grant do projeto Supabase real existe).
    -- O stub de storage.objects do banco de teste nasce SEM RLS (no Supabase real ela
    -- vem ligada): sem ligar, as policies não valem e o teste mediria o stub.
    alter table storage.objects enable row level security;
    grant usage on schema storage to authenticated;
    grant select, insert on storage.objects to authenticated;
    insert into storage.objects (bucket_id, name, metadata)
      values ('lgpd-exports', '${ORG}/pedido-0919/data.json', '{"size": 10}'::jsonb)
      on conflict do nothing;
  `);
});

describe("D-099: storage_redaction_queue não é gravável por membro", () => {
  const fila = (caminho: string) =>
    `insert into public.storage_redaction_queue (organization_id, bucket, object_path)
     values ('${ORG}', 'brand-logos', '${caminho}');`;

  it("viewer não insere o apagamento da logo da instalação", () => {
    const motivo = recusado(() => como(VIEWER, fila("platform/logo-0919.png")));
    expect(motivo, "o viewer enfileirou um apagamento").toContain("permission denied");
    expect(
      sql(`select count(*) from public.storage_redaction_queue where object_path = 'platform/logo-0919.png';`),
    ).toBe("0");
  });

  it("agent e admin também não escrevem, nem update, nem delete, nem truncate", () => {
    for (const quem of [AGENT, ADMIN]) {
      expect(recusado(() => como(quem, fila("platform/logo-0919-b.png")))).toContain("permission denied");
    }
    expect(
      recusado(() => como(ADMIN, `update public.storage_redaction_queue set status = 'pending' where organization_id = '${ORG}';`)),
    ).toContain("permission denied");
    expect(
      recusado(() => como(ADMIN, `delete from public.storage_redaction_queue where organization_id = '${ORG}';`)),
    ).toContain("permission denied");
    expect(recusado(() => como(ADMIN, `truncate public.storage_redaction_queue;`))).toContain("permission denied");
  });

  it("CONTROLE POSITIVO: o dono do banco (caminho do app) grava, e o membro lê a fila da própria organização", () => {
    sql(
      `insert into public.storage_redaction_queue (organization_id, bucket, object_path)
       values ('${ORG}', 'whatsapp-media', '${PREFIXO}/controle-0919.jpg') on conflict do nothing;`,
    );
    const lidas = como(
      VIEWER,
      `select count(*) from public.storage_redaction_queue where object_path = '${PREFIXO}/controle-0919.jpg';`,
    );
    expect(lidas.split("\n").pop()).toBe("1");
  });
});

describe("D-149: messages.media_storage_path só aceita o prefixo da própria conversa", () => {
  const tenta = (id: string, caminho: string) => recusado(() => sql(mensagem(id, caminho)));
  const id = (n: number) => `09190001-d0d0-4000-8000-0000000001${String(n).padStart(2, "0")}`;

  it("CONTROLE POSITIVO: caminho do prefixo e linha sem mídia entram", () => {
    expect(tenta(id(1), `${PREFIXO}/${id(1)}.jpg`)).toBe("");
    expect(tenta(id(2), "NULL")).toBe("");
    expect(tenta(id(3), `${PREFIXO}/out-abc.webp`)).toBe("");
  });

  it("caminho de outra organização é recusado", () => {
    const motivo = tenta(id(10), `${OUTRA_ORG}/${CONVERSA}/${id(10)}.jpg`);
    expect(motivo).toContain("media_storage_path fora do prefixo");
  });

  it("traversal, barra dupla, barra invertida, % e controle são recusados mesmo com o prefixo certo", () => {
    expect(tenta(id(11), `${PREFIXO}/../../${OUTRA_ORG}/x/y.pdf`)).toContain("fora do prefixo");
    expect(tenta(id(12), `${PREFIXO}//x.jpg`)).toContain("fora do prefixo");
    expect(tenta(id(13), `${PREFIXO}/a\\b.jpg`)).toContain("fora do prefixo");
    expect(tenta(id(14), `${PREFIXO}/%2e%2e/x.jpg`)).toContain("fora do prefixo");
    expect(tenta(id(15), `${PREFIXO}/./x.jpg`)).toContain("fora do prefixo");
  });

  it("trocar o valor para outra organização é recusado; o valor certo passa", () => {
    expect(tenta(id(20), "NULL")).toBe("");
    const ruim = recusado(() =>
      sql(`update public.messages set media_storage_path = '${OUTRA_ORG}/c/m.jpg' where id = '${id(20)}';`),
    );
    expect(ruim).toContain("fora do prefixo");
    sql(`update public.messages set media_storage_path = '${PREFIXO}/${id(20)}.jpg' where id = '${id(20)}';`);
    expect(sql(`select media_storage_path from public.messages where id = '${id(20)}';`)).toBe(
      `${PREFIXO}/${id(20)}.jpg`,
    );
  });

  it("linha antiga fora do prefixo continua atualizável por outra coluna (ack, status)", () => {
    sql(`update public.messages set status = 'read' where id = '${MSG_ANTIGA}';`);
    expect(sql(`select status from public.messages where id = '${MSG_ANTIGA}';`)).toBe("read");
  });
});

describe("D-110: buckets ai-policy e lgpd-exports", () => {
  it("ai-policy não tem policy de insert nem de delete", () => {
    const comandos = sql(
      `select coalesce(string_agg(cmd, ',' order by cmd), '') from pg_policies
        where schemaname = 'storage' and tablename = 'objects' and policyname in ('tenant_write_ai_policy', 'tenant_delete_ai_policy');`,
    );
    expect(comandos).toBe("");
  });

  it("viewer não grava em ai-policy pelo próprio JWT", () => {
    const motivo = recusado(() =>
      como(
        VIEWER,
        `insert into storage.objects (bucket_id, name) values ('ai-policy', '${ORG}/injecao-0919.pdf');`,
      ),
    );
    expect(motivo).toContain("row-level security");
  });

  it("lgpd-exports: agent e viewer não enxergam o export; admin enxerga (controle positivo)", () => {
    const vistos = (quem: string) =>
      como(quem, `select count(*) from storage.objects where bucket_id = 'lgpd-exports' and name like '${ORG}/%';`)
        .split("\n")
        .pop();
    expect(vistos(VIEWER)).toBe("0");
    expect(vistos(AGENT)).toBe("0");
    expect(vistos(ADMIN)).toBe("1");
  });
});
