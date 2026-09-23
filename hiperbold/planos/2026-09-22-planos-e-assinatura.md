# Plano: transformar o CRM em produto com planos e assinatura

Escrito em 22/09/2026, a pedido do Filipe. **Isto é planejamento. Nada aqui foi implementado.**

O gateway de pagamento ainda não foi escolhido, e este plano é desenhado para que essa escolha continue aberta até a última fase.

---

## 1. O que estamos construindo, em uma frase

Hoje toda organização dentro do CRM pode tudo. Queremos que cada organização tenha um **plano contratado**, que o plano diga **quanto de cada coisa ela pode ter**, e que o sistema **recuse com educação** quando o teto é atingido, sem nunca apagar o que já existe.

A primeira entrega roda com um plano único chamado **Ilimitado**, que libera tudo. Todo o encanamento existe e funciona desde o começo, só que com tetos altos. Isso é de propósito: um limitador que só entra em produção no dia em que o primeiro cliente contrata é um limitador que nunca foi testado.

---

## 2. Decisões já tomadas

| Decisão | Por quê |
|---|---|
| O plano é da **organização**, não da instalação nem do usuário | Cada cliente seu é uma organização dentro do mesmo CRM. É ali que o dinheiro e o teto se encontram. |
| **Um lugar só** decide se algo pode ser criado | Se cada tela contar do seu jeito, o teto vaza pelo caminho que ninguém olhou. É exatamente o defeito que já está registrado no débito D-034, sobre o limite de conexões MCP. |
| A trava final fica **no banco**, não no servidor | Servidor é conveniência e mensagem bonita; banco é verdade. Duas requisições ao mesmo tempo passam por qualquer contagem feita antes do insert. |
| O gateway de pagamento entra por uma **porta trocável** | Enquanto você não escolhe, o "gateway" é você, ligando o plano na mão pelo painel. Quando escolher, implementa a mesma porta e o resto do sistema não muda. |
| Cliente que cai de plano **nunca perde dado** | Se ele tem 8 agentes e o plano novo permite 3, os 8 continuam lá e funcionando. O que trava é criar o nono. Apagar excedente gera briga e não devolve receita. |
| Os planos nascem em **reais**, não em dólar | Seu cliente é brasileiro. O custo de IA é em dólar e isso fica por dentro, no teto de orçamento, não na tabela de preço. |
| A **chave de IA é da Hiperbold**, e o consumo é vendido dentro do plano | Decisão do Filipe em 22/09/2026. O cliente não traz chave própria: ele compra consumo junto com o plano e pode comprar mais. Ver a seção 6. |

---

## 3. O que o CRM já tem e vamos reaproveitar

Isto não nasce do zero. O levantamento do código mostrou três coisas aproveitáveis:

**O orçamento de IA é o ensaio geral de um plano.** Já existe uma tabela por organização com teto mensal em centavos, medição de consumo, percentual de alarme, e três modos de comportamento: seguir, avisar, bloquear. Ele já avisa antes de bloquear, já tem data de carência (uma data no futuro a partir da qual o bloqueio passa a valer), já tem uma chave de emergência da instalação inteira, e já registra o aviso na Central de avisos. Toda essa gramática serve igual para os planos, e vamos repeti-la em vez de inventar outra.

**A organização já tem campos de porte.** Ela guarda o estado (ativa, suspensa, arquivada), um teto de IA e um limite de requisições por segundo. O campo de estado suspenso é o que a inadimplência vai usar.

**A instalação já tem uma tela de comportamento.** Existe uma linha única de configuração da instalação inteira, com as chaves que ligam e desligam comportamentos globais. É onde entra o interruptor geral dos planos, para conseguirmos rodar com tudo liberado antes da cobrança existir.

**O que não existe, e precisa nascer:** nenhuma tabela de plano, assinatura, cobrança ou período de teste; nenhum interruptor de funcionalidade por organização; nenhuma contagem de nada por organização; nenhuma verificação de limite na criação de agente, funil, campanha, automação, canal ou usuário.

---

## 4. As peças que precisam nascer

### 4.1 O catálogo de planos

