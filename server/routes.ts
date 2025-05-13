import type { Express, Request, Response, NextFunction } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { db } from "./db";
import multer from "multer";
import { 
  insertServiceSchema, 
  insertClientSchema, 
  insertAppointmentSchema, 
  bookingFormSchema,
  AppointmentStatus,
  services,
  clients,
  providerClients,
  appointments,
  notifications,
  timeExclusions,
  InsertProvider,
  insertProviderSchema,
  InsertTimeExclusion
} from "@shared/schema";
import { and, eq, gt, gte, lte, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { setupAuth, hashPassword, comparePasswords } from "./auth";
import { WebSocketServer, WebSocket } from "ws";
import { verifyToken, generateVerificationToken, sendVerificationEmail, sendWelcomeEmail, isEmailServiceConfigured } from "./email-service";

export async function registerRoutes(app: Express): Promise<Server> {
  // Configurar autenticação
  setupAuth(app);
  
  const httpServer = createServer(app);
  
  // Configuração do WebSocket para atualizações em tempo real
  const wss = new WebSocketServer({ 
    server: httpServer, 
    path: '/ws',
    clientTracking: true,
    // Aumenta o timeout para conexões WebSocket
    perMessageDeflate: {
      zlibDeflateOptions: {
        chunkSize: 1024,
        memLevel: 7,
        level: 3
      },
      zlibInflateOptions: {
        chunkSize: 10 * 1024
      },
      // Outros parâmetros opcionais
      concurrencyLimit: 10, // Limita processamento concorrente
      threshold: 1024 // Mensagens menores que isso não são comprimidas
    }
  });
  
  // Armazenar conexões ativas
  const connectedClients = new Map<WebSocket, { userId?: number, isAlive?: boolean }>();
  
  // Função de heartbeat para verificar conexões ativas
  function heartbeat(this: WebSocket) {
    const client = connectedClients.get(this);
    if (client) {
      client.isAlive = true;
      connectedClients.set(this, client);
    }
  }
  
  // Verificar periodicamente se os clientes estão ativos
  const pingInterval = setInterval(() => {
    let activeCount = 0;
    let terminatedCount = 0;
    
    wss.clients.forEach((ws) => {
      const client = connectedClients.get(ws);
      
      if (!client || client.isAlive === false) {
        // Terminar conexões que não responderam ao ping anterior
        ws.terminate();
        connectedClients.delete(ws);
        terminatedCount++;
        return;
      }
      
      // Marcar como inativo até responder ao próximo ping
      client.isAlive = false;
      connectedClients.set(ws, client);
      
      try {
        // Enviar ping para verificar se está ativo
        ws.ping();
        activeCount++;
      } catch (e) {
        console.error('Erro ao enviar ping:', e);
        ws.terminate();
        connectedClients.delete(ws);
        terminatedCount++;
      }
    });
    
    if (activeCount > 0 || terminatedCount > 0) {
      console.log(`WebSocket heartbeat: ${activeCount} conexões ativas, ${terminatedCount} terminadas`);
    }
  }, 30000); // Verificar a cada 30 segundos
  
  // Limpar o intervalo quando o servidor for fechado
  process.on('SIGINT', () => {
    clearInterval(pingInterval);
    process.exit();
  });
  
  wss.on('connection', (ws: WebSocket) => {
    console.log('Nova conexão WebSocket estabelecida');
    
    // Inicializar como conexão ativa
    connectedClients.set(ws, { isAlive: true });
    
    // Configurar o heartbeat
    ws.on('pong', heartbeat);
    
    ws.on('message', (message: string) => {
      try {
        const data = JSON.parse(message.toString());
        
        // Se for um ping do cliente (implementação customizada), responder
        if (data.type === 'ping') {
          try {
            ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
            return;
          } catch (e) {
            console.error('Erro ao responder ping do cliente:', e);
          }
        }
        
        // Se a mensagem contém uma identificação de usuário, associamos à conexão
        if (data.type === 'identify' && data.userId) {
          console.log(`Cliente WebSocket identificado: usuário ${data.userId}`);
          const existingClient = connectedClients.get(ws) || {};
          connectedClients.set(ws, { ...existingClient, userId: data.userId, isAlive: true });
        }
      } catch (error) {
        console.error('Erro ao processar mensagem WebSocket:', error);
      }
    });
    
    ws.on('error', (error) => {
      console.error('Erro na conexão WebSocket:', error);
      // Remover cliente em caso de erro
      connectedClients.delete(ws);
      try {
        ws.terminate();
      } catch (e) {
        console.error('Erro ao terminar conexão com erro:', e);
      }
    });
    
    ws.on('close', (code, reason) => {
      // Remover cliente da lista quando a conexão é fechada
      connectedClients.delete(ws);
      console.log(`Conexão WebSocket fechada: código ${code}, razão: ${reason || 'N/A'}`);
    });
  });
  
  // Função auxiliar para enviar atualizações em tempo real
  function broadcastUpdate(type: string, data: any) {
    const message = JSON.stringify({ type, data });
    let sentCount = 0;
    let errorCount = 0;
    
    console.log(`Broadcastando atualização de tipo ${type} para ${connectedClients.size} clientes:`, 
      type === 'notification_created' ? 
        { notificationId: data.notification?.id, userId: data.userId } : 
        { data: typeof data === 'object' ? 'objeto' : data });
    
    connectedClients.forEach((client, ws) => {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          // Se for uma notificação, apenas enviar para o destinatário
          if (type === 'notification_created') {
            if (client.userId === data.userId) {
              console.log(`Enviando notificação para usuário específico ${client.userId}`);
              ws.send(message);
              sentCount++;
            }
          } else {
            // Para outros tipos, enviar para todos
            ws.send(message);
            sentCount++;
          }
        } catch (error) {
          console.error('Erro ao enviar mensagem WebSocket:', error);
          errorCount++;
          // Marcar para remoção em caso de erro
          try {
            ws.close(1011, 'Erro ao enviar mensagem');
          } catch (e) {
            // Se não conseguir fechar normalmente, tenta terminar abruptamente
            try {
              ws.terminate();
            } catch (e2) {
              console.error('Erro ao terminar conexão problemática:', e2);
            }
          }
          connectedClients.delete(ws);
        }
      }
    });
    
    console.log(`Broadcast realizado: ${type} - Enviado para ${sentCount} clientes, ${errorCount} erros`);
  }
  
  // Tornar a função broadcastUpdate disponível para outras partes do código
  (global as any).broadcastUpdate = broadcastUpdate;
  
  // Endpoint para verificação de email via POST (usado pelo frontend)
  app.post("/api/verify-email", async (req: Request, res: Response) => {
    try {
      const { email, token } = req.body;
      
      if (!email || !token) {
        return res.status(400).json({ 
          error: "Dados incompletos. Email e token são obrigatórios." 
        });
      }
      
      // Buscar o usuário pelo email
      const user = await storage.getUserByEmail(email);
      if (!user) {
        return res.status(404).json({ 
          error: "Usuário não encontrado com o email fornecido." 
        });
      }
      
      // Se o usuário já está verificado
      if (user.isEmailVerified) {
        return res.status(200).json({ 
          message: "Email já verificado anteriormente. Você pode fazer login." 
        });
      }
      
      // Verifica se o token é válido
      if (!verifyToken(user.id, token)) {
        return res.status(400).json({ 
          error: "Token inválido ou expirado. Solicite um novo link de verificação." 
        });
      }
      
      // Atualiza o usuário para marcar o email como verificado
      await storage.updateUser(user.id, {
        isEmailVerified: true,
        verificationToken: null,
        verificationTokenExpiry: null
      });
      
      // Envia um email de boas-vindas
      try {
        await sendWelcomeEmail(user);
      } catch (emailError) {
        console.error("Erro ao enviar email de boas-vindas:", emailError);
        // Não interrompemos o fluxo se falhar o envio do email de boas-vindas
      }
      
      return res.status(200).json({ 
        success: true, 
        message: "Email verificado com sucesso!" 
      });
    } catch (error) {
      console.error("Erro na verificação de email:", error);
      return res.status(500).json({ 
        error: "Erro ao processar a verificação de email. Tente novamente mais tarde." 
      });
    }
  });
  
  // Nova rota para verificação direta via GET (usado pelos links no email)
  app.get("/api/verify-email-direct/:token", async (req: Request, res: Response) => {
    try {
      const { token } = req.params;
      const email = req.query.email as string;
      
      if (!email || !token) {
        return res.status(400).send(`
          <html>
            <head>
              <title>Erro na Verificação</title>
              <style>
                body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
                .error { color: #e53e3e; margin-bottom: 20px; }
                .btn { background-color: #4F46E5; color: white; padding: 10px 20px; 
                      text-decoration: none; border-radius: 5px; display: inline-block; }
              </style>
            </head>
            <body>
              <h1 class="error">Erro na Verificação</h1>
              <p>Email ou token não fornecidos.</p>
              <a href="/auth" class="btn">Voltar para Login</a>
            </body>
          </html>
        `);
      }
      
      // Buscar o usuário pelo email
      const user = await storage.getUserByEmail(email);
      if (!user) {
        return res.status(404).send(`
          <html>
            <head>
              <title>Erro na Verificação</title>
              <style>
                body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
                .error { color: #e53e3e; margin-bottom: 20px; }
                .btn { background-color: #4F46E5; color: white; padding: 10px 20px; 
                      text-decoration: none; border-radius: 5px; display: inline-block; }
              </style>
            </head>
            <body>
              <h1 class="error">Erro na Verificação</h1>
              <p>Usuário não encontrado com o email fornecido.</p>
              <a href="/auth" class="btn">Voltar para Login</a>
            </body>
          </html>
        `);
      }
      
      // Se o usuário já está verificado
      if (user.isEmailVerified) {
        return res.status(200).send(`
          <html>
            <head>
              <title>Email Já Verificado</title>
              <style>
                body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
                .success { color: #48bb78; margin-bottom: 20px; }
                .btn { background-color: #4F46E5; color: white; padding: 10px 20px; 
                      text-decoration: none; border-radius: 5px; display: inline-block; }
              </style>
            </head>
            <body>
              <h1 class="success">Email Já Verificado</h1>
              <p>Seu email já foi verificado anteriormente. Você pode fazer login na sua conta.</p>
              <a href="/auth" class="btn">Ir para Login</a>
            </body>
          </html>
        `);
      }
      
      // Verifica se o token é válido
      if (user.verificationToken !== token) {
        return res.status(400).send(`
          <html>
            <head>
              <title>Erro na Verificação</title>
              <style>
                body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
                .error { color: #e53e3e; margin-bottom: 20px; }
                .btn { background-color: #4F46E5; color: white; padding: 10px 20px; 
                      text-decoration: none; border-radius: 5px; display: inline-block; }
              </style>
            </head>
            <body>
              <h1 class="error">Erro na Verificação</h1>
              <p>Token de verificação inválido.</p>
              <a href="/auth" class="btn">Voltar para Login</a>
            </body>
          </html>
        `);
      }
      
      // Verifica se o token expirou
      if (user.verificationTokenExpiry && new Date() > new Date(user.verificationTokenExpiry)) {
        return res.status(400).send(`
          <html>
            <head>
              <title>Erro na Verificação</title>
              <style>
                body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
                .error { color: #e53e3e; margin-bottom: 20px; }
                .btn { background-color: #4F46E5; color: white; padding: 10px 20px; 
                      text-decoration: none; border-radius: 5px; display: inline-block; }
                .resend { margin-top: 15px; }
              </style>
            </head>
            <body>
              <h1 class="error">Erro na Verificação</h1>
              <p>Token de verificação expirado.</p>
              <a href="/auth" class="btn">Voltar para Login</a>
              <p class="resend">
                <a href="/auth?resend=${encodeURIComponent(email)}">Solicitar novo email de verificação</a>
              </p>
            </body>
          </html>
        `);
      }
      
      // Verificação de expiração já foi feita acima
      
      // Atualiza o usuário para marcar o email como verificado
      const updatedUser = await storage.updateUser(user.id, {
        isEmailVerified: true,
        verificationToken: null,
        verificationTokenExpiry: null
      });
      
      if (!updatedUser) {
        return res.status(500).send(`
          <html>
            <head>
              <title>Erro na Verificação</title>
              <style>
                body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
                .error { color: #e53e3e; margin-bottom: 20px; }
                .btn { background-color: #4F46E5; color: white; padding: 10px 20px; 
                      text-decoration: none; border-radius: 5px; display: inline-block; }
              </style>
            </head>
            <body>
              <h1 class="error">Erro na Verificação</h1>
              <p>Falha ao atualizar usuário. Tente novamente.</p>
              <a href="/auth" class="btn">Voltar para Login</a>
            </body>
          </html>
        `);
      }
      
      // Envia um email de boas-vindas
      try {
        await sendWelcomeEmail(user);
      } catch (emailError) {
        console.error("Erro ao enviar email de boas-vindas:", emailError);
        // Não interrompemos o fluxo se falhar o envio do email de boas-vindas
      }
      
      // Responder com HTML de sucesso
      res.status(200).send(`
        <html>
          <head>
            <title>Email Verificado com Sucesso</title>
            <style>
              body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
              .success { color: #48bb78; margin-bottom: 20px; }
              .btn { background-color: #4F46E5; color: white; padding: 10px 20px; 
                    text-decoration: none; border-radius: 5px; display: inline-block; }
            </style>
          </head>
          <body>
            <h1 class="success">Email Verificado com Sucesso!</h1>
            <p>Seu email foi verificado com sucesso. Agora você pode fazer login na sua conta.</p>
            <a href="/auth" class="btn">Ir para Login</a>
          </body>
        </html>
      `);
    } catch (error) {
      console.error("Erro na verificação de email:", error);
      res.status(500).send(`
        <html>
          <head>
            <title>Erro na Verificação</title>
            <style>
              body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
              .error { color: #e53e3e; margin-bottom: 20px; }
              .btn { background-color: #4F46E5; color: white; padding: 10px 20px; 
                    text-decoration: none; border-radius: 5px; display: inline-block; }
            </style>
          </head>
          <body>
            <h1 class="error">Erro na Verificação</h1>
            <p>Ocorreu um erro durante a verificação do seu email. Tente novamente.</p>
            <a href="/auth" class="btn">Voltar para Login</a>
          </body>
        </html>
      `);
    }
  });
  
  // Configuração do multer para upload de arquivos
  const avatarStorage = multer.memoryStorage();
  const avatarUpload = multer({
    storage: avatarStorage,
    limits: {
      fileSize: 5 * 1024 * 1024, // limite de 5MB
    },
    fileFilter: (req, file, cb) => {
      // Aceitar apenas arquivos de imagem
      if (!file.mimetype.startsWith('image/')) {
        return cb(new Error('Apenas imagens são permitidas'));
      }
      cb(null, true);
    }
  });

  // Rota para upload de avatar
  app.post("/api/user/upload-avatar", avatarUpload.single('avatar'), async (req: Request, res: Response) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ error: "Não autenticado" });
    }
    
    try {
      const userId = req.user.id;
      
      // Verificar se o arquivo foi enviado
      if (!req.file) {
        return res.status(400).json({ error: "Dados da imagem não fornecidos" });
      }
      
      // Converter a imagem para base64
      const imageBuffer = req.file.buffer;
      const contentType = req.file.mimetype;
      const imageData = `data:${contentType};base64,${imageBuffer.toString('base64')}`;
      
      // Atualizar o usuário com a URL da imagem
      const updatedUser = await storage.updateUser(userId, { avatarUrl: imageData });
      if (!updatedUser) {
        return res.status(500).json({ error: "Falha ao atualizar avatar" });
      }
      
      // Atualizar a sessão com os novos dados do usuário via login
      const { password: _, ...userWithoutPassword } = updatedUser;
      
      req.login(updatedUser, (err) => {
        if (err) {
          console.error("Erro ao atualizar sessão:", err);
        }
        
        res.status(200).json({ 
          success: true, 
          avatarUrl: imageData,
          user: userWithoutPassword
        });
      });
    } catch (error) {
      console.error("Erro ao fazer upload do avatar:", error);
      res.status(500).json({ error: "Erro ao processar o upload da imagem" });
    }
  });
  
  // Rota para remover avatar
  app.delete("/api/user/avatar", async (req: Request, res: Response) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ error: "Não autenticado" });
    }
    
    try {
      const userId = req.user.id;
      
      // Atualizar o usuário para remover o avatar
      const updatedUser = await storage.updateUser(userId, { avatarUrl: null });
      if (!updatedUser) {
        return res.status(500).json({ error: "Falha ao remover avatar" });
      }
      
      // Atualizar a sessão com os novos dados do usuário via login
      const { password: _, ...userWithoutPassword } = updatedUser;
      
      req.login(updatedUser, (err) => {
        if (err) {
          console.error("Erro ao atualizar sessão:", err);
        }
        
        res.status(200).json({ 
          success: true, 
          user: userWithoutPassword
        });
      });
    } catch (error) {
      console.error("Erro ao remover avatar:", error);
      res.status(500).json({ error: "Erro ao remover a imagem de perfil" });
    }
  });
  
  // Rota para atualizar perfil do usuário
  app.patch("/api/user/profile", async (req: Request, res: Response) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ error: "Não autenticado" });
    }
    
    try {
      const userId = req.user.id;
      const { name, email } = req.body;
      
      // Validar dados
      if (!name || !email) {
        return res.status(400).json({ error: "Nome e email são obrigatórios" });
      }
      
      // Verificar se o email já está em uso por outro usuário
      if (email !== req.user.email) {
        const existingUser = await storage.getUserByEmail(email);
        if (existingUser && existingUser.id !== userId) {
          return res.status(400).json({ error: "Este email já está em uso" });
        }
      }
      
      // Atualizar o usuário
      const updatedUser = await storage.updateUser(userId, { name, email });
      if (!updatedUser) {
        return res.status(500).json({ error: "Falha ao atualizar perfil" });
      }
      
      // Atualizar a sessão com os novos dados do usuário via login
      const { password: _, ...userWithoutPassword } = updatedUser;
      
      req.login(updatedUser, (err) => {
        if (err) {
          console.error("Erro ao atualizar sessão:", err);
          return res.status(500).json({ error: "Erro ao atualizar sessão" });
        }
        
        res.status(200).json({ 
          success: true, 
          user: userWithoutPassword
        });
      });
    } catch (error) {
      console.error("Erro ao atualizar perfil:", error);
      res.status(500).json({ error: "Erro ao atualizar perfil" });
    }
  });
  
  // Configuração do multer para upload de arquivos
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: 5 * 1024 * 1024, // 5MB
    },
    fileFilter: (req, file, cb) => {
      // Aceitar apenas imagens
      if (file.mimetype.startsWith('image/')) {
        cb(null, true);
      } else {
        cb(null, false);
      }
    },
  });

  // Rota para upload de avatar
  app.post("/api/user/upload-avatar", upload.single('avatar'), async (req: Request, res: Response) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ error: "Não autenticado" });
    }
    
    try {
      if (!req.file) {
        return res.status(400).json({ error: "Nenhum arquivo enviado ou formato inválido" });
      }
      
      const userId = req.user.id;
      
      // Converter o buffer para base64
      const avatarBase64 = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
      
      // Atualizar o usuário com o avatar
      const updatedUser = await storage.updateUser(userId, { avatarUrl: avatarBase64 });
      if (!updatedUser) {
        return res.status(500).json({ error: "Falha ao atualizar avatar" });
      }
      
      // Atualizar a sessão com os novos dados do usuário
      const { password: _, ...userWithoutPassword } = updatedUser;
      
      req.login(updatedUser, (err) => {
        if (err) {
          console.error("Erro ao atualizar sessão:", err);
          return res.status(500).json({ error: "Erro ao atualizar sessão" });
        }
        
        res.status(200).json({ 
          success: true, 
          user: userWithoutPassword
        });
      });
    } catch (error) {
      console.error("Erro ao fazer upload do avatar:", error);
      res.status(500).json({ error: "Erro ao fazer upload do avatar" });
    }
  });
  
  // Rota para remover avatar
  app.delete("/api/user/avatar", async (req: Request, res: Response) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ error: "Não autenticado" });
    }
    
    try {
      const userId = req.user.id;
      
      // Atualizar o usuário removendo o avatar
      const updatedUser = await storage.updateUser(userId, { avatarUrl: null });
      if (!updatedUser) {
        return res.status(500).json({ error: "Falha ao remover avatar" });
      }
      
      // Atualizar a sessão com os novos dados do usuário
      const { password: _, ...userWithoutPassword } = updatedUser;
      
      req.login(updatedUser, (err) => {
        if (err) {
          console.error("Erro ao atualizar sessão:", err);
          return res.status(500).json({ error: "Erro ao atualizar sessão" });
        }
        
        res.status(200).json({ 
          success: true, 
          user: userWithoutPassword
        });
      });
    } catch (error) {
      console.error("Erro ao remover avatar:", error);
      res.status(500).json({ error: "Erro ao remover avatar" });
    }
  });

  // Rota para atualizar senha do usuário
  app.patch("/api/user/password", async (req: Request, res: Response) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ error: "Não autenticado" });
    }
    
    try {
      const userId = req.user.id;
      const { currentPassword, newPassword } = req.body;
      
      // Validar dados
      if (!currentPassword || !newPassword) {
        return res.status(400).json({ error: "Senha atual e nova senha são obrigatórias" });
      }
      
      // Obter o usuário pelo ID
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ error: "Usuário não encontrado" });
      }
      
      // Verificar se a senha atual está correta usando o método comparePasswords do auth.ts
      const isPasswordValid = await comparePasswords(currentPassword, user.password);
      if (!isPasswordValid) {
        return res.status(400).json({ error: "Senha atual incorreta" });
      }
      
      // Hash da nova senha
      const hashedPassword = await hashPassword(newPassword);
      
      // Atualizar a senha do usuário
      const updatedUser = await storage.updateUser(userId, { password: hashedPassword });
      if (!updatedUser) {
        return res.status(500).json({ error: "Falha ao atualizar senha" });
      }
      
      res.status(200).json({ 
        success: true, 
        message: "Senha atualizada com sucesso"
      });
    } catch (error) {
      console.error("Erro ao atualizar senha:", error);
      res.status(500).json({ error: "Erro ao atualizar senha" });
    }
  });

  // Endpoint para reenviar email de verificação
  app.post("/api/resend-verification", async (req: Request, res: Response) => {
    try {
      const { email } = req.body;
      
      if (!email) {
        return res.status(400).json({ 
          error: "Email é obrigatório" 
        });
      }
      
      // Verifica se o serviço de email está configurado
      if (!isEmailServiceConfigured()) {
        return res.status(503).json({
          error: "Serviço de email não configurado. Entre em contato com o administrador."
        });
      }
      
      // Buscar o usuário pelo email
      const user = await storage.getUserByEmail(email);
      if (!user) {
        // Não revelamos se o email existe ou não por segurança
        return res.status(200).json({ 
          message: "Se o email estiver registrado, um link de verificação será enviado." 
        });
      }
      
      // Se o usuário já está verificado
      if (user.isEmailVerified) {
        return res.status(200).json({ 
          message: "Este email já foi verificado. Você pode fazer login." 
        });
      }
      
      // Gera um novo token
      const token = generateVerificationToken(user.id);
      
      // Atualiza o usuário com o novo token
      const expiryDate = new Date();
      expiryDate.setHours(expiryDate.getHours() + 24); // Expira em 24 horas
      
      await storage.updateUser(user.id, {
        verificationToken: token,
        verificationTokenExpiry: expiryDate
      });
      
      // Envia o email de verificação
      const emailSent = await sendVerificationEmail(user, token);
      
      if (!emailSent) {
        return res.status(500).json({
          error: "Falha ao enviar o email de verificação. Tente novamente mais tarde."
        });
      }
      
      return res.status(200).json({
        success: true,
        message: "Um novo link de verificação foi enviado para seu email."
      });
    } catch (error) {
      console.error("Erro ao reenviar verificação:", error);
      return res.status(500).json({
        error: "Erro ao processar a solicitação. Tente novamente mais tarde."
      });
    }
  });
  
  // Middleware para verificar se o usuário é administrador
  const isAdmin = (req: Request, res: Response, next: NextFunction) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ error: "Não autenticado" });
    }
    
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: "Acesso não autorizado. Apenas administradores podem acessar esta rota." });
    }
    
    next();
  };
  
  // Middleware para verificar autenticação e carregar o provider do usuário na requisição
  const loadUserProvider = async (req: Request, res: Response, next: NextFunction) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ error: "Não autenticado" });
    }
    
    try {
      // Busca o provider associado ao usuário atual
      const provider = await storage.getProviderByUserId(req.user.id);
      
      if (!provider) {
        // Usuário logado não tem provider associado
        return res.status(404).json({ 
          error: "Perfil de prestador não encontrado", 
          message: "Você não tem um perfil de prestador de serviços configurado."
        });
      }
      
      // Adiciona o provider à requisição para uso nas rotas subsequentes
      (req as any).provider = provider;
      next();
    } catch (error) {
      console.error("Erro ao carregar provider do usuário:", error);
      res.status(500).json({ error: "Erro ao carregar perfil do prestador" });
    }
  };
  
  // Rotas de administração
  app.get("/api/admin/users", isAdmin, async (req: Request, res: Response) => {
    try {
      const users = await storage.getAllUsers();
      res.json(users);
    } catch (error) {
      console.error("Erro ao buscar usuários:", error);
      res.status(500).json({ error: "Erro ao buscar usuários" });
    }
  });
  
  // Rota para limpar o banco de dados (apenas Admin)
  app.post("/api/admin/clear-database", isAdmin, async (req: Request, res: Response) => {
    try {
      console.log("Iniciando limpeza do banco de dados...");
      
      // Usar diretamente as funções do Drizzle ORM
      try {
        console.log("Limpando notificações...");
        await db.delete(notifications);
        console.log("Notificações removidas com sucesso");
        
        console.log("Limpando agendamentos...");
        await db.delete(appointments);
        console.log("Agendamentos removidos com sucesso");
        
        console.log("Limpando associações entre provedores e clientes...");
        await db.delete(providerClients);
        console.log("Associações entre provedores e clientes removidas com sucesso");
        
        console.log("Limpando clientes...");
        await db.delete(clients);
        console.log("Clientes removidos com sucesso");
        
        console.log("Limpando serviços...");
        await db.delete(services);
        console.log("Serviços removidos com sucesso");
        
        // Envia notificação em tempo real
        broadcastUpdate('database_cleared', { message: 'Banco de dados limpo com sucesso' });
        
        res.status(200).json({ 
          success: true, 
          message: "Banco de dados limpo com sucesso. Todas as tabelas exceto usuários e provedores foram limpas." 
        });
      } catch (dbError: any) {
        console.error("Erro nas operações do banco:", dbError);
        throw new Error(`Erro nas operações de banco de dados: ${dbError.message || 'Erro desconhecido'}`);
      }
    } catch (error: any) {
      console.error("Erro ao limpar banco de dados:", error);
      res.status(500).json({ error: "Falha ao limpar banco de dados" });
    }
  });
  
  app.post("/api/admin/users", isAdmin, async (req: Request, res: Response) => {
    try {
      const { name, username, password, role } = req.body;
      
      // Validar dados
      if (!name || !username || !password || !role) {
        return res.status(400).json({ error: "Todos os campos são obrigatórios" });
      }
      
      // Verificar se o usuário já existe
      const existingUser = await storage.getUserByUsername(username);
      if (existingUser) {
        return res.status(400).json({ error: "Nome de usuário já existe" });
      }
      
      // Gerar um email temporário baseado no nome de usuário
      const email = `${username}@temp.com`;
      
      // Criar o usuário com senha hasheada
      const hashedPassword = await hashPassword(password);
      const user = await storage.createUser({
        name,
        username,
        email,
        password: hashedPassword,
        role,
      });
      
      // Se for um usuário do tipo provider, criar também um provider associado
      if (role === 'provider') {
        try {
          // Gerar um link de agendamento único baseado no nome de usuário
          const bookingLink = username.toLowerCase().replace(/[^a-z0-9]/g, '');
          
          // Criar provider associado ao usuário
          const provider = await storage.createProvider({
            userId: user.id,
            name: `${name}'s Service`,
            email: `${username}@example.com`, // Email temporário baseado no nome de usuário
            phone: "",
            bookingLink,
            workingHoursStart: 8, // Horário padrão de início (8h)
            workingHoursEnd: 18,  // Horário padrão de término (18h)
          });
          
          console.log(`Provider criado para usuário ${user.id} com link de agendamento: ${bookingLink}`);
        } catch (providerError) {
          console.error("Erro ao criar provider para o usuário:", providerError);
          // Não interrompemos o fluxo se falhar a criação do provider
        }
      }
      
      // Retornar o usuário criado (sem a senha)
      const { password: _, ...userWithoutPassword } = user;
      res.status(201).json(userWithoutPassword);
    } catch (error) {
      console.error("Erro ao criar usuário:", error);
      res.status(500).json({ error: "Erro ao criar usuário" });
    }
  });
  
  // Rota para atualizar um usuário existente (apenas Admin)
  app.put("/api/admin/users/:id", isAdmin, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) {
        return res.status(400).json({ error: "ID de usuário inválido" });
      }
      
      // Impedir alteração do usuário admin principal (ID 1)
      if (id === 1) {
        return res.status(403).json({ error: "Não é permitido modificar o usuário administrador principal" });
      }
      
      // Buscar o usuário existente
      const existingUser = await storage.getUser(id);
      if (!existingUser) {
        return res.status(404).json({ error: "Usuário não encontrado" });
      }
      
      const { name, username, password, role } = req.body;
      const updateData: Partial<{ name: string, username: string, password: string, role: string }> = {};
      
      // Validar e adicionar campos a serem atualizados
      if (name) updateData.name = name;
      
      if (username && username !== existingUser.username) {
        // Verificar se o novo nome de usuário já existe
        const existingUsername = await storage.getUserByUsername(username);
        if (existingUsername && existingUsername.id !== id) {
          return res.status(400).json({ error: "Nome de usuário já existe" });
        }
        updateData.username = username;
      }
      
      if (role) updateData.role = role;
      
      // Se uma nova senha foi fornecida, hashear e atualizar
      if (password) {
        updateData.password = await hashPassword(password);
      }
      
      // Atualizar usuário
      const updatedUser = await storage.updateUser(id, updateData);
      if (!updatedUser) {
        return res.status(500).json({ error: "Falha ao atualizar usuário" });
      }
      
      // Retornar o usuário atualizado (sem a senha)
      const { password: _, ...userWithoutPassword } = updatedUser;
      res.status(200).json(userWithoutPassword);
    } catch (error) {
      console.error("Erro ao atualizar usuário:", error);
      res.status(500).json({ error: "Erro ao atualizar usuário" });
    }
  });
  
  // Rota para excluir um usuário (apenas Admin)
  app.delete("/api/admin/users/:id", isAdmin, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) {
        return res.status(400).json({ error: "ID de usuário inválido" });
      }
      
      // Impedir exclusão do usuário admin principal (ID 1)
      if (id === 1) {
        return res.status(403).json({ error: "Não é permitido excluir o usuário administrador principal" });
      }
      
      // Verificar se o usuário existe
      const existingUser = await storage.getUser(id);
      if (!existingUser) {
        return res.status(404).json({ error: "Usuário não encontrado" });
      }
      
      // Excluir o usuário
      const success = await storage.deleteUser(id);
      if (!success) {
        return res.status(500).json({ error: "Falha ao excluir usuário" });
      }
      
      res.status(200).json({ success: true, message: "Usuário excluído com sucesso" });
    } catch (error) {
      console.error("Erro ao excluir usuário:", error);
      res.status(500).json({ error: "Erro ao excluir usuário" });
    }
  });
  
  // Rota para bloquear/desbloquear usuário (apenas Admin)
  app.patch("/api/admin/users/:id/toggle-active", isAdmin, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) {
        return res.status(400).json({ error: "ID de usuário inválido" });
      }
      
      // Impedir bloqueio do usuário admin principal (ID 1)
      if (id === 1) {
        return res.status(403).json({ error: "Não é permitido bloquear o usuário administrador principal" });
      }
      
      // Verificar se o usuário existe
      const existingUser = await storage.getUser(id);
      if (!existingUser) {
        return res.status(404).json({ error: "Usuário não encontrado" });
      }
      
      const { active } = req.body;
      if (typeof active !== 'boolean') {
        return res.status(400).json({ error: "O parâmetro 'active' é obrigatório e deve ser um booleano" });
      }
      
      // Atualizar o usuário
      const updatedUser = await storage.updateUser(id, { isActive: active });
      if (!updatedUser) {
        return res.status(500).json({ error: "Falha ao atualizar o status do usuário" });
      }
      
      const action = active ? "ativado" : "bloqueado";
      
      // Notificar via WebSocket
      broadcastUpdate('user-updated', updatedUser);
      
      res.status(200).json({ 
        success: true, 
        message: `Usuário ${action} com sucesso`,
        user: updatedUser
      });
    } catch (error) {
      console.error("Erro ao atualizar status do usuário:", error);
      res.status(500).json({ error: "Falha ao atualizar status do usuário" });
    }
  });
  
  // Rota para gerenciar assinatura de usuário (apenas Admin)
  app.patch("/api/admin/users/:id/subscription", isAdmin, async (req: Request, res: Response) => {
    try {
      console.log("Recebida solicitação para atualizar assinatura:", {
        params: req.params,
        body: req.body
      });
      
      const id = parseInt(req.params.id);
      if (isNaN(id)) {
        return res.status(400).json({ error: "ID de usuário inválido" });
      }
      
      // Verificar se o usuário existe
      const existingUser = await storage.getUser(id);
      if (!existingUser) {
        return res.status(404).json({ error: "Usuário não encontrado" });
      }
      
      const { neverExpires, extensionMonths, specificDate, method } = req.body;
      console.log("Dados extraídos:", { neverExpires, extensionMonths, specificDate, method });
      
      // Validar os dados da assinatura
      if (neverExpires === undefined && method === undefined) {
        return res.status(400).json({ 
          error: "Deve fornecer pelo menos um parâmetro: neverExpires ou método de extensão" 
        });
      }
      
      // Preparar os dados para atualização
      const updateData: Partial<any> = {};
      
      if (neverExpires !== undefined) {
        updateData.neverExpires = neverExpires;
        
        // Se neverExpires for true, limpar subscriptionExpiry
        if (neverExpires === true) {
          updateData.subscriptionExpiry = null;
        }
      }
      
      if (!neverExpires && method) {
        if (method === 'extension' && extensionMonths !== undefined) {
          // Validar extensionMonths
          const months = parseInt(extensionMonths);
          if (isNaN(months) || months < 1 || months > 36) {
            return res.status(400).json({ 
              error: "Meses de extensão deve ser um número entre 1 e 36" 
            });
          }
          
          // Calcular nova data de expiração
          let baseDate = new Date();
          
          // Se o usuário já tiver uma data de expiração no futuro, usar essa como base
          if (existingUser.subscriptionExpiry) {
            const currentExpiry = new Date(existingUser.subscriptionExpiry);
            if (currentExpiry > baseDate) {
              baseDate = currentExpiry;
            }
          }
          
          // Adicionar os meses de extensão
          const newExpiryDate = new Date(baseDate);
          newExpiryDate.setMonth(newExpiryDate.getMonth() + months);
          
          updateData.subscriptionExpiry = newExpiryDate;
        } 
        else if (method === 'specific_date' && specificDate) {
          // Validar data específica
          const dateObj = new Date(specificDate);
          console.log(`Data específica: ${specificDate}, objeto de data: ${dateObj}, é válida: ${!isNaN(dateObj.getTime())}`);
          
          if (isNaN(dateObj.getTime())) {
            return res.status(400).json({ 
              error: "Data de expiração inválida" 
            });
          }
          
          // Remover completamente verificação de data no passado
          const isInThePast = dateObj < new Date();
          console.log(`A data ${dateObj} está no passado? ${isInThePast}`);
          
          // Definir hora para o final do dia
          dateObj.setHours(23, 59, 59, 999);
          console.log(`Data final configurada: ${dateObj}`);
          
          updateData.subscriptionExpiry = dateObj;
        }
        else {
          return res.status(400).json({ 
            error: "Parâmetros inválidos para o método selecionado" 
          });
        }
      }
      
      // Atualizar o usuário
      const updatedUser = await storage.updateUser(id, updateData);
      if (!updatedUser) {
        return res.status(500).json({ error: "Falha ao atualizar a assinatura do usuário" });
      }
      
      // Notificar via WebSocket
      broadcastUpdate('user-updated', updatedUser);
      
      // Retornar o usuário atualizado (sem a senha)
      const { password: _, ...userWithoutPassword } = updatedUser;
      
      res.status(200).json({ 
        success: true, 
        message: `Assinatura atualizada com sucesso`,
        user: userWithoutPassword
      });
    } catch (error) {
      console.error("Erro ao atualizar assinatura do usuário:", error);
      res.status(500).json({ error: "Falha ao atualizar assinatura do usuário" });
    }
  });

  // Provider routes
  app.get("/api/providers", async (req: Request, res: Response) => {
    const providers = await storage.getProviders();
    res.json(providers);
  });
  
  // Rota para criar um novo provider (usado quando usuários precisam criar seu próprio perfil)
  app.post("/api/providers", async (req: Request, res: Response) => {
    try {
      // Verificar autenticação
      if (!req.isAuthenticated()) {
        return res.status(401).json({ error: "Não autenticado" });
      }
      
      // Verificar se o usuário atual já tem um provider
      const existingProvider = await storage.getProviderByUserId(req.user.id);
      if (existingProvider) {
        return res.status(400).json({ 
          error: "Perfil já existe", 
          message: "Você já possui um perfil de prestador configurado",
          provider: existingProvider
        });
      }
      
      // Validar os dados do body
      const providerData = insertProviderSchema.parse({
        ...req.body,
        userId: req.user.id // Garantir que o userId seja o do usuário atual
      });
      
      // Criar o provider
      const newProvider = await storage.createProvider(providerData);
      
      // Opcionalmente criar um serviço de exemplo
      try {
        const exampleService = {
          providerId: newProvider.id,
          name: "Serviço de Exemplo",
          description: "Este é um serviço de exemplo. Edite ou exclua conforme necessário.",
          duration: 60, // 60 minutos
          price: 10000, // R$ 100,00 (em centavos)
          active: true
        };
        
        await storage.createService(exampleService);
        console.log(`Serviço de exemplo criado para novo prestador: ${newProvider.id}`);
      } catch (serviceError) {
        console.error("Erro ao criar serviço de exemplo:", serviceError);
        // Continua mesmo com erro no serviço
      }
      
      // Retornar o provider criado
      res.status(201).json(newProvider);
    } catch (error) {
      console.error('Erro ao criar provider:', error);
      
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: "Dados inválidos", errors: error.errors });
      }
      
      res.status(500).json({ message: "Falha ao criar perfil de prestador" });
    }
  });

  app.get("/api/providers/:id", async (req: Request, res: Response) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      return res.status(400).json({ message: "Invalid provider ID" });
    }
    
    const provider = await storage.getProvider(id);
    if (!provider) {
      return res.status(404).json({ message: "Provider not found" });
    }
    
    res.json(provider);
  });
  
  // Rota para atualizar as configurações do provedor
  app.patch("/api/providers/:id/settings", async (req: Request, res: Response) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      return res.status(400).json({ message: "Invalid provider ID" });
    }
    
    const provider = await storage.getProvider(id);
    if (!provider) {
      return res.status(404).json({ message: "Provider not found" });
    }
    
    try {
      // Extrair os campos da requisição
      const { workingHoursStart, workingHoursEnd, workingDays, phone } = req.body;
      
      if (workingHoursStart === undefined || workingHoursEnd === undefined) {
        return res.status(400).json({ 
          message: "Missing required fields",
          errors: ["workingHoursStart and workingHoursEnd are required"]
        });
      }
      
      if (typeof workingHoursStart !== 'number' || typeof workingHoursEnd !== 'number') {
        return res.status(400).json({ 
          message: "Invalid data types",
          errors: ["workingHoursStart and workingHoursEnd must be numbers"]
        });
      }
      
      if (workingHoursStart < 0 || workingHoursStart > 23 || workingHoursEnd < 1 || workingHoursEnd > 24) {
        return res.status(400).json({ 
          message: "Invalid hour range",
          errors: ["workingHoursStart must be between 0-23 and workingHoursEnd must be between 1-24"]
        });
      }
      
      if (workingHoursEnd <= workingHoursStart) {
        return res.status(400).json({ 
          message: "Invalid hour range",
          errors: ["workingHoursEnd must be greater than workingHoursStart"]
        });
      }
      
      // Validação dos dias de trabalho (se fornecido)
      if (workingDays !== undefined) {
        if (typeof workingDays !== 'string') {
          return res.status(400).json({
            message: "Invalid working days format",
            errors: ["workingDays must be a string of comma-separated numbers (1-7)"]
          });
        }
        
        // Verificar se o formato é válido (números de 1 a 7 separados por vírgula)
        const daysArray = workingDays.split(',');
        const isValidFormat = daysArray.every(day => {
          const num = parseInt(day.trim());
          return !isNaN(num) && num >= 1 && num <= 7;
        });
        
        if (!isValidFormat) {
          return res.status(400).json({
            message: "Invalid working days values",
            errors: ["Each day must be a number between 1 and 7 (1=Monday, 7=Sunday)"]
          });
        }
      }
      
      // Preparar o objeto com os dados para atualização
      const providerData: Partial<InsertProvider> = {
        workingHoursStart,
        workingHoursEnd
      };
      
      // Adicionar workingDays ao update se fornecido
      if (workingDays !== undefined) {
        providerData.workingDays = workingDays;
      }
      
      // Adicionar o número de telefone/WhatsApp se fornecido
      if (phone !== undefined) {
        providerData.phone = phone;
      }
      
      const updatedProvider = await storage.updateProvider(id, providerData);
      if (!updatedProvider) {
        return res.status(500).json({ message: "Falha ao atualizar as configurações do provedor" });
      }
      
      res.json(updatedProvider);
    } catch (error) {
      console.error("Error updating provider settings:", error);
      res.status(500).json({ message: "Failed to update provider settings" });
    }
  });

  // Service routes
  app.get("/api/providers/:providerId/services", async (req: Request, res: Response) => {
    const providerId = parseInt(req.params.providerId);
    if (isNaN(providerId)) {
      return res.status(400).json({ message: "Invalid provider ID" });
    }
    
    const services = await storage.getServices(providerId);
    res.json(services);
  });
  
  // Rota para obter os serviços do profissional autenticado
  app.get("/api/my-services", loadUserProvider, async (req: Request, res: Response) => {
    const provider = (req as any).provider;
    const services = await storage.getServices(provider.id);
    res.json(services);
  });

  app.post("/api/services", loadUserProvider, async (req: Request, res: Response) => {
    try {
      const provider = (req as any).provider;
      
      // Garantir que o serviço está sendo criado para o provider do usuário logado
      const data = insertServiceSchema.parse({
        ...req.body,
        providerId: provider.id // Sobrescrever o providerId com o ID do provider do usuário logado
      });
      
      const service = await storage.createService(data);
      res.status(201).json(service);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: "Invalid service data", errors: error.errors });
      }
      res.status(500).json({ message: "Failed to create service" });
    }
  });

  app.put("/api/services/:id", loadUserProvider, async (req: Request, res: Response) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      return res.status(400).json({ message: "Invalid service ID" });
    }
    
    try {
      const provider = (req as any).provider;
      
      // Verifica se o serviço pertence ao provider do usuário
      const existingService = await storage.getService(id);
      if (!existingService) {
        return res.status(404).json({ message: "Service not found" });
      }
      
      if (existingService.providerId !== provider.id) {
        return res.status(403).json({ 
          error: "Acesso não autorizado", 
          message: "Você não tem permissão para editar este serviço" 
        });
      }
      
      // Não permite alterar o providerId
      const data = insertServiceSchema.partial().parse({
        ...req.body,
        providerId: provider.id // Garante que o providerId não é alterado
      });
      
      const service = await storage.updateService(id, data);
      
      if (!service) {
        return res.status(404).json({ message: "Service not found" });
      }
      
      res.json(service);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: "Invalid service data", errors: error.errors });
      }
      res.status(500).json({ message: "Failed to update service" });
    }
  });

  app.delete("/api/services/:id", loadUserProvider, async (req: Request, res: Response) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      return res.status(400).json({ message: "Invalid service ID" });
    }
    
    try {
      const provider = (req as any).provider;
      
      // Verifica se o serviço pertence ao provider do usuário
      const existingService = await storage.getService(id);
      if (!existingService) {
        return res.status(404).json({ message: "Service not found" });
      }
      
      if (existingService.providerId !== provider.id) {
        return res.status(403).json({ 
          error: "Acesso não autorizado", 
          message: "Você não tem permissão para excluir este serviço" 
        });
      }
      
      const success = await storage.deleteService(id);
      if (!success) {
        return res.status(404).json({ message: "Service not found" });
      }
      
      res.status(204).send();
    } catch (error) {
      console.error("Erro ao excluir serviço:", error);
      res.status(500).json({ message: "Falha ao excluir serviço" });
    }
  });

  // Client routes
  app.get("/api/clients", loadUserProvider, async (req: Request, res: Response) => {
    // Obter somente os clientes associados a este provider
    const provider = (req as any).provider;
    const clients = await storage.getClientsByProvider(provider.id);
    res.json(clients);
  });

  app.get("/api/clients/:id", loadUserProvider, async (req: Request, res: Response) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      return res.status(400).json({ message: "Invalid client ID" });
    }
    
    const client = await storage.getClient(id);
    if (!client) {
      return res.status(404).json({ message: "Client not found" });
    }
    
    // Verificar se o cliente pertence a este provider usando a associação direta
    const provider = (req as any).provider;
    const clientBelongsToProvider = await storage.clientBelongsToProvider(provider.id, client.id);
    
    if (!clientBelongsToProvider) {
      return res.status(403).json({ 
        error: "Acesso não autorizado", 
        message: "Você não tem permissão para acessar este cliente" 
      });
    }
    
    res.json(client);
  });

  app.post("/api/clients", loadUserProvider, async (req: Request, res: Response) => {
    try {
      const data = insertClientSchema.parse(req.body);
      const provider = (req as any).provider;
      
      // Check if client already exists with this phone number
      const existingClient = await storage.getClientByPhone(data.phone);
      if (existingClient) {
        console.log(`Cliente existente encontrado pelo telefone: ${data.phone}, ID: ${existingClient.id}`);
        
        // Sempre tenta associar o cliente existente a este provider para garantir
        try {
          // Verifica se já existe associação direta (não usa clientBelongsToProvider)
          const [association] = await db
            .select()
            .from(providerClients)
            .where(
              and(
                eq(providerClients.providerId, provider.id),
                eq(providerClients.clientId, existingClient.id)
              )
            );
            
          if (!association) {
            await storage.associateClientWithProvider(provider.id, existingClient.id);
            console.log(`Cliente existente #${existingClient.id} associado ao provider #${provider.id}`);
          } else {
            console.log(`Cliente #${existingClient.id} já está associado ao provider #${provider.id}`);
          }
        } catch (err) {
          console.error("Erro ao associar cliente existente:", err);
          // Sempre tenta criar a associação, mesmo se houver erro na verificação
          try {
            await storage.associateClientWithProvider(provider.id, existingClient.id);
          } catch (err2) {
            console.error("Segundo erro ao associar cliente:", err2);
          }
        }
        
        return res.json(existingClient);
      }
      
      // Criar o cliente
      const client = await storage.createClient(data);
      console.log(`Novo cliente criado: ${client.name} (ID: ${client.id})`);
      
      // Associar o cliente diretamente ao provider usando a tabela de associação
      // Tenta várias vezes para garantir que a associação seja criada
      let associationSuccess = false;
      for (let attempt = 0; attempt < 3 && !associationSuccess; attempt++) {
        try {
          await storage.associateClientWithProvider(provider.id, client.id);
          console.log(`Novo cliente #${client.id} associado ao provider #${provider.id}`);
          associationSuccess = true;
        } catch (err) {
          console.error(`Erro ao associar cliente ao provider (tentativa ${attempt + 1}):`, err);
          // Pequena pausa antes de tentar novamente
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
      
      if (!associationSuccess) {
        console.warn(`Não foi possível associar o cliente #${client.id} ao provider #${provider.id} após múltiplas tentativas`);
      }
      
      res.status(201).json(client);
    } catch (error) {
      console.error("Erro ao criar cliente:", error);
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: "Invalid client data", errors: error.errors });
      }
      res.status(500).json({ message: "Failed to create client" });
    }
  });
  
  // Rota para atualizar cliente
  app.put("/api/clients/:id", loadUserProvider, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) {
        return res.status(400).json({ message: "ID do cliente inválido" });
      }
      
      // Verifica se o cliente existe
      const client = await storage.getClient(id);
      if (!client) {
        return res.status(404).json({ message: "Cliente não encontrado" });
      }
      
      // Verifica se o cliente pertence a este provider
      const provider = (req as any).provider;
      // Usando associação direta em vez de buscar todos os clientes
      const clientBelongsToProvider = await storage.clientBelongsToProvider(provider.id, client.id);
      
      if (!clientBelongsToProvider) {
        return res.status(403).json({ 
          error: "Acesso não autorizado", 
          message: "Você não tem permissão para atualizar este cliente" 
        });
      }
      
      // Validar dados
      const data = insertClientSchema.partial().parse(req.body);
      
      // Atualizar cliente
      const updatedClient = await storage.updateClient(id, data);
      
      // Responder com o cliente atualizado
      res.json(updatedClient);
    } catch (error) {
      console.error('Erro ao atualizar cliente:', error);
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: "Dados do cliente inválidos", errors: error.errors });
      }
      res.status(500).json({ message: "Falha ao atualizar cliente" });
    }
  });
  
  // Rota para bloquear/desbloquear cliente
  app.patch("/api/clients/:id/block", loadUserProvider, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) {
        return res.status(400).json({ message: "ID do cliente inválido" });
      }
      
      // Verifica se o cliente existe
      const client = await storage.getClient(id);
      if (!client) {
        return res.status(404).json({ message: "Cliente não encontrado" });
      }
      
      // Verifica se o cliente pertence a este provider
      const provider = (req as any).provider;
      const clientBelongsToProvider = await storage.clientBelongsToProvider(provider.id, client.id);
      
      if (!clientBelongsToProvider) {
        return res.status(403).json({ 
          error: "Acesso não autorizado", 
          message: "Você não tem permissão para modificar este cliente" 
        });
      }
      
      const { blocked } = req.body;
      if (typeof blocked !== 'boolean') {
        return res.status(400).json({ message: "Parâmetro 'blocked' inválido" });
      }
      
      // Atualiza o status de bloqueio do cliente
      const updatedClient = await storage.updateClient(id, { isBlocked: blocked });
      
      const action = blocked ? "bloqueado" : "desbloqueado";
      res.json({ 
        success: true, 
        message: `Cliente ${action} com sucesso`,
        client: updatedClient
      });
      
      // Enviar atualização via WebSocket
      broadcastUpdate('client-updated', updatedClient);
      
    } catch (error) {
      console.error('Erro ao bloquear/desbloquear cliente:', error);
      res.status(500).json({ message: "Falha ao atualizar status do cliente" });
    }
  });

  // Rota para excluir cliente permanentemente
  app.delete("/api/clients/:id", loadUserProvider, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) {
        return res.status(400).json({ message: "ID do cliente inválido" });
      }
      
      // Verifica se o cliente existe
      const client = await storage.getClient(id);
      if (!client) {
        return res.status(404).json({ message: "Cliente não encontrado" });
      }
      
      // Verifica se o cliente pertence a este provider
      const provider = (req as any).provider;
      const clientBelongsToProvider = await storage.clientBelongsToProvider(provider.id, client.id);
      
      if (!clientBelongsToProvider) {
        return res.status(403).json({ 
          error: "Acesso não autorizado", 
          message: "Você não tem permissão para excluir este cliente" 
        });
      }
      
      // Verifica se o cliente possui agendamentos futuros
      const currentDate = new Date();
      const futureAppointments = await db
        .select()
        .from(appointments)
        .where(
          and(
            eq(appointments.clientId, id),
            eq(appointments.providerId, provider.id),
            gt(appointments.date, currentDate),
            sql`${appointments.status} != ${AppointmentStatus.CANCELLED}`
          )
        );
      
      if (futureAppointments.length > 0) {
        return res.status(400).json({ 
          message: "Não é possível excluir um cliente com agendamentos futuros", 
          appointments: futureAppointments.length
        });
      }
      
      // Excluir todos os agendamentos anteriores do cliente com este provider
      await db.delete(appointments)
        .where(
          and(
            eq(appointments.clientId, id),
            eq(appointments.providerId, provider.id)
          )
        );
      
      // Remover a associação entre este provider e o cliente
      await db.delete(providerClients)
        .where(
          and(
            eq(providerClients.clientId, id),
            eq(providerClients.providerId, provider.id)
          )
        );
      
      // Verificar se o cliente ainda está associado a outros providers
      const otherAssociations = await db
        .select()
        .from(providerClients)
        .where(eq(providerClients.clientId, id));
      
      // Se o cliente não está associado a nenhum outro provider, excluí-lo completamente
      if (otherAssociations.length === 0) {
        await db.delete(clients).where(eq(clients.id, id));
        res.json({ success: true, message: "Cliente excluído permanentemente do sistema" });
      } else {
        res.json({ 
          success: true, 
          message: "Cliente removido da sua lista, mas mantido no sistema pois está associado a outros profissionais" 
        });
      }
      
      // Enviar atualização via WebSocket
      broadcastUpdate('client-deleted', { clientId: id, providerId: provider.id });
      
    } catch (error) {
      console.error('Erro ao excluir cliente permanentemente:', error);
      res.status(500).json({ message: "Falha ao excluir cliente" });
    }
  });

  // Rota para obter o provider do usuário logado
  app.get("/api/my-provider", async (req: Request, res: Response) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ error: "Não autenticado" });
    }
    
    try {
      const provider = await storage.getProviderByUserId(req.user.id);
      
      if (!provider) {
        return res.status(404).json({ 
          error: "Perfil de prestador não encontrado", 
          message: "Você não tem um perfil de prestador de serviços configurado."
        });
      }
      
      res.json(provider);
    } catch (error) {
      console.error("Erro ao buscar provider do usuário:", error);
      res.status(500).json({ error: "Erro ao buscar perfil do prestador" });
    }
  });
  
  // Rota para obter link de compartilhamento único do usuário
  app.get("/api/my-booking-link", loadUserProvider, async (req: Request, res: Response) => {
    const provider = (req as any).provider;
    
    // Verifica se o provedor já tem um link de agendamento
    if (!provider.bookingLink) {
      // Se não tiver, atualiza o provider com um bookingLink baseado no nome de usuário
      const user = await storage.getUser(provider.userId);
      if (user) {
        // Certifica-se que o username é usado diretamente, sem caminhos
        const bookingLink = user.username.toLowerCase().replace(/^\/booking\//, '');
        await storage.updateProvider(provider.id, { bookingLink });
        provider.bookingLink = bookingLink;
      }
    }
    
    // URL do link de compartilhamento
    // Certifica-se que bookingLink não comece com '/booking/'
    const linkId = provider.bookingLink ? 
      provider.bookingLink.replace(/^\/booking\//, '') : 
      provider.id.toString();
    
    const bookingPath = `/booking/${linkId}`;
    
    res.json({ 
      bookingLink: bookingPath,
      linkId: linkId,
      fullUrl: `${req.protocol}://${req.get('host')}${bookingPath}`
    });
  });
  
  // Rota para buscar um provider pelo bookingLink
  app.get("/api/providers/booking/:linkId", async (req: Request, res: Response) => {
    const { linkId } = req.params;
    
    try {
      console.log(`Buscando provider pelo linkId: ${linkId}`);
      
      // Tenta primeiro buscar pelo bookingLink direto da tabela (mais eficiente)
      let provider = await storage.getProviderByBookingLink(linkId);
      
      // Se não encontrar, tenta como ID numérico (para compatibilidade)
      if (!provider) {
        const id = parseInt(linkId);
        if (!isNaN(id)) {
          provider = await storage.getProvider(id);
        }
      }
      
      // Se ainda não encontrou, tenta buscar pelo nome de usuário
      if (!provider) {
        try {
          provider = await storage.getProviderByUsername(linkId);
        } catch (err) {
          console.log("Erro ao tentar buscar por username:", err);
        }
      }
      
      if (provider) {
        console.log(`Provider encontrado: ${provider.name} (ID: ${provider.id})`);
        
        // Buscar dados do usuário associado para obter o avatarUrl
        if (provider.userId) {
          try {
            const user = await storage.getUser(provider.userId);
            if (user && user.avatarUrl) {
              // Se o provider não tiver avatarUrl mas o usuário tiver, usar o do usuário
              if (!provider.avatarUrl) {
                provider = { ...provider, avatarUrl: user.avatarUrl };
              }
            }
          } catch (err) {
            console.log("Erro ao buscar dados do usuário associado:", err);
            // Não interromper o fluxo se houver erro ao buscar o usuário
          }
        }
        
        return res.json(provider);
      }
      
      console.log(`Provider não encontrado para linkId: ${linkId}`);
      return res.status(404).json({ error: "Provider não encontrado" });
    } catch (error) {
      console.error("Erro ao buscar provider por link:", error);
      res.status(500).json({ error: "Erro ao buscar dados do profissional" });
    }
  });

  // Appointment routes - Usando middleware para garantir acesso apenas aos próprios dados
  app.get("/api/my-appointments", loadUserProvider, async (req: Request, res: Response) => {
    const provider = (req as any).provider;
    const providerId = provider.id;
    
    // Parse date filter parameters
    const dateParam = req.query.date as string;
    const startDateParam = req.query.startDate as string;
    const endDateParam = req.query.endDate as string;
    const statusFilter = req.query.status as string;
    
    // Determinar se os agendamentos cancelados devem ser incluídos
    // Se o filtro de status for 'cancelled', precisamos incluir agendamentos cancelados
    // Ou se não houver filtro de status, incluímos todos
    const includeCancelled = !statusFilter || statusFilter === 'all' || statusFilter === AppointmentStatus.CANCELLED;
    
    let appointments;
    
    if (dateParam) {
      // Cria uma data no formato local (baseada no fuso horário do servidor)
      // usando apenas o ano, mês e dia da data recebida
      const [year, month, day] = dateParam.split('-').map(Number);
      const date = new Date(year, month - 1, day, 0, 0, 0);
      
      if (isNaN(date.getTime())) {
        return res.status(400).json({ message: "Invalid date format" });
      }
      
      console.log(`Buscando agendamentos para a data: ${date.toISOString()} (data local: ${date.toString()})`);
      appointments = await storage.getAppointmentsByDate(providerId, date, includeCancelled);
    } else if (startDateParam && endDateParam) {
      const startDate = new Date(startDateParam);
      const endDate = new Date(endDateParam);
      if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
        return res.status(400).json({ message: "Invalid date format" });
      }
      appointments = await storage.getAppointmentsByDateRange(providerId, startDate, endDate, includeCancelled);
    } else {
      appointments = await storage.getAppointments(providerId, includeCancelled);
    }
    
    // Filtrar por status se um status específico foi solicitado (exceto 'all')
    if (statusFilter && statusFilter !== 'all') {
      appointments = appointments.filter(appointment => appointment.status === statusFilter);
    }
    
    // Enriquecer os agendamentos com informações de cliente e serviço
    const enrichedAppointments = await Promise.all(
      appointments.map(async (appointment) => {
        // Obter cliente
        const client = await storage.getClient(appointment.clientId);
        
        // Obter serviço
        const service = await storage.getService(appointment.serviceId);
        
        return {
          ...appointment,
          clientName: client?.name || "Cliente não encontrado",
          serviceName: service?.name || "Serviço não encontrado",
          servicePrice: service?.price || 0,
          serviceDuration: service?.duration || 0
        };
      })
    );
    
    res.json(enrichedAppointments);
  });
  
  // Manter a rota original para compatibilidade com a API pública
  app.get("/api/providers/:providerId/appointments", async (req: Request, res: Response) => {
    const providerId = parseInt(req.params.providerId);
    if (isNaN(providerId)) {
      return res.status(400).json({ message: "Invalid provider ID" });
    }
    
    // Parse date filter parameters
    const dateParam = req.query.date as string;
    const startDateParam = req.query.startDate as string;
    const endDateParam = req.query.endDate as string;
    const statusFilter = req.query.status as string;
    
    // Determinar se os agendamentos cancelados devem ser incluídos
    // Se o filtro de status for 'cancelled', precisamos incluir agendamentos cancelados
    // Ou se não houver filtro de status, incluímos todos
    const includeCancelled = !statusFilter || statusFilter === 'all' || statusFilter === AppointmentStatus.CANCELLED;
    
    let appointments;
    
    if (dateParam) {
      // Cria uma data no formato local (baseada no fuso horário do servidor)
      // usando apenas o ano, mês e dia da data recebida
      const [year, month, day] = dateParam.split('-').map(Number);
      const date = new Date(year, month - 1, day, 0, 0, 0);
      
      if (isNaN(date.getTime())) {
        return res.status(400).json({ message: "Invalid date format" });
      }
      
      console.log(`Buscando agendamentos para a data: ${date.toISOString()} (data local: ${date.toString()})`);
      appointments = await storage.getAppointmentsByDate(providerId, date, includeCancelled);
    } else if (startDateParam && endDateParam) {
      const startDate = new Date(startDateParam);
      const endDate = new Date(endDateParam);
      if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
        return res.status(400).json({ message: "Invalid date format" });
      }
      appointments = await storage.getAppointmentsByDateRange(providerId, startDate, endDate, includeCancelled);
    } else {
      appointments = await storage.getAppointments(providerId, includeCancelled);
    }
    
    // Filtrar por status se um status específico foi solicitado (exceto 'all')
    if (statusFilter && statusFilter !== 'all') {
      appointments = appointments.filter(appointment => appointment.status === statusFilter);
    }
    
    // Enriquecer os agendamentos com informações de cliente e serviço
    const enrichedAppointments = await Promise.all(
      appointments.map(async (appointment) => {
        // Obter cliente
        const client = await storage.getClient(appointment.clientId);
        
        // Obter serviço
        const service = await storage.getService(appointment.serviceId);
        
        return {
          ...appointment,
          clientName: client?.name || "Cliente não encontrado",
          serviceName: service?.name || "Serviço não encontrado",
          servicePrice: service?.price || 0,
          serviceDuration: service?.duration || 0
        };
      })
    );
    
    res.json(enrichedAppointments);
  });

  app.get("/api/appointments/:id", loadUserProvider, async (req: Request, res: Response) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      return res.status(400).json({ message: "Invalid appointment ID" });
    }
    
    const appointment = await storage.getAppointment(id);
    if (!appointment) {
      return res.status(404).json({ message: "Appointment not found" });
    }
    
    // Verificar se o agendamento pertence ao provider do usuário logado
    const provider = (req as any).provider;
    if (appointment.providerId !== provider.id) {
      return res.status(403).json({ 
        error: "Acesso não autorizado", 
        message: "Você não tem permissão para acessar este agendamento" 
      });
    }
    
    res.json(appointment);
  });

  app.post("/api/appointments", async (req: Request, res: Response) => {
    try {
      console.log("Criando agendamento com dados:", JSON.stringify(req.body, null, 2));
      
      // Tenta processar os dados com o esquema com transformações
      const data = insertAppointmentSchema.parse(req.body);
      console.log("Dados após processamento do schema:", JSON.stringify(data, null, 2));
      
      // Verifica se as datas são válidas
      if (!(data.date instanceof Date) || isNaN(data.date.getTime())) {
        return res.status(400).json({ 
          message: "Data de início inválida",
          details: `Valor recebido: ${JSON.stringify(req.body.date)}`
        });
      }
      
      if (!(data.endTime instanceof Date) || isNaN(data.endTime.getTime())) {
        return res.status(400).json({ 
          message: "Data de término inválida",
          details: `Valor recebido: ${JSON.stringify(req.body.endTime)}`
        });
      }
      
      // Verifica se o serviço existe
      const service = await storage.getService(data.serviceId);
      if (!service) {
        return res.status(404).json({ message: "Serviço não encontrado" });
      }
      
      // Verifica se é o próprio usuário do sistema fazendo o agendamento
      let isAvailable = false;
      
      // Se for agendamento pelo sistema, verificamos apenas conflitos de horário
      // ignorando restrições de dias e horários de trabalho
      if (req.isAuthenticated()) {
        console.log(`Verificação para usuário do sistema: ${req.user.username}`);
        
        // Verificar se o usuário autenticado é o proprietário do provider ou um admin
        const userProvider = await storage.getProviderByUserId(req.user.id);
        const isAdmin = req.user.role === 'admin';
        const isProviderOwner = userProvider && userProvider.id === data.providerId;
        
        if (isAdmin || isProviderOwner) {
          console.log(`Usuário autorizado (${isAdmin ? 'admin' : 'proprietário do provider'}), verificando apenas conflitos de horário`);
          
          // Buscar apenas os agendamentos existentes para verificar conflitos
          const appointments = await storage.getAppointmentsByDate(data.providerId, data.date);
          
          // Calcular horário de término para comparação
          const proposedEndTime = new Date(data.date.getTime() + service.duration * 60000);
          
          // Verificar se há conflito com algum agendamento existente
          const hasConflict = appointments.some(appointment => {
            if (appointment.status !== AppointmentStatus.CONFIRMED && 
                appointment.status !== AppointmentStatus.PENDING) {
              return false; // Ignora agendamentos cancelados ou concluídos
            }
            
            const appointmentEndTime = appointment.endTime || 
              new Date(appointment.date.getTime() + service.duration * 60000);
            
            // Verifica sobreposição
            return !(proposedEndTime <= appointment.date || data.date >= appointmentEndTime);
          });
          
          isAvailable = !hasConflict;
          console.log(`Verificação de conflitos por usuário do sistema: ${hasConflict ? 'CONFLITO DETECTADO' : 'NENHUM CONFLITO'}`);
        } else {
          console.log(`Usuário não autorizado para agendamento privilegiado, usando verificação padrão`);
          isAvailable = await storage.checkAvailability(data.providerId, data.date, service.duration);
        }
      } else {
        // Cliente normal fazendo agendamento - usa todas as verificações
        isAvailable = await storage.checkAvailability(data.providerId, data.date, service.duration);
      }
      
      if (!isAvailable) {
        return res.status(409).json({ message: "Horário indisponível" });
      }
      
      // Calcula o horário de término baseado na duração do serviço
      const endTime = new Date(data.date.getTime() + service.duration * 60000);
      console.log(`Horário calculado para o agendamento: ${data.date.toLocaleTimeString()} - ${endTime.toLocaleTimeString()}`);
      
      // Cria o agendamento com o horário de término explícito
      const appointment = await storage.createAppointment({
        ...data,
        endTime
      });
      
      // Enviar atualização em tempo real via WebSocket
      broadcastUpdate('appointment_created', appointment);
      
      // Criar uma notificação para o prestador de serviço
      const provider = await storage.getProvider(appointment.providerId);
      if (provider && provider.userId) {
        try {
          await storage.createNotification({
            userId: provider.userId,
            title: "Novo agendamento",
            message: `Um novo agendamento foi criado para o serviço #${appointment.serviceId}`,
            type: 'appointment',
            appointmentId: appointment.id
          });
          console.log(`Notificação criada para o usuário ${provider.userId}`);
        } catch (error) {
          console.error("Erro ao criar notificação:", error);
        }
      }
      
      // Aqui enviaríamos uma notificação via WhatsApp
      // Por enquanto, apenas logamos
      console.log(`Agendamento ${appointment.id} criado com sucesso! Notificação seria enviada.`);
      
      res.status(201).json(appointment);
    } catch (error) {
      console.error("Erro ao criar agendamento:", error);
      
      if (error instanceof z.ZodError) {
        return res.status(400).json({ 
          message: "Dados de agendamento inválidos", 
          errors: error.errors 
        });
      }
      
      if (error instanceof Error) {
        return res.status(400).json({ 
          message: "Erro ao processar agendamento", 
          details: error.message
        });
      }
      
      res.status(500).json({ message: "Falha ao criar agendamento" });
    }
  });

  // Atualizar status de agendamento (somente para o próprio provider)
  app.patch("/api/appointments/:id/status", loadUserProvider, async (req: Request, res: Response) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      return res.status(400).json({ message: "Invalid appointment ID" });
    }
    
    try {
      const provider = (req as any).provider;
      
      // Busca o agendamento para verificar se pertence ao provider do usuário logado
      const existingAppointment = await storage.getAppointment(id);
      if (!existingAppointment) {
        return res.status(404).json({ message: "Appointment not found" });
      }
      
      // Verifica se o agendamento pertence ao provider do usuário logado
      if (existingAppointment.providerId !== provider.id) {
        return res.status(403).json({ 
          error: "Acesso não autorizado", 
          message: "Você não tem permissão para atualizar este agendamento" 
        });
      }
      
      const statusSchema = z.object({
        status: z.enum([
          AppointmentStatus.PENDING,
          AppointmentStatus.CONFIRMED,
          AppointmentStatus.CANCELLED,
          AppointmentStatus.COMPLETED
        ]),
        cancellationReason: z.string().optional()
      });
      
      const { status, cancellationReason } = statusSchema.parse(req.body);
      const updatedAppointment = await storage.updateAppointmentStatus(id, status, cancellationReason);
      
      if (!updatedAppointment) {
        return res.status(404).json({ message: "Appointment not found" });
      }
      
      // Enviar atualização em tempo real via WebSocket
      broadcastUpdate('appointment_updated', updatedAppointment);
      
      // Aqui enviaríamos uma notificação via WhatsApp sobre a mudança de status
      // Por enquanto, apenas logamos
      console.log(`Enviando atualização em tempo real e notificação WhatsApp para agendamento ${id}: ${status}`);
      
      // Criar uma notificação no sistema para o usuário associado ao prestador
      // Já temos acesso ao provider pelo middleware loadUserProvider
      if (provider && provider.userId) {
        try {
          // Determinar mensagem apropriada baseada no status
          let titleMsg = "Agendamento atualizado";
          let message = `O agendamento #${updatedAppointment.id} foi atualizado para ${status}`;
          
          if (status === AppointmentStatus.CONFIRMED) {
            titleMsg = "Agendamento confirmado";
            message = `O agendamento #${updatedAppointment.id} foi confirmado`;
          } else if (status === AppointmentStatus.CANCELLED) {
            titleMsg = "Agendamento cancelado";
            message = cancellationReason 
              ? `O agendamento #${updatedAppointment.id} foi cancelado. Motivo: ${cancellationReason}`
              : `O agendamento #${updatedAppointment.id} foi cancelado`;
          } else if (status === AppointmentStatus.COMPLETED) {
            titleMsg = "Agendamento concluído";
            message = `O agendamento #${updatedAppointment.id} foi marcado como concluído`;
          }
          
          // Criar a notificação para o usuário
          await storage.createNotification({
            userId: provider.userId,
            title: titleMsg,
            message,
            type: 'appointment',
            appointmentId: updatedAppointment.id
          });
          
          console.log(`Notificação criada para o usuário ${provider.userId}`);
        } catch (error) {
          console.error("Erro ao criar notificação:", error);
        }
      }
      
      res.json(updatedAppointment);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: "Invalid status", errors: error.errors });
      }
      res.status(500).json({ message: "Failed to update appointment status" });
    }
  });

  // Check availability
  app.get("/api/providers/:providerId/availability", async (req: Request, res: Response) => {
    console.log(`=== VERIFICANDO DISPONIBILIDADE ===`);
    console.log(`Parâmetros recebidos:`, req.params, req.query);
    
    const providerId = parseInt(req.params.providerId);
    if (isNaN(providerId)) {
      console.log(`❌ ID do prestador inválido: ${req.params.providerId}`);
      return res.status(400).json({ message: "Invalid provider ID" });
    }
    
    const dateParam = req.query.date as string;
    const serviceIdParam = req.query.serviceId as string;
    const bySystemUserParam = req.query.bySystemUser as string; // Novo parâmetro para indicar se é feito pelo próprio sistema
    
    console.log(`Data param: ${dateParam}`);
    console.log(`Service ID param: ${serviceIdParam}`);
    console.log(`By System User param: ${bySystemUserParam}`);
    
    if (!dateParam || !serviceIdParam) {
      console.log(`❌ Data ou ID do serviço ausentes`);
      return res.status(400).json({ message: "Date and serviceId are required" });
    }
    
    const date = new Date(dateParam);
    const serviceId = parseInt(serviceIdParam);
    const bySystemUser = bySystemUserParam === 'true';
    
    console.log(`Data convertida: ${date.toISOString()} (${date.toLocaleString()})`);
    console.log(`ID do serviço: ${serviceId}`);
    console.log(`Agendamento pelo usuário do sistema: ${bySystemUser}`);
    
    if (isNaN(date.getTime()) || isNaN(serviceId)) {
      console.log(`❌ Data ou ID do serviço inválidos`);
      return res.status(400).json({ message: "Invalid date or service ID" });
    }
    
    const service = await storage.getService(serviceId);
    if (!service) {
      console.log(`❌ Serviço não encontrado: ${serviceId}`);
      return res.status(404).json({ message: "Service not found" });
    }
    
    console.log(`✓ Serviço encontrado: ${service.name}, duração: ${service.duration} minutos`);
    
    // Verificar se é o próprio usuário do sistema fazendo o agendamento
    let isAvailable = false;
    
    // Se for agendamento pelo sistema, verificamos apenas conflitos de horário
    // ignorando restrições de dias de trabalho
    if (bySystemUser && req.isAuthenticated()) {
      console.log(`Verificação para usuário do sistema: ${req.user.username}`);
      
      // Verificar se o usuário autenticado é o proprietário do provider ou um admin
      const userProvider = await storage.getProviderByUserId(req.user.id);
      const isAdmin = req.user.role === 'admin';
      const isProviderOwner = userProvider && userProvider.id === providerId;
      
      if (isAdmin || isProviderOwner) {
        console.log(`Usuário autorizado (${isAdmin ? 'admin' : 'proprietário do provider'}), verificando apenas conflitos de horário`);
        
        // Buscar apenas os agendamentos existentes para verificar conflitos
        const appointments = await storage.getAppointmentsByDate(providerId, date);
        
        // Calcular horário de término para comparação
        const proposedEndTime = new Date(date.getTime() + service.duration * 60000);
        
        // Verificar se há conflito com algum agendamento existente
        const hasConflict = appointments.some(appointment => {
          if (appointment.status !== AppointmentStatus.CONFIRMED && 
              appointment.status !== AppointmentStatus.PENDING) {
            return false; // Ignora agendamentos cancelados ou concluídos
          }
          
          const appointmentEndTime = appointment.endTime || 
            new Date(appointment.date.getTime() + service.duration * 60000);
          
          // Verifica sobreposição
          return !(proposedEndTime <= appointment.date || date >= appointmentEndTime);
        });
        
        isAvailable = !hasConflict;
        console.log(`Verificação de conflitos: ${hasConflict ? 'CONFLITO DETECTADO' : 'NENHUM CONFLITO'}`);
      } else {
        console.log(`Usuário não autorizado para agendamento privilegiado, usando verificação padrão`);
        isAvailable = await storage.checkAvailability(providerId, date, service.duration);
      }
    } else {
      // Verificação padrão para clientes externos
      isAvailable = await storage.checkAvailability(providerId, date, service.duration);
    }
    
    console.log(`✓ Resultado da verificação: ${isAvailable ? 'DISPONÍVEL' : 'INDISPONÍVEL'}`);
    
    // Adicionar detalhes no retorno para debug
    res.json({ 
      available: isAvailable,
      date: date.toISOString(),
      localDate: date.toLocaleString(),
      serviceId,
      serviceName: service.name,
      duration: service.duration,
      providerId
    });
  });

  // Booking endpoint (for clients)
  app.post("/api/booking", async (req: Request, res: Response) => {
    try {
      console.log("Recebendo dados de agendamento:", JSON.stringify(req.body, null, 2));
      
      // Valida os dados do formulário
      const bookingData = bookingFormSchema.parse(req.body);
      
      let appointmentDate: Date;
      
      try {
        // Tenta analisar a data e hora com tratamento de erro
        if (bookingData.date.includes('-')) {
          // Formato ISO (YYYY-MM-DD) - usando Date.UTC para garantir consistência no fuso horário
          const [year, month, day] = bookingData.date.split('-').map(Number);
          const [hour, minute] = bookingData.time.split(':').map(Number);
        
          if (isNaN(year) || isNaN(month) || isNaN(day) || isNaN(hour) || isNaN(minute)) {
            throw new Error(`Valores inválidos: ano=${year}, mês=${month}, dia=${day}, hora=${hour}, minuto=${minute}`);
          }
          
          // Usamos diretamente o horário informado, sem nenhuma compensação
          // Como queremos trabalhar com o horário de Brasília (GMT-3)
          appointmentDate = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
          console.log(`Usando horário de Brasília: ${hour}:${minute} (dia ${day}/${month}/${year})`);
          
        } else if (bookingData.date.includes('/')) {
          // Formato BR (DD/MM/YYYY) - usando Date.UTC para garantir consistência no fuso horário
          const [day, month, year] = bookingData.date.split('/').map(Number);
          const [hour, minute] = bookingData.time.split(':').map(Number);
        
          if (isNaN(year) || isNaN(month) || isNaN(day) || isNaN(hour) || isNaN(minute)) {
            throw new Error(`Valores inválidos: ano=${year}, mês=${month}, dia=${day}, hora=${hour}, minuto=${minute}`);
          }
        
          // Usamos diretamente o horário informado, sem nenhuma compensação
          // Como queremos trabalhar com o horário de Brasília (GMT-3)
          appointmentDate = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
          console.log(`Usando horário de Brasília: ${hour}:${minute} (dia ${day}/${month}/${year})`);
          
        } else {
          // Tentar como timestamp ou outro formato - usando UTC para consistência
          const baseDate = new Date(bookingData.date);
          const [hour, minute] = bookingData.time.split(':').map(Number);
          
          // Usamos diretamente o horário informado, sem nenhuma compensação
          // Como queremos trabalhar com o horário de Brasília (GMT-3)
          appointmentDate = new Date(Date.UTC(
            baseDate.getFullYear(),
            baseDate.getMonth(),
            baseDate.getDate(),
            hour, minute, 0
          ));
          console.log(`Usando horário de Brasília: ${hour}:${minute} (dia ${baseDate.getDate()}/${baseDate.getMonth()+1}/${baseDate.getFullYear()})`);
        }
        
        if (isNaN(appointmentDate.getTime())) {
          throw new Error(`Data inválida após conversão: ${appointmentDate}`);
        }
        
        console.log("Data processada:", appointmentDate.toISOString());
      } catch (error) {
        console.error("Erro ao processar data e hora:", error);
        return res.status(400).json({ 
          message: "Formato de data ou hora inválido", 
          details: error instanceof Error ? error.message : String(error)
        });
      }
      
      // Busca o serviço para calcular horário de término
      const service = await storage.getService(bookingData.serviceId);
      if (!service) {
        return res.status(404).json({ message: "Serviço não encontrado" });
      }
      
      // Calcula o horário de término baseado na duração do serviço
      const endTime = new Date(appointmentDate.getTime() + service.duration * 60000);
      console.log(`Horário calculado para o agendamento: ${appointmentDate.toLocaleTimeString()} - ${endTime.toLocaleTimeString()}`);
      
      // Verifica disponibilidade
      const isAvailable = await storage.checkAvailability(
        service.providerId,
        appointmentDate,
        service.duration
      );
      
      if (!isAvailable) {
        return res.status(409).json({ message: "Horário indisponível" });
      }
      
      // Obtém cliente existente pelo telefone ou cria um novo
      let client = await storage.getClientByPhone(bookingData.phone);
      
      if (!client) {
        // Se o cliente não existe, cria um novo
        client = await storage.createClient({
          name: bookingData.name,
          phone: bookingData.phone,
          email: "",
          notes: bookingData.notes || ""
        });
      } else {
        // Verifica se o cliente está bloqueado
        if (client.isBlocked) {
          return res.status(403).json({ 
            message: "Cliente bloqueado", 
            error: "Este cliente está impedido de realizar agendamentos"
          });
        }
        
        // Se o cliente já existe mas enviou um nome diferente ou notas diferentes,
        // atualiza os dados do cliente para manter o cadastro atualizado
        if (client.name !== bookingData.name || 
            (bookingData.notes && client.notes !== bookingData.notes)) {
          
          console.log(`Cliente já existente com telefone ${bookingData.phone}.`);
          console.log(`Nome no sistema: "${client.name}" - Nome informado: "${bookingData.name}"`);
          
          // Manteremos o telefone original, mas atualizaremos as notas se forem enviadas
          await storage.updateClient(client.id, {
            // Não atualizamos o nome para manter consistência com o cadastro original
            notes: bookingData.notes || client.notes
          });
          
          // Adicionamos uma nota sobre o nome diferente para referência futura
          if (client.name !== bookingData.name) {
            const notaAdicional = client.notes 
              ? `${client.notes}. Cliente também conhecido como: ${bookingData.name}`
              : `Cliente também conhecido como: ${bookingData.name}`;
            
            await storage.updateClient(client.id, {
              notes: notaAdicional
            });
          }
        }
      }
      
      // Cria o agendamento
      const appointment = await storage.createAppointment({
        providerId: service.providerId,
        clientId: client.id,
        serviceId: bookingData.serviceId,
        date: appointmentDate,
        endTime: endTime,
        status: AppointmentStatus.PENDING,
        notes: bookingData.notes || ""
      });
      
      // Enviar atualização em tempo real via WebSocket
      broadcastUpdate('appointment_created', appointment);
      
      // Criar uma notificação para o prestador de serviço
      const provider = await storage.getProvider(service.providerId);
      if (provider && provider.userId) {
        try {
          // Formatar a data para o padrão DD/MM/YYYY
          const dateFormatter = new Intl.DateTimeFormat('pt-BR', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
          });
          const formattedDate = dateFormatter.format(appointmentDate);
          
          // Criar notificação e obter a notificação criada
          const notification = await storage.createNotification({
            userId: provider.userId,
            title: "Novo agendamento",
            message: `${client.name} agendou ${service.name} para ${formattedDate}`,
            type: 'appointment',
            appointmentId: appointment.id
          });
          console.log(`Notificação criada para o usuário ${provider.userId}`, notification);
          
          // Também enviar atualização em tempo real sobre a nova notificação
          broadcastUpdate('notification_created', { notification, userId: provider.userId });
        } catch (error) {
          console.error("Erro ao criar notificação:", error);
        }
      }
      
      // Aqui enviaríamos uma confirmação via WhatsApp
      console.log(`Agendamento ${appointment.id} criado com sucesso! Confirmação seria enviada para ${client.phone}.`);
      
      res.status(201).json({
        success: true,
        appointment,
        message: "Agendamento realizado com sucesso! Você receberá uma confirmação por WhatsApp em breve."
      });
    } catch (error) {
      console.error("Erro ao processar agendamento do cliente:", error);
      
      if (error instanceof z.ZodError) {
        return res.status(400).json({ 
          message: "Dados de agendamento inválidos", 
          errors: error.errors 
        });
      }
      
      if (error instanceof Error) {
        return res.status(400).json({ 
          message: "Erro ao processar agendamento", 
          details: error.message
        });
      }
      
      res.status(500).json({ message: "Falha ao criar agendamento" });
    }
  });

  // API de notificações
  app.get("/api/notifications", async (req: Request, res: Response) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ error: "Não autenticado" });
    }

    try {
      const notifications = await storage.getNotifications(req.user.id);
      res.json(notifications);
    } catch (error: any) {
      console.error("Erro ao buscar notificações:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/notifications/unread", async (req: Request, res: Response) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ error: "Não autenticado" });
    }

    try {
      const notifications = await storage.getUnreadNotifications(req.user.id);
      res.json(notifications);
    } catch (error: any) {
      console.error("Erro ao buscar notificações não lidas:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.patch("/api/notifications/:id/mark-as-read", async (req: Request, res: Response) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ error: "Não autenticado" });
    }

    const id = parseInt(req.params.id);
    
    try {
      const notification = await storage.markNotificationAsRead(id);
      if (!notification) {
        return res.status(404).json({ error: "Notificação não encontrada" });
      }
      res.json(notification);
    } catch (error: any) {
      console.error("Erro ao marcar notificação como lida:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/notifications/mark-all-as-read", async (req: Request, res: Response) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ error: "Não autenticado" });
    }

    try {
      await storage.markAllNotificationsAsRead(req.user.id);
      res.json({ success: true });
    } catch (error: any) {
      console.error("Erro ao marcar todas notificações como lidas:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // ============== Rotas para Exclusão de Horários ==============
  
  // Obter todas as exclusões de horário de um prestador
  app.get("/api/time-exclusions", loadUserProvider, async (req: Request, res: Response) => {
    try {
      const provider = (req as any).provider;
      
      // Buscar todas as exclusões de horário do prestador
      const exclusions = await storage.getTimeExclusions(provider.id);
      
      res.json(exclusions);
    } catch (error) {
      console.error("Erro ao buscar exclusões de horário:", error);
      res.status(500).json({ message: "Erro ao buscar exclusões de horário" });
    }
  });
  
  // Obter exclusões de horário para um dia específico
  app.get("/api/time-exclusions/day/:dayOfWeek", loadUserProvider, async (req: Request, res: Response) => {
    try {
      const provider = (req as any).provider;
      const dayOfWeek = parseInt(req.params.dayOfWeek);
      
      if (isNaN(dayOfWeek) || dayOfWeek < 1 || dayOfWeek > 7) {
        return res.status(400).json({ message: "Dia da semana inválido. Deve ser um número de 1 a 7." });
      }
      
      // Buscar exclusões para o dia específico
      const exclusions = await storage.getTimeExclusionsByDay(provider.id, dayOfWeek);
      
      res.json(exclusions);
    } catch (error) {
      console.error("Erro ao buscar exclusões de horário para o dia:", error);
      res.status(500).json({ message: "Erro ao buscar exclusões de horário para o dia" });
    }
  });
  
  // Criar uma nova exclusão de horário
  app.post("/api/time-exclusions", loadUserProvider, async (req: Request, res: Response) => {
    try {
      const provider = (req as any).provider;
      
      // Validar os dados recebidos
      // Requisitos: startTime, endTime (formato: "HH:MM")
      const { startTime, endTime, dayOfWeek, name } = req.body;
      
      // Validar formato de hora
      const timeRegex = /^([0-1][0-9]|2[0-3]):([0-5][0-9])$/; // Formato HH:MM (00:00 a 23:59)
      
      if (!startTime || !endTime || !timeRegex.test(startTime) || !timeRegex.test(endTime)) {
        return res.status(400).json({ message: "Formato de hora inválido. Use o formato HH:MM (24h)" });
      }
      
      // Validar que hora de início é antes da hora de fim
      if (startTime >= endTime) {
        return res.status(400).json({ message: "Hora de início deve ser anterior à hora de término" });
      }
      
      // Validar dia da semana se fornecido (permitindo 0 para 'todos os dias')
      if (dayOfWeek !== undefined && dayOfWeek !== null && 
          (isNaN(Number(dayOfWeek)) || (Number(dayOfWeek) !== 0 && (Number(dayOfWeek) < 1 || Number(dayOfWeek) > 7)))) {
        return res.status(400).json({ message: "Dia da semana inválido. Deve ser um número de 1 a 7, 0 para todos os dias, ou nulo." });
      }
      
      // Criar nova exclusão
      const newExclusion = await storage.createTimeExclusion({
        providerId: provider.id,
        startTime,
        endTime,
        dayOfWeek: dayOfWeek !== undefined && dayOfWeek !== null ? Number(dayOfWeek) : null,
        name: name || `Exclusão ${startTime}-${endTime}`,
        isActive: true
      });
      
      res.status(201).json(newExclusion);
    } catch (error) {
      console.error("Erro ao criar exclusão de horário:", error);
      res.status(500).json({ message: "Erro ao criar exclusão de horário" });
    }
  });
  
  // Atualizar uma exclusão de horário
  app.put("/api/time-exclusions/:id", loadUserProvider, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      const provider = (req as any).provider;
      
      if (isNaN(id)) {
        return res.status(400).json({ message: "ID inválido" });
      }
      
      // Buscar a exclusão para verificar se pertence a este prestador
      const exclusion = await storage.getTimeExclusion(id);
      
      if (!exclusion) {
        return res.status(404).json({ message: "Exclusão de horário não encontrada" });
      }
      
      if (exclusion.providerId !== provider.id) {
        return res.status(403).json({ message: "Você não tem permissão para editar esta exclusão de horário" });
      }
      
      // Validar dados
      const { startTime, endTime, dayOfWeek, name, isActive } = req.body;
      
      const updateData: Partial<InsertTimeExclusion> = {};
      
      // Validar e adicionar campos ao objeto de atualização
      if (startTime !== undefined && endTime !== undefined) {
        const timeRegex = /^([0-1][0-9]|2[0-3]):([0-5][0-9])$/;
        
        if (!timeRegex.test(startTime) || !timeRegex.test(endTime)) {
          return res.status(400).json({ message: "Formato de hora inválido. Use o formato HH:MM (24h)" });
        }
        
        if (startTime >= endTime) {
          return res.status(400).json({ message: "Hora de início deve ser anterior à hora de término" });
        }
        
        updateData.startTime = startTime;
        updateData.endTime = endTime;
      } else if (startTime !== undefined || endTime !== undefined) {
        return res.status(400).json({ message: "Hora de início e término devem ser fornecidos juntos" });
      }
      
      if (dayOfWeek !== undefined) {
        if (dayOfWeek === null) {
          updateData.dayOfWeek = null; // Para todos os dias
        } else if (isNaN(Number(dayOfWeek)) || Number(dayOfWeek) < 1 || Number(dayOfWeek) > 7) {
          return res.status(400).json({ message: "Dia da semana inválido. Deve ser um número de 1 a 7, ou nulo para todos os dias." });
        } else {
          updateData.dayOfWeek = Number(dayOfWeek);
        }
      }
      
      if (name !== undefined) {
        updateData.name = name;
      }
      
      if (isActive !== undefined) {
        updateData.isActive = Boolean(isActive);
      }
      
      // Atualizar a exclusão
      const updatedExclusion = await storage.updateTimeExclusion(id, updateData);
      
      res.json(updatedExclusion);
    } catch (error) {
      console.error("Erro ao atualizar exclusão de horário:", error);
      res.status(500).json({ message: "Erro ao atualizar exclusão de horário" });
    }
  });
  
  // Excluir uma exclusão de horário
  app.delete("/api/time-exclusions/:id", loadUserProvider, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      const provider = (req as any).provider;
      
      if (isNaN(id)) {
        return res.status(400).json({ message: "ID inválido" });
      }
      
      // Buscar a exclusão para verificar se pertence a este prestador
      const exclusion = await storage.getTimeExclusion(id);
      
      if (!exclusion) {
        return res.status(404).json({ message: "Exclusão de horário não encontrada" });
      }
      
      if (exclusion.providerId !== provider.id) {
        return res.status(403).json({ message: "Você não tem permissão para excluir esta exclusão de horário" });
      }
      
      // Excluir a exclusão
      await storage.deleteTimeExclusion(id);
      
      res.status(200).json({ message: "Exclusão de horário removida com sucesso" });
    } catch (error) {
      console.error("Erro ao excluir exclusão de horário:", error);
      res.status(500).json({ message: "Erro ao excluir exclusão de horário" });
    }
  });

  // Rota para verificação de código
  app.post("/api/verify-code", async (req: Request, res: Response) => {
    try {
      const { email, code } = req.body;
      
      if (!email || !code) {
        return res.status(400).json({ error: "Email e código são obrigatórios" });
      }
      
      // Buscar o usuário pelo email
      const user = await storage.getUserByEmail(email);
      
      if (!user) {
        // Não indicamos que o usuário não existe por razões de segurança
        return res.status(400).json({ error: "Código inválido ou expirado" });
      }
      
      // Verificar se o código é válido
      const isValid = verifyToken(user.id, code);
      
      if (!isValid) {
        return res.status(400).json({ error: "Código inválido ou expirado" });
      }
      
      // Marcar o email como verificado
      await storage.updateUser(user.id, { 
        isEmailVerified: true,
        verificationToken: null,
        verificationTokenExpiry: null
      });
      
      // Enviar email de boas-vindas após a verificação
      await sendWelcomeEmail(user);
      
      // Iniciar a sessão do usuário (login automático)
      // Atualiza o usuário após a verificação
      const updatedUser = await storage.getUser(user.id);
      
      if (!updatedUser) {
        return res.status(500).json({ error: "Erro ao recuperar dados do usuário" });
      }
      
      // Fazer login automático
      req.login(updatedUser, (err) => {
        if (err) {
          console.error("Erro ao iniciar sessão automática:", err);
          return res.status(200).json({ 
            success: true, 
            message: "Email verificado com sucesso. Por favor, faça login.",
            autoLogin: false
          });
        }
        
        // Retorna sucesso com indicação de login automático
        return res.status(200).json({ 
          success: true, 
          message: "Email verificado com sucesso. Login automático realizado.",
          autoLogin: true,
          user: req.user
        });
      });
    } catch (error) {
      console.error("Erro ao verificar código:", error);
      return res.status(500).json({ error: "Erro ao processar verificação" });
    }
  });
  
  // Rota para reenvio de código de verificação
  app.post("/api/resend-verification", async (req: Request, res: Response) => {
    try {
      const { email } = req.body;
      
      if (!email) {
        return res.status(400).json({ error: "Email é obrigatório" });
      }
      
      // Buscar o usuário pelo email
      const user = await storage.getUserByEmail(email);
      
      if (!user) {
        // Por razões de segurança, não revelamos se o usuário existe ou não
        return res.status(200).json({
          message: "Se o email existir em nosso sistema, um novo código de verificação será enviado."
        });
      }
      
      // Verificar se o email já está verificado
      if (user.isEmailVerified) {
        return res.status(400).json({ error: "Email já foi verificado" });
      }
      
      // Gerar um novo token
      const token = generateVerificationToken(user.id);
      
      // Atualizar o token de verificação no banco de dados
      await storage.updateUser(user.id, {
        verificationToken: token,
        verificationTokenExpiry: new Date(Date.now() + 20 * 60 * 1000) // 20 minutos
      });
      
      // Enviar email com o novo token
      const sent = await sendVerificationEmail(user, token);
      
      if (!sent) {
        return res.status(500).json({ error: "Falha ao enviar email. Tente novamente mais tarde." });
      }
      
      return res.status(200).json({
        message: "Novo código de verificação enviado. Verifique seu email."
      });
    } catch (error) {
      console.error("Erro ao reenviar código de verificação:", error);
      return res.status(500).json({ error: "Erro ao processar reenvio" });
    }
  });

  return httpServer;
}
