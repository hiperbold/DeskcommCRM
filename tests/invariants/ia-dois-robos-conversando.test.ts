/**
 * D-158: dois robôs conversando entre si. Contra o banco que o self-host
 * instala, com o transporte `pg` do motor (o mesmo do drain e do turno).
 *
 *  - O remetente que é número de canal da instalação (desta organização ou de
 *    outra) não recebe resposta de IA, em qualquer grafia do número.
 *  - O disjuntor conta turnos de IA do contato na última hora em `llm_calls`
 *    (um turno = um job_id) e, ao estourar, para a IA naquela conversa e abre UM
 *    aviso na Central. A mensagem continua sendo gravada: o teste não toca no
 *    recebimento.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { decidirElegibilidadeDaConversa } from "../../lib/ai/elegibilidade/consulta-pg";

if (!process.env.TEST_DB_CONTAINER) throw new Error("Rode via pnpm test:db");
const pool = new pg.Pool({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres` });

const org = randomUUID();
const outraOrg = randomUUID();
const canal = randomUUID();
const canalDaOutraOrg = randomUUID();
const contatoReal = randomUUID();
const conversaReal = randomUUID();
const contatoRobo = randomUUID();
const conversaRobo = randomUUID();
const contatoDoOutroCanal = randomUUID();
const conversaDoOutroCanal = randomUUID();
const telefoneReal = "+5511987654321";
const telefoneDoCanalDaOutraOrg = "+5521998877665";

const agora = new Date("2026-10-06T15:00:00Z");
const decidir = (conversationId: string, teto = 20, quando = agora) =>
  decidirElegibilidadeDaConversa(pool, {
    organizationId: org,
    conversationId,
    agora: quando,
    ttlMs: 86_400_000,
    tetoDeTurnosPorHora: teto,
  });

/** Uma linha de llm_calls por passo; o turno é o job_id. */
async function registrarTurno(contactId: string, minutosAtras: number, passos = 1, purpose = "agent_turn") {
  const job = randomUUID();
  await pool.query(
    "insert into job_queue(id,organization_id,contact_id,kind,status) values($1,$2,$3,'inbound_turn','done')",
    [job, org, contactId],
  );
  for (let i = 0; i < passos; i++) {
    await pool.query(
      `insert into llm_calls(organization_id,contact_id,job_id,purpose,provider,model,created_at)
       values($1,$2,$3,$4,'anthropic','teste',$5)`,
      [org, contactId, job, purpose, new Date(agora.getTime() - minutosAtras * 60_000)],
    );
  }
}

const avisosAbertos = async (conversationId: string) =>
  (
    await pool.query(
      `select count(*)::int as n from agent_inbox_items
        where organization_id=$1 and ref_kind='conversation' and ref_id=$2 and status='open'
          and title like 'A IA parou de responder%'`,
      [org, String(conversationId)],
    )
  ).rows[0].n as number;

beforeAll(async () => {
  for (const id of [org, outraOrg]) {
    await pool.query("insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Teste','Teste')", [id]);
  }
  // Canal desta organização, gate aberto (metadata vazio), com o número dele.
  await pool.query(
    "insert into channel_sessions(id,organization_id,waha_session_name,webhook_secret_encrypted,phone_number) values($1::uuid,$2,$1::text,'\\x00','+5511900001111')",
    [canal, org],
  );
  // Canal de OUTRA organização da instalação, gravado sem o nono dígito e sem "+".
  await pool.query(
    "insert into channel_sessions(id,organization_id,waha_session_name,webhook_secret_encrypted,phone_number) values($1::uuid,$2,$1::text,'\\x00',$3)",
    [canalDaOutraOrg, outraOrg, telefoneDoCanalDaOutraOrg.replace("+", "")],
  );
  const contatos: [string, string, string][] = [
    [contatoReal, telefoneReal, conversaReal],
    [contatoRobo, "+5511900001111", conversaRobo],
    [contatoDoOutroCanal, telefoneDoCanalDaOutraOrg, conversaDoOutroCanal],
  ];
  for (const [id, tel, conv] of contatos) {
    await pool.query("insert into contacts(id,organization_id,phone_number) values($1,$2,$3)", [id, org, tel]);
    await pool.query(
      "insert into conversations(id,organization_id,contact_id,channel_session_id) values($1,$2,$3,$4)",
      [conv, org, id, canal],
    );
  }
});
afterAll(async () => {
  await pool.end();
});

