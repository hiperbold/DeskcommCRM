# Guia de uso: módulo de planos e cobrança

Este guia descreve a branch feat/planos-assinatura (27/09/2026), ainda não publicada.

## 1. Onde fica cada coisa

Há três telas no admin e uma tela no lado do cliente.

1. Aba Plano de uma organização: `/admin/tenants/{id}/plano`. Aqui você vê e mexe no plano, na assinatura, nos pagamentos, nos tokens e nos limites de uma organização específica.
2. Tela do sistema: `/admin/sistema`. Aqui você liga e desliga o bloqueio geral, define os dias de folga, cadastra pacotes de tokens e vê quem está atrasado ou suspenso.
3. Tela de cobrança: `/admin/sistema/cobranca`. Aqui você acompanha o Asaas: chaves, alarmes, planos à venda, pedidos e eventos recebidos.
4. Tela do cliente: `/app/settings/plano`. É o que a própria organização vê sobre o plano dela, o uso e o pagamento.

## 2. Tarefas do dia a dia

### Registrar um pagamento recebido por fora

1. Na aba Plano da organização, vá até "Registrar pagamento".
2. Preencha o fim do novo período, o valor recebido em reais e, se quiser, uma nota.
3. Clique em "Registrar".

Isso grava o pagamento, avança o fim do período e, se a assinatura estava atrasada, volta ela para ativa. Pode clicar duas vezes sem medo: não duplica.

### Estornar um pagamento

1. Vá até "Pagamentos e estornos".
2. Clique em "Estornar" no pagamento desejado.

Esse botão só aparece em pagamentos recebidos por fora, registrados à mão. O estorno grava uma linha nova, não apaga a original e não mexe no período. Se o período também precisar mudar, corrija ele à parte, na tarefa de correção de período.

### Creditar tokens avulsos

1. Na seção de crédito de tokens, informe a quantidade de tokens.
2. Se recebeu algum valor por isso, preencha o valor recebido (opcional).
3. Se quiser, escreva uma nota.

Reenviar a mesma ação não duplica o crédito.

### Creditar um pacote do catálogo

1. Vá até "Creditar pacote do catálogo".
2. Escolha o pacote.
3. Se o pacote não tiver preço cadastrado, preencha o valor recebido. Se tiver preço, não precisa.
4. Se quiser, escreva uma nota.

### Dar mais dias antes de o bloqueio valer

1. Na seção "Plano contratado", preencha o campo "Dar carência extra até" com a nova data.
2. Clique em "Estender carência".

Isso só estende a data, nunca encurta. E só funciona depois que o bloqueio foi ligado em "bloquear", porque antes disso a organização ainda não tem data de bloqueio para adiar.

### Mudar o estado da assinatura

1. Na seção "Assinatura", escolha o novo estado.
2. Escreva o motivo.
3. Clique em "Mudar estado".

Regras: qualquer estado pode virar cancelada. Ativa pode virar atrasada ou suspensa. Atrasada, suspensa ou cancelada só voltam para ativa se o fim do período estiver no futuro. Se não estiver, registre um pagamento ou corrija o período antes de mudar o estado.

### Pôr uma organização em avaliação até uma data

1. Use "Pôr em avaliação até".
2. Informe a data.
3. Escreva o motivo (obrigatório).

### Corrigir o fim do período lançado errado

1. Use "Corrigir período".
2. Informe a nova data de fim.
3. Escreva o motivo (obrigatório).

### Trocar o plano

1. Na seção "Trocar plano", escolha o novo plano.
2. Clique em "Salvar".

### Ajustar limites só para uma organização

1. Na seção "Ajustar limites", defina os valores desejados.
2. Clique em "Salvar ajuste".
3. Para voltar ao padrão do plano, clique em "Remover ajuste".

A seção "Limites" mostra três colunas para comparar: "Do plano", "Do ajuste" e "Em vigor".

### Marcar para cancelar no fim do período

1. Clique em "Cancelar no fim do período".
2. Para desistir, clique em "Não cancelar" a qualquer momento antes do fim do período.

Toda ação nesta seção fica registrada no histórico de auditoria, com quem fez e o motivo. As ações de cobrança exigem o acesso completo de admin da plataforma.

## 3. Bloqueio dos planos e dias de folga

Na tela do sistema, em "Bloqueio dos planos", há três modos:

- Desligado: nada acontece por falta de pagamento.
- Avisar (padrão atual): o cliente é avisado, mas nada para.
- Bloquear: depois da folga, o acesso vira modo leitura.

Ao mudar para bloquear, a tela pede confirmação e mostra quantas organizações vão ganhar folga e a data prevista para cada uma.

Toda organização que ainda não tem uma data de folga definida recebe, no momento da mudança, hoje mais os dias de folga configurados (padrão de 7 dias). Só depois dessa data o bloqueio passa a valer para ela. Você define os dias de folga (de 0 a 90) e confirma em "Salvar dias".

## 4. O que o cliente vê

