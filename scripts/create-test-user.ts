/**
 * Script para criar um usuário de teste no banco de dados local
 * 
 * Uso:
 * $ npx tsx scripts/create-test-user.ts
 */

import { Pool } from 'pg';
import * as dotenv from 'dotenv';
import * as bcrypt from 'bcrypt';

// Carregar variáveis de ambiente
dotenv.config();

// Verificar se a URL do banco de dados está definida
if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL deve ser definida no arquivo .env");
}

// Criar pool de conexão com o PostgreSQL local
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Função para criar hash da senha
async function hashPassword(password: string): Promise<string> {
  const saltRounds = 10;
  return bcrypt.hash(password, saltRounds);
}

// Função principal para criar usuário de teste
async function createTestUser() {
  console.log('Criando usuário de teste...');
  
  try {
    // Verificar se o usuário admin já existe
    const checkResult = await pool.query(`SELECT * FROM users WHERE username = 'admin'`);
    
    if (checkResult.rows.length > 0) {
      console.log('Usuário admin já existe. Pulando criação.');
      return;
    }
    
    // Criar hash da senha
    const hashedPassword = await hashPassword('admin123');
    
    // Inserir usuário admin
    const userResult = await pool.query(`
      INSERT INTO users (
        name, username, email, password, role, 
        is_active, is_email_verified, never_expires, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
      ) RETURNING *
    `, [
      'Administrador',
      'admin',
      'admin@example.com',
      hashedPassword,
      'admin',
      true,
      true,
      true,
      new Date(),
      new Date()
    ]);
    
    const user = userResult.rows[0];
    console.log(`Usuário admin criado com ID: ${user.id}`);
    
    // Criar provedor para o usuário admin
    const providerResult = await pool.query(`
      INSERT INTO providers (
        user_id, name, email, phone, working_hours_start, 
        working_hours_end, working_days, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9
      ) RETURNING *
    `, [
      user.id,
      'Administrador',
      'admin@example.com',
      '11999999999',
      8, // 8h da manhã
      18, // 18h da tarde
      '1,2,3,4,5', // Segunda a sexta
      new Date(),
      new Date()
    ]);
    
    const provider = providerResult.rows[0];
    console.log(`Provedor criado com ID: ${provider.id}`);
    
    // Criar um serviço de exemplo
    const serviceResult = await pool.query(`
      INSERT INTO services (
        provider_id, name, description, duration, price, active
      ) VALUES (
        $1, $2, $3, $4, $5, $6
      ) RETURNING *
    `, [
      provider.id,
      'Consulta Padrão',
      'Consulta padrão de 1 hora',
      60, // 60 minutos
      10000, // R$ 100,00 (em centavos)
      true
    ]);
    
    console.log(`Serviço criado com ID: ${serviceResult.rows[0].id}`);
    
    console.log('\n✅ Usuário de teste criado com sucesso!');
    console.log('\nCredenciais de acesso:');
    console.log('- Usuário: admin');
    console.log('- Senha: admin123');
    
  } catch (error) {
    console.error('Erro ao criar usuário de teste:', error);
  } finally {
    // Fechar conexão
    await pool.end();
  }
}

// Executar a função
createTestUser();
