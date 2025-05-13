/**
 * Serviço para gerenciar assinaturas e pagamentos
 */
import { db, dbWithQueries } from './db';
import { subscriptionPlans, subscriptionTransactions, users } from '../shared/schema';
import { eq, and, desc, inArray } from 'drizzle-orm';
import { PaymentService } from './payment-service';
import { storage } from './storage';
import { User } from '../shared/schema';
import { MercadoPagoConfig, Payment } from 'mercadopago';

// Instância do serviço de pagamento
const paymentService = new PaymentService();

export class SubscriptionService {
  /**
   * Busca o histórico de assinaturas de um usuário
   */
  async getUserSubscriptionHistory(userId: number) {
    try {
      // Buscar todas as transações do usuário
      const transactions = await db.select()
        .from(subscriptionTransactions)
        .where(eq(subscriptionTransactions.userId, userId))
        .orderBy(desc(subscriptionTransactions.createdAt));

      // Se não houver transações, retornar lista vazia
      if (transactions.length === 0) {
        return [];
      }
      
      // Buscar todos os planos
      const plans = await db.select().from(subscriptionPlans);
      
      // Associar os planos às transações
      const history = transactions.map(transaction => {
        const plan = plans.find(p => p.id === transaction.planId);
        return {
          ...transaction,
          plan: plan || {
            id: transaction.planId,
            name: "Plano não encontrado",
            description: "",
            durationMonths: 1,
            price: transaction.amount,
            isActive: true,
            createdAt: new Date(),
            updatedAt: new Date()
          }
        };
      });
      
      return history;
    } catch (error) {
      console.error(`Erro ao buscar histórico de assinaturas do usuário ${userId}:`, error);
      throw new Error('Não foi possível buscar o histórico de assinaturas');
    }
  }
  /**
   * Busca todos os planos de assinatura ativos
   */
  async getActivePlans() {
    try {
      const plans = await db.select()
        .from(subscriptionPlans)
        .where(eq(subscriptionPlans.isActive, true))
        .orderBy(subscriptionPlans.price);
      
      return plans;
    } catch (error) {
      console.error('Erro ao buscar planos de assinatura:', error);
      throw new Error('Não foi possível buscar os planos de assinatura');
    }
  }
  
  /**
   * Busca um plano específico por ID
   */
  async getPlanById(id: number) {
    try {
      const [plan] = await db.select()
        .from(subscriptionPlans)
        .where(and(
          eq(subscriptionPlans.id, id),
          eq(subscriptionPlans.isActive, true)
        ));
      
      return plan;
    } catch (error) {
      console.error(`Erro ao buscar plano ${id}:`, error);
      throw new Error('Não foi possível buscar o plano de assinatura');
    }
  }
  
  /**
   * Busca todos os planos de assinatura (incluindo inativos) para o admin
   */
  async getAllPlans() {
    try {
      const plans = await db.select()
        .from(subscriptionPlans)
        .orderBy(subscriptionPlans.price);
      
      return plans;
    } catch (error) {
      console.error('Erro ao buscar todos os planos de assinatura:', error);
      throw new Error('Não foi possível buscar os planos de assinatura');
    }
  }
  
  /**
   * Atualiza o preço de um plano de assinatura
   */
  async updatePlanPrice(id: number, price: number) {
    try {
      if (price < 0) {
        throw new Error('O preço não pode ser negativo');
      }
      
      const [updatedPlan] = await db.update(subscriptionPlans)
        .set({ 
          price,
          updatedAt: new Date()
        })
        .where(eq(subscriptionPlans.id, id))
        .returning();
      
      return updatedPlan;
    } catch (error) {
      console.error(`Erro ao atualizar preço do plano ${id}:`, error);
      throw new Error('Não foi possível atualizar o preço do plano');
    }
  }
  
