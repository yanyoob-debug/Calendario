# Publicação

A interface atual foi simplificada para uso pessoal local, sem login. As configurações de produção abaixo mantêm autenticação obrigatória na API; publicar essa interface exige antes definir um fluxo de acesso apropriado. A execução local com `npm start` abre a agenda diretamente.

O projeto usa Node.js 24 e SQLite em disco. A publicação precisa de um serviço com **processo Node/Docker e volume persistente**. Uma hospedagem de HTML estático não executa a API.

O repositório contém um Dockerfile, sem dados pessoais ou senhas dentro da imagem. O Dockerfile foi preparado, mas não foi executado neste ambiente porque Docker não está instalado.

## Configuração

1. Disponibilize o código em seu repositório de origem.
2. Crie um serviço Docker no provedor escolhido.
3. Monte um volume persistente em `/app/data` e mantenha uma única instância do aplicativo.
4. Defina `PUBLIC_ORIGIN` como a origem HTTPS pública, sem caminho ou barra final, por exemplo `https://agenda.exemplo.com`.
5. Defina um `SETUP_TOKEN` longo, aleatório e privado. Na primeira criação de conta online, o proprietário informa esse código. Depois da primeira conta, o código não é necessário para novos cadastros.
6. Defina as outras variáveis do arquivo `.env.example` no painel do provedor. A aplicação não carrega `.env` automaticamente.
7. Publique e teste criação de conta, login, logout, persistência após reinício e isolamento entre duas contas.

O Dockerfile já define `NODE_ENV=production`, `HOST=0.0.0.0`, `PORT=3000` e `DB_PATH=/app/data/agenda.sqlite`. O provedor pode substituir `PORT`. Em produção, o cookie da sessão usa `Secure`, portanto o acesso precisa de HTTPS.

Para construir e executar onde Docker estiver instalado:

```sh
docker build -t florir .
docker run --env-file .env -p 3000:3000 -v florir-data:/app/data florir
```

Esse comando usa configuração de produção: para acessar o contêiner, use um proxy HTTPS com a origem configurada. Para desenvolvimento HTTP local, use `npm start` diretamente.

## Dados

- Não publique sua pasta `data`, os backups ou arquivos `.env` no Git nem na imagem.
- O primeiro usuário pessoal recebe os dados legados sem proprietário. Para um serviço público novo, use um banco vazio e crie a conta do proprietário antes de compartilhar o endereço.
- Antes de migrar um banco antigo, o aplicativo cria uma cópia `agenda.sqlite.before-v2-<timestamp>.bak`.
- Para backup periódico completo, pare o serviço e copie a pasta de dados para armazenamento privado. A exportação ICS contém apenas compromissos, não tarefas, anotações, usuários ou histórico.
- Contas de demonstração são isoladas. Seus registros com mais de 24 horas são removidos quando uma nova demonstração é criada.

## Limites desta entrega

O serviço online ainda depende da escolha e conexão de um provedor. Não há URL pública publicada. O workflow de CI só executará após o envio a um repositório no GitHub.

Não foram implementados recuperação de senha por e-mail, verificação de e-mail ou alta disponibilidade. O limite de tentativas usa o endereço da conexão; revise a configuração de proxy e a política de cadastro antes de operar um serviço público com volume elevado.
