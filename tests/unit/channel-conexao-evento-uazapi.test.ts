import { describe, expect, it } from "vitest";

import { lerConexaoUazapi, parseUazapiConexao } from "@/lib/channels/uazapi/conexao-evento";
import { saudeDoEstadoUazapi } from "@/lib/channels/uazapi/saude";

/**
 * Evento `connection` da instância UAZAPI.
 *
 * ─── De onde vem a forma, e o que isso obriga ───────────────────────────────
 *
 * Diferente dos dois irmãos, este evento NÃO foi capturado: a instância não
 * caiu enquanto se media, e o contrato publicado do servidor diz que o corpo
 * "varia conforme o tipo do evento". Então o que se testa aqui não é "o
 * servidor manda assim" — é que CADA forma plausível é lida, que a forma
 * desconhecida é recusada com nome em vez de virar "tudo bem", e que a
 * tradução do estado é a MESMA que a varredura usa.
 *
 * Os números são inventados: nenhum dado de cliente entra no repositório.
 */

function ler(bruto: Record<string, unknown>) {
  const leitura = lerConexaoUazapi(JSON.stringify(bruto));
  if (!leitura.ok) throw new Error(`payload de teste fora do contrato: ${JSON.stringify(leitura)}`);
  return leitura.envelope;
}

const base = {
  EventType: "connection",
  BaseUrl: "https://empresa.uazapi.com",
  instanceName: "comercial",
  owner: "553599990000",
};

describe("evento de conexão da instância", () => {
  it("lê o estado de `instance.status`, que é a forma do resto da API", () => {
    const r = parseUazapiConexao(ler({ ...base, instance: { id: "abc", status: "disconnected", name: "comercial" } }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.conexao.estado).toBe("disconnected");
    expect(r.conexao.saude).toEqual({ reachable: true, status: "SCAN_QR_CODE", detail: null });
  });

  it("aceita `status` como string solta", () => {
    const r = parseUazapiConexao(ler({ ...base, status: "connected" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.conexao.saude.status).toBe("WORKING");
  });

  it("aceita `status` como objeto sem recusar o evento inteiro por causa do campo", () => {
    const r = parseUazapiConexao(ler({ ...base, status: { connected: true, loggedIn: true } }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.conexao.estado).toBe("connected");
  });

  it("`connected: false` NÃO vira desconectado: não distingue queda de conexão em curso", () => {
    // Chamar isso de `disconnected` mandaria escanear um QR que talvez nem
    // precise ser escaneado — o pior conselho possível num aviso de conexão.
    const r = parseUazapiConexao(ler({ ...base, status: { connected: false } }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivo).toBe("conexao_sem_estado");
  });

  it("prefere `instance.status` quando o evento traz as duas formas", () => {
    const r = parseUazapiConexao(ler({ ...base, instance: { status: "hibernated" }, status: { connected: true } }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.conexao.saude).toEqual({ reachable: true, status: "STOPPED", detail: "instancia_hibernada" });
  });

  it("estado que não está na lista vira `reachable: false` com o nome dele, não silêncio", () => {
    const r = parseUazapiConexao(ler({ ...base, instance: { status: "pairing" } }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.conexao.saude).toEqual({ reachable: false, status: null, detail: "estado_desconhecido_pairing" });
  });

  it("evento sem estado nenhum é recusado com motivo, não tratado como 'tudo bem'", () => {
    const r = parseUazapiConexao(ler(base));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivo).toBe("conexao_sem_estado");
  });

  it("outro tipo de evento não entra por aqui", () => {
    const r = parseUazapiConexao(ler({ ...base, EventType: "messages", instance: { status: "connected" } }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivo).toBe("evento_sem_interesse");
  });

  it("corpo que não é JSON não derruba a leitura", () => {
    expect(lerConexaoUazapi("não é json").ok).toBe(false);
  });
});

describe("tradução do estado, compartilhada com a varredura", () => {
  // O empurrão e a varredura leem o mesmo vocabulário. Se esta tabela divergir
  // do que o adapter faz, o aviso da Central passa a piscar sozinho: uma fonte
  // abre e a outra fecha o mesmo episódio a cada ciclo.
  it.each([
    ["connected", { reachable: true, status: "WORKING", detail: null }],
    ["Connected", { reachable: true, status: "WORKING", detail: null }],
    ["connecting", { reachable: true, status: "SCAN_QR_CODE", detail: null }],
    ["disconnected", { reachable: true, status: "SCAN_QR_CODE", detail: null }],
    ["hibernated", { reachable: true, status: "STOPPED", detail: "instancia_hibernada" }],
  ])("%s", (estado, esperado) => {
    expect(saudeDoEstadoUazapi(estado)).toEqual(esperado);
  });

  it("vazio e nulo são nomeados, não confundidos com conectado", () => {
    expect(saudeDoEstadoUazapi("")).toEqual({ reachable: false, status: null, detail: "estado_desconhecido_vazio" });
    expect(saudeDoEstadoUazapi(null)).toEqual({ reachable: false, status: null, detail: "estado_desconhecido_vazio" });
  });
});
