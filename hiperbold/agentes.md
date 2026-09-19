# Agentes no CRM: como funcionam e como vamos organizar

Estudo feito em 17 e 18/09/2026 lendo o código e a documentação do autor (fork em `3ee4c4ec`,
autor 63 commits à frente, sem mudança nestes pontos). Próximo passo: cruzar com a transcrição do
vídeo do Rafael Melgaço sobre o DeskcommCRM e fechar a decisão da seção 6.

---

## 1. O que é um agente

Um agente é uma entidade versionada (`ai_agents` + `ai_agent_versions`). Cada **versão publicada
é congelada**: prompt, modelo, capacidades (`tool_ids`), funis que pode mover (`pipeline_ids`),
materiais que pode ler (`knowledge_source_ids`), número de WhatsApp, follow-ups, palavras de
passagem para humano. Mudar qualquer coisa exige publicar uma versão nova. Material ou capacidade
criados depois **não entram sozinhos** num agente já publicado.

O que vale para **todos** os agentes da organização, sem escolher por agente:
- **IA › Memória**: as regras da casa (documento da organização) e os aprendizados.
- **IA › Skills**: `agendamento` e `objecao-preco` já valem para todo agente.

## 2. Um agente tem três papéis (não são três agentes)

Fonte: `docs/specs/16-spec-tres-papeis-do-agente.md`. Decisão do autor: *"Uma unidade, três
papéis. Não são 3 agentes na lista."*

Motivo medido: com o mesmo prompt atendendo e operando o CRM, o agente contou ao cliente o que
fazia por dentro em **30%** dos turnos; com prompt só de atendimento, **0%**.

| Papel | Aba na tela do agente | O que faz |
|---|---|---|
| Conversador | "Conversa com o cliente" | só fala. Não enxerga ferramenta, tabela, código de erro nem UUID |
| Operador | "Organiza o sistema" | roda **depois** do envio: move funil, abre chamado, distribui, organiza. Não tem canal |
| Segurança | "Confere antes de enviar" | portões determinísticos + checagem de promessa e jailbreak (opcionais) |

**O Operador vem desligado por padrão** (`operator_enabled = false`). Desligado, o básico ainda é
registrado por código (etapa, retorno prometido, histórico); o que some é o julgamento sobre a
operação. Ligado, pode usar um modelo mais barato e tem **lista própria de capacidades**
(`operator_tool_ids`). Custo: +1 chamada de modelo por turno.

## 3. Teto de capacidades

`TETO_TOOLS_POR_AGENTE = 25` (`lib/mcp/tools/selecao-por-pacote.ts`). Era 20. Motivo: muitas
ferramentas no prompt pioram a escolha do modelo; o próprio autor escreve que essa heurística
**nunca foi medida**. Catálogo de 57 capacidades em 6 pacotes (Atender 18, Vender 17...), dois
pacotes cheios não cabem juntos. Capacidade `critico` (ex.: mandar WhatsApp de verdade) nunca
entra por pacote, só uma a uma.

O autor responde ao teto com **capacidade composta** (ex.: `crm_find_and_book_appointment`,
confere e marca numa vaga só), não com mais agentes.

Não gastam vaga: as ferramentas nativas do motor (`send_message`, `search_knowledge`,
`get_lead_context` e outras; cerca de 12).

## 4. Roteador: como vários agentes dividem um número

Código: `lib/agent-engine/agent/resolve-turn-agent.ts`, `intent-classifier.ts`,
`router-config.ts`. Tela: **IA › Roteadores**.

- **Um roteador ativo por número.** Membros = pares (intenção → agente), com descrição de quando
  escolher e frases de exemplo. Mais um **agente de fallback**.
- A cada mensagem que chega, um **modelo barato** (padrão `claude-haiku-4-5`, configurável) lê
  **só a última mensagem do cliente** e responde qual intenção casa, com uma confiança de 0 a 1.
- **Confiança mínima 0,6** (padrão). Abaixo disso, não troca.
- **Aderência (sticky, ligada por padrão)**: a conversa guarda o agente escolhido
  (`conversations.active_ai_agent_id`). Nas mensagens seguintes o classificador roda mesmo assim,
  mas **só troca de agente se vier outra intenção com confiança ≥ 0,6**. Passagem para humano ou
  fechamento da conversa limpam a escolha.
- **Ordem de decisão**: aderência → classificação → fallback → agente publicado do número →
  agente genérico. Nunca fica em silêncio. Falha do classificador não derruba o turno.
- **Follow-up** (mensagem que parte do CRM, sem mensagem do cliente): nunca classifica, usa o
  agente aderido ou o fallback.
- Cada decisão vira uma linha em `ai_router_decisions` (sem texto do cliente), para medir.
- Custo: +1 chamada barata por mensagem recebida.

### O ponto que decide o desenho

**O roteador classifica a INTENÇÃO DA MENSAGEM, não a etapa do funil.** Ele não sabe se o lead é
novo, se já foi qualificado ou em que coluna está. Por isso uma cadeia "agente de boas-vindas →
agente que qualifica → agente que fecha" **não tem como ser montada pelo roteador**: a mensagem
"quanto custa?" chega igual no primeiro e no décimo contato. Boas-vindas e qualificação são a
mesma conversa, então ficam no mesmo agente. E "mover no CRM" é o Operador desse agente.