Uma tabela com os planos que existem para venda. Cada plano tem um apelido estável (`basico`, `intermediario`, `avancado`, `ilimitado`), um nome de tela, um preço mensal e anual, se está à venda ou não, e duas listas: **os tetos** (quantos de cada coisa) e **os recursos** (o que está ligado ou desligado).

Tetos e recursos ficam em campo flexível, não em uma coluna por item. Motivo prático: cada item novo que você quiser limitar viraria uma migração de banco e um deploy. Com campo flexível, plano novo e teto novo são cadastro, não obra.

O preço mora aqui para a tela de venda e para conferência. Quem cobra de verdade é o gateway, e o preço real da assinatura é o que está lá. Divergência entre os dois é um alarme, não um detalhe.

### 4.2 A assinatura da organização

Uma tabela ligando organização e plano, com: estado da assinatura, início e fim do período atual, se é mensal ou anual, e três campos do gateway (qual gateway, o id do cliente lá, o id da assinatura lá). Esses três campos ficam vazios enquanto a cobrança for na mão.

Os estados da assinatura, que é o que governa o comportamento do sistema:

| Estado | O que significa | O que o CRM faz |
|---|---|---|
| `avaliacao` | Período de teste | Funciona como o plano contratado, com data de fim |
| `ativa` | Em dia | Tudo normal |
| `atrasada` | Não pagou, dentro da carência | Funciona normal, avisa o admin da organização |
| `suspensa` | Carência acabou | Entra em modo leitura: atendimento humano continua, criação e automação param |
| `cancelada` | Saiu | Modo leitura, dado preservado pelo prazo combinado |

A carência é dado do plano, não número fixo no código. Sugestão inicial: 7 dias.

**Modo leitura precisa ser desenhado com cuidado.** O que exatamente para quando o cliente é suspenso é decisão de produto, não técnica, e está na lista de perguntas abertas no fim deste documento. O perigo real: um cliente que parou de pagar mas tem o WhatsApp dele ligado no CRM. Se as mensagens simplesmente pararem de entrar, o cliente final dele fica sem resposta e a culpa cai na Hiperbold.

### 4.3 O ajuste por organização

Uma folga por cima do plano, para o caso que sempre aparece: o cliente que negociou cinco usuários a mais sem mudar de plano. Sem isso, a saída vira criar um plano novo para cada exceção, e o catálogo apodrece em seis meses.

Regra de leitura, nesta ordem: ajuste da organização, se não tiver, o do plano, se não tiver, o padrão do sistema.

### 4.4 O lugar único que responde "pode?"

Uma função que recebe a organização e o que se quer criar, e responde uma de três coisas: pode; não pode porque bateu o teto (com o número atual e o teto, para a tela dizer isso ao usuário); não pode porque este recurso não está no plano (com o plano que resolveria).

Toda rota de criação passa a chamar essa função antes de inserir. E cada teto ganha também uma trava no banco, que é a que vale quando duas requisições chegam juntas.

### 4.5 A contagem

Para dizer "você tem 7 de 10", é preciso contar. Duas formas, e a escolha muda com o item:

- **Contar na hora** (`select count`) para o que é pouco e muda pouco: agentes, funis, conexões, usuários, campanhas, automações. É simples e não pode dessincronizar.
- **Contador materializado** para o que é muito: contatos, leads, mensagens. Contar milhões de linhas a cada criação de contato derruba o banco. Aqui entra um contador por organização, atualizado por gatilho, com um conferidor periódico que compara com a realidade e corrige.

A leitura da tela de uso é uma consulta só, que devolve todos os números de uma vez. Uma consulta por item multiplicaria por vinte o custo dessa tela.

### 4.6 As telas

1. **Painel da plataforma (você):** catálogo de planos, qual organização está em qual plano, trocar plano na mão, conceder ajuste, ver quem está perto do teto, ver quem está atrasado.
2. **Dentro da organização (seu cliente):** uma tela "Plano e uso" que mostra, item por item, quanto ele usa do que tem, o que o plano dele não inclui, e o convite para subir de plano. Essa tela é a que vende o upgrade, então ela é de produto, não de engenharia.
3. **Nas telas existentes:** quando o teto está batido, o botão de criar não some. Ele fica desabilitado com o motivo e o caminho. Botão que some deixa o cliente achando que quebrou.

