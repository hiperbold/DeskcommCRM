# Fase F8: o que dá para entregar sem as respostas do Filipe

Aberta em 27/09/2026. O Filipe pediu para seguir com tudo o que não depende das decisões dele, só no computador local, sem publicar, anotando as questões novas. As perguntas antigas continuam na lista de `progresso-da-noite.md`, na ordem de prioridade que ele recebeu.

## Frentes

1. **Site de vendas** (`F:\github-projects\hipercrm-site`): conferência em seis larguras de tela (360 a 1440 px), busca do Google básica (título e descrição por página, compartilhamento, sitemap e endereço canônico só quando o domínio for definido, Termos e Privacidade fora da busca enquanto forem rascunho), página 404 e revisão de acessibilidade. O menu do celular já estava pronto (commit 7b3b187).
2. **Atualizações do autor (D-028)**: numa cópia separada (`~/projects/deskcommcrm-merge`, branch `merge/upstream-2026-09-27`). O ensaio de 27/09 mostrou que o autor andou muito mais do que os 63 commits de 16/09: são 1.420 commits (1.006 sem contar os merges), 48 migrações novas (0383 a 0442) e 28 arquivos em conflito, inclusive o `baseline.sql`. Estratégia do baseline: a versão do autor inteira, com os blocos do fork depois, juntando à mão cada objeto que os dois lados mexeram. Os dois lados têm uma migração 0385 (arquivos diferentes). A branch `feat/planos-assinatura` não é tocada; a junção só entra nela depois dos portões completos verdes e de revisão.
3. **Astro na versão principal nova**, no site, numa branch separada, depois da frente 1.
4. **Conferência das telas de plano e cobrança no CRM local**, com prints para o Filipe ver sem abrir.
5. **Guia de uso da cobrança** para o Filipe: registrar pagamento, estornar, dar carência, ligar o bloqueio, ler alertas.
6. **D-042** (reenvio de evento da UAZAPI com várias réplicas): decisão técnica abaixo.

## Decisões técnicas

- **D-042 fica como está, com a justificativa escrita**: a produção roda uma réplica só do app (EasyPanel `hiperbold-crm-1`), e a proteção por processo cobre esse caso. Guardar os eventos vistos no banco acrescentaria uma escrita por mensagem recebida para proteger uma topologia que não existe. Se um dia houver mais de uma réplica, a troca é pelo Redis que o worker já usa.
- **D-062 fica como está**: corrigir exige trocar a garantia de "move todos ou nenhum" do lote, e o travamento é raro, só com o bloqueio ligado, e o banco desfaz uma das duas operações sozinho.

## Perguntas novas desta fase

Nenhuma até agora; as que surgirem entram aqui com o padrão adotado.
