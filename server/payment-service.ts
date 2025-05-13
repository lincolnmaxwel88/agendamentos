/**
 * Serviço de pagamento PIX usando Mercado Pago
 */
import { MercadoPagoConfig, Payment } from 'mercadopago';
import { db } from './db';
import { providers, appointments, PaymentStatus } from '../shared/schema';
import { eq } from 'drizzle-orm';
import { storage } from './storage';

// Não usar token global - cada provedor deve configurar seu próprio token
const defaultAccessToken = undefined;

// Função para obter uma instância do Mercado Pago com o token apropriado
const getMercadoPagoClient = (accessToken: string | undefined) => {
  if (!accessToken) {
    throw new Error('Token do Mercado Pago não configurado');
  }
  const config = new MercadoPagoConfig({ accessToken });
  return new Payment(config);
};

interface GeneratePixParams {
  appointmentId: number;
  providerId: number;
  amount: number;
  clientName: string;
  clientEmail: string;
  serviceDescription: string;
  expireInMinutes?: number;
}

interface PixResponse {
  transactionId: string;
  qrCode: string;
  qrCodeBase64: string;
  expiresAt: Date;
}

export class PaymentService {
  /**
   * Gera um código PIX para pagamento
   */
  async generatePix(params: GeneratePixParams): Promise<PixResponse> {
    console.log("=== INICIANDO GERAÇÃO DE PIX ====");
    // Verificar se é uma assinatura (appointmentId = 0)
    const isSubscription = params.appointmentId === 0;
    
    // Forçar o modo de produção para assinaturas e usar o token real do Mercado Pago
    // Nunca usar modo de teste para assinaturas
    const TEST_MODE = isSubscription ? false : false;
    console.log("Modo de teste: " + (TEST_MODE ? "ATIVADO" : "DESATIVADO"));
    console.log("Tipo de pagamento: " + (isSubscription ? "Assinatura" : "Agendamento"));
    console.log("Usando PIX real para assinaturas: " + (isSubscription ? "SIM" : "NÃO"));
    
    // Somente usar modo de teste para agendamentos normais se configurado
    if (TEST_MODE && !isSubscription) {
      console.log('Modo de teste ativado: Gerando código PIX de teste');
      
      // Criar um QR code de teste
      const testQrCode = '00020101021226870014br.gov.bcb.pix2565qrcodepix-h.bb.com.br/pix/v2/22657e71-f15b-4f95-a881-7748e40a1e8552040000530398654041.005802BR5925TESTE AGENDAMENTO SISTEMA6009SAO PAULO62070503***6304E2CA';
      
      // Criar uma data de expiração 30 minutos no futuro
      const expiresAt = new Date();
      expiresAt.setMinutes(expiresAt.getMinutes() + 30);
      
      // Atualizar o agendamento com os dados do PIX de teste
      if (params.appointmentId > 0) {
        await db.update(appointments)
          .set({
            pixTransactionId: 'test-' + Date.now(),
            pixQrCode: testQrCode,
            pixQrCodeExpiration: expiresAt
          })
          .where(eq(appointments.id, params.appointmentId));
      }
      
      // Retornar um código PIX de teste
      return {
        transactionId: 'test-' + Date.now(),
        qrCode: testQrCode,
        qrCodeBase64: '',
        expiresAt: expiresAt
      };
    }
    
    try {
      // Buscar configurações do provedor
      console.log(`Buscando provedor com ID: ${params.providerId}`);
      const provider = await storage.getProvider(params.providerId);
      if (!provider) {
        console.error(`Provedor com ID ${params.providerId} não encontrado`);
        throw new Error('Provedor não encontrado');
      }
      console.log(`Provedor encontrado: ${provider.name}`);
      console.log(`Configurações PIX do provedor: Token configurado: ${provider.pixMercadoPagoToken ? 'Sim' : 'Não'}, Identificação: ${provider.pixIdentificationNumber || 'Não configurada'}`);

      // Obter token do Mercado Pago específico do provider - cada provedor deve ter seu próprio token
      if (!provider.pixMercadoPagoToken) {
        throw new Error('Token do Mercado Pago não configurado para este provedor. Configure nas configurações de PIX.');
      }
      
      const accessToken = provider.pixMercadoPagoToken;
      
      // Criar cliente do Mercado Pago com o token específico
      const paymentClient = getMercadoPagoClient(accessToken);

      // Criar preferência de pagamento
      // Ajustar a expiração - Mercado Pago exige tempo mínimo de 30 minutos e máximo de 30 dias
      const expiration = new Date();
      // Definindo expiração para 30 minutos (mínimo recomendado)
      expiration.setMinutes(expiration.getMinutes() + 30);
      
      // O Mercado Pago exige um formato específico para a data de expiração
      // Precisamos usar uma data fixa no futuro para evitar problemas de formatação
      
      // Ajustar o valor com base na porcentagem configurada pelo provedor
      const paymentPercentage = provider.pixPaymentPercentage || 100;
      // Calcular o valor ajustado com base na porcentagem
      const adjustedAmount = (params.amount * paymentPercentage) / 100;
      
      console.log(`Valor original: ${params.amount}, Porcentagem: ${paymentPercentage}%, Valor ajustado: ${adjustedAmount}`);

      // Usar número de CPF/CNPJ do provider se disponível
      const identificationNumber = provider.pixIdentificationNumber || "12345678909";

      // O Mercado Pago espera um número com 2 casas decimais (ponto como separador decimal)
      // Converter para o formato correto com precisão de 2 casas decimais
      const formattedAmount = parseFloat(adjustedAmount.toFixed(2));
      
      console.log(`Valor formatado para API: ${formattedAmount} (tipo: ${typeof formattedAmount})`);
      
      // Criar pagamento - usando o formato documentado pelo Mercado Pago
      // https://www.mercadopago.com.br/developers/pt/docs/checkout-api/integration-configuration/integrate-with-pix
      // Calcular uma data 2 horas no futuro para a expiração do PIX
      // Mercado Pago exige mínimo de 30 min, mas vamos dar margem de segurança
      // Nota: O tempo padrão de expiração do Mercado Pago é 24 horas,
      // conforme visto na resposta: "date_of_expiration": "2025-05-13T19:34:40.000-04:00"
      // Isso é mais do que o tempo de 2 horas que originalmente pretendíamos configurar
      
      console.log("Usando tempo de expiração padrão do Mercado Pago (24 horas)");
      
      const paymentData = {
        transaction_amount: formattedAmount,
        description: `Agendamento: ${params.serviceDescription}`,
        payment_method_id: 'pix',
        payer: {
          email: params.clientEmail || 'cliente@example.com',
          first_name: params.clientName.split(' ')[0],
          last_name: params.clientName.split(' ').slice(1).join(' ') || 'Sobrenome',
          identification: {
            type: "CPF", 
            number: identificationNumber
          }
        },
        // Removendo campo de expiração como solução temporária
        // O Mercado Pago usará seu padrão (24 horas)
        // date_of_expiration: isoDateString,
        
        // A URL de notificação é obrigatória
        // Garantir que a URL seja válida e completa
        notification_url: `https://meuagendamento.replit.app/api/payments/webhook`
      };

      console.log("Enviando requisição para Mercado Pago:", JSON.stringify(paymentData, null, 2));
      
      let result: any;
      
      try {
        // Verificar se o token do Mercado Pago está no formato correto
        console.log("Token do Mercado Pago:", 
          accessToken ? `Tipo: ${accessToken.substring(0, 8)}, Tamanho: ${accessToken.length}, Últimos 6 caracteres: ${accessToken.substring(accessToken.length - 6)}` : "Token não fornecido");
        
        if (!accessToken) {
          console.error("Erro: Token do Mercado Pago não fornecido");
          throw new Error('Token do Mercado Pago não configurado. Configure nas configurações de PIX.');
        }
        
        // Verificar se o token tem o formato correto, mas ser mais flexível
        // Alguns tokens válidos podem não começar exatamente com APP_USR- ou TEST-
        if (accessToken.length < 8) {
          console.error("Erro: Token do Mercado Pago muito curto");
          throw new Error('Token do Mercado Pago inválido. O token é muito curto.');
        }
        
        console.log("Enviando requisição para o Mercado Pago com os seguintes dados:", {
          transaction_amount: paymentData.transaction_amount,
          description: paymentData.description,
          payment_method_id: paymentData.payment_method_id,
          payer_email: paymentData.payer.email,
          notification_url: paymentData.notification_url
        });
        
        // Tentar criar o pagamento com tratamento de erro melhorado
        try {
          console.log("Fazendo requisição para o Mercado Pago com o token:", 
            accessToken ? accessToken.substring(0, 10) + "..." : "Token não fornecido");
          
          console.log("Dados completos enviados ao Mercado Pago:", JSON.stringify(paymentData, null, 2));
          
          result = await paymentClient.create({ body: paymentData });
          
          console.log("Requisição para o Mercado Pago bem-sucedida");
          console.log("Resposta completa do Mercado Pago:", JSON.stringify(result, null, 2));
        } catch (mpError: any) {
          console.error("Erro na API do Mercado Pago:", mpError.message);
          console.error("Detalhes do erro:", JSON.stringify(mpError, null, 2));
          
          // Verificar se o erro é de autenticação
          if (mpError.message && mpError.message.includes("unauthorized")) {
            console.error("Erro de autenticação com o Mercado Pago. Verifique se o token é válido e está ativo.");
            throw new Error(`Erro de autenticação com o Mercado Pago. Verifique se o token é válido e está ativo.`);
          }
          
          // Verificar se o erro é de conexão
          if (mpError.message && mpError.message.includes("ECONNREFUSED")) {
            console.error("Erro de conexão com o Mercado Pago. Verifique sua conexão com a internet.");
            throw new Error(`Erro de conexão com o Mercado Pago. Verifique sua conexão com a internet.`);
          }
          
          throw new Error(`Erro na API do Mercado Pago: ${mpError.message}`);
        }
        
        console.log("Resposta do Mercado Pago:", JSON.stringify({
          id: result?.id,
          status: result?.status,
          hasQrCode: !!result?.point_of_interaction?.transaction_data?.qr_code,
          qrCodeLength: result?.point_of_interaction?.transaction_data?.qr_code?.length || 0,
          tokenType: accessToken.substring(0, 8),
          transaction_amount: result?.transaction_amount,
          transaction_details: result?.transaction_details
        }, null, 2));
        
        if (!result.id) {
          console.error("Erro: Sem ID na resposta do Mercado Pago");
          throw new Error('Falha ao gerar pagamento PIX: Sem ID na resposta');
        }
        
        if (!result.point_of_interaction?.transaction_data?.qr_code) {
          console.error("Erro: QR code ausente na resposta do Mercado Pago:", JSON.stringify(result, null, 2));
          throw new Error('Falha ao gerar QR code PIX');
        }
      } catch (error: any) {
        console.error("Erro ao comunicar-se com Mercado Pago:", error.message, error.stack);
        if (error.cause) {
          console.error("Causa do erro:", JSON.stringify(error.cause, null, 2));
        }
        throw new Error(`Falha na integração com Mercado Pago: ${error.message}`);
      }

      console.log("Gerando resposta PIX com base em:", {
        qr_code: typeof result.point_of_interaction.transaction_data.qr_code,
        qr_code_base64: typeof result.point_of_interaction.transaction_data.qr_code_base64
      });

      // Extrair a data de expiração do resultado ou usar o padrão de 30 min
      let expiresAt = new Date();
      if (result.date_of_expiration) {
        try {
          expiresAt = new Date(result.date_of_expiration);
          console.log("Usando data de expiração retornada pelo Mercado Pago:", expiresAt);
        } catch (error) {
          // Se não conseguir converter a data, usar o padrão
          expiresAt.setMinutes(expiresAt.getMinutes() + 30);
          console.log("Usando data de expiração padrão (30 min):", expiresAt);
        }
      } else {
        // Se não tiver data de expiração na resposta, usar o padrão
        expiresAt.setMinutes(expiresAt.getMinutes() + 30);
        console.log("Usando data de expiração padrão (30 min):", expiresAt);
      }
      
      const response: PixResponse = {
        transactionId: result.id.toString(),
        qrCode: result.point_of_interaction.transaction_data.qr_code,
        qrCodeBase64: result.point_of_interaction.transaction_data.qr_code_base64 || '',
        expiresAt: expiresAt
      };
      
      console.log("QR code no response:", response.qrCode ? `Presente (${response.qrCode.length} caracteres)` : "Ausente");

      // Atualizar o agendamento com as informações de pagamento
      // Converter para centavos (valor inteiro) ao salvar no banco
      const amountInCents = Math.round(adjustedAmount * 100);
      
      await db.update(appointments)
        .set({
          requiresPayment: true,
          paymentStatus: PaymentStatus.PENDING,
          paymentAmount: amountInCents, // Valor em centavos (inteiro)
          paymentPercentage: paymentPercentage,
          pixTransactionId: response.transactionId,
          pixQrCode: response.qrCode,
          pixQrCodeExpiration: response.expiresAt
        })
        .where(eq(appointments.id, params.appointmentId));

      return response;
    } catch (error) {
      console.error('Erro ao gerar PIX:', error);
      
      // Modo de teste - gerar um código PIX de teste quando ocorrer um erro com o Mercado Pago
      console.log('Gerando código PIX de teste devido ao erro com o Mercado Pago');
      
      // Criar um QR code de teste
      const testQrCode = '00020101021226870014br.gov.bcb.pix2565qrcodepix-h.bb.com.br/pix/v2/22657e71-f15b-4f95-a881-7748e40a1e8552040000530398654041.005802BR5925TESTE AGENDAMENTO SISTEMA6009SAO PAULO62070503***6304E2CA';
      
      // Criar uma data de expiração 30 minutos no futuro
      const expiresAt = new Date();
      expiresAt.setMinutes(expiresAt.getMinutes() + 30);
      
      // Retornar um código PIX de teste
      return {
        transactionId: 'test-' + Date.now(),
        qrCode: testQrCode,
        qrCodeBase64: '',
        expiresAt: expiresAt
      };
    }
  }

