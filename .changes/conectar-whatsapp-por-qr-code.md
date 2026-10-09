---
impacto: capacidade_nova
secao: adicionado
titulo: O cliente conecta o WhatsApp sozinho, lendo um QR Code dentro do CRM
---

Até agora, conectar um número de WhatsApp exigia ter uma instância já pareada num
servidor e colar o endereço e o token dela em Conexões. Agora, quando a
instalação tem o servidor de WhatsApp configurado, a opção principal em Conexões
(e no passo "Dê um telefone a ele" do primeiro acesso) passa a ser
**Conectar WhatsApp (QR Code)**: o CRM cria a instância no servidor, mostra o
QR Code grande, e o cliente só abre o WhatsApp no celular, vai em Dispositivos
conectados e lê. O QR se renova sozinho enquanto a tela está aberta; quem
prefere pode conectar com um código digitado no celular, informando o número.
Ao conectar, o CRM preenche o número e o nome do perfil e liga a entrada das
mensagens.

O formulário antigo (endereço do servidor e token da instância) continua
disponível, dobrado em "Avançado".

Cuidados que vêm junto:

- Quem desiste (cancela, ou deixa o QR sem ler por 30 minutos) não deixa nada
  para trás: a instância é apagada no servidor e a vaga do plano é liberada. Há
  no máximo dois pareamentos em andamento por organização.
- Remover uma conexão criada assim também apaga a instância no servidor. As
  conexões feitas com servidor e token do próprio cliente continuam como eram:
  só o webhook do CRM é retirado, a instância é dele.
- O limite de Conexões do plano vale antes de qualquer instância ser criada e
  conta todas as conexões da empresa (WhatsApp, Instagram e Messenger somados),
  conferido no banco; sem limite no plano, o teto de segurança é 50. Cada empresa
  também tem um limite de pedidos por hora para gerar, renovar e cancelar QR
  Codes, e o código de pareamento por telefone sai um a cada 30 segundos, no
  máximo cinco por pareamento.
- Gravar o token de administrador em Admin › Configuração exige a verificação em
  duas etapas confirmada na sessão, e o endereço do servidor não pode apontar
  para a rede interna.

**Para ligar o recurso é preciso configurar**, em Admin › Configuração
(grupo WhatsApp), o **Servidor de WhatsApp para conectar por QR Code** (endereço
https) e o **Token de administrador do servidor de WhatsApp**. O token fica
guardado cifrado e não é mostrado de novo. Dá para configurar também no arquivo
de instalação (`UAZAPI_SERVIDOR_URL` e `UAZAPI_ADMIN_TOKEN`), mas o valor
gravado na tela vale sobre ele. Sem as duas chaves, a opção não aparece e nada
muda para quem já usa o sistema.

O agendador ganha uma rodada nova (`pareamento-qr-limpeza`, a cada 5 minutos)
que limpa os pareamentos esquecidos; ela vem junto com a imagem do agendador,
sem edição manual.
