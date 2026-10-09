/**
 * As chaves de instalação que pertencem a um CANAL — e por que elas moram aqui.
 *
 * O painel de configuração (`lib/instalacao/catalogo.ts`) precisa mostrar ao dono
 * da VPS o estado das credenciais do transporte de WhatsApp, porque é uma das
 * primeiras coisas que ele confere quando o atendimento para. Mas o NOME dessas
 * variáveis é o nome do provider, e a doutrina `restricao-de-canal` proíbe
 * nomear provider fora de `lib/channels/` — com razão: espalhar o nome pelo
 * código é o que torna impossível trocar de transporte depois.
 *
 * A saída não é abrir exceção no lint (a lista de lá é dívida em extinção, não
 * anistia): é deixar estas entradas DENTRO da fronteira que já tem o direito de
 * nomear o provider, e o catálogo as importa como dados. Quem lê o catálogo
 * continua sem nomear ninguém; quem nomeia é este arquivo, que é de canais.
 */

import { motivoDaRecusaDeDestino } from "@/lib/automation/destinos-internos-autorizados";

export interface ChaveDeCanal {
  readonly chave: string;
  readonly rotulo: string;
  readonly explicacao: string;
  readonly comoTrocar: string;
}

/**
 * Nenhuma delas é editável pela tela, e o motivo é físico, não de recorte: cada
 * uma tem um PAR do outro lado — o contêiner do transporte guarda a versão
 * embaralhada da mesma senha. Trocar só de um lado deixa os dois falando senhas
 * diferentes e derruba o WhatsApp. A troca é no arquivo de instalação, seguida
 * de reinício dos dois.
 */
export const CHAVES_DE_CANAL_DA_INSTALACAO: readonly ChaveDeCanal[] = [
  {
    chave: "WAHA_API_KEY",
    rotulo: "Senha de acesso ao WhatsApp",
    explicacao:
      "A senha que o sistema usa para falar com o programa que conecta o WhatsApp.",
    comoTrocar:
      "Esta senha tem um par do outro lado: o programa do WhatsApp guarda a versão embaralhada dela. Trocar só aqui deixaria os dois falando senhas diferentes e o WhatsApp cairia. A troca é no arquivo de instalação, seguida de reinício dos dois programas.",
  },
  {
    chave: "WAHA_HMAC_SECRET",
    rotulo: "Senha de conferência das mensagens recebidas",
    explicacao:
      "Garante que as mensagens que chegam vieram mesmo do WhatsApp, e não de um impostor.",
    comoTrocar:
      "Mesma situação da senha de acesso: o programa do WhatsApp guarda a outra metade. Os dois trocam juntos, no arquivo de instalação.",
  },
] as const;

/**
 * As chaves de canal que SIM se editam pela tela: o servidor de instâncias da
 * instalação e o token de administrador dele, que o CRM usa para criar a
 * instância do cliente quando ele lê o QR Code dentro do CRM.
 *
 * Diferente das duas acima, estas não têm par em outro contêiner: quem as lê é
 * o próprio app, no momento do uso (`valorDaInstalacao`), então trocar pela tela
 * vale na hora. Sem as duas, o pareamento por QR simplesmente não aparece e a
 * conexão por servidor e token do cliente segue como sempre.
 *
 * `validar` devolve a frase de recusa, ou `null` quando o valor serve (pode ser
 * assíncrono: a régua de destino resolve DNS). O endereço exige https, porque o
 * token de administrador viaja nele e em texto puro qualquer ponto da rede o leria,
 * e passa pela MESMA régua de destino de toda saída configurada por organização:
 * IP privado, link-local (169.254.x.x, o serviço de metadados da nuvem), loopback e
 * nome que resolve para eles são recusados na hora de gravar, e não só no uso.
 */
export interface ChaveDeCanalEditavel {
  readonly chave: string;
  readonly rotulo: string;
  readonly explicacao: string;
  readonly natureza: "segredo" | "texto";
  readonly validar?: (valor: string) => string | null | Promise<string | null>;
  /**
   * Gravar esta chave exige o segundo fator PROVADO nesta sessão (aal2), como o segredo do grupo
   * WhatsApp. Vale para o endereço do servidor: quem o troca decide para onde o token de
   * administrador da instalação viaja.
   */
  readonly exigeSegundoFator?: boolean;
  /**
   * Chaves guardadas na tela que perdem o valor quando ESTA muda (voltam ao arquivo de instalação):
   * o segredo que foi digitado para um endereço não pode seguir valendo para outro.
   */
  readonly apagaAoMudar?: readonly string[];
  /** Como comparar o valor novo com o atual para saber se mudou (o mesmo endereço escrito de outro jeito não muda). */
  readonly normalizar?: (valor: string) => string;
}

export const CHAVES_DE_CANAL_EDITAVEIS_DA_INSTALACAO: readonly ChaveDeCanalEditavel[] = [
  {
    chave: "UAZAPI_SERVIDOR_URL",
    rotulo: "Servidor de WhatsApp para conectar por QR Code",
    explicacao:
      "O endereço (https) do servidor onde o CRM cria o WhatsApp do cliente quando ele lê o QR Code. Só com este endereço e o token de administrador abaixo a opção de conectar por QR Code aparece em Conexões.",
    natureza: "texto",
    exigeSegundoFator: true,
    // O token de administrador gravado foi digitado para o endereço de antes: ao trocar o endereço, ele sai
    // e tem de ser digitado de novo. Sem isto, quem alcançasse esta tela apontava o servidor para um host
    // seu e o CRM mandava a ele, na criação da próxima instância, o token já guardado.
    apagaAoMudar: ["UAZAPI_ADMIN_TOKEN"],
    normalizar: (valor) => {
      try {
        return new URL(valor.trim()).origin;
      } catch {
        return valor.trim();
      }
    },
    validar: async (valor) => {
      let url: URL;
      try {
        url = new URL(valor.trim());
      } catch {
        return "Endereço de servidor inválido.";
      }
      if (url.protocol !== "https:") return "O endereço precisa começar com https://.";
      if (!url.hostname.includes(".")) return "Endereço de servidor inválido.";
      // A régua de destino das saídas por organização: mensagem fixa, sem dizer se foi
      // endereço interno ou nome que não resolve (nunca o código técnico).
      if (await motivoDaRecusaDeDestino(url.origin, "organizacao")) {
        return "Este endereço não pode ser usado: ele aponta para a rede interna ou não foi encontrado.";
      }
      return null;
    },
  },
  {
    chave: "UAZAPI_ADMIN_TOKEN",
    rotulo: "Token de administrador do servidor de WhatsApp",
    explicacao:
      "A senha de administrador do servidor acima, usada só para criar e apagar o WhatsApp dos clientes. Fica guardada cifrada e não é mostrada de novo.",
    natureza: "segredo",
  },
] as const;
