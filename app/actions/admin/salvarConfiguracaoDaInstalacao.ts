"use server";

import { revalidatePath } from "next/cache";

import { audit } from "@/lib/audit";
import { requirePlatformAdminFull } from "@/lib/auth/portao-de-escrita";
import { sessionAal } from "@/lib/auth/server";
import { acharChave } from "@/lib/instalacao/catalogo";
import {
  estadoParaTela,
  gravarPelaTela,
  valorDaInstalacao,
  voltarAoAmbiente,
  type EstadoParaTela,
} from "@/lib/instalacao/config";

/**
 * `ok: true` carrega o ESTADO NOVO da chave, relido depois da escrita.
 *
 * A tela aplica esse estado direto, em vez de depender do `router.refresh()`.
 * Medido neste repo (memória `project_router_refresh_perde_corrida`): o refresh
 * disparado depois de uma mutação é atropelado pelos prefetches RSC da barra
 * lateral e a tela fica no estado ANTERIOR cerca de metade das vezes — com o
 * dado já gravado no banco. A bateria E2E do painel reprovou exatamente assim,
 * duas rodadas seguidas: o operador clicava "Voltar ao padrão" e a tela seguia
 * dizendo "Definido aqui nesta tela". Aplicar o corpo da resposta é
 * determinístico por construção; o refresh continua, só que ninguém depende dele.
 */
export type ResultadoDaGravacao =
  | {
      ok: true;
      estado: EstadoParaTela;
      /** Algo além do que foi pedido aconteceu e a pessoa precisa saber (ex.: outra chave foi limpa). */
      aviso?: string;
    }
  | { ok: false; erro: string };

/**
 * Grava uma chave da instalação pela tela.
 *
 * ── O gate é `requirePlatformAdminFull()`, e a razão é a mesma de `updateBranding` ─
 *
 * Server Action não é rota: não passa por `requireRole` nem pelo layout de
 * `/admin`. Um POST direto na action, com sessão de um platform admin, entraria
 * sem o gate — e aqui o banco NÃO tem como fechar o buraco, porque a escrita vai
 * pelo `service_role` e o Postgres não enxerga a sessão do GoTrue. O objeto
 * editado é a INSTALAÇÃO inteira, não uma organização: num revendedor, deixar
 * isso com o admin de um tenant seria dar a um cliente as credenciais dos
 * outros.
 *
 * ── A chave vem do CATÁLOGO, nunca do corpo da requisição ────────────────────
 *
 * `acharChave()` resolve o nome contra a lista declarada em código. Sem isso, o
 * corpo poderia nomear QUALQUER chave — inclusive uma `de_partida` ou uma
 * `chave_mestra`, que a tela não oferece de propósito. É a mesma doutrina de
 * resolver `organization_id` de fonte confiável e nunca do body.
 *
 * ── O audit registra o FATO, jamais o VALOR ──────────────────────────────────
 *
 * `api_audit_log` é append-only por schema — nenhum papel tem GRANT de UPDATE ou
 * DELETE, nem o `service_role`. Um segredo que entre ali não sai mais: fica cinco
 * anos, legível por quem puder ler a tabela. E o molde que um implementador
 * copiaria (`app/api/v1/agenda/configuracao/route.ts`) passa `metadata:
 * parsed.data` inteiro. Aqui vai só o nome da chave e os últimos 4 caracteres —
 * o suficiente para auditar "quem trocou o quê e quando" sem guardar o segredo.
 */
