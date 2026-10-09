---
impacto: capacidade_nova
secao: adicionado
titulo: O limite de Conexões do plano vale para todos os canais e bloqueia de verdade
---

O item "Conexões" do plano (Pro 3, Max 10, Scale 20) agora soma todos os canais
da empresa: WhatsApp pela API não oficial, WhatsApp oficial, Instagram e
Messenger. Ao chegar no limite, o CRM recusa uma conexão nova (e também
reativar uma removida) com a mensagem "Sua conta atingiu o limite de N conexões
do plano X. Remova uma conexão ou mude de plano.", e o botão de conectar fica
desabilitado com um link para a tela de planos.

Diferente dos outros itens do plano (funis, leads, membros, integrações), que
seguem o modo da trava configurado em Admin, o limite de Conexões bloqueia
sempre. Conexões que já existem não são afetadas: uma empresa que já tem mais
conexões que o limite continua com elas, só não cria nem reativa mais. Plano
sem limite de conexões (como o Ilimitado) não bloqueia nada.

A mudança de banco (`0954`) vem junto com a atualização; nada a configurar.