---

## 5. A matriz dos planos (rascunho para você mexer)

Os números abaixo são chute inicial meu, para você ter algo concreto para discordar. **Quem define é você**, e o desenho acima aceita qualquer número sem mudar código.

### O que nunca é limitado

Estas são as funções essenciais. Limitar qualquer uma delas transforma uma venda em um problema de suporte:

- Receber e responder mensagem, em qualquer canal contratado
- Histórico de conversa e busca no histórico
- Contato e lead (o número deles pode ser limitado, mas o uso não)
- Registro de auditoria e segurança
- Backup e exportação dos dados do cliente
- Convite e remoção de usuário dentro do teto contratado

### O que é limitado, por nível

| Item | Básico | Intermediário | Avançado |
|---|---|---|---|
| Usuários | 3 | 10 | 30 |
| Números de WhatsApp conectados | 1 | 3 | 10 |
| Agentes de IA | 1 | 5 | 20 |
| Funis (pipelines) | 1 | 5 | ilimitado |
| Conexões MCP | 0 | 3 | 10 |
| Automações ativas | 3 | 20 | ilimitado |
| Campanhas por mês | 1 | 10 | ilimitado |
| Contatos | 2.000 | 20.000 | 200.000 |
| Crédito de IA incluso por mês (ver seção 6) | R$ 50 | R$ 200 | R$ 800 |
| Retenção de mídia | 90 dias | 365 dias | 730 dias |

### O que é recurso ligado ou desligado, por nível

| Recurso | Básico | Intermediário | Avançado |
|---|---|---|---|
| Agente de IA respondendo sozinho | sim | sim | sim |
| Operador (o agente que executa ações) | não | sim | sim |
| Conexões MCP (sistemas externos) | não | sim | sim |
| Campanhas | não | sim | sim |
| Automações | limitado | sim | sim |
| Relatórios avançados | não | não | sim |
| Acesso por API | não | não | sim |
| Chave de IA própria do cliente | não ofertado (decisão de 22/09/2026, ver seção 6) | | |

Três observações que valem mais que os números:

- **O teto de IA é o que protege sua margem.** É o único item cujo custo é diretamente seu. Ele já existe pronto no CRM e só precisa passar a ser preenchido pelo plano.
- **Conexão de WhatsApp é o segundo custo real**, se for por instância paga da UAZAPI. Vale conferir esse custo antes de fechar o número do plano básico.
- **Contatos é o limite mais perigoso da lista.** É o que mais cresce sozinho, e o cliente que bate nele no meio de uma campanha vai ligar bravo. Talvez seja melhor como aviso, não como bloqueio.

---

## 6. O consumo de IA como produto

Decisão do Filipe em 22/09/2026: **a chave de IA é da Hiperbold**. O cliente não cadastra chave dele. Ele recebe um tanto de consumo dentro do plano e pode comprar mais.

Isso é a mudança mais importante deste plano, porque transforma um custo em receita, e porque coloca a conta do fornecedor de IA no seu nome. Tudo que segue é consequência disso.

### 6.1 A unidade de venda: crédito em reais, não token

**Recomendação forte: não venda "tokens".** Mil tokens em um modelo custam várias vezes mais que mil tokens em outro, e o mesmo atendimento consome quantidades diferentes conforme o modelo que o agente usar. Vendendo token, toda troca de modelo e todo reajuste do fornecedor mexem na sua margem sozinhos, e o pacote que você já vendeu vira prejuízo.

Venda **crédito em reais**: "R$ 80 de IA inclusos", "pacote adicional de R$ 50". Por dentro o CRM já mede consumo em centavos, então a peça central já existe. Ao lado do número, a tela mostra a tradução para a linguagem do cliente ("dá para aproximadamente 4.000 atendimentos"), calculada do consumo médio real dele, e marcada como estimativa.

Vantagem prática: você troca de modelo, negocia preço melhor com fornecedor, ou usa modelo mais barato para tarefa simples, e tudo isso vira margem sua sem renegociar nada com o cliente.

