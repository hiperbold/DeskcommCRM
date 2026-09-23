# Handoff do fork Hiperbold

Escrito em 22/09/2026. Para quem retomar o trabalho, seja o Filipe ou outra sessão.

Leia antes: `hiperbold/status.md` (onde as coisas estão) e `hiperbold/DEBITO.md` (o que está pendente). Este arquivo diz o que fazer primeiro e por quê.

---

## 1. O que depende do Filipe, e trava o resto

### 1.1 Conferir a produção na tela

A publicação de hoje foi um salto de 2298 arquivos e **não houve conferência humana antes**. A combinação era conferir no local primeiro; o Filipe mandou executar e a publicação saiu. Então fica pendente: abrir `crm.hiperbold.com.br` e olhar Conexões, IA, funil e conversas.

Se algo estiver errado, o caminho de volta é publicar de novo o commit `9da397d`, e o backup do banco de antes está em `D:\Hiperbold\backups\hiperbold-crm\hiperbold-crm-2026-09-22_2120.dump`.

### 1.2 Decidir o que fazer com a branch `fix/debitos-pequenos-2026-09-22`

Ela tem quatro correções prontas e conferidas, sem push. Publicar é: `git switch main`, `git merge --ff-only fix/debitos-pequenos-2026-09-22`, `git push origin main`. O push dispara imagem e deploy sozinho. Nenhuma dessas quatro mexe em banco, então não precisa de `prod-schema.sh`.

### 1.3 Responder as 18 perguntas do plano de assinatura

Estão em `hiperbold/planos/2026-09-22-planos-e-assinatura.md`, seção 12. As que travam mais coisa: quanto de crédito de IA entra em cada plano, qual a remarcação sobre o custo, e onde o cliente digita o cartão (página do Asaas ou dentro do CRM, o que joga a Hiperbold no escopo de PCI DSS).

---

## 2. O que fazer em seguida, em ordem

### 2.1 Alinhar o teste de ponta a ponta com as escolhas do fork

É o item de maior retorno. Hoje são 11 casos vermelhos no CI, e enquanto estiverem assim ninguém vê o próximo defeito de verdade. O detalhe de cada um está no `status.md`. O trabalho:

- **Fonte**: três specs do autor exigem Atkinson no `font-family` calculado; o fork usa Inter mantendo o nome da variável. O que eles provam é "o tema carregou", então a asserção deve aceitar a fonte do fork.
- **Canal**: duas specs criam canal WAHA e esperam vê-lo na tela de Conexões. Devem criar canal UAZAPI, que é o caminho real daqui.
- **Pareamento por código**: feature do WAHA, que saiu da instalação. A spec precisa ser aposentada com a razão escrita, não apagada em silêncio.
- **D-041** (`pre-go-live-whatsapp`) morre junto com o item "canal" acima.

### 2.2 O buraco real do onboarding (achado hoje)

Numa instalação nova, o passo "Treinar" cria o atendente, não publica porque ainda não há número de WhatsApp, e **avança sem avisar que ficou rascunho**. Nos outros motivos (sem chave de IA, sem modelo) o passo para e explica, com um botão "Continuar sem publicar".

Onde está: `app/actions/onboarding/createDefaultAgent.ts` trata `reason` igual a `failed`, `sem_chave` e `no_model`; o caso "ainda não há canal" cai no `redirect` final. A tela é `app/onboarding/setup-ai/_form.tsx`.

Isso virou o caminho normal quando o passo do telefone deixou de criar canal por QR (commit `3ee4c4ec`). A decisão de produto é do Filipe: parar e explicar, ou seguir com um aviso mais claro. Não implemente sem essa decisão.

### 2.3 Dívidas pequenas que sobraram

| Dívida | Resumo | Tamanho |
|---|---|---|
| D-036 | IP do audit e do limite de tentativas vem do primeiro salto do `X-Forwarded-For`, que o cliente forja. Atrás do nosso proxy, o valor bom é o ÚLTIMO. São 6 rotas com audit (5 nossas) mais `lib/auth/rate-limit.ts` e `lib/http/ip-do-cliente.ts`. Atenção: o limite conta por IP **e** por e-mail, então o balde do e-mail continua valendo; não é portão aberto | pequeno |
| D-042 | Evento de webhook da UAZAPI pode ser reenviado: não há nonce nem janela de tempo | médio |
| D-043 | "Exigir assinatura no webhook" não chega à rota de canal. Com o WAHA fora, a opção hoje não faz nada nesta instalação. Ou passa a valer na rota de canal, ou a tela precisa dizer a que se aplica | médio |
| D-044 | `resolveSessionRef` não tem ramo para o provider `wacalls`, que veio na junção. Nada nosso depende disso hoje | pequeno |
| D-034 | Teto de conexões MCP sem trava no banco. **Não corrija isolado**: a fase 2 do plano de assinatura resolve isso para todos os itens de uma vez | adiar |

### 2.4 Planos e assinatura

O plano está escrito e o gateway está escolhido (Asaas). Nada implementado, por instrução do Filipe. A ordem das fases está na seção 11 do plano. O contrato de integração é comum aos três produtos da Hiperbold e vive em `F:\github-projects\hiper-track\docs\manual-api-asaas-saas.md`: **ele manda** em nomes de tabela, eventos e prefixo de referência (o CRM é `HC:`).

---

## 3. Armadilhas que já custaram tempo hoje

1. **`session_ref` da UAZAPI é o `instance.id` opaco, e o `instanceName` do webhook é o NOME do painel.** Comparar um com o outro descarta todo evento legítimo, com resposta 200 que a UAZAPI não reentrega: o canal para em silêncio. Já aconteceu uma vez, e o teste que acompanhava a versão errada passava porque a ficha usava o mesmo texto nos dois campos.
2. **Toda atualização do autor precisa conferir se a UAZAPI sobreviveu.** A migração 0368 dele recriou a restrição de provider sem ela.
3. **O `gh` resolve para o repositório do autor.** Sempre `-R hiperbold/DeskcommCRM`.
4. **Não edite arquivo do projeto enquanto a bateria de testes roda.** O vitest lê o arquivo quando chega nele, e o resultado vira mentira. Isso obrigou a refazer uma bateria de uma hora hoje.
5. **Redirecionamento de saída para pasta que não existe** faz o comando morrer devolvendo sucesso. Uma suíte "verde" assim não rodou. Criar a pasta antes.
6. **Heredoc e crase passando pelo `wsl` chegam mangleados** e o conteúdo vira comando executado. Escreva arquivo com a ferramenta de escrita, ou grave um `.sh` em `F:\temp` e rode com bash.
7. **O typecheck estoura a memória** sem `NODE_OPTIONS=--max-old-space-size=6144`.

---

## 4. Estado dos portões, para comparação futura

Medido em 22/09/2026 na branch `fix/debitos-pequenos-2026-09-22`:

- typecheck: limpo
- lint: 0 erros, 420 avisos (todos anteriores)
- lint:channels: ok, 60 arquivos de dívida conhecida
- unitários: 1294 arquivos, 13.195 testes verdes, 1 vermelho de ambiente (`e2e-parte-4`, a espera pelo Redis, 67 minutos até desistir)
- test:db: 2193 testes verdes, 9 minutos (medido na branch da junção)
- build: verde, 23 segundos de compilação

Se algum desses números piorar muito sem explicação, é sinal antes de ser sintoma.
