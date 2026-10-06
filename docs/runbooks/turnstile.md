# Cloudflare Turnstile: como ligar em produção

Origem: D-173. Código: `lib/security/turnstile.ts`, `components/auth/TurnstileWidget.tsx`.

## O que o Turnstile protege

| Onde | Quem confere o token |
|---|---|
| `/signup`, `/login`, `/login/forgot` | O Supabase Auth (GoTrue). O app só repassa o token em `captchaToken` (`signUp`, `signInWithPassword`, `resetPasswordForEmail`, e o `resend` do cadastro por convite). |
| Captação pública de leads (`POST /api/v1/webhooks/in/<token>`) | O próprio app, no servidor, pelo `siteverify` da Cloudflare. |

Entrar com Google, MFA, aceite de convite (já logado) e redefinição com sessão de recuperação não passam
pelo captcha do GoTrue e não foram tocados.

## Variáveis (EasyPanel, serviço do app)

- `TURNSTILE_SITE_KEY`: chave pública do widget. Lida em runtime pelo servidor; sem ela as telas ficam
  exatamente como eram.
- `TURNSTILE_SECRET_KEY`: chave secreta. Usada pela captação pública. A MESMA vai no Supabase (passo 4).
- `TURNSTILE_CAPTACAO_EXIGIR`: opcional. `1` faz a captação pública recusar envio sem token válido. Vazio
  deixa a captação como sempre foi. Ver "Captação pública" abaixo antes de ligar.

Não use `NEXT_PUBLIC_`: a imagem é construída no GitHub Actions, sem as chaves.

## Ordem de ligar

1. Publique o código (push na `main` faz o deploy). Com as variáveis ainda vazias nada muda.
2. Confira no EasyPanel que `TURNSTILE_SITE_KEY` e `TURNSTILE_SECRET_KEY` estão preenchidas e reinicie o
   serviço se elas foram criadas depois do deploy. O widget do Turnstile precisa ter `crm.hiperbold.com.br`
   na lista de domínios.
3. Abra `/login`, `/signup` e `/login/forgot` em aba anônima: o widget aparece e o botão só habilita depois
   de resolvido. Entre com a sua conta para provar que o login segue funcionando (o GoTrue ainda não exige
   o token nesta etapa).
4. Só então ligue em Supabase > Auth > Bot and Abuse Protection > Enable CAPTCHA protection > Turnstile,
   colando a chave secreta. Teste login, cadastro por convite e "esqueci a senha" de novo.

## Se ligar o Supabase ANTES do código estar no ar

O GoTrue passa a exigir `captchaToken` em todo login, cadastro e recuperação, e o app antigo não manda
nenhum: todo login é recusado, inclusive o seu. Desfaça desligando o CAPTCHA no mesmo painel; nada mais
precisa ser revertido.

Se o widget não carregar (extensão de bloqueio, rede), o botão fica desabilitado e a tela avisa para
recarregar. Com a chave pública errada ou o domínio fora da lista do widget, o mesmo acontece: confira o
passo 2.

## Captação pública de leads

O formulário do cliente é HTML colado no site dele, sem o widget. Por isso a exigência é opt-in
(`TURNSTILE_CAPTACAO_EXIGIR=1`) e vale para todas as fontes da instalação: ligar sem migrar os formulários
derruba toda captação por formulário. Integrações que assinam o envio com HMAC (`x-deskcomm-signature`
válida) não precisam do token e passam sempre.

Para migrar um formulário embutido em site de terceiro, o cliente cola duas linhas, e o widget injeta o
campo `cf-turnstile-response` no formulário sozinho (o servidor lê esse nome):

```html
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
<div class="cf-turnstile" data-sitekey="SUA_TURNSTILE_SITE_KEY"></div>
```

O widget só roda em domínio presente na lista de hostnames dele no painel da Cloudflare. Como cada cliente
publica em um site diferente, ou se cadastra cada domínio, ou a lista fica sem restrição de hostname (a
chave pública é pública por desenho; a proteção real é a secreta no servidor).

Recusas aparecem em Leads recebidos com o motivo "verificação de segurança". Sem a secreta no ambiente o
servidor não verifica e registra um aviso no log, uma vez por processo. Se a Cloudflare não responder, o
envio é recusado com 503 e pede para tentar de novo.

O botão "Enviar lead de teste" da tela de Webhooks não leva token: com `TURNSTILE_CAPTACAO_EXIGIR=1` ele
passa a ser recusado em fontes sem segredo HMAC.

## Testar sem as chaves reais

Chaves de teste oficiais da Cloudflare: site `1x00000000000000000000AA` (sempre passa), secreta
`1x0000000000000000000000000000000AA` (sempre passa) e `2x0000000000000000000000000000000AA` (sempre
recusa). Servem para ensaiar local; nunca as coloque em produção.
