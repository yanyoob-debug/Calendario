# Medição de consultas

Execute `npm run benchmark`. O script cria 10.000 compromissos fictícios em SQLite **em memória**, aquece as consultas e mede 100 repetições. Nenhum dado da agenda pessoal é acessado.

Medição local em 19/10/2026, Node.js v24.19.0:

| Operação | Mediana | P95 |
| --- | ---: | ---: |
| Filtro de mês com `substr(date,1,7)` | 0,664 ms | 1,146 ms |
| Consulta por intervalo com índice | 0,167 ms | 0,268 ms |
| Consulta de produção de 43 dias e expansão das recorrências | 1,578 ms | 2,344 ms |

Os números medem consulta e transformação de dados, sem HTTP, autenticação, escrita em disco ou renderização. Não representam latência completa do aplicativo. Variam conforme máquina, carga e quantidade de dados.

## Mudanças feitas

- Índices em `(user_id, deleted_at, date)` para compromissos, `(user_id, deleted_at)` para tarefas e `(user_id, id DESC)` para histórico.
- Consulta por intervalo de datas, com limite de 62 dias; a interface pede o mês mais as bordas necessárias para a visão semanal.
- Recorrências calculadas apenas para o período consultado, sem criar centenas de cópias no banco.
- Histórico paginado em blocos de 30 registros.
- Digitar anotações não reconstrói o calendário: só o estado do botão, o contador e o marcador do dia são atualizados.
- Respostas de compromissos expõem `Server-Timing`, disponível nas ferramentas de desenvolvimento do navegador.

## Próximas medições

Para uma publicação, medir também latência HTTP, tempo de renderização, concorrência de escrita e tamanho real do banco. SQLite atende este projeto em uma instância; múltiplas réplicas exigiriam outra estratégia de armazenamento.