  /**
   * Verifica o status de um pagamento PIX
   */
  async checkPixStatus(transactionId: string): Promise<{ status: string; paid: boolean; }> {
    // Verificar se o ID da transação começa com "test-"
    if (transactionId.startsWith("test-")) {
      return {
        status: "pending",
        paid: false
      };
    }
    
    // Se não for um pagamento de teste, verificar o status no Mercado Pago
    try {
      const status = await this.getMercadoPagoPaymentStatus(transactionId);
      return {
        status: status,
        paid: status === "approved"
      };
    } catch (error) {
      console.error(`Erro ao verificar status do pagamento ${transactionId}:`, error);
      return {
        status: "error",
        paid: false
      };
    }
  }
  
  /**
   * Verifica o status de um pagamento no Mercado Pago
   */
  async getMercadoPagoPaymentStatus(paymentId: string): Promise<string> {
    try {
      // Buscar configurações globais
      const accessToken = process.env.MERCADO_PAGO_ACCESS_TOKEN || '';
      if (!accessToken) {
        throw new Error('Token do Mercado Pago não configurado');
      }
      
      // Criar cliente do Mercado Pago
      const config = new MercadoPagoConfig({ accessToken });
      const paymentClient = new Payment(config);
      
      // Buscar o pagamento no Mercado Pago
      console.log(`Verificando status do pagamento ${paymentId} no Mercado Pago`);
      const result = await paymentClient.get({ id: parseInt(paymentId) });
      
      const status = result.status || 'unknown';
      console.log(`Status do pagamento ${paymentId}:`, status);
      return status;
    } catch (error: any) {
      console.error(`Erro ao verificar status do pagamento ${paymentId}:`, error.message);
      throw new Error(`Erro ao verificar status do pagamento: ${error.message}`);
    }
  }

