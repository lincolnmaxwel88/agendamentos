import React, { useEffect, useState } from 'react';
import { useToast } from '@/hooks/use-toast';
import { useLocation } from 'wouter';

interface PaymentStatusCheckerProps {
  appointmentId: number;
  transactionId: string;
  onPaymentConfirmed?: () => void;
}

/**
 * Componente que verifica periodicamente o status do pagamento
 * e redireciona o usuário quando o pagamento for confirmado
 */
export function PaymentStatusChecker({ 
  appointmentId, 
  transactionId,
  onPaymentConfirmed 
}: PaymentStatusCheckerProps) {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const [isChecking, setIsChecking] = useState(true);
  const [checkCount, setCheckCount] = useState(0);

  useEffect(() => {
    // Função para verificar o status do pagamento
    const checkPaymentStatus = async () => {
      try {
        // Verificar o status do pagamento na API
        const response = await fetch(`/api/payments/${appointmentId}/status`);
        
        if (!response.ok) {
          const errorData = await response.json();
          console.error('Erro ao verificar status do pagamento:', errorData);
          return false;
        }
        
        const data = await response.json();
        console.log('Status do pagamento:', data);
        
        // Se o pagamento foi confirmado, redirecionar o usuário
        if (data.paid || data.confirmed || data.appointmentStatus === 'confirmed') {
          setIsChecking(false);
          
          // Mostrar toast de sucesso
          toast({
            title: 'Pagamento confirmado!',
            description: 'Seu agendamento foi confirmado com sucesso.',
            variant: 'default',
          });
          
          // Executar callback se fornecido
          if (onPaymentConfirmed) {
            onPaymentConfirmed();
          }
          
          // Redirecionar para a página de confirmação
          setTimeout(() => {
            navigate(`/booking/confirmation/${appointmentId}`);
          }, 1500);
          
          return true;
        }
        
        return false;
      } catch (error) {
        console.error('Erro ao verificar status do pagamento:', error);
        return false;
      }
    };
    
    // Verificar o status do pagamento a cada 5 segundos
    let intervalId: NodeJS.Timeout | null = null;
    
    if (isChecking) {
      // Verificar imediatamente
      checkPaymentStatus();
      
      // Configurar intervalo para verificar periodicamente
      intervalId = setInterval(async () => {
        const confirmed = await checkPaymentStatus();
        
        // Incrementar contador de verificações
        setCheckCount(prev => prev + 1);
        
        // Se o pagamento foi confirmado ou já verificamos 60 vezes (5 minutos),
        // parar de verificar
        if (confirmed || checkCount >= 60) {
          setIsChecking(false);
        }
      }, 5000); // Verificar a cada 5 segundos
    }
    
    // Limpar intervalo quando o componente for desmontado
    return () => {
      if (intervalId) {
        clearInterval(intervalId);
      }
    };
  }, [appointmentId, transactionId, isChecking, checkCount, toast, navigate, onPaymentConfirmed]);
  
  // Este componente não renderiza nada visualmente
  return null;
}
