-- 0912, aceitar um convite não dobra a conta do membro (D-053, item 1, fork Hiperbold).
--
-- Faixa 09xx reservada ao fork (ver 0901).
--
-- O defeito. No aceite (lib/auth/aplicar-convite.ts) a ordem é: (1)
-- fn_accept_team_invite grava o vínculo em user_organizations já ativo
-- (accepted_at preenchido); (2) só DEPOIS o convite em team_invites recebe
-- accepted_at. Entre os dois passos a MESMA pessoa aparece nas duas
-- contagens de "membros" (vínculo ativo + convite pendente). A 0907 fechou
-- isso nas funções de leitura (fn_billing_uso e fn_billing_pode_criar
-- ignoram o convite cujo e-mail já tem vínculo ativo,
-- fn_billing_convite_ja_tem_vinculo_ativo), mas a conferência de AVISO que o
-- próprio gatilho de user_organizations faz roda num BEFORE INSERT: nesse
-- instante o vínculo novo ainda NÃO é visível, então o convite pendente
-- continua contando (o ocupante já estava contado como convite) e
-- fn_billing_pode_criar responde "não pode criar mais um" para uma
-- organização exatamente no teto. Resultado medido: aviso espúrio na Central
-- "Limite de membros do plano atingido" ao aceitar um convite legítimo, sem
-- membro nenhum a mais do que o plano permite (o bloqueio de verdade já era
-- isento pela isenção 1 da 0907; só o aviso escapava).
--
-- A correção. Quando existe convite pendente e válido para o e-mail de quem
-- está virando membro (a mesma função da isenção 1,
-- fn_billing_convite_pendente_do_membro, que só vale para o servidor), a
-- vaga JÁ estava ocupada por esse convite: transformar convite em vínculo não
-- soma ocupante nenhum, então o aceite não confere o teto (nem avisa). Os
-- casos que de fato somam um ocupante continuam conferindo e avisando: aceite
-- sem linha de convite (token antigo, isenção 2), dono do provisionamento
-- (isenção 3), readmissão sem convite, insert direto de um vínculo ativo por
-- qualquer sessão que não seja o servidor. O bloqueio de verdade não muda
-- nada (as três isenções continuam exatamente as mesmas).
--
-- Regras de desenho da F2 preservadas (D-049): gatilho security definer com
-- search_path fixo; nada aqui lê organizations.settings.plan; a conferência
-- de aviso continua nunca lançando (quem pode falhar é
-- fn_billing_conferir_teto, que já captura).
--
-- Só troca o CORPO da função (create or replace): o gatilho
-- trg_billing_trava_user_organizations (0905) continua apontando para ela,
-- sem nenhum DDL em tabela quente. Reaplicável em produção com o app no ar,
-- instrução por instrução.

create or replace function public.fn_billing_trava_user_organizations()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_novo_ativo boolean;
  v_antigo_ativo boolean;
  v_invited_by_antigo uuid;
  v_invited_at_antigo timestamptz;
  v_convite_ja_ocupava_a_vaga boolean;
begin
  v_novo_ativo := new.accepted_at is not null and new.revoked_at is null and not new.provisional_until_handover;

  if tg_op = 'INSERT' then
    v_antigo_ativo := false;
    v_invited_by_antigo := null;
    v_invited_at_antigo := null;
  else
    v_antigo_ativo := old.accepted_at is not null and old.revoked_at is null and not old.provisional_until_handover;
    v_invited_by_antigo := old.invited_by;
    v_invited_at_antigo := old.invited_at;
  end if;

  if v_novo_ativo and not v_antigo_ativo then
    -- Isenção 1 da 0907: existe convite pendente e válido para o e-mail deste
    -- usuário nesta organização. Guardada numa variável porque agora decide
    -- DUAS coisas: liberar o bloqueio (como antes) e dispensar a conferência
    -- de aviso abaixo (0912): o convite já ocupava a vaga.
    v_convite_ja_ocupava_a_vaga :=
      public.fn_billing_convite_pendente_do_membro(new.organization_id, new.user_id);

    if not (
      v_convite_ja_ocupava_a_vaga
      or public.fn_billing_veio_de_aceite_de_convite(
        new.invited_by, new.invited_at, v_invited_by_antigo, v_invited_at_antigo, tg_op = 'INSERT'
      )
      or public.fn_billing_dono_do_provisionamento(new.organization_id, new.user_id, new.role)
    ) then
      if public.fn_billing_bloqueia(new.organization_id, 'membros', null) then
        raise exception 'Limite do plano atingido' using errcode = 'PT402', detail = 'membros';
      end if;
    end if;

    -- 0912: só confere o teto (e avisa) quando o vínculo SOMA um ocupante. Com
    -- convite pendente do mesmo e-mail a pessoa já estava contada como convite,
    -- e neste BEFORE INSERT o vínculo novo ainda não é visível: conferir aqui
    -- contaria a mesma pessoa duas vezes.
    if not v_convite_ja_ocupava_a_vaga then
      perform public.fn_billing_conferir_teto(new.organization_id, 'membros', null);
    end if;
  end if;

  return new;
end;
$$;

comment on function public.fn_billing_trava_user_organizations() is
  'Gatilho de plano (Tarefa 3, decisão 5): chama fn_billing_conferir_teto(membros) na transição para ativo (accepted_at preenchido, revoked_at nulo, provisional_until_handover falso), cobrindo aceite direto, readmissão de revogado e insert já ativo. O admin provisório nunca conta. Fase F3 (migration 0907, decisão 4, item 2): antes do bloqueio de verdade, três isenções (convite pendente do e-mail, aceite sem linha de convite, dono do provisionamento) liberam o aceite mesmo no teto. 0912 (D-053, item 1): quando a isenção 1 vale (convite pendente e válido do mesmo e-mail), a conferência de aviso NÃO roda, porque o convite já ocupava a vaga e, neste BEFORE INSERT, o vínculo novo ainda não é visível: conferir contaria a mesma pessoa duas vezes e abriria aviso espúrio numa organização exatamente no teto. Os demais casos (aceite sem convite, dono do provisionamento, readmissão sem convite) seguem conferindo e avisando.';

revoke execute on function public.fn_billing_trava_user_organizations() from public, anon, authenticated;
grant execute on function public.fn_billing_trava_user_organizations() to service_role;
