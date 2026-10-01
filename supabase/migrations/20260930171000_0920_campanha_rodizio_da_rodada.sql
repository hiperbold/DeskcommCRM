-- 0920, rodízio da rodada de campanhas: `campaigns.last_tick_at` (D-098, fork Hiperbold).
--
-- Faixa 09xx reservada ao fork (ver 0901).
--
-- O defeito. O cron de campanhas (lib/campanhas/rodada.ts) lia só as 30 campanhas
-- `running` mais antigas (`order by started_at limit 30`) e, dentre elas, avaliava
-- uma por número. Campanha que fica esperando (ritmo, teto diário, número sem vaga)
-- continua `running` e continua entre as mais antigas: uma organização com 30
-- campanhas assim ocupava a janela para sempre, e a 31ª campanha em diante, de
-- qualquer organização, nunca era avaliada.
--
-- A correção. A rodada passa a ordenar por `last_tick_at` (nulo primeiro, depois
-- `started_at`) e grava `last_tick_at` na campanha que avaliou (e, um segundo antes,
-- na que só foi pulada por dividir o número com ela) ao fim do tique, então a
-- janela anda e toda campanha `running` é avaliada cedo ou tarde. A coluna é nula
-- para campanha nunca avaliada.
--
-- Reaplicável com o app no ar: `add column if not exists` nulo e sem default (só
-- catálogo, sem reescrever a tabela), `create index if not exists`, lock_timeout curto
-- para desistir em vez de ficar na fila. Sem função: nada a ver com a VARREDURA anon.

do $campanha_rodizio$
begin
 perform set_config('lock_timeout','3s',true);
 alter table public.campaigns add column if not exists last_tick_at timestamptz;
 create index if not exists idx_campaigns_rodizio_running
  on public.campaigns (last_tick_at nulls first, started_at)
  where status = 'running';
end
$campanha_rodizio$;
