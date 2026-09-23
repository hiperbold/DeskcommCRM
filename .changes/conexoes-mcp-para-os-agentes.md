---
impacto: capacidade_nova
secao: adicionado
titulo: O agente consulta outros sistemas por conexões MCP
---

Até aqui o agente só usava as ferramentas do próprio CRM. Uma imobiliária que
guarda os imóveis em outro sistema, ou uma loja com o estoque num ERP, não
tinha como fazer o agente consultar esses dados durante o atendimento.

Agora dá para conectar servidores MCP (o padrão aberto de ferramentas para
IA) em IA › Ensinar o agente › Conexões MCP. O CRM se conecta ao servidor,
lista as ferramentas dele, e cada uma vira uma capacidade que se marca no
agente como qualquer outra. Ela conta no limite de 25 capacidades.

Nenhuma ferramenta externa roda sem o admin decidir antes se ela só consulta
ou se altera dados. Uma ferramenta nova, ou uma cuja descrição o servidor
mudou, fica aguardando aprovação até alguém olhar. O Testar só roda as de
consulta. Com o Operador ligado, as que alteram dados saem do agente que
conversa com o cliente, e cada uso delas fica na auditoria.

Dado de cliente não sai junto com o pedido: telefone, e-mail, CPF, CNPJ e
endereço de WhatsApp são retirados do que o agente manda para a ferramenta
externa, e o que saiu fica no registro. Código de barras, referência de
produto, CEP, ano e preço passam inteiros, que é do que a consulta de catálogo
vive.

A chave de acesso do servidor é guardada cifrada, e a tela mostra só o começo
do endereço. Um servidor fora do ar ou lento não derruba o atendimento: o
agente responde sem aquela ferramenta e a Central avisa. Os dados que o agente
manda para a ferramenta saem para o servidor de terceiro, e a tela de cadastro
avisa isso.
