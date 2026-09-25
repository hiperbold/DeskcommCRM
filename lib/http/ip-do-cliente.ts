/**
 * DE ONDE VEIO A REQUISIÇÃO, uma régua só.
 *
 * O repo lia isto inline em 15 lugares (`x-forwarded-for?.split(",")[0]`), e só
 * um deles (o rate limit de autenticação) tinha o plano B do `x-real-ip`, que
 * é o que o Nginx costuma setar sozinho. Quinze cópias de uma leitura é quinze
 * lugares para consertar quando a hospedagem muda de header.
 *
 * ═══ D-036: o PRIMEIRO salto era o que o CLIENTE escreve ═══
 *
 * `x-forwarded-for` é uma lista que cresce por APPEND: cada proxy pelo qual a
 * requisição passa acrescenta ao FIM o endereço de quem se conectou nele
 * diretamente. O primeiro item da lista é o que o cliente HTTP escolheu mandar,
 * e nada impede um `curl -H "X-Forwarded-For: 1.2.3.4"` de inventar qualquer
 * coisa ali. O item que um proxy NOSSO acrescentou é, por definição, verdadeiro:
 * é o endereço que ELE viu se conectando.
 *
 * Esta stack só tem os proxies que ELA MESMA sobe na frente do app (Caddy no
 * `docker-compose.prod.yml` padrão, ou o Traefik da hospedagem no override
 * `docker-compose.traefik.yml`: Coolify, Dokploy, CapRover, Hostinger). Em
 * QUALQUER uma dessas topologias medidas, é UM salto confiável entre o cliente
 * e o app: o último item da lista é sempre o que esse proxy acrescentou.
 *
 * `TRUSTED_PROXY_COUNT` existe para quem coloca infraestrutura ADICIONAL na
 * frente dessa (ex.: um CDN/WAF antes do Traefik da hospedagem); aí são dois
 * saltos confiáveis, e o valor bom passa a ser o PENÚLTIMO item, não o último.
 * Sem essa variável, o padrão (1) cobre a instalação normal sem quebrar nada.
 *
 * ═══ O QUE ESTE VALOR NÃO É ═══
 *
 * Não é prova de origem ABSOLUTA, é a leitura correta de um header que só um
 * proxy NOSSO escreve por último. Nada no produto pode DECIDIR acesso com base
 * nele, nem autorizar, nem bloquear. Ele serve para (a) isolar um balde de
 * rate limit, (b) registrar de onde uma ação veio no audit, para quem opera
 * reconhecer padrão e investigar.
 *
 * ═══ `null` em vez de sentinela ═══
 *
 * "Não sei de onde veio" precisa ser inexprimível como se fosse uma origem.
 * Uma string tipo `"desconhecido"` vira balde compartilhado no rate limit e
 * vira uma linha que parece um IP na tela. Índice insuficiente (menos saltos no
 * header do que `TRUSTED_PROXY_COUNT` configurado) também vira `null`: adivinhar
 * um índice errado devolveria um valor forjável, que é exatamente o defeito que
 * isto conserta.
 */

import { isIP } from "node:net";

/**
 * Quantos proxies NOSSOS ficam entre o cliente e o app, cada um acrescentando
 * ao `x-forwarded-for`. Sem padrão declarado no repositório antes desta
 * mudança (ver D-036 em `hiperbold/DEBITO.md`). `0` desliga a confiança nos
 * dois headers (app exposto direto, sem proxy nenhum). Valor ausente, vazio ou
 * inválido cai no padrão de 1 (a topologia normal desta stack): a falha é
 * fechada, nunca aberta por uma variável mal escrita.
 */
