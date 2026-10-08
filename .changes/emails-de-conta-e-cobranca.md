---
impacto: capacidade_nova
secao: adicionado
titulo: E-mails de conta e cobrança para quem administra a empresa
---

Até aqui o CRM mandava um único e-mail de cobrança, a régua de renovação do
plano que não renova sozinho. Os avisos de pagamento, recibo e atraso ficavam
por conta do gateway.

Agora o CRM manda dez e-mails novos para os admins da empresa cliente: boas-vindas
quando a empresa é criada, plano confirmado, recibo de cada pagamento (um só
por compra parcelada), aviso dias antes da renovação automática no cartão,
pagamento não aprovado, conta suspensa, cancelamento confirmado, estorno,
pacote de tokens liberado e tokens de IA do mês acabando (em 80% e em 100%).
Todos usam o mesmo layout, com a marca da instalação.

Os e-mails entram numa fila no banco no momento do acontecimento e saem por um
agendamento que roda a cada minuto. Falha do servidor de e-mail não perde o
aviso: ele é tentado de novo com espera crescente, até seis vezes. Cada aviso
sai uma vez só, mesmo que o evento do gateway chegue repetido.

Quem opera a instalação pode receber cópia dos avisos de empresa nova e de
cobrança (assinatura, recusa, suspensão, cancelamento, estorno e pacote de
tokens). O endereço fica em Configuração, no grupo de e-mail, em "E-mail que
recebe cópia dos avisos de clientes"; vazio, a cópia vai para os admins da
plataforma.

Precisa de SMTP ou Resend configurado para sair. Sem nenhum dos dois, os
avisos esperam na fila e saem quando o envio for configurado.