### 6.2 As três fontes de crédito, e a ordem de consumo

| Fonte | O que é | Quando expira |
|---|---|---|
| **Crédito do plano** | Vem junto com a assinatura, todo mês | No fim do ciclo, não acumula |
| **Assinatura adicional de crédito** | Um valor mensal a mais, contratado por fora do plano | No fim do ciclo, não acumula |
| **Pacote avulso** | Compra única, para o mês que estourou | Prazo longo, ver risco 13 |

Consome nesta ordem: primeiro o do plano, depois o adicional recorrente, por último o avulso. Assim o avulso, que é o que o cliente pagou à parte, é o último a evaporar.

**Não acumular o crédito do plano é decisão de produto**, e é o padrão do mercado. Acumular parece generoso e vira dívida: cliente que ficou seis meses parado volta com meio ano de crédito e consome tudo num mês, com custo real seu, hoje, em dólar de hoje.

### 6.3 O que acontece quando acaba

A mesma gramática do orçamento de IA que já existe no CRM, e que já está pronta: avisa em 50% e em 80%, avisa ao bater 100%, e só então para. Nunca para sem ter avisado. O que muda é o que aparece na tela ao parar: um botão de comprar pacote, não uma mensagem de erro.

Enquanto o crédito está zerado, o CRM **não deixa de receber mensagem e não deixa de atender**. O que para é a resposta automática por IA. A conversa cai para atendimento humano, com aviso na Central, exatamente como já acontece hoje quando o orçamento estoura.

Recarga automática (o cliente autoriza recompra quando zerar) é bom para você e precisa de gateway, então fica para a fase 5. É também o item que mais precisa de trava: recarga automática com agente em laço é a receita de uma fatura de milhares de reais numa madrugada.

### 6.4 Margem, câmbio e preço do fornecedor

Seu custo é em dólar e seu preço é em real. Três coisas precisam existir desde o começo:

1. **Fator de remarcação** configurável (quanto você cobra sobre o custo). Fica em configuração da instalação, não no código, porque vai mudar.
2. **Folga de câmbio** embutida nesse fator. Dólar subindo 15% não pode virar prejuízo silencioso.
3. **Painel de margem** por organização: quanto o cliente pagou no mês contra quanto ele custou de verdade. Sem essa tela você só descobre o prejuízo no extrato do fornecedor.

### 6.5 O que precisa ser medido, e que costuma escapar

Se algum destes ficar de fora da medição, a margem vaza por ali:

- Chamada de modelo do agente, entrada e saída, que é o óbvio
- Token de cache, que tem preço diferente
- Tentativa repetida após falha do fornecedor
- Chamada de ferramenta que gera nova rodada de modelo
- Transcrição de áudio
- Geração de embedding para a busca do agente
- As chamadas internas de controle (detecção de intenção, conferência de promessa, roteador)

O CRM já mede chamada de modelo. As outras precisam ser conferidas uma a uma na fase 2.

### 6.6 O que isso exige de peça nova

- **Carteira da organização:** saldo por fonte, com o ciclo a que pertence
- **Livro-caixa:** toda entrada (plano, adicional, pacote, ajuste manual seu) e toda saída (consumo), com data, origem e valor, para o extrato do cliente e para a defesa em caso de contestação
- **Extrato na tela do cliente:** consumo por dia e por agente. Isso não é luxo: é o que evita a discussão de "esse consumo não foi meu"
- **Catálogo de pacotes:** os valores de pacote avulso e de adicional recorrente à venda
- **Trava de segurança por organização:** teto por conversa e teto por dia, independentes do saldo, para que um laço de agente não queime o mês inteiro em uma hora
- **Trava de segurança da instalação:** um teto geral, seu, que para tudo se o consumo do dia sair da curva. É a última proteção da sua conta no fornecedor

### 6.7 Por que não a chave do cliente

