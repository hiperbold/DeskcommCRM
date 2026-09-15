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
- [ ] **D-012 · Webhook do WAHA sem assinatura.** O WAHA Core não assina os eventos, então `WAHA_WEBHOOK_REQUIRE_SIGNATURE` fica `false`. A proteção é o domínio: `/api/v1/webhooks/waha` aponta para a porta 1 do app (502 para a internet) e o WAHA chega por `http://app:3000`. Conferir com um POST externo depois do deploy. Resolve de vez com WAHA Plus (pago) ou proxy que assine.
- [ ] **D-013 · Role dedicada `agent_worker`** no banco para o worker (hoje usa a conexão privilegiada do pooler). Recomendação do guia de self-host do autor.
- [ ] **D-014 · Chave da API do EasyPanel como segredo do fork público.** Mesmo padrão do Studio e da Guaxupé. Segredo não vai para PR de terceiros, e o deploy só roda depois de push no `main`. Avaliar chave com escopo menor se o EasyPanel passar a oferecer.

- [ ] **D-016 · Instalador do autor não lê as chaves de projeto Supabase novo.** `hostgator-setup-kit/supabase-provision.sh` procura `api_key` depois de `name` no JSON e a API atual devolve em outra ordem: parou em "Não consegui ler anon/service_role" e a senha gerada do banco se perdeu. Contornado em 15/09/2026 lendo as chaves por JSON e trocando a senha do banco pela Management API. Vale abrir issue no repositório do autor.
- [ ] **D-017 · Logo na produção.** O logo local foi enviado para o storage do Supabase local; na produção precisa ir para o bucket `brand-logos` do projeto `hiperbold-crm` (ou pela tela `/admin/marca`) depois que o app subir. Arquivo: `key-visual-hiperbold/brand-hiperbold/hiperboldPngHq_09.png`.
- [ ] **D-018 · Tipografia trocada em arquivo do autor.** `app/layout.tsx` carrega Inter no lugar da Atkinson (mantendo o nome `--font-atkinson`) e Assistant nos títulos, mais o import de `hiperbold/marca.css`. É o único arquivo do autor alterado: conferir esse trecho a cada merge do upstream.

## Resolvidas

- **D-002 · Liberar o GitHub Actions no fork.** Resolvido em 15/09/2026 pelo Filipe (8 workflows ativos).
- **D-010 · Renovar os tokens de deploy de `srh` e `waha`.** Resolvido em 15/09/2026 com `refreshAppDeployToken` (2 de 2).
- **D-015 · Desligar o workflow `release` do autor no fork.** Resolvido em 15/09/2026: estado `disabled_manually`. Ele rodou uma vez no primeiro push e falhou, como previsto.
