#!/bin/bash
# Script para configurar um banco de dados PostgreSQL local para o sistema de agendamento

# Cores para melhor visualização
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${YELLOW}=====================================================${NC}"
echo -e "${GREEN}Configuração de Banco de Dados Local - Sistema de Agendamento${NC}"
echo -e "${YELLOW}=====================================================${NC}"
echo

# Verificar se PostgreSQL está instalado
if ! command -v psql &> /dev/null; then
    echo -e "${RED}PostgreSQL não encontrado! Por favor, instale-o antes de prosseguir.${NC}"
    echo "No Ubuntu/Debian: sudo apt install postgresql postgresql-contrib"
    echo "No macOS (com Homebrew): brew install postgresql"
    echo "No Windows: Baixe o instalador em https://www.postgresql.org/download/windows/"
    exit 1
fi

echo -e "${BLUE}PostgreSQL detectado. Continuando com a configuração...${NC}"
echo

# Solicitar configurações do banco local
read -p "Nome do Banco de Dados [agendadb]: " DB_NAME
DB_NAME=${DB_NAME:-agendadb}

read -p "Usuário PostgreSQL [postgres]: " DB_USER
DB_USER=${DB_USER:-postgres}

read -p "Senha PostgreSQL: " DB_PASSWORD

read -p "Host [localhost]: " DB_HOST
DB_HOST=${DB_HOST:-localhost}

read -p "Porta [5432]: " DB_PORT
DB_PORT=${DB_PORT:-5432}

# Criar arquivo .env temporário com as configurações
echo "LOCAL_DB_HOST=$DB_HOST" > .env.local
echo "LOCAL_DB_PORT=$DB_PORT" >> .env.local
echo "LOCAL_DB_NAME=$DB_NAME" >> .env.local
echo "LOCAL_DB_USER=$DB_USER" >> .env.local
echo "LOCAL_DB_PASSWORD=$DB_PASSWORD" >> .env.local

echo -e "${YELLOW}Verificando se o banco de dados '$DB_NAME' existe...${NC}"

# Verificar se o banco de dados já existe
if PGPASSWORD=$DB_PASSWORD psql -h $DB_HOST -p $DB_PORT -U $DB_USER -lqt | grep -q $DB_NAME; then
    echo -e "${GREEN}O banco de dados '$DB_NAME' já existe.${NC}"
else
    echo -e "${YELLOW}Criando banco de dados '$DB_NAME'...${NC}"
    if PGPASSWORD=$DB_PASSWORD createdb -h $DB_HOST -p $DB_PORT -U $DB_USER $DB_NAME; then
        echo -e "${GREEN}Banco de dados '$DB_NAME' criado com sucesso!${NC}"
    else
        echo -e "${RED}Erro ao criar o banco de dados. Tentando com comandos SQL diretos...${NC}"
        if PGPASSWORD=$DB_PASSWORD psql -h $DB_HOST -p $DB_PORT -U $DB_USER -c "CREATE DATABASE $DB_NAME;"; then
            echo -e "${GREEN}Banco de dados '$DB_NAME' criado com sucesso!${NC}"
        else
            echo -e "${RED}Falha ao criar o banco de dados. Por favor, crie manualmente antes de continuar.${NC}"
            echo "Command: createdb -h $DB_HOST -p $DB_PORT -U $DB_USER $DB_NAME"
            exit 1
        fi
    fi
fi

echo
echo -e "${YELLOW}Executando script de migração de dados...${NC}"
echo

# Usar o Node.js para executar o script de migração
if [ -f "scripts/migrate-to-local-db.js" ]; then
    node scripts/migrate-to-local-db.js
else
    echo -e "${YELLOW}Script JavaScript não encontrado. Usando TypeScript diretamente...${NC}"
    
    # Verificar se tsx (executor de TypeScript) está instalado
    if ! command -v npx &> /dev/null; then
        echo -e "${RED}npx não encontrado. Por favor, instale o Node.js antes de prosseguir.${NC}"
        exit 1
    fi
    
    # Executar o script TypeScript
    npx tsx scripts/migrate-to-local-db.ts
fi

# Limpeza
rm -f .env.local

# Exibir string de conexão para usar no .env
echo
echo -e "${GREEN}===== CONFIGURAÇÃO CONCLUÍDA! =====${NC}"
echo
echo -e "${BLUE}Para usar o banco local, adicione esta linha ao seu arquivo .env:${NC}"
echo -e "${YELLOW}DATABASE_URL=postgres://$DB_USER:$DB_PASSWORD@$DB_HOST:$DB_PORT/$DB_NAME${NC}"
echo
echo -e "${GREEN}Credenciais de acesso:${NC}"
echo -e "- ${BLUE}Usuário Admin:${NC} admin / password123"
echo -e "- ${BLUE}Usuário Link:${NC} link / password123"
echo

# Informações adicionais
echo -e "${BLUE}Para gerenciar seu banco de dados, você pode usar:${NC}"
echo -e "- pgAdmin 4: Interface gráfica para PostgreSQL - https://www.pgadmin.org/download/"
echo -e "- DBeaver: Cliente SQL universal - https://dbeaver.io/download/"
echo -e "- Ou diretamente via terminal com o comando psql"
echo
echo -e "${GREEN}Obrigado por utilizar o Sistema de Agendamento!${NC}"