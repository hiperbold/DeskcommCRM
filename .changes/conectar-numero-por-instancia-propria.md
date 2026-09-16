---
impacto: capacidade_nova
secao: adicionado
titulo: Conectar um número de WhatsApp que já roda numa instância do seu próprio servidor
---

Quem já mantém números de WhatsApp em um servidor de instâncias próprio
precisava, até agora, mover o número para um dos transportes que o CRM conhecia
— ou seja, desconectar o aparelho, parear de novo e deixar para trás as
automações que já falavam com aquela instância.

Agora Conexões tem a aba "API não oficial": você informa o endereço do servidor
e o token da instância, e o CRM testa os dois antes de gravar. Dá certo, a
conexão aparece com o número e o apelido, o token fica guardado cifrado (e não
é mostrado de novo) e a volta das mensagens é ligada sozinha — o CRM registra o
próprio endereço no servidor sem apagar os webhooks que já estavam lá.

A partir daí é um canal como os outros: as conversas entram no inbox com
imagem, áudio, documento e figurinha; o texto de PDF e a descrição de imagem
são extraídos como em qualquer canal; o que você envia pelo CRM sai pela
instância e os tiques de entregue e lido voltam para a bolha. Áudio gravado no
próprio CRM chega como nota de voz. Quando alguém responde pelo celular, a IA
pausa naquela conversa, e quando a instância cai ou pede o QR de novo, o aviso
aparece na Central e se fecha sozinho quando o número volta.

Dois pontos para saber antes de usar:

- **O número corre o mesmo risco de bloqueio do canal por QR.** É o WhatsApp
  comum, não a API oficial: o CRM trata este canal com as mesmas travas
  anti-bloqueio, e não com as regras de janela e modelo do canal oficial.
- **O que outro sistema enviar pela mesma instância aparece na conversa.** Se
  um n8n (ou qualquer outra automação) responder por aquele mesmo número, a
  resposta entra no inbox como saída de fora do CRM, e a IA daquela conversa
  pausa, como pausa quando alguém responde pelo celular: o cliente já recebeu
  uma resposta e não deve receber duas. O que o próprio CRM envia não aparece
  duplicado.

Para a conexão funcionar, o endereço público do CRM precisa estar configurado
(`NEXT_PUBLIC_APP_URL`): é dele que sai o endereço de volta registrado no
servidor. Sem ele, a conexão é gravada, o aviso diz que a entrada de mensagens
não foi ligada, e basta reconectar com o mesmo token depois de configurar.