Registrado para memória, já que a decisão foi tomada: a chave própria do cliente tiraria o custo de IA do seu bolso e tiraria também a receita, o controle do modelo, a qualidade (cliente colocando chave de conta gratuita com limite baixo) e a maior parte do suporte ("a IA parou" vira problema seu de qualquer jeito). Continua disponível como exceção negociada para cliente grande, se um dia valer a pena, e nesse caso o consumo dele simplesmente não passa pela carteira.

---

## 7. Como o limite é aplicado, em três camadas

1. **Banco:** gatilho que conta e recusa. É a verdade. Vale mesmo que alguém escreva direto no banco.
2. **Servidor:** a função única, chamada antes de qualquer criação. É quem produz a mensagem boa e o registro.
3. **Tela:** o botão desabilitado com o motivo. É quem evita a frustração.

As três existem porque cada uma falha de um jeito. Só banco dá erro feio. Só servidor vaza em corrida. Só tela não protege nada.

---

## 8. Assinatura e pagamento

### O que não depende do gateway escolhido

Quase tudo: catálogo, tetos, contagem, trava, telas, estados da assinatura, modo leitura, avisos. Tudo isso pode ser construído e usado com você trocando o plano na mão. **É por isso que a escolha do gateway não trava nenhuma fase antes da última.**

### O que o gateway precisa fazer

1. Criar cliente e assinatura recorrente em reais
2. Avisar por webhook quando o pagamento entra, falha ou a assinatura é cancelada
3. Aceitar troca de plano no meio do período
4. Emitir cobrança por Pix, boleto e cartão, que é o que o mercado brasileiro usa
5. De preferência, emitir nota fiscal de serviço, ou integrar com quem emite

Candidatos naturais no Brasil: Asaas, Iugu, Vindi, Pagar.me, Stripe (que agora opera em reais, mas com menos jeito para boleto e nota). **Não recomendo escolher agora.** A escolha fica muito mais fácil quando as fases 1 a 4 estiverem de pé e você souber exatamente o que precisa pedir.

### O que o CRM guarda sobre pagamento

Id do cliente e id da assinatura no gateway, e o estado. **Nada de dado de cartão, nunca.** Isso é regra, não preferência: guardar cartão muda o nível de exigência de segurança da empresa inteira.

### Webhook de cobrança

Mesma disciplina que já usamos nos webhooks de WhatsApp: segredo na URL, assinatura conferida, evento repetido não conta duas vezes, e todo evento arquivado antes de ser processado. Um webhook de pagamento processado em dobro vira crédito indevido ou suspensão errada.

---

## 9. O que muda no que já está pronto

| Onde | O que muda |
|---|---|
| Criação de agente, funil, campanha, automação, canal, conexão MCP, credencial | Passa a perguntar antes de criar |
| Convite de usuário | Passa a contar quantos já existem |
| Conexões MCP | O teto fixo de 10 vira teto do plano, e o débito D-034 é resolvido junto |
| Orçamento de IA | O teto deixa de ser cadastro manual e passa a vir do plano |
| Retenção de mídia | O valor passa a vir do plano |
| Tela de capacidades do agente | O teto de 25 capacidades pode virar teto de plano |
| Central de avisos | Ganha os avisos de "perto do teto", "teto batido" e "pagamento atrasado" |
| Onboarding de organização nova | Passa a escolher plano ou começar em avaliação |
| Arquivamento de organização | Passa a conversar com o cancelamento da assinatura |

---

## 10. Riscos

Em ordem do que mais dói:

**1. O cliente suspenso com WhatsApp ligado.** Se a suspensão derruba a entrada de mensagens, o cliente final dele fica sem resposta e a reclamação chega na Hiperbold. Mitigação: suspensão nunca derruba recebimento; ela desliga IA, automação e campanha, e avisa na tela. O atendimento humano continua.

**2. Teto burlado por caminho lateral.** Todo teto tem uma porta dos fundos: importação em massa, duplicação, restauração de item arquivado, criação por automação, criação pela API. Mitigação: a trava no banco, que não tem porta dos fundos, e uma varredura de teste que percorre todas as rotas de criação e prova que cada uma pergunta antes.

