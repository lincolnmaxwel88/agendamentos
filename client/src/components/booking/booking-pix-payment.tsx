import React, { useState, useEffect, useRef } from "react";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2, CheckCircle2, AlertTriangle, RefreshCw, Clock } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import QRCode from "qrcode";
import { Progress } from "@/components/ui/progress";
import { PaymentStatusChecker } from "@/components/payment/payment-status-checker";

interface BookingPixPaymentProps {
  appointmentId: number;
  providerId: number;
  servicePrice: number;
  serviceName: string;
  onPaymentComplete: (status?: string) => void;
  onCancel: () => void;
}

interface PixResponse {
  transactionId: string;
  qrCode: string;
  qrCodeBase64: string;
  expiresAt: string;
  adjustedAmount?: number;
  paymentPercentage?: number;
}

const BookingPixPayment: React.FC<BookingPixPaymentProps> = ({
  appointmentId,
  providerId,
  servicePrice,
  serviceName,
  onPaymentComplete,
  onCancel
}) => {
  const { toast } = useToast();
  const [pixData, setPixData] = useState<PixResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);
  const [paymentStatus, setPaymentStatus] = useState<string>("pending");
  const [error, setError] = useState<string | null>(null);
  const [checkTimer, setCheckTimer] = useState<NodeJS.Timeout | null>(null);
  const [qrCodeUrl, setQrCodeUrl] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [timeRemaining, setTimeRemaining] = useState<number>(7200); // 2 horas em segundos
  const [progressValue, setProgressValue] = useState<number>(100);
  const [isCancelling, setIsCancelling] = useState<boolean>(false);

  // Gerar código PIX ao carregar o componente
  useEffect(() => {
    generatePixCode();
    
    // Limpar timer ao desmontar
    return () => {
      if (checkTimer) clearInterval(checkTimer);
    };
  }, []);

  // Verificar status de pagamento periodicamente
  useEffect(() => {
    if (pixData?.transactionId && paymentStatus !== "confirmed" && paymentStatus !== "paid") {
      // Configurar checagem a cada 5 segundos
      console.log("Iniciando verificação automática de pagamento a cada 5 segundos...");
      const timer = setInterval(() => {
        console.log("Verificando status de pagamento automaticamente...");
        checkPaymentStatus();
      }, 5000);
      setCheckTimer(timer);
      
      return () => clearInterval(timer);
    }
  }, [pixData, paymentStatus]);
  
  // Gerar QR Code quando o pixData for atualizado
  useEffect(() => {
    if (pixData?.qrCode) {
      generateQRCode(pixData.qrCode);
    }
  }, [pixData]);

  // Timer de expiração para o PIX
  useEffect(() => {
    // Iniciar temporizador de 5 minutos quando o código PIX é gerado
    if (pixData && paymentStatus !== "paid") {
      const countdownTimer = setInterval(() => {
        setTimeRemaining(prev => {
          if (prev <= 1) {
            clearInterval(countdownTimer);
            // Quando o timer chegar a zero, cancelar o agendamento automaticamente
            handleCancelPayment();
            return 0;
          }
          const newValue = prev - 1;
          setProgressValue((newValue / 1800) * 100); // 1800 = 30 minutos em segundos
          return newValue;
        });
      }, 1000);

      return () => clearInterval(countdownTimer);
    }
  }, [pixData, paymentStatus]);
  
  // Função para cancelar o pagamento
  const handleCancelPayment = async () => {
    if (isCancelling) return;
    
    setIsCancelling(true);
    try {
      // Faz a requisição para a API de cancelamento
      const response = await apiRequest('POST', `/api/payments/${appointmentId}/cancel`);
      
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Falha ao cancelar agendamento');
      }
      
      toast({
        title: "Agendamento cancelado",
        description: "Você cancelou o pagamento e o agendamento foi cancelado",
        variant: "destructive",
      });
      
      // Chama a função de callback para o componente pai
      onCancel();
    } catch (error: any) {
      console.error("Erro ao cancelar agendamento:", error);
      toast({
        title: "Erro ao cancelar",
        description: error.message || "Ocorreu um erro ao cancelar o agendamento.",
        variant: "destructive",
      });
      
      // Mesmo com erro, voltar para o fluxo anterior
      onCancel();
    } finally {
      setIsCancelling(false);
    }
  };
  
  // Função para gerar o QR Code usando a biblioteca qrcode
  const generateQRCode = async (text: string) => {
    try {
      console.log("Gerando QR code para texto:", text);
      const url = await QRCode.toDataURL(text, {
        width: 200,
        margin: 2
      });
      console.log("QR code gerado com sucesso");
      setQrCodeUrl(url);
    } catch (error) {
      console.error("Erro ao gerar QR Code:", error);
      setError("Não foi possível gerar o QR Code");
    }
  };

  // Gerar um novo código PIX
  const generatePixCode = async () => {
    setIsGenerating(true);
    setError(null);
    
    try {
      console.log("Gerando PIX para agendamento:", appointmentId, "no valor:", servicePrice / 100);

      const response = await apiRequest('POST', '/api/payments/generate-pix', {
        appointmentId,
        amount: servicePrice / 100, // Convertendo de centavos para reais
        providerId,
      });
      
      console.log("Resposta do servidor PIX:", response.status);
      
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Falha ao gerar PIX');
      }
      
      const data = await response.json();
      console.log("Dados PIX recebidos:", {
        transactionId: data.transactionId,
        hasQrCode: !!data.qrCode,
        hasQrCodeBase64: !!data.qrCodeBase64,
        qrCodeLength: data.qrCode?.length || 0,
      });
      
      setPixData(data);
      setPaymentStatus("pending");
      
      // Gerar QR code localmente quando não recebemos do Mercado Pago
      if (data.qrCode && !data.qrCodeBase64) {
        generateQRCode(data.qrCode);
      }
      
      toast({
        title: "Código PIX gerado",
        description: "Escaneie o QR Code para realizar o pagamento.",
      });
    } catch (error: any) {
      console.error("Erro ao gerar PIX:", error);
      setError(error.message || "Não foi possível gerar o código PIX");
      toast({
        title: "Erro ao gerar PIX",
        description: error.message || "Ocorreu um erro ao gerar o código PIX.",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
      setIsGenerating(false);
    }
  };

  // Verificar se o pagamento foi realizado
  const checkPaymentStatus = async () => {
    if (!pixData?.transactionId || paymentStatus === "paid") return;
    
    try {
      console.log("Verificando pagamento da transação:", pixData.transactionId);
      const response = await apiRequest('GET', `/api/payments/${appointmentId}/status`);
      const data = await response.json();
      
      console.log("Resposta da verificação de pagamento:", data);
      
      // Atualizar status do pagamento
      const newStatus = data.paymentStatus;
      setPaymentStatus(newStatus);
      
      // Atualizar informações de valor e porcentagem se disponíveis
      if (data.paymentAmount && pixData) {
        const updatedPixData = {
          transactionId: pixData.transactionId,
          qrCode: pixData.qrCode,
          qrCodeBase64: pixData.qrCodeBase64,
          expiresAt: pixData.expiresAt,
          adjustedAmount: data.paymentAmount,
          paymentPercentage: data.paymentPercentage || 100
        };
        setPixData(updatedPixData);
      }
      
      // Se o pagamento foi concluído (confirmed, paid ou approved)
      if (newStatus === "confirmed" || newStatus === "paid" || newStatus === "approved") {
        if (checkTimer) clearInterval(checkTimer);
        toast({
          title: "Pagamento confirmado!",
          description: "Seu pagamento foi recebido com sucesso!",
        });
        // Passar o status do pagamento para o componente pai
        onPaymentComplete(newStatus);
      }
    } catch (error) {
      console.error("Erro ao verificar status do pagamento:", error);
      toast({
        title: "Erro ao verificar pagamento",
        description: "Não foi possível verificar o status do pagamento. Tente novamente.",
        variant: "destructive",
      });
    }
  };

  // Renderizar o estado de carregamento
  if (isLoading && !pixData) {
    return (
      <Card className="w-full max-w-md mx-auto my-4">
        <CardContent className="pt-6 flex flex-col items-center justify-center min-h-[300px]">
          <Loader2 className="h-8 w-8 animate-spin text-primary mb-4" />
          <p className="text-center text-gray-600">Gerando código de pagamento...</p>
        </CardContent>
      </Card>
    );
  }

  // Renderizar o estado de erro
  if (error && !pixData) {
    return (
      <Card className="w-full max-w-md mx-auto my-4">
        <CardContent className="pt-6 flex flex-col items-center justify-center min-h-[300px]">
          <AlertTriangle className="h-12 w-12 text-destructive mb-4" />
          <h3 className="text-lg font-medium mb-2">Erro ao gerar pagamento</h3>
          <p className="text-center text-gray-600 mb-4">{error}</p>
          <Button onClick={generatePixCode} disabled={isGenerating}>
            {isGenerating ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Gerando...
              </>
            ) : (
              <>
                <RefreshCw className="mr-2 h-4 w-4" />
                Tentar novamente
              </>
            )}
          </Button>
        </CardContent>
        <CardFooter className="flex justify-center pb-6">
          <Button variant="outline" onClick={onCancel} className="w-full">
            Cancelar
          </Button>
        </CardFooter>
      </Card>
    );
  }

  // Renderizar o pagamento confirmado
  if (paymentStatus === "paid") {
    return (
      <Card className="w-full max-w-md mx-auto my-4">
        <CardContent className="pt-6 flex flex-col items-center justify-center min-h-[300px]">
          <CheckCircle2 className="h-16 w-16 text-green-500 mb-4" />
          <h3 className="text-xl font-medium mb-2">Pagamento confirmado!</h3>
          <p className="text-center text-gray-600">
            Seu pagamento foi processado com sucesso.
          </p>
        </CardContent>
        <CardFooter className="flex justify-center pb-6">
          <Button 
            onClick={() => onPaymentComplete('paid')} 
            className="w-full"
          >
            Continuar
          </Button>
        </CardFooter>
      </Card>
    );
  }

  // Renderizar o QR Code para pagamento
  return (
    <Card className="w-full max-w-md mx-auto my-4">
      <CardContent className="pt-6">
        <div className="flex flex-col items-center text-center">
          <h3 className="text-lg font-medium mb-4">Pagamento PIX</h3>
          <p className="text-sm text-gray-600 mb-6">
            Escaneie o QR Code abaixo para finalizar seu agendamento de {serviceName}
          </p>
          
          {pixData && (
            <div className="bg-white p-4 rounded-lg border mb-4">
              {pixData.qrCodeBase64 ? (
                <>
                <img 
                  src={`data:image/png;base64,${pixData.qrCodeBase64}`} 
                  alt="QR Code PIX" 
                  className="mx-auto"
                  style={{ maxWidth: "200px", height: "auto" }}
                />
                <p className="text-xs text-center mt-1 text-gray-500">QR code original do Mercado Pago</p>
                <p className="text-xs text-center mt-1 text-amber-600 font-medium">É necessário ter configurado o webhook no painel Mercado Pago</p>
                </>
              ) : qrCodeUrl ? (
                <div className="flex flex-col items-center">
                  <img 
                    src={qrCodeUrl} 
                    alt="QR Code PIX" 
                    className="mx-auto"
                    style={{ maxWidth: "200px", height: "auto" }}
                  />
                  <p className="text-xs text-center mt-1 text-gray-500">QR code gerado localmente</p>
                  <p className="text-xs text-center mt-1 text-amber-600 font-medium">É necessário ter configurado o webhook no painel Mercado Pago</p>
                </div>
              ) : (
                <div className="flex justify-center items-center h-[200px] w-[200px] bg-gray-100 mx-auto rounded">
                  <Loader2 className="h-8 w-8 animate-spin text-primary" />
                </div>
              )}
            </div>
          )}
          
          {/* Adicionar informação sobre o código PIX */}
          {pixData && (
            <div className="text-xs text-gray-500 border border-gray-200 bg-gray-50 p-2 rounded-md mb-4">
              <div><strong>Info do QR Code:</strong></div>
              <div>Base64: {pixData.qrCodeBase64 ? "✓ Presente" : "✗ Ausente"}</div>
              <div>Código PIX: {pixData.qrCode ? `✓ Presente (${pixData.qrCode.length} caracteres)` : "✗ Ausente"}</div>
              <div>ID da transação: {pixData.transactionId}</div>
              <div className="mt-1 text-amber-600 font-medium">Após o pagamento, aguarde até 1 minuto para a confirmação automática</div>
            </div>
          )}
          
          <div className="bg-gray-50 p-4 rounded-lg w-full mb-4">
            <p className="font-semibold mb-1">Código PIX copia e cola:</p>
            <div className="bg-white border rounded p-2 text-xs break-all">
              {pixData?.qrCode}
            </div>
            <Button 
              variant="ghost" 
              size="sm" 
              className="mt-2 text-xs w-full"
              onClick={() => {
                navigator.clipboard.writeText(pixData?.qrCode || "");
                toast({
                  title: "Código copiado!",
                  description: "Cole o código no seu aplicativo de banco",
                });
              }}
            >
              Copiar código
            </Button>
          </div>
          
          <div className="text-sm text-gray-600 mb-4">
            <p>Após o pagamento, o sistema verificará automaticamente.</p>
            <p className="mt-2">
              {pixData?.paymentPercentage && pixData.paymentPercentage < 100 ? (
                <>
                  Valor: <span className="font-medium">
                    R$ {((pixData.adjustedAmount || 0) / 100).toFixed(2)}
                  </span>
                  <span className="text-xs ml-1">
                    ({pixData.paymentPercentage}% do total: R$ {(servicePrice / 100).toFixed(2)})
                  </span>
                </>
              ) : (
                <>
                  Valor: <span className="font-medium">R$ {(servicePrice / 100).toFixed(2)}</span>
                </>
              )}
            </p>
          </div>

          <div className="w-full mb-4">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center">
                <Clock className="h-4 w-4 mr-1 text-yellow-600" />
                <span className="text-sm font-medium">
                  Tempo restante: {Math.floor(timeRemaining / 3600) > 0 ? `${Math.floor(timeRemaining / 3600)}:` : ''}{Math.floor((timeRemaining % 3600) / 60).toString().padStart(2, '0')}:{(timeRemaining % 60).toString().padStart(2, '0')}
                </span>
              </div>
            </div>
            <Progress value={progressValue} className="h-2" 
              style={{
                background: "#f1f5f9",
                "--progress-background": progressValue > 50 
                  ? "var(--primary)" 
                  : progressValue > 20 
                    ? "orange" 
                    : "red"
              } as React.CSSProperties} 
            />
            <p className="text-xs text-gray-500 mt-1">
              O pagamento será cancelado automaticamente após 2 horas.
            </p>
          </div>
          
          <Button 
            variant="outline" 
            size="sm" 
            className="mb-2" 
            onClick={checkPaymentStatus}
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            Verificar pagamento
          </Button>
        </div>
      </CardContent>
      <CardFooter className="flex justify-between pb-6">
        <Button 
          variant="outline" 
          onClick={handleCancelPayment}
          disabled={isCancelling}
        >
          {isCancelling ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Cancelando...
            </>
          ) : (
            "Cancelar"
          )}
        </Button>
        <Button 
          variant="ghost" 
          onClick={generatePixCode} 
          disabled={isGenerating}
        >
          {isGenerating ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Gerando...
            </>
          ) : (
            <>
              <RefreshCw className="mr-2 h-4 w-4" />
              Gerar novo PIX
            </>
          )}
        </Button>
      </CardFooter>
      
      {/* Componente que verifica automaticamente o status do pagamento */}
      {pixData && pixData.transactionId && (
        <PaymentStatusChecker
          appointmentId={appointmentId}
          transactionId={pixData.transactionId}
          onPaymentConfirmed={() => onPaymentComplete('paid')}
        />
      )}
    </Card>
  );
};

export default BookingPixPayment;