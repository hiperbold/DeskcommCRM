/**
 * O GATE DA ASSINATURA SUSPENSA: decisão, sem I/O. Irmã de `./carteira.ts`
 * (decisões 5 e 6 da fase F4, `hiperbold/planos/fase-F4-tarefas.md`, Tarefa 6).
 *
 * ═══ POR QUE É UM GATE SEPARADO, ANTES DA CARTEIRA E DO ORÇAMENTO ═══
 *
 * O modo leitura (`fn_billing_modo_leitura`, migration 0908 parte 2) não mede
 * gasto nenhum: mede se a ASSINATURA da organização está em dia (contrato
 * `suspensa`/`cancelada`, bloqueio ligado e carência vencida). É um veto
 * anterior aos dois outros (carteira de tokens e orçamento em dólar) porque uma
 * conta que não paga a mensalidade não tem "saldo" nem "teto" que a salve — a
 * decisão 6 da fase é explícita: "a checagem da IA é separada da carteira e vem
 * ANTES dos atalhos de origem da chave e de propósito".
 *
 * ═══ A ISENÇÃO É MAIS ESTREITA QUE A DE `PURPOSES_ISENTOS` (ORÇAMENTO) ═══
 *
 * A suspensão vale para QUALQUER chave (da instalação ou BYOK da organização —
 * ao contrário da carteira, que só debita a chave da instalação) e QUALQUER
 * propósito que responda ao cliente. Só ficam isentos os DOIS guardrails
 * puramente internos de segurança, que classificam mensagens já recebidas para
 * proteger a própria conta e NUNCA respondem ao cliente:
 *
 *   - `jailbreak_detect` (`lib/agent-engine/guardrails/jailbreak/classifier.ts`)
 *   - `promise_semantic` (`lib/agent-engine/guardrails/promise/semantic.ts`)
 *
 * Desligar um guardrail de segurança numa conta já inadimplente trocaria dívida
 * por vulnerabilidade exatamente na hora em que ninguém está olhando a conta.
 *
 * `connection_test` (isento no orçamento em dólar, `PURPOSES_ISENTOS`) NÃO é
 * isento aqui, de propósito: ele existe para validar uma credencial ANTES de a
 * IA responder ao cliente com ela — uma conta suspensa não tem cliente para a
 * IA responder, então testar o canal de resposta é exatamente a ação que o modo
 * leitura deveria barrar, não uma exceção a ela.
 */
import { type ChaveDeOrcamento } from './orcamento';
import type { ModoDeBilling } from './carteira';

/** Ver o cabeçalho do arquivo: isenção estreita, só segurança interna. */
export const PURPOSES_ISENTOS_DA_ASSINATURA = ['jailbreak_detect', 'promise_semantic'] as const;

/**
 * O PORTÃO DE CUSTO (decisão 6): "zero consulta a mais" no modo avisar/desligado.
 * As duas condições, em ordem do mais barato para o mais caro: quem chama já
 * testou `chave` e `purpose` (ambos em memória) ANTES de pagar a leitura
 * cacheada de `billing_settings.modo` — esta função só existe para a decisão em
 * si ficar testável sem banco, com o `modo` já resolvido entregue por parâmetro.
 *
 * SEM o atalho de `origemDaChave` que `deveConsultarCarteira` tem: aqui a
 * suspensão vale para as duas origens (decisão 6).
 */
export function deveConsultarAssinatura(d: {
  chave: ChaveDeOrcamento;
  modoDoBanco: ModoDeBilling;
  purpose: string;
}): boolean {
  if (d.chave === 'off') return false;
  if ((PURPOSES_ISENTOS_DA_ASSINATURA as readonly string[]).includes(d.purpose)) return false;
  return d.modoDoBanco === 'bloquear';
}

/**
 * O título do aviso crítico na Central — texto literal da decisão 6 da fase F4.
 * Compartilhado pelos DOIS caminhos que abrem este item (o seam do engine e o
 * worker legado, `workers/ai-response-worker.ts`), mesma doutrina de
 * `AVISO_TITULO`/`AVISO_CORPO` em `./orcamento.ts`: duas cópias do mesmo texto
 * virariam dois textos, e quem lê a Central não saberia que são a mesma coisa.
 *
 * Dedup por TÍTULO ABERTO (`status = 'open'`, sem período embutido): diferente
 * de `carteiraBloqueioTitulo` (que embute o ciclo), este aviso não tem como
 * consultar `billing_token_avisos_emitidos` — a tabela de dedup que sobrevive
 * ao encerramento (0906) é concedida só a `service_role`, e este gate roda com
 * o pool/cliente do `agent_worker` (ver o grant explícito de
 * `fn_billing_modo_leitura` na migration 0908 parte 2, que documenta a mesma
 * exceção). Mesmo padrão de `BLOQUEIO_TITULO` (orçamento em dólar) e de
 * `TITULO_ENDERECO_SEM_CHAVE_DA_EMPRESA`: título fixo, dedup "enquanto aberto".
 * O aviso PERIÓDICO por ciclo (entrada em atrasada, suspensão, cancelamento)
 * já existe em `fn_billing_avisar_assinatura` (migration 0908 parte 2, decisão
 * 9), chamado pelo conferidor diário com dedup por período — este aviso aqui é
 * só o registro de que a IA, especificamente, recusou uma chamada.
 */
export const TITULO_ASSINATURA_SUSPENSA =
  'A conta está suspensa: a IA e as automações estão paradas até o pagamento ser regularizado';

/** O corpo do aviso — aponta para a tela onde se resolve (Plano e uso). */
export function corpoDaSuspensaoDeAssinatura(): string {
  return (
    'O pagamento desta organização não foi regularizado dentro da carência, e o acesso está em ' +
    'modo leitura: a IA e as automações pararam de responder aos clientes. As conversas que estavam ' +
    'sendo atendidas pela IA foram para a fila de atendimento humano. Para a IA voltar a responder, ' +
    'regularize o pagamento em Configurações › Plano e uso.'
  );
}

/**
 * `conversations.last_handoff_reason` (coluna livre) e o motivo de skip do
 * worker legado — valor PRÓPRIO, para quem lê distinguir de
 * `carteira_de_tokens_esgotada`/`orcamento_de_ia`: os três param a IA por
 * motivos de negócio diferentes, e cada um manda quem investiga para uma tela
 * diferente (Plano e uso › Assinatura, e não Uso de IA › Orçamento).
 */
export const HANDOFF_REASON_ASSINATURA = 'assinatura_suspensa';