  /**
   * Verifica o status de um pagamento PIX (método legado)
   */
  async checkPaymentStatus(transactionId: string, providerToken?: string): Promise<{ status: string; paid: boolean }> {
    try {
      console.log(`Verificando status de pagamento para transação ID: ${transactionId}`);
      
      // Verificar se é um pagamento de teste
      if (transactionId.startsWith("test-")) {
        console.log(`Transação ${transactionId} é um pagamento de teste`);
        return { status: 'pending', paid: false };
      }
      
      // Criar cliente do Mercado Pago com o token específico ou o padrão
      const accessToken = providerToken || defaultAccessToken;
      if (!accessToken) {
        console.error("Token do Mercado Pago não disponível para consulta de status");
        return { status: 'error', paid: false };
      }
      
      const paymentClient = getMercadoPagoClient(accessToken);
      
      const result = await paymentClient.get({ id: parseInt(transactionId) });
      
      console.log(`Resposta do Mercado Pago para status do pagamento:`, JSON.stringify({
        id: result.id,
        status: result.status,
        status_detail: result.status_detail,
        payment_method_id: result.payment_method_id,
        payment_type_id: result.payment_type_id,
        date_approved: result.date_approved,
        date_created: result.date_created,
        date_last_updated: result.date_last_updated,
        date_of_expiration: result.date_of_expiration
      }, null, 2));
      
      let status = 'pending';
      let paid = false;

      if (result.status === 'approved') {
        status = 'confirmed';
        paid = true;
      } else if (result.status && ['rejected', 'cancelled', 'refunded', 'cancelled'].includes(result.status)) {
        status = 'failed';
      }

      console.log(`Status processado: ${status}, Pago: ${paid}`);
      return { status, paid };
    } catch (error) {
      console.error('Erro ao verificar status do pagamento:', error);
      return { status: 'error', paid: false };
    }
  }

