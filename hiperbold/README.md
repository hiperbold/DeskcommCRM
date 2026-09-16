# DeskcommCRM · fork da Hiperbold

Este é o fork `hiperbold/DeskcommCRM` do projeto `melgarafael/DeskcommCRM` (MIT). A doutrina do autor continua valendo e mora em `CLAUDE.md` e `AGENTS.md` na raiz: **esses dois arquivos não são editados aqui**, para puxar as atualizações do autor sem conflito. Tudo o que é específico da Hiperbold fica nesta pasta.

- Pendências: [`DEBITO.md`](DEBITO.md)
- Produção: https://crm.hiperbold.com.br

## Fluxo de trabalho

1. Desenvolver no WSL, em `~/projects/deskcommcrm`.
2. Commit e push no `main` do fork.
3. O GitHub Actions do próprio projeto (`.github/workflows/publish-image.yml`) compila e publica três imagens: `ghcr.io/hiperbold/deskcommcrm`, `deskcomm-worker` e `deskcomm-scheduler`.
4. O EasyPanel (projeto `hiperbold-crm-1`) só baixa a imagem pronta e reinicia.

**A VPS nunca compila código.** Build na VPS já derrubou os outros serviços, e o build do Next pede 4 GB.

## Desenvolvimento local (WSL)

Portas: app **3300**, WAHA **3230**, ponte do Redis **8090**, Supabase local **54321** (API), **54322** (banco), **54323** (Studio), **54324** (caixa de e-mails de teste). A 3000 é do site da Unique no WSL, e a 3200 e a 3201 são de programas Node no Windows (o WSL enxerga as portas do Windows).

```bash
cd ~/projects/deskcommcrm
pnpm install

# 1ª vez, ou para zerar o banco local (APAGA os dados locais)
bash hiperbold/scripts/supabase-local.sh
# nas outras vezes basta: npx supabase@2.117.0 start   (a pasta de migrations precisa sair do caminho só num banco novo)

bash hiperbold/scripts/dev-env.sh          # gera .env.local (não sobrescreve)
docker compose -f hiperbold/docker-compose.dev.yml --env-file .env.local up -d
pnpm dev -p 3300 -H 0.0.0.0                # app
pnpm worker                                # agente de IA 24/7, em outro terminal
pnpm dev:crons                             # crons, em outro terminal
```

Conferir: `curl http://localhost:3300/api/v1/health`.

Testes unitários no WSL: `bash hiperbold/scripts/test-unit.sh` (roda `pnpm test:unit` nas condições do CI; direto, o Redis de dev e a rede espelhada do WSL dão falsos vermelhos).

## Produção

- Banco: Supabase Cloud, região São Paulo. Piloto no plano Free; Pro antes de entrar dado de cliente real.
- Serviços no EasyPanel com o mesmo nome curto do `docker-compose.prod.yml` do autor, porque o nome curto é o endereço interno: `redis`, `srh`, `waha`, `app`, `worker`, `scheduler`.
- Schema: o deploy só troca a imagem. Código que depende de coluna nova exige, ANTES do push, `bash hiperbold/scripts/prod-schema.sh` (re-aplica o `baseline.sql` idempotente e garante a chave de cifra).
- Segredos de produção: `.env.production` no WSL (fora do Git, só leitura do usuário). Nunca no chat, nunca em commit.

## Puxar atualizações do autor

```bash
git fetch upstream
git merge upstream/main
```

Conflito só deve aparecer em arquivo que a Hiperbold alterou fora desta pasta. Antes de alterar arquivo do autor, pesar se não cabe como configuração.