O que o roteador faz bem: separar **públicos diferentes que escrevem para o mesmo número**
(quem quer comprar × quem já é cliente e tem um problema).

## 5. Orientação do autor por nicho

Fonte: `.agents/skills/deskcomm-cliente-novo/references/nichos.md` e `pela-tela.md`.

- Clínica: "um agente 'Recepção' resolve a maioria".
- Serviços / agência: "geralmente um agente só; com 'Comercial' e 'Suporte/pós-venda', intenção
  *problema com serviço já contratado* → Suporte".
- Imobiliária: "Locação" e "Vendas".
- Curso: "Vendas" e "Suporte ao aluno" (intenção *já sou aluno*).
- Loja: "Vendas" e "Pós-venda" (intenção *pedido já feito*).
- Roteador **só** com dois ou mais agentes no mesmo número, e criado **depois** de os agentes
  estarem publicados.

## 6. Proposta para a Hiperbold (a validar com o vídeo)

Dois agentes no número comercial, com roteador:

| Agente | Intenção | Faz |
|---|---|---|
| **Comercial** (também o fallback) | quer contratar, conhecer serviço, orçamento | recebe, qualifica, apresenta portfólio e cases, agenda conversa. Operador ligado para mover o funil |
| **Clientes** | já é cliente: problema, relatório, ajuste de campanha, dúvida de entrega | acolhe, registra, abre chamado para o time. Operador ligado para abrir caso e distribuir |

Por que não três: boas-vindas e qualificação são a mesma conversa (seção 4), e a operação no CRM
já é o Operador de cada agente. Um terceiro agente só se aparecer um **público** claramente
diferente no mesmo número (ex.: suporte de um produto próprio como o HiperTrack ou o Hiperbold
Studio, ou candidatos e parcerias).

Materiais (IA › Conhecimento), escolhidos por agente:
- Comercial: FAQ comercial, portfólio de serviços, cases autorizados.
- Clientes: FAQ de atendimento a cliente, prazos e processo de entrega.
- Preço: a regra do bot de atendimento da Hiperbold é que nenhum valor sai do bot e desconto
  sempre passa para uma pessoa. Se valer aqui, preço fica fora da base.

## 7. O que os vídeos do Rafael confirmam (18/09/2026)

Fontes: `F:\Temp\hiper-crm-conteudo\` (4 vídeos com legenda + um manual resumido feito a partir
deles). Conferido na **fala original** (arquivos `.pt.srt`), não só no manual.

- **Multiagente é por intenção, com roteador.** O exemplo dele é exatamente "suporte técnico"
  (problema de acesso, dificuldade de uso, como configurar) × "comercial" (interesse em comprar,
  "quanto custa"), mais um agente de fallback, e o botão "testar a classificação" (uma pergunta
  de preço deu comercial com 95%). Vídeo `8lG8EmE8-UI`, 00:03:57 a 00:05:18.
- **"Organizar o sistema" é configuração DENTRO do agente, não outro agente.** Fala literal:
  *"Você pode configurar o follow-up que o seu agente vai utilizar quando ele pede ajuda sem sair
  da conversa, quando ele passa a conversa para uma pessoa, como que ele organiza o sistema. Você
  pode ativar um agente de IA para organizar o sistema e você pode configurar também os
  guardrails, as conferências que ele vai fazer antes de responder um cliente."* Vídeo
  `wrPl3DvEr5U`, 00:12:38 a 00:13:01. É a aba "Organiza o sistema" (o Operador) e a aba "Confere
  antes de enviar" (a Segurança) da seção 2.
- **ERRO DO MANUAL RESUMIDO:** a seção 4.2 dele lista "agente responsável por organizar o CRM",
  "agente que acompanha casos abertos" e "agente que executa follow-ups" como agentes separados.
  A fala original e o código dizem o contrário: são configurações do mesmo agente. Não usar o
  manual como fonte nesse ponto.
- **Memória geral** para quando há vários agentes ("20 agentes"): descrição da empresa e regras
  valem para todos, cada um com seu prompt. **Aprendizados** são regras acumuladas ("não oferecer
  frete grátis no primeiro contato", "não pedir CPF sem autorização humana").
- Nenhum vídeo fala em cadeia por etapa (boas-vindas → qualificação → fechamento).
- O que os vídeos NÃO respondem: modelo e custo por papel, como ele escreve as intenções além do
  exemplo, se liga as camadas opcionais de segurança, e a base de conhecimento (não aparece).
- Desatualizado nos vídeos: "a chave da Anthropic é obrigatória porque o agente principal usa
  Anthropic". O instalador atual deixa escolher OpenAI, Anthropic ou OpenRouter.

## 8. Perguntas que continuam abertas

Respondidas pelos vídeos: divisão por intenção com roteador (não por etapa); "organizar o
sistema" é o Operador do próprio agente; memória geral para contexto comum.

Continuam abertas, e se respondem medindo no nosso CRM, não no vídeo:
1. Qual modelo usar para conversar, para operar e para classificar, e quanto custa por conversa
   (a tela IA › Uso mostra o custo real por organização).
2. Ligar as camadas opcionais de segurança (promessa, jailbreak)? Cada uma custa +1 chamada.
3. As intenções do Comercial e de Clientes acertam com as mensagens reais da Hiperbold? Testar
   no botão "testar a classificação" com 10 mensagens reais antes de ativar o roteador.
