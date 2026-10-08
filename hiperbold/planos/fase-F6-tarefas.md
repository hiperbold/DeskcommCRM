# Fase F6: site de vendas do HiperCRM

Pedido do Filipe (23/09/2026): homepage que é a página de vendas completa, mais `/precos`, Termos de Uso e Política de Privacidade. Projeto separado em `F:\github-projects\` (nome a definir na implementação, por exemplo `hipercrm-site`). Sem deploy e sem push até o Filipe pedir.

Modelos de referência: canvas https://claude.ai/artifact/5dXN2LREhJNpTpmEm3QiE2 (A · Clareza azul, `Main.dc.html`; B · Editorial creme, `Editorial.dc.html`; C · Produto em blocos, `Bento.dc.html`). Cópia local dos três em `F:\temp\2026-09-24\landing\project\pub\project\` (mover para o projeto novo como referência, porque o F:\temp é apagado todo mês).

## Composição escolhida pelo Filipe (24/09/2026), na ordem

1. **Hero**: da opção B (título grande centralizado, dois botões, tela de atendimento em três colunas: conversas, conversa, negócio).
2. **"Quatro coisas que param de dar errado no primeiro mês"**: da opção A (quatro cartões com ícone).
3. **"01 · Atendimento com IA"**: da opção B, trocando o box da direita (passagem para humano) pela **conversa animada** do bloco equivalente da opção A (mensagens aparecendo uma a uma, "Agente digitando...", aviso "Lead movido para a etapa Agendado").
4. **"02 · Automações e follow-up"**: da opção B (seção escura, título e texto), mas com os **três blocos da opção A** no lugar do fluxo de quatro colunas: Follow-up automático (4 passos numerados), Campanhas de disparo (barras de enviadas, entregues e responderam, animadas), Prospecção (lista de empresas com status e a nota da chave Apify). Referência: print enviado pelo Filipe.
5. **"03 · Funil e agenda"**: da opção A (quadro de funil em quatro colunas com cartões e etiquetas).
6. **"04 · Campanhas e resultados"**: da opção B (texto à esquerda, gráfico de linhas de leads e vendas e os três números à direita).
7. **"Feito para" e "Não é para"**: da opção B (listas numeradas).
8. **Tabela de valores**: da opção A (três cartões Pro, Max e Scale, com o selo "Mais escolhido" no Max).
9. **FAQ e CTA final**: da opção A (perguntas que abrem ao clicar; cartão azul "Seu WhatsApp já recebe os clientes...").
10. **Rodapé**: da opção A.

## Decisões de execução (registradas para o Filipe conferir)

- **Regra de cor**: continua valendo três seções claras para uma escura. Com a composição acima, a seção 4 (Automações, escura na B) e a seção 5 (Funil, escura na A) ficariam juntas. Padrão adotado: a seção 5 (Funil) vira versão clara (mesmo quadro, cartões claros), e a sequência fica: claro, claro, claro, escuro (4), claro, claro, claro, escuro (8, tabela), claro (9), escuro (rodapé).
- **"03 · Funil e agenda" da opção A**: a opção A tem o quadro de funil sem a agenda e sem a numeração "03". Padrão adotado: usar o quadro de funil da A com o título numerado "03 · Funil e agenda" no estilo editorial da B, sem a agenda (a agenda aparece no chat animado e no FAQ). Se o Filipe quiser a agenda da B ao lado do quadro, é um acréscimo simples.
- **Paleta única**: a página mistura seções de A e de B. Padrão adotado: base da B (fundo creme `#F8F6F0`, azul-marinho `#052242` nas seções escuras, azul `#0139B0` de destaque, verde `#047857` nos botões principais, fontes Assistant e Inter), com as seções vindas da A redesenhadas nessa paleta, para a página parecer uma só. Cartões brancos da A continuam brancos sobre o creme.
- **Números de exemplo** nas telas simuladas continuam marcados como exemplo; nenhum resultado de cliente inventado.
- **Pendências de conteúdo** (espaços reservados até o Filipe informar): nome final do produto (usado "HiperCRM"), preço do pacote adicional de tokens, CNPJ, endereço, e-mail e WhatsApp do rodapé, e a regra de fidelidade (não afirmar "sem fidelidade" até decidir).
- **Textos legais**: Termos de Uso e Política de Privacidade saem como rascunho, marcados para revisão jurídica e com os dados da empresa em espaços reservados.

## Tarefas

1. Projeto novo em `F:\github-projects\` (stack decidida na implementação, site estático e rápido; sem CMS), com AGENTS.md e CLAUDE.md espelho, e os três modelos copiados como referência.
2. Homepage na composição acima, responsiva (desktop e celular), com as animações dos números, do gráfico e do chat.
3. `/precos` com a tabela da opção A e a comparação completa dos limites e a FAQ de cobrança.
4. Termos de Uso e Política de Privacidade (rascunho, espaços reservados).
5. Revisão visual pelo Filipe na versão local (enviar o endereço junto, regra de sempre).
6. Publicação só quando o Filipe pedir.
