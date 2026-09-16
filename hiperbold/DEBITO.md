# Débito · DeskcommCRM Hiperbold

Toda pendência do fork da Hiperbold (técnica, conta, custo, terceiro) fica aqui até ser resolvida. Resolvido sai da lista e vai para a seção final com a data.

## Abertas

- [ ] **D-001 · Token do Supabase (Filipe).** Gerar em supabase.com/dashboard/account/tokens e gravar em `C:\Users\nucle\.claude\.env` como `SUPABASE_ACCESS_TOKEN`. Bloqueia criar o banco de produção.
- [ ] **D-003 · Supabase Pro antes de cliente real (custo).** Cerca de US$ 25/mês. O Free pausa após 7 dias sem uso e limita o banco a 500 MB. Decisão do Filipe: piloto no Free, Pro antes de entrar dado de cliente.
- [ ] **D-004 · SMTP dos e-mails de login.** O envio embutido do Supabase faz cerca de 2 e-mails por hora (confirmação de conta, recuperação de senha). Candidato: SendKit da Hiperbold.
- [ ] **D-005 · Revogar o token do Supabase** depois de criar e configurar o projeto, se não houver uso recorrente.
- [ ] **D-006 · Imagens no GHCR: pública ou privada.** Se privada, o EasyPanel precisa de credencial de leitura no formulário da imagem de cada serviço.
- [ ] **D-007 · Backup diário do banco para fora da VPS** (o autor tem `scripts/backup-db.sh`).
- [ ] **D-008 · Validação manual com o Filipe, não só teste automatizado:** isolamento entre duas organizações, áudio e arquivo pelo WhatsApp, agente movendo um card sozinho.
- [ ] **D-009 · Vigiar a RAM da VPS** depois que `app`, `worker` e `scheduler` subirem (WAHA tem teto de 1280 MB). Em 15/09/2026, antes deles: 64% de 7,9 GB.
- [ ] **D-011 · Apagar o clone de leitura** em `F:\github-projects\DeskcommCRM`. O código de trabalho é o do WSL.
- [ ] **D-012 · Webhook do WAHA sem assinatura.** O WAHA Core não assina os eventos, então `WAHA_WEBHOOK_REQUIRE_SIGNATURE` fica `false`. A proteção é o domínio: `/api/v1/webhooks/waha` aponta para a porta 1 do app (502 para a internet) e o WAHA chega por `http://app:3000`. Conferido em 15/09/2026: POST externo devolve 502. Resolve de vez com WAHA Plus (pago) ou proxy que assine.
- [ ] **D-013 · Role dedicada `agent_worker`** no banco para o worker (hoje usa a conexão privilegiada do pooler). Recomendação do guia de self-host do autor.
- [ ] **D-014 · Chave da API do EasyPanel como segredo do fork público.** Mesmo padrão do Studio e da Guaxupé. Segredo não vai para PR de terceiros, e o deploy só roda depois de push no `main`. Avaliar chave com escopo menor se o EasyPanel passar a oferecer.

- [ ] **D-016 · Instalador do autor não lê as chaves de projeto Supabase novo.** `hostgator-setup-kit/supabase-provision.sh` procura `api_key` depois de `name` no JSON e a API atual devolve em outra ordem: parou em "Não consegui ler anon/service_role" e a senha gerada do banco se perdeu. Contornado em 15/09/2026 lendo as chaves por JSON e trocando a senha do banco pela Management API. Vale abrir issue no repositório do autor.
- [ ] **D-018 · Tipografia trocada em arquivo do autor.** `app/layout.tsx` carrega Inter no lugar da Atkinson (mantendo o nome `--font-atkinson`) e Assistant nos títulos, mais o import de `hiperbold/marca.css`. Conferir a cada merge do upstream, junto com os outros arquivos do autor tocados pela Hiperbold: `next.config.ts` (`allowedDevOrigins`) e `tests/unit/gatilho-dos-jobs-de-entrega.test.ts` (entrada do `deploy-easypanel.yml`), além dos pontos de encaixe do canal UAZAPI em `lib/channels/`.

