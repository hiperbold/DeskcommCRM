/**
 * Orçamento de TENTATIVAS DE CONEXÃO MCP, somado entre criar
 * (`app/api/v1/ai/mcp/conexoes/route.ts`) e "Atualizar ferramentas"
 * (`app/api/v1/ai/mcp/conexoes/[id]/atualizar/route.ts`).
 *
 * Vive FORA das duas rotas, e não dentro de uma delas, por dois motivos:
 *
 *  1. Um `route.ts` do App Router só pode exportar os handlers HTTP
 *     (`GET`/`POST`/...) e a config de rota (`dynamic`, `runtime`, ...) — o
 *     Next confere isso e `next build` recusa qualquer outro export nomeado
 *     com "is not a valid Route export field".
 *  2. Importar uma rota de dentro de outra é frágil mesmo quando o build
 *     deixa passar: acopla o roteamento (App Router pode reescrever como
 *     esses arquivos são carregados) ao que devia ser só lógica de negócio.
 *
 * Cada tentativa abre uma sessão de verdade contra um servidor escolhido por
 * quem preenche o formulário (D7 do plano: endereço controlado por entrada
 * não confiável). Sem teto, o cadastro de conexão MCP vira uma varredura de
 * rede grátis: tentar mil endereços internos, um por requisição, lendo o
 * `last_error` de cada um. 10 em 10 minutos é folga generosa para configurar
 * uma conexão de verdade (poucas tentativas, erros de digitação incluídos) e
 * curto demais para valer como sonda.
 *
 * `checkRateLimit` já existe no repositório (`lib/ai/dispatcher/rate-limit.ts`,
 * usado pelo dispatcher de IA e pelo rate limit de auth): reaproveitado aqui
 * em vez de um contador novo, mesmo padrão (Redis com recuo em memória).
 */
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";

const LIMITE_DE_TENTATIVAS_DE_CONEXAO = 10;
const JANELA_DO_LIMITE_DE_CONEXAO_SEG = 600; // 10 minutos

export const MOTIVO_LIMITE_DE_CONEXAO = "Muitas tentativas de conexão. Espere alguns minutos.";

/** `true` = ainda dentro do orçamento. A chamada JÁ CONTA, mesmo quando o resultado é `false`. */
export async function tentativaDeConexaoLiberada(orgId: string, userId: string): Promise<boolean> {
  const bucket = `mcp_conexao:${orgId}:${userId}`;
  const resultado = await checkRateLimit(bucket, LIMITE_DE_TENTATIVAS_DE_CONEXAO, JANELA_DO_LIMITE_DE_CONEXAO_SEG);
  return resultado.allowed;
}
