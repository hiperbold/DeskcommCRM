/**
 * (A) e (H, a parte de ligação) do LOTE 2 da Tarefa 9.
 *
 * `executarTurnoDoAgente` não é exportada (é o núcleo do turno inteiro, caro
 * demais para rodar de ponta a ponta num teste unitário sem banco — mesma
 * doutrina de `handoff-por-orcamento.test.ts`, que também recorre ao TEXTO
 * quando o call site não é alcançável por unidade). O que se prova aqui é
 * ausência/presença de um trecho exato, sempre com CONTROLE NEGATIVO: sem
 * ele, um detector quebrado ficaria verde por não medir nada.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CAMINHO = join(process.cwd(), "lib/agent-engine/agent/inbound-turn.ts");
const FONTE = readFileSync(CAMINHO, "utf8");

function blocoDePuladas(fonte: string): string {
  const inicio = fonte.indexOf("if (mcp.puladas.length > 0) {");
  // Pára no `catch` que fecha o `try` deste bloco — não em "A CURA" (mais
  // adiante no arquivo): entre os dois fica o `catch (err)` do item (I), que
  // TEM o seu próprio `impediments.push` legítimo (falha total de montagem,
  // não uma pulada de política) e não pode contaminar esta asserção.
  const fim = fonte.indexOf("} catch (err) {", inicio);
  if (inicio === -1 || fim === -1) {
    throw new Error(
      "não achei o bloco de `mcp.puladas` em inbound-turn.ts — o extrator perdeu o alvo. " +
        "Perder o alvo NÃO é aprovação: conserte o extrator, nunca apague o caso.",
    );
  }
  return fonte.slice(inicio, fim);
}

describe("(A) puladas de ferramenta MCP nunca vira impediment de prévia", () => {
  it("o bloco que trata mcp.puladas não empurra capabilities_unavailable — só loga e (fora da prévia) delega a `mensagensDePuladasParaAvisar` (quais motivos avisam é coberto, sem banco, em mensagens-de-puladas-para-avisar.test.ts)", () => {
    const bloco = blocoDePuladas(FONTE);
    expect(
      bloco,
      "um impediment aqui preenche impediments[0], e reply-drafts.ts grava error_code = " +
        "impediments[0]?.code na MESMA linha que marca o rascunho como sucesso — corrompendo o contrato",
    ).not.toContain("impediments.push");
    expect(bloco).toContain("runLog.info('ferramentas MCP externas puladas no turno'");
    expect(bloco).toContain("mensagensDePuladasParaAvisar(mcp.puladas)");
  });

  it("controle negativo: o detector acusa a volta de um impediment no bloco de puladas", () => {
    const bloco = blocoDePuladas(FONTE);
    const sabotado = bloco.replace(
      "runLog.info('ferramentas MCP externas puladas no turno', { puladas: mcp.puladas });",
      "preview?.result.impediments.push({ code: 'capabilities_unavailable', message: 'x' });\n            runLog.info('ferramentas MCP externas puladas no turno', { puladas: mcp.puladas });",
    );
    expect(sabotado).not.toBe(bloco);
    expect(sabotado).toContain("impediments.push");
  });

  it("no_candidate continua condicionado a impediments vazio — é o contrato que a ausência acima protege", () => {
    const marcador =
      "if (preview.result.candidates.length === 0 && preview.result.impediments.length === 0)";
    expect(FONTE).toContain(marcador);
    const idx = FONTE.indexOf(marcador);
    expect(FONTE.slice(idx, idx + 250)).toContain("no_candidate");
  });

  it("controle negativo: o detector acusa a guarda de no_candidate enfraquecida (sem checar impediments)", () => {
    const marcador =
      "if (preview.result.candidates.length === 0 && preview.result.impediments.length === 0)";
    const enfraquecido = FONTE.replace(marcador, "if (preview.result.candidates.length === 0)");
    expect(enfraquecido).not.toBe(FONTE);
    expect(enfraquecido).not.toContain(marcador);
  });
});

describe("(H) a prévia recebe de inbound-turn.ts só os ids externos que a montagem aprovou", () => {
  it("mcpExternasDeConsulta nasce vazio, é atualizado a partir de mcp.externasDeConsulta, e é o ÚLTIMO argumento de applyPreviewPolicy", () => {
    expect(FONTE).toContain("let mcpExternasDeConsulta: Set<string> = new Set();");
    expect(FONTE).toContain("mcpExternasDeConsulta = mcp.externasDeConsulta;");

    const inicioChamada = FONTE.indexOf("applyPreviewPolicy(");
    expect(inicioChamada, "a chamada de applyPreviewPolicy sumiu do arquivo").toBeGreaterThan(-1);
    const fimChamada = FONTE.indexOf(");", FONTE.lastIndexOf("agendaToolCalledThisTurn,", inicioChamada + 2000));
    const chamada = FONTE.slice(inicioChamada, fimChamada + 2);
    expect(
      chamada,
      "applyPreviewPolicy sem o Set aprovado cai no default vazio (fail-closed) — nenhuma externa roda na prévia",
    ).toContain("mcpExternasDeConsulta,");
  });

  it("controle negativo: o detector acusa a ligação removida (a chamada some do último argumento)", () => {
    const semLigacao = FONTE.replace(
      "            // (H) só os ids externos que a montagem aprovou como consulta.\n            mcpExternasDeConsulta,\n          )",
      "          )",
    );
    expect(semLigacao, "a sabotagem não bateu no texto atual — ajuste o marcador junto com o refactor").not.toBe(
      FONTE,
    );
    const inicioChamada = semLigacao.indexOf("applyPreviewPolicy(");
    const fimChamada = semLigacao.indexOf(
      ");",
      semLigacao.lastIndexOf("agendaToolCalledThisTurn,", inicioChamada + 2000),
    );
    const chamada = semLigacao.slice(inicioChamada, fimChamada + 2);
    expect(chamada).not.toContain("mcpExternasDeConsulta,");
  });
});
