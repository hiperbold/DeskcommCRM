# CSP e HSTS: o que está ligado e como ativar o resto

Origem: D-124 (auditoria de 30/09/2026). Texto da política: `lib/security/cabecalhos.ts`,
aplicado em `next.config.ts` (`headers()`).

## O que já está ligado

| Cabeçalho | Estado | Efeito |
|---|---|---|
| `Strict-Transport-Security: max-age=31536000` | ativo | O navegador passa a exigir HTTPS neste host por 1 ano depois do primeiro acesso seguro. Ignorado em resposta HTTP, então instalação sem TLS não muda. |
| `Content-Security-Policy-Report-Only` | só observação | O navegador avalia a política e registra a violação no console. Nada é bloqueado. |

A política já libera `https://challenges.cloudflare.com` em `script-src`, `connect-src` e `frame-src`
para o widget do Turnstile (D-173, ver `docs/runbooks/turnstile.md`).

## Como ativar a CSP de verdade

1. Abra as telas principais (login, inbox, leads, agenda, configurações, admin) com o
   console do navegador aberto e filtre por `Content Security Policy`.
2. Para cada violação decida: ajustar a política (origem legítima que faltou) ou corrigir o
   código (script/estilo/imagem de origem indevida).
3. Com o console limpo, troque a chave `Content-Security-Policy-Report-Only` por
   `Content-Security-Policy` em `CABECALHOS_DE_SEGURANCA_EXTRAS`. Publique e confira as
   mesmas telas. Se algo quebrar, volte a chave (um commit).
4. Passo seguinte, o que dá força real contra XSS: tirar `'unsafe-inline'` e `'unsafe-eval'`
   de `script-src` usando nonce gerado no `proxy.ts` (um nonce por resposta, repassado ao
   Next pelo cabeçalho de requisição). Isso exige medir a hidratação e o
   `<PublicEnvScript/>` antes de bloquear.
5. Opcional: endpoint de relatório (`report-uri`/`report-to`) para ver violações de usuários
   reais sem depender do console.

## Como ampliar o HSTS

Só depois de confirmar que **todos** os subdomínios do domínio servem HTTPS:

1. Acrescente `; includeSubDomains` em `HSTS` (`lib/security/cabecalhos.ts`).
2. `preload` só se for submeter o domínio à lista de preload dos navegadores: é praticamente
   irreversível, não ligue sem decisão explícita.

## Proxies do kit

`Caddyfile`, `Caddyfile.single-server` e `docker-compose.traefik.yml` não foram alterados: a
Caddy emite HTTPS sozinha e o app já manda o HSTS. Se um dia o proxy for o dono do cabeçalho,
mova o valor para lá e tire do app, para não duplicar.
