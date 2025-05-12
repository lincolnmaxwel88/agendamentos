#!/bin/bash
# Script para criar um backup completo do banco de dados do Sistema de Agendamento
# Este script cria um arquivo SQL e também um arquivo comprimido (.gz)

# Cores para melhor visualização
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${YELLOW}=====================================================${NC}"
echo -e "${GREEN}Backup do Banco de Dados - Sistema de Agendamento${NC}"
echo -e "${YELLOW}=====================================================${NC}"
echo

# Obter data e hora atual para nome do arquivo
DATA_HORA=$(date +"%Y%m%d_%H%M%S")
DIRETORIO_BACKUP="./backups"
NOME_ARQUIVO="agendamento_backup_${DATA_HORA}"

# Verificar se PostgreSQL está instalado
if ! command -v psql &> /dev/null; then
    echo -e "${RED}PostgreSQL não encontrado! Por favor, instale-o antes de prosseguir.${NC}"
    exit 1
fi

# Carregar variáveis de ambiente do arquivo .env, se existir
if [ -f ".env" ]; then
    echo -e "${BLUE}Carregando configurações do arquivo .env...${NC}"
    export $(grep -v '^#' .env | xargs)
fi

# Solicitar configurações do banco de dados
if [ -z "$DATABASE_URL" ]; then
    echo -e "${YELLOW}Nenhuma URL de banco de dados encontrada no arquivo .env.${NC}"
    echo -e "${YELLOW}Por favor, informe os detalhes de conexão:${NC}"
    
    read -p "Host [localhost]: " DB_HOST
    DB_HOST=${DB_HOST:-localhost}
    
    read -p "Porta [5432]: " DB_PORT
    DB_PORT=${DB_PORT:-5432}
    
    read -p "Nome do Banco de Dados [agendadb]: " DB_NAME
    DB_NAME=${DB_NAME:-agendadb}
    
    read -p "Usuário [postgres]: " DB_USER
    DB_USER=${DB_USER:-postgres}
    
    read -s -p "Senha: " DB_PASSWORD
    echo
else
    # Extrair informações da URL de conexão
    # Exemplo: postgres://usuario:senha@host:porta/banco
    echo -e "${BLUE}Extraindo informações da variável DATABASE_URL...${NC}"
    
    # Extrair informações com regex
    DB_USER=$(echo $DATABASE_URL | sed -n 's/.*:\/\/\([^:]*\):.*/\1/p')
    DB_PASSWORD=$(echo $DATABASE_URL | sed -n 's/.*:\/\/[^:]*:\([^@]*\).*/\1/p')
    DB_HOST=$(echo $DATABASE_URL | sed -n 's/.*@\([^:]*\):.*/\1/p')
    DB_PORT=$(echo $DATABASE_URL | sed -n 's/.*@[^:]*:\([^\/]*\).*/\1/p')
    DB_NAME=$(echo $DATABASE_URL | sed -n 's/.*\/\(.*\)$/\1/p')
    
    echo -e "${BLUE}Banco: $DB_NAME em $DB_HOST:$DB_PORT${NC}"
fi

# Criar diretório para backups, se não existir
mkdir -p "$DIRETORIO_BACKUP"

# Nome completo dos arquivos
ARQUIVO_SQL="${DIRETORIO_BACKUP}/${NOME_ARQUIVO}.sql"
ARQUIVO_COMPRIMIDO="${DIRETORIO_BACKUP}/${NOME_ARQUIVO}.sql.gz"

echo
echo -e "${YELLOW}Iniciando backup do banco '$DB_NAME'...${NC}"

# Executar o backup usando pg_dump
PGPASSWORD=$DB_PASSWORD pg_dump -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -F p > "$ARQUIVO_SQL"

# Verificar se o backup foi concluído com sucesso
if [ $? -eq 0 ]; then
    echo -e "${GREEN}Backup salvo em: ${ARQUIVO_SQL}${NC}"
    
    # Comprimir o arquivo SQL
    echo -e "${YELLOW}Comprimindo o arquivo de backup...${NC}"
    gzip -c "$ARQUIVO_SQL" > "$ARQUIVO_COMPRIMIDO"
    
    # Calcular tamanho dos arquivos
    TAMANHO_SQL=$(du -h "$ARQUIVO_SQL" | cut -f1)
    TAMANHO_GZ=$(du -h "$ARQUIVO_COMPRIMIDO" | cut -f1)
    
    echo -e "${GREEN}Backup SQL: ${TAMANHO_SQL}${NC}"
    echo -e "${GREEN}Backup comprimido: ${TAMANHO_GZ}${NC}"
    echo
    echo -e "${GREEN}✅ Backup concluído com sucesso!${NC}"
    echo
    
    # Instruções para restauração
    echo -e "${BLUE}Para restaurar este backup, use um dos comandos:${NC}"
    echo -e "${YELLOW}• Arquivo SQL:${NC}"
    echo "  psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME < $ARQUIVO_SQL"
    echo
    echo -e "${YELLOW}• Arquivo comprimido:${NC}"
    echo "  gunzip -c $ARQUIVO_COMPRIMIDO | psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME"
else
    echo -e "${RED}❌ Falha ao criar o backup!${NC}"
    echo -e "${RED}Verifique as credenciais e tente novamente.${NC}"
    
    # Remover arquivo incompleto se existir
    if [ -f "$ARQUIVO_SQL" ]; then
        rm "$ARQUIVO_SQL"
    fi
fi