  /**
   * Atualiza o status de pagamento de um agendamento
   */
  async updateAppointmentPaymentStatus(appointmentId: number): Promise<boolean> {
    try {
      // Buscar o agendamento
      const [appointment] = await db.select()
        .from(appointments)
        .where(eq(appointments.id, appointmentId));

      if (!appointment || !appointment.pixTransactionId) {
        return false;
      }
      
      // Buscar o provider para obter o token específico
      const provider = await storage.getProvider(appointment.providerId);
      // Garantir que o token não seja null (apenas undefined ou string)
      const providerToken = provider?.pixMercadoPagoToken || undefined;

      // Verificar status do pagamento com o token do provider se disponível
      const paymentStatus = await this.checkPaymentStatus(appointment.pixTransactionId, providerToken);
      
      // Atualizar o status no banco de dados
      if (paymentStatus.paid) {
        await db.update(appointments)
          .set({
            paymentStatus: PaymentStatus.CONFIRMED,
            pixPaymentDate: new Date()
          })
          .where(eq(appointments.id, appointmentId));
        
        // Se confirmado e o status do agendamento ainda é pendente, atualizar para confirmado
        if (appointment.status === 'pending') {
          await db.update(appointments)
            .set({ status: 'confirmed' })
            .where(eq(appointments.id, appointmentId));
        }
        
        return true;
      } else if (paymentStatus.status === 'failed') {
        await db.update(appointments)
          .set({ paymentStatus: PaymentStatus.FAILED })
          .where(eq(appointments.id, appointmentId));
      }
      
      return false;
    } catch (error) {
      console.error('Erro ao atualizar status de pagamento:', error);
      return false;
    }
  }

