import React, { useState, useEffect } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2, AlertCircle, RefreshCw, CheckCircle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { toast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { PaymentStatusChecker } from "@/components/payment/payment-status-checker";

interface PixPaymentProps {
  appointmentId: number;
  servicePrice: number;
  serviceName: string;
}

export interface PixResponse {
  transactionId: string;
  qrCode: string;
  qrCodeBase64: string;
  expiresAt: string;
  paymentAmount?: number;
  paymentPercentage?: number;
}

// Função utilitária para formatar valores em Reais
const formatCurrency = (valueInCents: number) => {
  const valueInReais = valueInCents / 100;
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL'
  }).format(valueInReais);
};

export const AppointmentPixPayment: React.FC<PixPaymentProps> = ({ appointmentId, servicePrice, serviceName }) => {
  const [refreshInterval, setRefreshInterval] = useState<number | null>(5000); // Atualiza a cada 5 segundos

  // Consulta para verificar o status do pagamento
  const { data: paymentStatus, isLoading: statusLoading } = useQuery({
    queryKey: [`/api/payments/${appointmentId}/status`],
    queryFn: async () => {
      const res = await apiRequest('GET', `/api/payments/${appointmentId}/status`);
      const data = await res.json();
      
      // Se o pagamento foi concluído, parar a atualização automática
      if (data.paymentStatus === 'paid') {
        setRefreshInterval(null);
        toast({
          title: "Pagamento confirmado!",
          description: "O pagamento via PIX foi processado com sucesso.",
          variant: "default",
        });
      }
      
      return data;
    },
    refetchInterval: refreshInterval !== null ? refreshInterval : false,
    enabled: !!appointmentId
  });

  // Mutação para gerar um novo PIX
  const generatePixMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest('POST', '/api/payments/generate-pix', {
        appointmentId,
        amount: servicePrice / 100 // Convertendo de centavos para reais
      });
      return await res.json();
    },
    onSuccess: () => {
      // Revalidar o status do pagamento
      queryClient.invalidateQueries({ queryKey: [`/api/payments/${appointmentId}/status`] });
      // Revalidar os detalhes do agendamento
      queryClient.invalidateQueries({ queryKey: ['/api/my-appointments'] });
      toast({
        title: "QR Code PIX gerado",
        description: "Um novo código PIX foi gerado para este agendamento.",
      });
      // Verificar o status a cada 5 segundos após gerar um novo PIX
      setRefreshInterval(5000);
    },
    onError: (error: any) => {
      toast({
        title: "Erro ao gerar PIX",
        description: error.message || "Não foi possível gerar o código PIX. Tente novamente.",
        variant: "destructive",
      });
    }
  });

  // Verificar o status do pagamento manualmente
  const handleCheckStatus = () => {
    queryClient.invalidateQueries({ queryKey: [`/api/payments/${appointmentId}/status`] });
  };

  // Gerar um novo código PIX
  const handleGeneratePix = () => {
    generatePixMutation.mutate();
  };

  // Usando a função formatCurrency definida acima

  // Verificar se o pagamento já foi realizado
  const isPaid = paymentStatus?.paymentStatus === 'paid';
  
  // Verificar se o pagamento ainda está pendente
  const isPending = paymentStatus?.paymentStatus === 'pending';
  
  // Verificar se o pagamento não é necessário
  const isNotRequired = paymentStatus?.paymentStatus === 'not_required';

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle>Pagamento PIX</CardTitle>
        <CardDescription>
          {isPaid
            ? "Pagamento confirmado"
            : isPending
              ? "Escaneie o QR Code para pagar"
              : isNotRequired
                ? "Pagamento presencial"
                : "Configure o pagamento para este agendamento"}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {statusLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
          </div>
        ) : isPaid ? (
          <Alert className="bg-green-50 border-green-200">
            <CheckCircle className="h-5 w-5 text-green-600" />
            <AlertTitle className="text-green-800">Pagamento confirmado!</AlertTitle>
            <AlertDescription className="text-green-700">
              O pagamento de {formatCurrency(servicePrice)} para {serviceName} foi recebido.
            </AlertDescription>
          </Alert>
        ) : isPending && paymentStatus?.qrCodeBase64 ? (
          <div className="flex flex-col items-center space-y-4">
            <div className="flex flex-col items-center p-3 bg-white rounded-lg border">
              <img 
                src={`data:image/png;base64,${paymentStatus.qrCodeBase64}`} 
                alt="QR Code PIX" 
                className="w-48 h-48 object-contain"
              />
              <span className="text-sm text-gray-500 mt-2">
                {paymentStatus.paymentPercentage && paymentStatus.paymentPercentage < 100 && paymentStatus.paymentAmount ? (
                  <>
                    Valor: {formatCurrency(paymentStatus.paymentAmount)} 
                    <span className="text-xs ml-1">
                      ({paymentStatus.paymentPercentage}% do total: {formatCurrency(servicePrice)})
                    </span>
                  </>
                ) : (
                  <>Valor: {formatCurrency(servicePrice)}</>
                )}
              </span>
            </div>
            
            <div className="w-full p-3 bg-gray-50 rounded border mt-4">
              <p className="text-sm font-medium mb-1">Código PIX Copia e Cola:</p>
              <div className="flex">
                <div className="flex-1 bg-white p-2 text-xs rounded-l overflow-x-auto whitespace-nowrap border-y border-l">
                  {paymentStatus.qrCode}
                </div>
                <Button 
                  variant="secondary" 
                  size="sm" 
                  className="rounded-l-none"
                  onClick={() => {
                    navigator.clipboard.writeText(paymentStatus.qrCode);
                    toast({
                      title: "Código copiado!",
                      description: "O código PIX foi copiado para a área de transferência.",
                    });
                  }}
                >
                  Copiar
                </Button>
              </div>
            </div>
            
            <Alert className="bg-blue-50 border-blue-200 mt-4">
              <AlertCircle className="h-5 w-5 text-blue-600" />
              <AlertTitle className="text-blue-800">Aguardando pagamento</AlertTitle>
              <AlertDescription className="text-blue-700">
                Após o pagamento, a confirmação pode levar alguns instantes para ser processada.
              </AlertDescription>
            </Alert>
          </div>
        ) : isNotRequired ? (
          <Alert className="bg-gray-50 border-gray-200">
            <AlertCircle className="h-5 w-5 text-gray-600" />
            <AlertTitle className="text-gray-800">Pagamento presencial</AlertTitle>
            <AlertDescription className="text-gray-700">
              Este agendamento não requer pagamento antecipado via PIX. O valor de {formatCurrency(servicePrice)} será cobrado presencialmente.
            </AlertDescription>
          </Alert>
        ) : (
          <div className="text-center py-4">
            <p className="text-gray-600 mb-4">
              Gere um código PIX para receber o pagamento antecipado.
            </p>
            <Button 
              onClick={handleGeneratePix}
              disabled={generatePixMutation.isPending}
            >
              {generatePixMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Gerar PIX
            </Button>
          </div>
        )}
      </CardContent>
      {isPending && (
        <CardFooter className="flex justify-between">
          <Button 
            variant="outline" 
            size="sm" 
            onClick={handleCheckStatus}
            disabled={statusLoading}
          >
            {statusLoading ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-2 h-4 w-4" />
            )}
            Verificar pagamento
          </Button>
          <Button 
            variant="outline" 
            size="sm" 
            onClick={handleGeneratePix}
            disabled={generatePixMutation.isPending}
          >
            {generatePixMutation.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              "Gerar novo PIX"
            )}
          </Button>
        </CardFooter>
      )}
      
      {/* Componente que verifica automaticamente o status do pagamento */}
      {paymentStatus?.pixTransactionId && (
        <PaymentStatusChecker
          appointmentId={appointmentId}
          transactionId={paymentStatus.pixTransactionId}
          onPaymentConfirmed={() => {
            // Revalidar os detalhes do agendamento
            queryClient.invalidateQueries({ queryKey: ["/api/my-appointments"] });
            // Parar a atualização automática
            setRefreshInterval(null);
          }}
        />
      )}
    </Card>
  );
};