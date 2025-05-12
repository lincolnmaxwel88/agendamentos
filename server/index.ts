import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { setupVite, serveStatic, log } from "./vite";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      if (logLine.length > 80) {
        logLine = logLine.slice(0, 79) + "…";
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  try {
    // Log para fins de depuração, mostra o ambiente
    console.log(`Ambiente: ${process.env.NODE_ENV}`);
    console.log(`DATABASE_URL disponível: ${!!process.env.DATABASE_URL}`);
    console.log(`Porta configurada: ${process.env.PORT || 5000}`);
    
    // Registra as rotas da API
    const server = await registerRoutes(app);

    // Middleware de tratamento de erros
    app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
      const status = err.status || err.statusCode || 500;
      const message = err.message || "Internal Server Error";
      console.error("Erro na aplicação:", err);
      res.status(status).json({ message });
    });

    // Rota especial para redirecionamento da verificação direta para API
    app.get('/verify-email-direct/:token', (req, res) => {
      const token = req.params.token;
      const email = req.query.email as string;
      console.log(`Redirecionando verificação de email para API: ${req.url}`);
      res.redirect(`/api/verify-email-direct/${token}?email=${encodeURIComponent(email)}`);
    });

    // Configuração do frontend
    if (app.get("env") === "development") {
      console.log("Configurando ambiente de desenvolvimento (Vite)");
      await setupVite(app, server);
    } else {
      console.log("Configurando ambiente de produção (arquivos estáticos)");
      serveStatic(app);
    }
    
    // Rota específica para verificação de email
    app.get('/verify-email/:token', (req, res) => {
      console.log(`Interceptando rota de verificação de email: ${req.url}`);
      // Sempre envia o index.html para permitir que o React Router processe a rota
      if (app.get("env") === "development") {
        res.redirect('/');
      } else {
        res.sendFile('index.html', { root: './dist/client' });
      }
    });

    // Rota de fallback para capturar todos os caminhos não tratados
    app.get('*', (req, res) => {
      if (app.get("env") === "development") {
        // No desenvolvimento, deixa o Vite lidar com isso
        res.status(404).send('Página não encontrada');
      } else {
        // Em produção, serve o index.html para suportar client-side routing
        res.sendFile('index.html', { root: './dist/client' });
      }
    });

    // Use a porta do ambiente ou 3000 como fallback
    const port = process.env.PORT ? parseInt(process.env.PORT) : 3000;
    server.listen(port, "localhost", () => {
      log(`Servidor rodando na porta ${port} em modo ${app.get("env")}`);
    });
  } catch (error) {
    console.error("Erro fatal durante a inicialização do servidor:", error);
    // Não deixa o processo morrer silenciosamente
    process.exit(1);
  }
})();