export async function salvarConfiguracaoDaInstalacao(
  chave: string,
  valor: string,
): Promise<ResultadoDaGravacao> {
  const { user } = await requirePlatformAdminFull();

  const doCatalogo = acharChave(chave);
  if (!doCatalogo || doCatalogo.controle !== "edita") {
    // Falha fechada: chave fora do catálogo, ou que a tela mostra só como
    // diagnóstico, não é editável nem por caminho alternativo.
    return { ok: false, erro: "Esta configuração não pode ser alterada por aqui." };
  }

  const limpo = valor.trim();
  if (limpo.length === 0) {
    return { ok: false, erro: "Escreva um valor, ou use “Voltar ao padrão” para limpar." };
  }

  // Segredo do WhatsApp (ex.: o token de administrador do servidor de QR Code): quem o
  // grava passa a poder criar e apagar WhatsApp pago de toda empresa da instalação. O mesmo
  // vale para o endereço desse servidor (`exigeSegundoFator`): quem o troca decide para onde
  // o token de administrador viaja.
  // `requirePlatformAdminFull` só barra a sessão em dívida com o segundo fator; aqui se
  // exige o segundo fator PROVADO nesta sessão (aal2), também de quem ainda não cadastrou
  // um (aí precisa ativar a verificação em duas etapas antes).
  if (doCatalogo.exigeSegundoFator || (doCatalogo.natureza === "segredo" && doCatalogo.grupo === "whatsapp")) {
    if ((await sessionAal()) !== "aal2") {
      return {
        ok: false,
        erro: doCatalogo.natureza === "segredo"
          ? "Para gravar esta senha é preciso ter a verificação em duas etapas ativa e confirmada nesta sessão. Entre de novo informando o código de 6 dígitos."
          : "Para trocar este endereço é preciso ter a verificação em duas etapas ativa e confirmada nesta sessão. Entre de novo informando o código de 6 dígitos.",
      };
    }
  }

  // Conferência própria da chave (ex.: endereço de servidor só com https e fora da rede
  // interna). A frase vem do catálogo, escrita para a pessoa: nunca o valor digitado.
  const recusa = (await doCatalogo.validar?.(limpo)) ?? null;
  if (recusa) return { ok: false, erro: recusa };

  // Trocar o endereço de que um segredo depende apaga o segredo guardado (volta ao arquivo de
  // instalação), ANTES de gravar o endereço novo: se a limpeza falhar nada é gravado, e se a
  // gravação falhar depois o pior é digitar o segredo de novo. Mesmo endereço escrito de outro
  // jeito (maiúsculas, porta padrão, barra no fim) não é troca.
  const limpas: string[] = [];
  if (doCatalogo.apagaAoMudar && doCatalogo.apagaAoMudar.length > 0) {
    const normalizar = doCatalogo.normalizar ?? ((v: string) => v.trim());
    const atual = (await valorDaInstalacao(chave)).valor;
    if (atual === null || normalizar(atual) !== normalizar(limpo)) {
      for (const dependente of doCatalogo.apagaAoMudar) {
        const apagou = await voltarAoAmbiente(dependente);
        if (!apagou.ok) {
          return { ok: false, erro: "Não consegui salvar agora. Tente de novo em instantes." };
        }
        limpas.push(dependente);
      }
    }
  }

  const r = await gravarPelaTela(chave, limpo, {
    ehSegredo: doCatalogo.natureza === "segredo",
    ator: user.id,
  });

  if (!r.ok) {
    if (r.motivo === "sem_chave_de_cifra") {
      // Falha fechada na AÇÃO, aberta na INFORMAÇÃO: não grava em claro, e diz
      // em português o que falta em vez de devolver o erro técnico da cifra.
      return {
        ok: false,
        erro:
          "Esta instalação está sem a chave que protege segredos guardados, então nada foi salvo. " +
          "Peça a quem cuida do servidor para conferir a chave de criptografia no arquivo de instalação.",
      };
    }
    return { ok: false, erro: "Não consegui salvar agora. Tente de novo em instantes." };
  }

  await audit({
    action: "platform.config_changed",
    actorUserId: user.id,
    actingAsPlatformAdmin: true,
    resourceType: "platform_config",
    resourceId: null,
    metadata: {
      chave,
      // NUNCA o valor. Os últimos 4 caracteres identificam QUAL credencial ficou
      // lá sem revelá-la — mesma decisão de `ai_provider_credentials`.
      last4: doCatalogo.natureza === "segredo" ? limpo.slice(-4) : undefined,
      natureza: doCatalogo.natureza,
      ...(limpas.length > 0 ? { limpou_ao_mudar: limpas } : {}),
    },
  });

  revalidatePath("/admin/configuracao");
  return {
    ok: true,
    estado: await estadoParaTela(chave, doCatalogo.natureza === "segredo"),
    ...(limpas.length > 0
      ? { aviso: "O endereço mudou, então a senha de administrador guardada foi apagada. Digite-a de novo." }
      : {}),
  };
}

/**
 * Apaga a linha e devolve a palavra ao arquivo de instalação — o "voltar ao
 * padrão". Sem linha, o resolvedor lê o `.env` de novo e pode semear outra vez.
 */
export async function voltarConfiguracaoAoPadrao(chave: string): Promise<ResultadoDaGravacao> {
  const { user } = await requirePlatformAdminFull();

  const doCatalogo = acharChave(chave);
  if (!doCatalogo || doCatalogo.controle !== "edita") {
    return { ok: false, erro: "Esta configuração não pode ser alterada por aqui." };
  }

  const r = await voltarAoAmbiente(chave);
  if (!r.ok) return { ok: false, erro: "Não consegui limpar agora. Tente de novo em instantes." };

  await audit({
    action: "platform.config_reset",
    actorUserId: user.id,
    actingAsPlatformAdmin: true,
    resourceType: "platform_config",
    resourceId: null,
    metadata: { chave },
  });

  revalidatePath("/admin/configuracao");
  return { ok: true, estado: await estadoParaTela(chave, doCatalogo.natureza === "segredo") };
}