Na tela `/app/settings/plano`:

- "Plano e uso" (funis, etapas, membros, conexões, integrações, leads e tokens): visível para gerente e para admin da organização.
- "Assinatura e pagamento": visível só para o admin da organização.

Quando a organização está em modo leitura por falta de pagamento, aparece este aviso:

"O acesso desta organização está em modo leitura por falta de pagamento."
"Param: a IA, as automações, as campanhas de disparo, os follow-ups e a criação de funil, etapa, integração e convite."
"Continuam: receber mensagem, responder à mão, ler tudo e criar lead."

A compra pela tela, em `/app/settings/plano/assinar`, só aparece para o admin da organização e só quando as duas chaves do Asaas estiverem ligadas (veja a seção 6). Sem elas, o cliente vê: "A compra pela tela ainda não está disponível. Fale com o suporte." Nessa tela só aparecem os planos postos à venda e que tenham preço mensal cadastrado.

## 5. Estados da assinatura

| Nome na tela | O que significa | O que para |
|---|---|---|
| Avaliação | Período de teste, até uma data definida | Nada para durante o teste |
| Ativa | Em dia com o pagamento | Nada para |
| Atrasada | O período venceu, mas ainda está dentro dos dias de tolerância (padrão 7) | Nada para ainda, é o aviso |
| Suspensa | A tolerância acabou | Modo leitura: a organização só recebe mensagem, responde à mão, lê tudo e cria lead |
| Cancelada | Assinatura encerrada | Depende da configuração de bloqueio da conta |

Uma conferência automática, todo dia, faz o seguinte:

- Assinatura marcada para cancelar no fim do período, com período vencido, vira cancelada.
- Ativa ou em avaliação com o período vencido vira atrasada.
- Atrasada com o período vencido há mais tempo que os dias de tolerância vira suspensa.

O fim do período vale até a meia noite, no horário de São Paulo, do dia informado.

## 6. Asaas (quando for ligado)

Existem duas chaves e as duas precisam estar ligadas para o cliente comprar pela tela:

1. A variável de ambiente do servidor (ver seção 7).
2. O botão "Ligar compra pelo cliente", na tela de cobrança (para desligar, o botão vira "Desligar compra pelo cliente"). Os dois pedem confirmação antes de agir.

Se a chave do servidor estiver desligada, o CRM não faz nenhuma chamada ao Asaas.

### Pôr um plano à venda

1. Na tela de cobrança, encontre o plano.
2. Clique em "Pôr à venda".
3. Para tirar de venda, clique em "Tirar de venda".

Um plano sem preço mensal cadastrado não pode ser posto à venda.

### Alarmes e o que fazer

- "Pendente há mais de 1 hora": olhe a lista de eventos e confira o pagamento no painel do Asaas.
- "Erro nas últimas 24h": olhe a lista de eventos; se o evento tiver resultado erro, use "Reprocessar".
- "Divergente nas últimas 24h": olhe a lista de eventos e confira o pagamento no painel do Asaas.
- "Sem vínculo nas últimas 24h": olhe a lista de eventos; se o evento estiver sem vínculo, use "Reprocessar".
- "Sem evento há 3 dias, assinatura ativa": confira o pagamento no painel do Asaas e, se precisar, registre o pagamento à mão (seção 2).

O botão "Reprocessar" só aparece em eventos com resultado erro ou sem vínculo.

Estorno ou contestação de cartão não corta o acesso da organização sozinho: ele aparece como alarme e você decide o que fazer.

### Cancelar um pedido

1. Na tela de cobrança, encontre o pedido (só funciona com pedido em aberto: criado, processando, aguardando pagamento ou inconclusivo).
2. Clique em "Cancelar pedido".
3. Escreva o motivo (obrigatório).

Isso remove a cobrança no Asaas e marca o pedido como cancelado.

### Cancelar assinatura no Asaas

1. Clique em "Cancelar assinatura no Asaas".

A assinatura continua valendo até o fim do período já pago. Depois disso, o Asaas para de cobrar.

O cliente paga com cartão ou Pix na própria página do Asaas. O CRM nunca vê o número do cartão.

## 7. Para quem for configurar o servidor

- ASAAS_ENABLED: liga ou desliga o Asaas no servidor. Vem desligada por padrão.
- ASAAS_BASE_URL: define se o ambiente é sandbox ou produção. A chave usada precisa ser do mesmo ambiente, senão o app recusa.
- ASAAS_API_KEY: a chave da API do Asaas. Em arquivo .env, o cifrão do início precisa ser escrito com barra invertida antes.
- ASAAS_WEBHOOK_TOKEN: token do webhook, diferente da chave da API. É criado no painel do Asaas junto com o cadastro do webhook.
- ASAAS_WEBHOOK_ID: usado só na conferência diária.
- TRUSTED_PROXY_COUNT: não definir antes de medir o cabeçalho de IP em produção. Ver pendências D-036 e D-075 em hiperbold/DEBITO.md.