**3. Cliente atual passando a ter limite.** Quando os planos entrarem valendo, quem já usa pode estar acima do teto do plano que você quer vender para ele. Mitigação: todo mundo começa no plano Ilimitado, e a migração é uma decisão por cliente, com ajuste por organização para quem ficou fora da caixa.

**4. Contagem errada.** Contador materializado que dessincroniza é clássico, e dessincroniza sempre para o lado de cobrar a mais, que é o lado que gera briga. Mitigação: conferidor periódico que compara o contador com a contagem real e corrige, e uso da contagem na hora para tudo que for pequeno.

**5. Custo de IA maior que o preço do plano.** O plano básico com crédito mal calibrado vende prejuízo. Como a chave é sua, a conta chega no seu cartão antes de você perceber. Mitigação: crédito por plano obrigatório desde o primeiro dia, fator de remarcação com folga de câmbio, e painel de margem por organização.

**5-A. Agente em laço queimando crédito.** O risco mais caro e o mais rápido: um agente que entra em laço, ou uma ferramenta externa que devolve algo que faz o modelo repetir, consome em uma madrugada o que era para durar um mês. Com recarga automática ligada, vira fatura de milhares de reais sem ninguém acordado. Mitigação: teto por conversa e teto por dia, independentes do saldo; teto geral da instalação como última barreira; recarga automática com limite de recargas por dia.

**5-B. Contestação de consumo.** "Esse consumo não foi meu" é discussão garantida quando a fatura é variável. Sem extrato item a item, quem perde é você, porque não tem como provar. Mitigação: livro-caixa e extrato por dia e por agente desde a primeira versão, não depois.

**5-C. Fornecedor reajusta preço ou modelo sai do ar.** Crédito vendido em real com custo em dólar é uma promessa sua sobre um preço que não é seu. Mitigação: vender crédito em reais e não em token (assim a troca de modelo é sua decisão, não um problema contratual), fator de remarcação ajustável sem deploy, e pacote avulso com prazo de validade declarado.

**6. A junção com o código do autor original.** Este é um sistema inteiro que só existe no nosso fork, e ele toca todas as rotas de criação, que são justamente onde o autor mexe com frequência. Cada atualização dele vai ficar mais trabalhosa. Mitigação: concentrar tudo em arquivos nossos, tocando o código dele com uma linha só por rota, e registrar cada ponto de contato numa lista.

**7. Nota fiscal e imposto.** Vender assinatura recorrente para empresa exige nota fiscal de serviço por cobrança. Isso é trabalho contábil e operacional, não técnico, e costuma ser lembrado tarde. Mitigação: entrar na escolha do gateway como requisito, não como bônus.

**8. Preço que muda.** Cliente antigo com preço antigo é normal e precisa ser suportado desde o começo, senão vira migração dolorosa depois. Mitigação: o preço fica na assinatura, não só no plano.

**9. Uma pessoa com várias organizações.** Se o mesmo cliente tem duas organizações, ele tem duas assinaturas. Isso é simples e correto, mas precisa estar claro na venda, senão vira discussão.

**10. Modo leitura mal desenhado.** É o lugar mais fácil de introduzir bug sério, porque muda o comportamento de dezenas de telas. Mitigação: um conjunto de testes dedicado só a isso, e a suspensão desligando poucos verbos bem definidos, não cada tela na mão.

**11. Crédito comprado que não é usado.** Pacote pago com prazo de validade curto é o tipo de cláusula que o consumidor contesta, e no Brasil crédito pré-pago que expira já rendeu discussão de sobra. Mitigação: prazo longo e escrito em contrato, aviso antes de expirar, e nunca expirar o pacote avulso antes do crédito do plano.

**12. Medição incompleta.** Se transcrição de áudio, geração de embedding e as chamadas internas de controle não entrarem na conta, a margem vaza por ali sem aparecer em lugar nenhum. Mitigação: a conferência item a item descrita em 6.5, na fase 2, com um teste que soma tudo o que saiu do sistema e compara com a fatura do fornecedor no mês.

**13. Sua chave de IA é uma só para todos.** Todas as organizações consomem pela mesma conta. Um defeito de cota não afeta um cliente: afeta a sua fatura inteira e pode derrubar o atendimento de todos por limite do fornecedor. Mitigação: teto geral da instalação, alarme de consumo fora da curva, e monitoramento diário do gasto contra o esperado.