- [ ] **D-019 · Cadastro fechado no produto, aberto no Supabase.** Desde 15/09/2026 a instalação está em `so_convite` (banco `platform_settings` e `SIGNUP_MODE` no `.env`): `/signup` sem convite recusa, a ação de cadastro recusa e `/auth/confirm` não cria organização. O cadastro do Supabase Auth continua ligado porque o convite de equipe usa `supabase.auth.signUp`; desligar no Supabase quebraria os convites. Risco que sobra: alguém chamar a API do Supabase direto e criar um usuário SEM organização, que não enxerga dado nenhum (RLS). Fechar de vez exige trocar o aceite de convite para criação pelo admin (`auth.admin.createUser`) e aí desligar o signup no Supabase.



## Resolvidas

- **D-023 · Saída que outro sistema manda pela instância.** Resolvido em 16/09/2026. O webhook deixou de usar `excludeMessages: ["wasSentByApi"]` (webhook antigo com o filtro é atualizado pelo id ao reconectar); a saída mandada pela API entra na conversa com `metadata.via_api`, rotulada "Automação" no balão, e pausa a IA; o eco do próprio envio é apagado por id exato e não pausa a IA. Provado na S9 real: mensagem mandada direto pela API apareceu UMA vez como "Automação" com a IA pausada; mensagem mandada pelo CRM apareceu UMA vez, eco absorvido, pausa não estendida.
- **D-024 · Evento `connection` sem payload real.** Resolvido em 16/09/2026 com instância descartável (criada pela API de admin, conectada pela tela, `/instance/connect` e `/instance/disconnect`): dois eventos reais, estado em `instance.status` (`connecting`, `disconnected` com `lastDisconnectReason`), os dois processados e a sessão em aguardando QR. Formas reais viraram teste.
- **D-020 · Token da instância `s9filipe2025` exposto.** Encerrado em 16/09/2026 sem trocar o token: o Filipe decidiu correr o risco.
- **D-021 · Chave de cifra não semeada.** Resolvido em 16/09/2026 com `hiperbold/scripts/semear-chave-de-cifra.sh local|producao` (idempotente, recusa trocar chave diferente), chamado pelo `supabase-local.sh` e pelo `dev-env.sh`. Achado junto: a PRODUÇÃO também estava sem a chave, então nenhuma credencial cifrada gravava lá; semeada pelo novo `prod-schema.sh`. Sem a chave, a tela mostra "cifra indisponível nesta instalação".
- **D-025 · Login pelo túnel.** Resolvido em 16/09/2026 com `allowedDevOrigins: ["*.trycloudflare.com"]` no `next.config.ts` (só vale no `next dev`; arquivo do autor, conferir no merge do upstream). Conferido no navegador: login pelo túnel chega a `/app/inbox`.
- **D-026 · Falhas de teste.** Resolvido em 16/09/2026, e o diagnóstico anterior estava ERRADO numa parte: `gatilho-dos-jobs-de-entrega` falhava por causa da Hiperbold (o `deploy-easypanel.yml` não estava declarado no mapa do teste; o `git stash` não pegava porque o workflow já estava commitado). Declarado. As outras eram ambiente: Redis real do `.env.local` (`rate-limit`, `recoverOrganization`) e porta fechada que demora 10 s no WSL espelhado (`inbox-unread-send`). Rodar localmente com `bash hiperbold/scripts/test-unit.sh`: 899 arquivos, 9219 testes, zero falha.
- **D-002 · Liberar o GitHub Actions no fork.** Resolvido em 15/09/2026 pelo Filipe (8 workflows ativos).
- **D-010 · Renovar os tokens de deploy de `srh` e `waha`.** Resolvido em 15/09/2026 com `refreshAppDeployToken` (2 de 2).
- **D-017 · Logo na produção.** Resolvido em 15/09/2026: PNG enviado ao bucket `brand-logos` do projeto `hiperbold-crm` e `platform_branding` gravada (nome, cor #0139B0, logo).
- **D-015 · Desligar o workflow `release` do autor no fork.** Resolvido em 15/09/2026: estado `disabled_manually`. Ele rodou uma vez no primeiro push e falhou, como previsto.