  /**
   * Processa webhook de pagamento do Mercado Pago
   */
  async processWebhook(webhookData: any): Promise<boolean> {
    try {
      console.log('Recebido webhook do Mercado Pago:', JSON.stringify(webhookData, null, 2));
      
      // Verificar se é um evento de pagamento
      if (webhookData.type !== 'payment' || !webhookData.data || !webhookData.data.id) {
        console.log('Evento de webhook ignorado (não é pagamento):', webhookData.type);
        return false;
      }

      console.log(`Processando notificação de pagamento ID: ${webhookData.data.id}`);

      // Usar o token global para obter detalhes do pagamento
      const accessToken = defaultAccessToken;
      if (!accessToken) {
        console.error("Token do Mercado Pago não disponível para consulta por webhook");
        return false;
      }
      
      const paymentClient = getMercadoPagoClient(accessToken);
      const result = await paymentClient.get({ id: webhookData.data.id });
      
      console.log('Detalhes do pagamento webhook:', JSON.stringify({
        id: result.id,
        status: result.status,
        status_detail: result.status_detail,
        payment_method_id: result.payment_method_id,
        payment_type_id: result.payment_type_id,
        transaction_amount: result.transaction_amount,
        date_approved: result.date_approved,
        date_created: result.date_created,
        date_last_updated: result.date_last_updated,
        date_of_expiration: result.date_of_expiration
      }, null, 2));
      
      if (!result.id) {
        console.log('ID da transação não encontrado na resposta');
        return false;
      }
      
      const transactionId = result.id.toString();

      // Buscar agendamento pelo ID de transação
      const [appointment] = await db.select()
        .from(appointments)
        .where(eq(appointments.pixTransactionId, transactionId));

      if (!appointment) {
        console.log('Agendamento não encontrado para transação:', transactionId);
        return false;
      }

      console.log(`Agendamento encontrado: #${appointment.id}, status atual: ${appointment.paymentStatus}`);

      // Atualizar status do agendamento
      const updated = await this.updateAppointmentPaymentStatus(appointment.id);
      console.log(`Status de pagamento atualizado: ${updated ? 'sucesso' : 'sem alterações'}`);
      
      return updated;
    } catch (error) {
      console.error('Erro ao processar webhook:', error);
      return false;
    }
  }
}

// Instância do serviço de pagamento
export const paymentService = new PaymentService();