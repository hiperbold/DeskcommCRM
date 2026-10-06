/**
 * Migrations 0935 e 0936 (lote 12 da auditoria de 30/09/2026): D-131 (ack de campanha antes do
 * vínculo) e D-132 (uma chave de `organizations.settings` por vez). Contra o banco que o
 * self-host instala.
 *
 * Roda via `pnpm test:db tests/invariants/lote12-sobras-de-banco.test.ts`.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

if (!process.env.TEST_DB_CONTAINER) throw new Error("Rode via pnpm test:db");
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
  max: 8,
});

const org = randomUUID();
const outraOrg = randomUUID();
const canal = randomUUID();
const contato = randomUUID();
const conversa = randomUUID();
const campanha = randomUUID();

/** `campaign_recipients` é único por (campanha, contato): cada destinatário de teste tem o seu. */
async function novoContato(): Promise<string> {
  const id = randomUUID();
  await pool.query("insert into contacts(id,organization_id,phone_number) values($1,$2,$3)", [
    id,
    org,
    `+5511${Math.floor(900000000 + Math.random() * 99999999)}`,
  ]);
  return id;
}

async function setting(caminho: string[], valor: unknown, organizationId = org) {
  const { rows } = await pool.query("select public.fn_atualizar_setting_da_organizacao($1,$2,$3::jsonb) as n", [
    organizationId,
    caminho,
    valor === null ? null : JSON.stringify(valor),
  ]);
  return rows[0].n as number;
}
async function settings(organizationId = org): Promise<Record<string, unknown>> {
  const { rows } = await pool.query("select settings from organizations where id=$1", [organizationId]);
  return rows[0].settings;
}

beforeAll(async () => {
  for (const id of [org, outraOrg]) {
    await pool.query("insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Teste','Teste')", [id]);
  }
  await pool.query(
    "insert into channel_sessions(id,organization_id,waha_session_name,webhook_secret_encrypted) values($1::uuid,$2,$1::text,'\\x00')",
    [canal, org],
  );
  await pool.query("insert into contacts(id,organization_id,phone_number) values($1,$2,'+5511987654321')", [contato, org]);
  await pool.query("insert into conversations(id,organization_id,contact_id,channel_session_id) values($1,$2,$3,$4)", [
    conversa,
    org,
    contato,
    canal,
  ]);
  await pool.query(
    "insert into campaigns(id,organization_id,name,channel_session_id,base_legal) values($1,$2,'c',$3,'consent')",
    [campanha, org, canal],
  );
});
afterAll(async () => {
  await pool.end();
});

describe("0935: ack de campanha que chega antes do vínculo (D-131)", () => {
  async function novoEnvio(metadata: Record<string, unknown> | null) {
    const recipient = randomUUID();
    const mensagem = randomUUID();
    await pool.query(
      `insert into campaign_recipients(id,organization_id,campaign_id,contact_id,recipient_address,status,sending_at)
       values($1,$2,$3,$4,$5,'sending',now())`,
      [recipient, org, campanha, await novoContato(), `+55119${Math.floor(10000000 + Math.random() * 89999999)}`],
    );
    await pool.query(
      `insert into messages(id,organization_id,conversation_id,channel_session_id,contact_id,type,direction,status,metadata)
       values($1,$2,$3,$4,$5,'text','outbound','sent',$6::jsonb)`,
      [mensagem, org, conversa, canal, contato, JSON.stringify(metadata ?? { campaign_recipient_id: recipient })],
    );
    return { recipient, mensagem };
  }
  const linha = async (id: string) =>
    (await pool.query("select status, delivered_at, read_at, message_id from campaign_recipients where id=$1", [id])).rows[0];

  it("entregue ANTES do vínculo: o destinatário avança, achado pelo metadata", async () => {
    const { recipient, mensagem } = await novoEnvio(null);
    expect((await linha(recipient)).message_id).toBeNull();
    await pool.query("update messages set status='delivered' where id=$1", [mensagem]);
    const l = await linha(recipient);
    expect(l.status).toBe("delivered");
    expect(l.delivered_at).not.toBeNull();
  });

  it("lido ANTES do vínculo: marca lido e entregue", async () => {
    const { recipient, mensagem } = await novoEnvio(null);
    await pool.query("update messages set status='read' where id=$1", [mensagem]);
    const l = await linha(recipient);
    expect(l.status).toBe("read");
    expect(l.read_at).not.toBeNull();
  });

  it("com o vínculo gravado, segue pelo message_id (controle positivo da regra antiga)", async () => {
    const { recipient, mensagem } = await novoEnvio(null);
    await pool.query("update campaign_recipients set message_id=$2 where id=$1", [recipient, mensagem]);
    await pool.query("update messages set status='delivered' where id=$1", [mensagem]);
    expect((await linha(recipient)).status).toBe("delivered");
  });

  it("status nunca retrocede: replied não volta para delivered", async () => {
    const { recipient, mensagem } = await novoEnvio(null);
    await pool.query("update campaign_recipients set status='replied' where id=$1", [recipient]);
    await pool.query("update messages set status='delivered' where id=$1", [mensagem]);
    expect((await linha(recipient)).status).toBe("replied");
  });

  it("metadata torto não derruba o update de status da mensagem", async () => {
    const { mensagem } = await novoEnvio({ campaign_recipient_id: "isto-nao-e-uuid" });
    await expect(pool.query("update messages set status='delivered' where id=$1", [mensagem])).resolves.toBeDefined();
  });

  it("destinatário de OUTRA organização não é tocado pelo metadata", async () => {
    const recipient = randomUUID();
    const mensagem = randomUUID();
    await pool.query(
      `insert into campaign_recipients(id,organization_id,campaign_id,contact_id,recipient_address,status,sending_at)
       values($1,$2,$3,$4,'+5511900000001','sending',now())`,
      [recipient, org, campanha, await novoContato()],
    );
    // A mensagem é da outra organização, mas o metadata aponta para o destinatário desta.
    const canalB = randomUUID();
    const contatoB = randomUUID();
    const conversaB = randomUUID();
    await pool.query(
      "insert into channel_sessions(id,organization_id,waha_session_name,webhook_secret_encrypted) values($1::uuid,$2,$1::text,'\\x00')",
      [canalB, outraOrg],
    );
    await pool.query("insert into contacts(id,organization_id,phone_number) values($1,$2,'+5521999990000')", [contatoB, outraOrg]);
    await pool.query("insert into conversations(id,organization_id,contact_id,channel_session_id) values($1,$2,$3,$4)", [
      conversaB,
      outraOrg,
      contatoB,
      canalB,
    ]);
    await pool.query(
      `insert into messages(id,organization_id,conversation_id,channel_session_id,contact_id,type,direction,status,metadata)
       values($1,$2,$3,$4,$5,'text','outbound','sent',$6::jsonb)`,
      [mensagem, outraOrg, conversaB, canalB, contatoB, JSON.stringify({ campaign_recipient_id: recipient })],
    );
    await pool.query("update messages set status='delivered' where id=$1", [mensagem]);
    expect((await linha(recipient)).status).toBe("sending");
  });
});