---

## 11. Ordem de execução

Cada fase entrega algo utilizável sozinha. Nenhuma fase depende do gateway, exceto a última.

| Fase | O que entrega | Depende de |
|---|---|---|
| **F0** | Este plano aprovado, matriz de planos fechada por você, respostas às perguntas abertas | você |
| **F1** | Catálogo de planos e assinatura no banco, tudo no plano Ilimitado, nada bloqueia ainda. Painel da plataforma para ver e trocar plano na mão | F0 |
| **F2** | A função única que responde "pode?", as travas no banco, a contagem, e a tela "Plano e uso" para o cliente. Ainda sem bloquear: só avisa e mostra. Aqui entra também a conferência de tudo que consome IA e ainda não é medido (6.5) | F1 |
| **F2-B** | A carteira de crédito de IA: saldo por fonte, livro-caixa, extrato para o cliente, fator de remarcação, painel de margem para você, e as travas por conversa, por dia e da instalação | F2 |
| **F3** | Bloqueio ligado, com a mesma gramática do orçamento de IA: avisa antes, tem carência, tem chave de emergência da instalação | F2-B |
| **F4** | Os três planos de venda cadastrados, período de avaliação, estados de atrasado e suspenso, modo leitura, catálogo de pacotes de crédito vendidos na mão | F3 |
| **F5** | Gateway de pagamento: cobrança recorrente, compra de pacote pelo próprio cliente, recarga automática, webhook, troca de plano automática, nota fiscal | escolha do gateway |

Ordem de grandeza, para você calibrar expectativa: F1, F2 e F2-B são as fases grandes, F3 é média, F4 é média com muito teste, e F5 depende inteiramente do gateway escolhido.

Enquanto o gateway não existe, o cliente compra pacote adicional falando com você, e você credita pelo painel. Isso é feio de operar e é suficiente para os primeiros clientes, além de ser a melhor forma de descobrir o preço certo antes de automatizar.

---

## 12. Perguntas abertas, que são suas e não minhas

1. **Suspensão por falta de pagamento:** o que exatamente para? Minha proposta é: para IA, automação e campanha; continuam recebimento, resposta humana e leitura de tudo.
2. **Período de avaliação:** existe? De quantos dias? Pede cartão na entrada?
3. **Contatos:** teto que bloqueia ou teto que avisa?
4. **Usuário adicional:** vende avulso por fora do plano, ou só subindo de plano?
5. **Preço:** os três níveis saem por quanto? Tem desconto anual?
6. **O que fica no básico:** a matriz acima deixa o básico sem IA com Operador, sem MCP e sem campanha. Isso ainda é vendável para o seu mercado?
7. **As organizações internas da Hiperbold** entram como plano Ilimitado permanente, certo?

Sobre o crédito de IA, que virou a seção 6:

8. **A unidade de venda:** fecha em crédito em reais, como recomendo, ou você quer mesmo anunciar em tokens? Se for token, preciso saber como você quer lidar com a diferença de preço entre modelos.
9. **Quanto de crédito em cada plano**, e por quanto sai o pacote adicional. Isso depende do seu custo real por atendimento, que dá para medir nas organizações que já rodam.
10. **Qual a sua remarcação** sobre o custo. Precisa cobrir o dólar, o imposto e a sua margem.
11. **Acumula ou não acumula** o crédito não usado do mês. Minha recomendação é não acumular o do plano e deixar o pacote avulso durar.
12. **Quando zera:** para a IA e cai para atendimento humano (minha proposta), ou você prefere que continue rodando e vire cobrança no mês seguinte? A segunda é mais cara de errar.
13. **Recarga automática:** quer oferecer? Ela vende mais e é o caminho mais curto para uma fatura absurda por defeito. Se quiser, entra na F5 com limite de recargas por dia.

---

## 13. O que este plano absorve do débito

- **D-034** (limite de conexões MCP sem trava no banco): resolvido pela trava genérica da F2, que vale para todos os itens de uma vez.