function proxiesConfiaveis(): number | null {
  // Sem a variável (ou com valor inválido), vale o comportamento ANTIGO, o do
  // primeiro salto: a produção roda atrás de Cloudflare mais o Traefik da
  // hospedagem, e ligar a leitura de trás sem saber quantos saltos existem
  // poria todo mundo no balde de rate limit do mesmo endereço de borda. A
  // correção do D-036 liga quando a instalação declara a conta de saltos.
  const bruto = process.env.TRUSTED_PROXY_COUNT;
  if (bruto === undefined || bruto.trim() === "") return null;
  const n = Number.parseInt(bruto, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * O salto confiável do `x-forwarded-for` (o `TRUSTED_PROXY_COUNT`-ésimo a
 * partir do FIM da lista), ou o `x-real-ip`. `null` = sem proxy confiável à
 * frente, ou header curto demais para confiar em algum índice.
 */
export function ipDoCliente(headers: Headers): string | null {
  const confiaveis = proxiesConfiaveis();
  if (confiaveis === 0) return null;

  if (confiaveis === null) {
    const primeiro = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
    if (primeiro) return primeiro;
    const realAntigo = headers.get("x-real-ip")?.trim();
    return realAntigo || null;
  }

  const encaminhados = headers.get("x-forwarded-for");
  if (encaminhados) {
    const saltos = encaminhados
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const indice = saltos.length - confiaveis;
    return indice >= 0 ? (saltos[indice] ?? null) : null;
  }

  const real = headers.get("x-real-ip")?.trim();
  return real || null;
}

/**
 * O mesmo valor, mas só quando o Postgres o aceitaria como `inet`.
 *
 * A coluna `webhook_lead_captures.remote_ip` é `inet`, e um INSERT com texto que
 * não é IP falha com `22P02` — o que derrubaria o registro inteiro da captação
 * por causa de um header malformado (que é justamente o que um cliente hostil
 * mandaria). Aqui o valor inválido vira `null`: a linha entra, sem a origem.
 *
 * ═══ Por que `net.isIP` e não uma regex ═══
 *
 * A primeira versão desta função tinha uma regex escrita à mão para IPv6
 * (`/^[0-9a-fA-F:]+…/` mais `includes(":")`), e ela ACEITAVA lixo que o Postgres
 * recusa: `":::::"` passa (só hex e dois-pontos), `"12345::"` passa (cinco
 * dígitos hex num grupo de quatro). Qualquer um dos dois num `X-Forwarded-For`
 * derrubava o INSERT inteiro com `22P02` — e como `registrarCaptacao` não lança,
 * a captação sumia da tela em silêncio. Ou seja: um header hostil apagava do
 * histórico exatamente a batida que alguém queria investigar.
 *
 * `net.isIP` é a implementação do próprio Node (devolve 4, 6 ou 0) e não tem
 * como divergir por descuido de regex. IPv6 é notoriamente difícil de validar à
 * mão — `::ffff:1.2.3.4`, zeros comprimidos, grupos de tamanho variável — e
 * escrever essa regex era trabalho para uma ferramenta que já existe.
 *
 * ⚠️ `isIP` sozinho NÃO BASTA, e isto foi MEDIDO contra o Postgres, não
 * presumido — a primeira versão deste comentário afirmava o contrário:
 *
 *     node  -> isIP("fe80::1%eth0") === 6           (aceita a zona)
 *     psql  -> ERROR: invalid input syntax for type inet: "fe80::1%eth0"
 *
 * Ou seja, o identificador de zona (`%eth0`) atravessaria o guarda e recriaria
 * exatamente o `22P02` que ele existe para impedir. O `%` é recusado antes.
 * Notação CIDR (`/64`) também sai: o Postgres a aceitaria, mas um prefixo de
 * rede não é "de onde veio esta requisição".
 *
 * A validação é de FORMA, não de veracidade — ver o cabeçalho.
 */
export function ipDoClienteParaInet(headers: Headers): string | null {
  const bruto = ipDoCliente(headers);
  if (bruto === null) return null;
  if (bruto.includes("%") || bruto.includes("/")) return null;
  return isIP(bruto) === 0 ? null : bruto;
}
