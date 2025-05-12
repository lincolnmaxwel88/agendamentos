# Alterações Locais no Sistema de Agendamento

Este arquivo documenta todas as alterações feitas localmente no sistema, para facilitar a aplicação dessas mudanças quando o código for atualizado pelo Replit.

## Alterações de Configuração

1. **Configuração do PostgreSQL Local**
   - Arquivo: `server/db.ts`
   - Alteração: Substituição do Neon Database pelo PostgreSQL local
   - Detalhes: Modificada a importação de `drizzle-orm/neon-serverless` para `drizzle-orm/node-postgres`

2. **Configuração de Scripts para Windows**
   - Arquivo: `package.json`
   - Alteração: Adicionado `cross-env` para compatibilidade com Windows
   - Detalhes: Modificados os scripts de `dev` e `start`

3. **Configuração do Servidor**
   - Arquivo: `server/index.ts`
   - Alteração: Modificada a configuração do servidor para usar `localhost` em vez de `0.0.0.0`
   - Detalhes: Alterada a porta padrão para 3000

## Correções de Bugs

1. **Correção de Fuso Horário**
   - Arquivo: `client/src/components/booking/booking-form.tsx`
   - Alteração: Removido o ajuste manual de fuso horário que estava causando discrepâncias
   - Detalhes: Removidas as linhas que subtraíam 3 horas do horário para compensar GMT-3

## Scripts Adicionais

1. **Script para Criar Usuário de Teste**
   - Arquivo: `scripts/create-test-user.ts`
   - Função: Cria um usuário administrador para testes locais
   - Credenciais: admin / admin123

## Variáveis de Ambiente

Arquivo `.env` deve conter:
```
DATABASE_URL=postgres://postgres:linday1818@localhost:5432/agendamento
NODE_ENV=development
PORT=3000
SESSION_SECRET=meu-agendamento-secret-key-development-only
GMAIL_USER=seu-email@gmail.com
GMAIL_APP_PASSWORD=sua-senha-de-aplicativo
```
