-- 0951, o plano de código `escale` passa a se chamar Scale (fork Hiperbold).
--
-- Faixa 09xx reservada ao fork (ver 0901).
--
-- Decisão do Filipe em 08/10/2026: o nome que as pessoas veem do plano mais alto muda de "Escale"
-- para "Scale". Só o NOME exibido muda (billing_plans.name, que as telas, os e-mails e a descrição da
-- cobrança no Asaas leem). O CÓDIGO interno continua `escale`: billing_plans.code, preços, pedidos,
-- contratos e settings seguem apontando para ele, nada de preço, limite ou versão muda.
-- Medido: billing_plans.name é a única coluna do banco que guarda o nome do plano; o catálogo de
-- limites (jsonb `limits`) só tem as sete chaves numéricas, sem texto.
-- A 0904 semeou o nome antigo e o baseline a reaplica (on conflict do nothing), então este bloco
-- vem depois dela e corrige a cada atualização. Só troca a linha que ainda tem o nome antigo, em
-- qualquer versão do plano: um nome que o admin tenha escolhido depois não é sobrescrito.
-- Reaplicável com o app no ar: um update só, idempotente, lock_timeout curto, sem função.
-- Sem função: nada a ver com a VARREDURA anon.

do $d0951$
begin
  perform set_config('lock_timeout', '3s', true);

  update public.billing_plans
     set name = 'Scale'
   where code = 'escale'
     and name = 'Escale';
end
$d0951$;
