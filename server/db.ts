// Importação do PostgreSQL local
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '@shared/schema';
import * as dotenv from 'dotenv';

// Carrega as variáveis de ambiente do arquivo .env
dotenv.config();

// Verifica se a URL do banco de dados está definida
if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL deve ser definida no arquivo .env. Você esqueceu de provisionar um banco de dados?"
  );
}

// Cria o pool de conexão com o PostgreSQL local
export const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Exporta a instância do Drizzle ORM
export const db = drizzle(pool, { schema });

// Função de limpeza para encerrar o pool quando o servidor for desligado
export async function closeDb() {
  await pool.end();
}