describe("remetente que é número de canal da instalação", () => {
  it("controle positivo: contato comum, gate aberto, sem turnos → a IA responde", async () => {
    expect(await decidir(conversaReal)).toMatchObject({ permite: true, motivo: "gate_aberto" });
  });

  it("número do próprio canal da organização → a IA não responde", async () => {
    expect(await decidir(conversaRobo)).toMatchObject({ permite: false, motivo: "remetente_e_canal_da_instalacao" });
  });

  it("número de canal de OUTRA organização da instalação → a IA não responde", async () => {
    expect(await decidir(conversaDoOutroCanal)).toMatchObject({
      permite: false,
      motivo: "remetente_e_canal_da_instalacao",
    });
  });

  it("vale com o disjuntor desligado (teto 0): é uma trava própria, não a contagem", async () => {
    expect(await decidir(conversaRobo, 0)).toMatchObject({ permite: false, motivo: "remetente_e_canal_da_instalacao" });
  });

  it("canal arquivado deixa de ser um robô nosso", async () => {
    await pool.query("update channel_sessions set archived_at=now() where id=$1", [canalDaOutraOrg]);
    expect(await decidir(conversaDoOutroCanal)).toMatchObject({ permite: true, motivo: "gate_aberto" });
    await pool.query("update channel_sessions set archived_at=null where id=$1", [canalDaOutraOrg]);
  });
});

describe("disjuntor de turnos de IA por contato por hora", () => {
  it("19 turnos na hora → ainda responde; o 20º fecha", async () => {
    for (let i = 0; i < 19; i++) await registrarTurno(contatoReal, 5 + i, 3);
    expect(await decidir(conversaReal)).toMatchObject({ permite: true });
    expect(await avisosAbertos(conversaReal)).toBe(0);

    await registrarTurno(contatoReal, 1);
    expect(await decidir(conversaReal)).toMatchObject({ permite: false, motivo: "disjuntor_de_turnos" });
  });

  it("abre UM aviso na Central, mesmo consultando várias vezes", async () => {
    await decidir(conversaReal);
    await decidir(conversaReal);
    expect(await avisosAbertos(conversaReal)).toBe(1);
  });

  it("conta turnos (job_id), não passos: 3 passos de um mesmo turno valem 1", async () => {
    // 19 jobs com 3 passos cada = 57 linhas; se contasse linhas, fecharia bem antes.
    const { rows } = await pool.query(
      "select count(*)::int as linhas, count(distinct job_id)::int as turnos from llm_calls where contact_id=$1",
      [contatoReal],
    );
    expect(rows[0].linhas).toBeGreaterThan(rows[0].turnos);
    expect(rows[0].turnos).toBe(20);
  });

  it("outro contato da mesma organização não é afetado", async () => {
    const outro = randomUUID();
    const conversaOutro = randomUUID();
    await pool.query("insert into contacts(id,organization_id,phone_number) values($1,$2,'+5531977776666')", [outro, org]);
    await pool.query(
      "insert into conversations(id,organization_id,contact_id,channel_session_id) values($1,$2,$3,$4)",
      [conversaOutro, org, outro, canal],
    );
    expect(await decidir(conversaOutro)).toMatchObject({ permite: true, motivo: "gate_aberto" });
  });

  it("a janela é de uma hora: com os turnos 61 minutos atrás a IA volta", async () => {
    expect(await decidir(conversaReal, 20, new Date(agora.getTime() + 61 * 60_000))).toMatchObject({
      permite: true,
      motivo: "gate_aberto",
    });
  });

  it("turno de outro propósito (classificador, compactação) não conta", async () => {
    const contato = randomUUID();
    const conversa = randomUUID();
    await pool.query("insert into contacts(id,organization_id,phone_number) values($1,$2,'+5541966665555')", [contato, org]);
    await pool.query(
      "insert into conversations(id,organization_id,contact_id,channel_session_id) values($1,$2,$3,$4)",
      [conversa, org, contato, canal],
    );
    for (let i = 0; i < 25; i++) await registrarTurno(contato, 2, 1, "classifier");
    expect(await decidir(conversa)).toMatchObject({ permite: true });
  });

  it("teto 0 desliga o disjuntor", async () => {
    expect(await decidir(conversaReal, 0)).toMatchObject({ permite: true, motivo: "gate_aberto" });
  });
});