  /**
   * Gera um pagamento PIX para a renovação de assinatura
   */
  async generatePayment(userId: number, planId: number) {
    try {
      // Buscar usuário
      const user = await storage.getUser(userId);
      if (!user) {
        throw new Error('Usuário não encontrado');
      }
      
      // Buscar plano
      const plan = await this.getPlanById(planId);
      if (!plan) {
        throw new Error('Plano não encontrado ou inativo');
      }
      
      // Buscar ou criar provider padrão para processamento do pagamento
      const adminUser = await storage.getUserByUsername('admin');
      if (!adminUser) {
        throw new Error('Usuário admin não encontrado para processamento do pagamento');
      }
      
      const adminProvider = await storage.getProviderByUserId(adminUser.id);
      if (!adminProvider) {
        throw new Error('Provider do admin não encontrado para processamento do pagamento');
      }
      
      // Verificar se o admin tem o token de pagamento configurado
      if (!adminProvider.pixMercadoPagoToken) {
        throw new Error('Token do Mercado Pago não configurado pelo administrador. Configure nas configurações de PIX.');
      }
      
      const tokenToUse = adminProvider.pixMercadoPagoToken;
      console.log(`Gerando pagamento PIX para assinatura usando token do admin`);
      console.log(`Token usado: ${tokenToUse.substring(0, 10)}...`);
      
      // Gerar o pagamento PIX usando o serviço de pagamento
      // Usar diretamente a API do Mercado Pago para garantir que não use o modo de teste
      console.log("Gerando PIX REAL para assinatura");
      
      // Criar cliente do Mercado Pago com o token apropriado
      const config = new MercadoPagoConfig({ accessToken: tokenToUse });
      const paymentClient = new Payment(config);
      
      // Criar preferência de pagamento
      const expiration = new Date();
      expiration.setMinutes(expiration.getMinutes() + 30);
      
      // Ajustar o valor com base na porcentagem configurada
      const formattedAmount = parseFloat((plan.price / 100).toFixed(2));
      
      // Usar número de CPF/CNPJ do provider se disponível
      const identificationNumber = adminProvider.pixIdentificationNumber || "12345678909";
      
      // Criar dados do pagamento
      const paymentData = {
        transaction_amount: formattedAmount,
        description: `Assinatura ${plan.name} - ${plan.durationMonths} mês(es)`,
        payment_method_id: 'pix',
        payer: {
          email: user.email || 'cliente@example.com',
          first_name: user.name.split(' ')[0],
          last_name: user.name.split(' ').slice(1).join(' ') || 'Sobrenome',
          identification: {
            type: "CPF", 
            number: identificationNumber
          }
        },
        notification_url: `https://meuagendamento.replit.app/api/payments/webhook`
      };
      
      console.log("Enviando requisição para Mercado Pago:", JSON.stringify(paymentData, null, 2));
      
      // Criar o pagamento no Mercado Pago
      const result = await paymentClient.create({ body: paymentData });
      
      console.log("Resposta do Mercado Pago:", JSON.stringify(result, null, 2));
      
      // Extrair dados do QR code
      if (!result.id) {
        throw new Error('Falha ao gerar pagamento PIX: ID da transação não retornado pelo Mercado Pago');
      }
      
      const pixResponse = {
        transactionId: result.id.toString(),
        qrCode: result.point_of_interaction?.transaction_data?.qr_code || '',
        qrCodeBase64: result.point_of_interaction?.transaction_data?.qr_code_base64 || '',
        expiresAt: new Date(result.date_of_expiration || expiration)
      };
      
      console.log("PIX gerado com sucesso. ID da transação:", pixResponse.transactionId);
      
      // Salvar a transação no banco de dados
      const [transaction] = await db.insert(subscriptionTransactions)
        .values({
          userId: userId,
          planId: planId,
          amount: plan.price,
          transactionId: pixResponse.transactionId,
          pixQrCode: pixResponse.qrCode,
          pixQrCodeBase64: pixResponse.qrCodeBase64,
          pixQrCodeExpiration: pixResponse.expiresAt,
          paymentMethod: 'pix',
          status: 'pending'
        })
        .returning();
      
      return {
        transactionId: pixResponse.transactionId,
        pixQrCode: pixResponse.qrCode,
        pixQrCodeBase64: pixResponse.qrCodeBase64,
        expiresAt: pixResponse.expiresAt
      };
    } catch (error: any) {
      console.error('Erro ao gerar pagamento para assinatura:', error);
      throw new Error(error.message || 'Não foi possível gerar o pagamento');
    }
  }
  
