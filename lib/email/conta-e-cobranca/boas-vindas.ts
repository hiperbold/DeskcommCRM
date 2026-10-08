/**
 * CONTA-06, boas-vindas: sai quando uma empresa nasce do cadastro do próprio cliente
 * (`ensureTenantForUser`, `lib/auth/provision.ts`), só para quem a criou, com cópia para o operador. A chave é
 * a organização: a empresa nasce uma vez, e o e-mail sai uma vez.
 *
 * Também passa por aqui a aprovação de um pedido de cadastro pelo admin da plataforma
 * (`app/actions/registration/decide.ts`): ela chama `ensureTenantForUser` com a conta de quem pediu, e o e-mail
 * vai a essa pessoa (o `criadorUserId`), nunca ao admin que aprovou.
 *
 * Não passa por aqui: a empresa criada pelo provisionamento externo (`/api/v1/tenants/provision`), por script
 * ou por seed. Esses caminhos não chamam `ensureTenantForUser`.
 * A empresa recuperada (`source: "recovery"`, o cadastro que falhou e foi refeito) recebe: para quem a pessoa
 * olha, é a primeira vez que a empresa existe.
 *
 * Só enfileira (`fila.ts`): o envio é do cron `enviar-emails-de-conta`. Nunca lança: o cadastro não pode falhar
 * por causa de e-mail.
 */
import { enfileirarEmailDeConta, type DesfechoDoEnfileiramento } from "./fila";

export async function avisarBoasVindas(p: {
  organizationId: string;
  criadorUserId: string;
}): Promise<DesfechoDoEnfileiramento> {
  // O nome de quem recebe e o da empresa entram na hora do envio (o cadastro por e-mail não pede o nome da
  // pessoa, só o da empresa: sem nome, vale o da empresa). Aqui só se registra o fato.
  return enfileirarEmailDeConta({
    organizationId: p.organizationId,
    emailId: "CONTA-06",
    chave: `organizacao:${p.organizationId}`,
    destino: "criador",
    criadorUserId: p.criadorUserId,
    copiaParaOperador: true,
    dados: {},
  });
}