describe("0936: fn_atualizar_setting_da_organizacao (D-132)", () => {
  it("grava a chave e preserva todas as outras", async () => {
    await pool.query("update organizations set settings=$2::jsonb where id=$1", [
      org,
      JSON.stringify({ visibility_mode: "own", branding: { app_name: "X" }, llm: { provider: "a", params: { t: 1 } } }),
    ]);
    expect(await setting(["security", "mfa_required"], true)).toBe(1);
    expect(await settings()).toEqual({
      visibility_mode: "own",
      branding: { app_name: "X" },
      llm: { provider: "a", params: { t: 1 } },
      security: { mfa_required: true },
    });
  });

  it("caminho aninhado: troca só a folha e cria os pais que faltam", async () => {
    await setting(["llm", "default_model"], "m1");
    await setting(["a", "b", "c"], 5);
    const s = (await settings()) as Record<string, unknown>;
    expect(s.llm).toEqual({ provider: "a", params: { t: 1 }, default_model: "m1" });
    expect(s.a).toEqual({ b: { c: 5 } });
    expect(s.visibility_mode).toBe("own");
  });

  it("valor nulo remove a chave e deixa as irmãs", async () => {
    await setting(["security", "mfa_required"], null);
    const s = (await settings()) as Record<string, unknown>;
    expect(s.security).toEqual({});
    expect(s.llm).toMatchObject({ provider: "a" });
  });

  it("recusa caminho que atravessa um valor que não é objeto, sem apagar o valor", async () => {
    await setting(["escalar"], "texto");
    await expect(setting(["escalar", "filho"], 1)).rejects.toMatchObject({ code: "22023" });
    expect(((await settings()) as Record<string, unknown>).escalar).toBe("texto");
  });

  it("recusa caminho vazio, item vazio e fundo demais", async () => {
    for (const caminho of [[], [""], ["a", " "], ["a", "b", "c", "d", "e"]]) {
      await expect(setting(caminho, 1)).rejects.toMatchObject({ code: "22023" });
    }
  });

  it("organização inexistente devolve 0 linhas, sem criar nada", async () => {
    expect(await setting(["x"], 1, randomUUID())).toBe(0);
  });

  it("escritores concorrentes de chaves diferentes não se apagam", async () => {
    await pool.query("update organizations set settings='{}'::jsonb where id=$1", [org]);
    await Promise.all(Array.from({ length: 24 }, (_, i) => setting([`chave_${i}`], i)));
    const s = (await settings()) as Record<string, number>;
    expect(Object.keys(s).length).toBe(24);
    for (let i = 0; i < 24; i++) expect(s[`chave_${i}`]).toBe(i);
  });

  it("settings nulo vira objeto; outra organização não é tocada", async () => {
    await pool.query("update organizations set settings=null where id=$1", [org]).catch(() => undefined);
    await setting(["k"], 1);
    expect(await settings(outraOrg)).not.toHaveProperty("k");
  });

  it("só o servidor executa: anon e authenticated não têm EXECUTE", async () => {
    const { rows } = await pool.query(`select
      has_function_privilege('anon','fn_atualizar_setting_da_organizacao(uuid,text[],jsonb)','execute') as anon,
      has_function_privilege('authenticated','fn_atualizar_setting_da_organizacao(uuid,text[],jsonb)','execute') as membro,
      has_function_privilege('service_role','fn_atualizar_setting_da_organizacao(uuid,text[],jsonb)','execute') as servidor`);
    expect(rows[0]).toEqual({ anon: false, membro: false, servidor: true });
  });
});