  /**
   * Verifica o status de um pagamento
   */
  async checkPaymentStatus(transactionId: string) {
    try {
      // Buscar transação
      const [transaction] = await db.select()
        .from(subscriptionTransactions)
        .where(eq(subscriptionTransactions.transactionId, transactionId));
      
      if (!transaction) {
        throw new Error('Transação não encontrada');
      }
      
      // Buscar o token do admin para verificar o pagamento
      const adminUser = await storage.getUserByUsername('admin');
      if (!adminUser) {
        throw new Error('Usuário admin não encontrado para verificar o pagamento');
      }
      
      const adminProvider = await storage.getProviderByUserId(adminUser.id);
      if (!adminProvider) {
        throw new Error('Provider do admin não encontrado para verificar o pagamento');
      }
      
      // Verificar se o admin tem o token de pagamento configurado
      if (!adminProvider.pixMercadoPagoToken) {
        throw new Error('Token do Mercado Pago não configurado pelo administrador. Configure nas configurações de PIX.');
      }
      
      const tokenToUse = adminProvider.pixMercadoPagoToken;
      console.log(`Verificando status de pagamento usando token do admin`);
      console.log(`Token usado: ${tokenToUse.substring(0, 10)}...`);
      
      // Verificar o status do pagamento via Mercado Pago usando o token apropriado
      const paymentStatus = await paymentService.checkPaymentStatus(transactionId, tokenToUse);
      
      // Se o status mudou, atualizar na base
      if (transaction.status !== paymentStatus.status) {
        await this.updateTransactionStatus(transaction.id, paymentStatus.status);
        
        // Se o pagamento foi confirmado, renovar a assinatura
        if (paymentStatus.status === 'paid' || paymentStatus.status === 'confirmed' || paymentStatus.status === 'approved') {
          await this.renewSubscription(transaction.userId, transaction.planId);
        }
      }
      
      return {
        status: paymentStatus.status,
        paidAt: paymentStatus.paid ? new Date() : undefined
      };
    } catch (error) {
      console.error('Erro ao verificar status do pagamento:', error);
      throw new Error('Não foi possível verificar o status do pagamento');
    }
  }
  
  /**
   * Atualiza o status de uma transação
   */
  private async updateTransactionStatus(transactionId: number, status: string, paidAt?: Date) {
    try {
      const updateData: any = { status };
      
      if (status === 'paid' || status === 'confirmed' || status === 'approved') {
        updateData.paidAt = paidAt || new Date();
      }
      
      await db.update(subscriptionTransactions)
        .set(updateData)
        .where(eq(subscriptionTransactions.id, transactionId));
    } catch (error) {
      console.error('Erro ao atualizar status da transação:', error);
      throw new Error('Não foi possível atualizar o status da transação');
    }
  }
  
  /**
   * Renova a assinatura do usuário
   */
  async renewSubscription(userId: number, planId: number) {
    try {
      // Buscar usuário
      const user = await storage.getUser(userId);
      if (!user) {
        throw new Error('Usuário não encontrado');
      }
      
      // Buscar plano
      const plan = await this.getPlanById(planId);
      if (!plan) {
        throw new Error('Plano não encontrado');
      }
      
      // Calcular nova data de expiração
      let baseDate = new Date();
      
      // Se o usuário já tiver uma data de expiração no futuro, usar essa como base
      if (user.subscriptionExpiry) {
        const currentExpiry = new Date(user.subscriptionExpiry);
        if (currentExpiry > baseDate) {
          baseDate = currentExpiry;
        }
      }
      
      // Adicionar meses do plano
      const newExpiryDate = new Date(baseDate);
      newExpiryDate.setMonth(newExpiryDate.getMonth() + plan.durationMonths);
      
      // Atualizar data de expiração do usuário
      await storage.updateUser(userId, {
        subscriptionExpiry: newExpiryDate,
        neverExpires: false
      });
      
      return {
        success: true,
        expiryDate: newExpiryDate
      };
    } catch (error) {
      console.error('Erro ao renovar assinatura:', error);
      throw new Error('Não foi possível renovar a assinatura');
    }
  }
  
  /**
   * Processa um webhook de pagamento (callback do Mercado Pago)
   */
  async processPaymentWebhook(data: any) {
    try {
      // Extrair ID da transação do Mercado Pago
      const mpPaymentId = data?.data?.id;
      if (!mpPaymentId) {
        throw new Error('ID de pagamento não encontrado no webhook');
      }
      
      // Verificar status diretamente (sem usar getPaymentDetails que não existe)
      // Buscar transação baseada no ID do webhook
      const [transaction] = await db.select()
        .from(subscriptionTransactions)
        .where(eq(subscriptionTransactions.transactionId, mpPaymentId.toString()));
      
      if (transaction) {
        // Buscar status atual direto do webhook
        const status = data?.action === 'payment.updated' ? 'approved' : 'pending';
        
        // Atualizar status da transação
        await this.updateTransactionStatus(
          transaction.id,
          status === 'approved' ? 'paid' : status,
          status === 'approved' ? new Date() : undefined
        );
        
        // Se o pagamento foi aprovado, renovar a assinatura
        if (status === 'approved') {
          await this.renewSubscription(transaction.userId, transaction.planId);
        }
        
        return {
          success: true,
          status: status,
          transactionId: transaction.id
        };
      }
      
      return {
        success: false,
        message: 'Transação não encontrada'
      };
    } catch (error) {
      console.error('Erro ao processar webhook de pagamento:', error);
      throw new Error('Não foi possível processar o webhook de pagamento');
    }
  }
}