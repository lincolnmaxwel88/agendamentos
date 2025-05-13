import { useState, useEffect } from "react";
import { Switch, Route } from "wouter";
import { queryClient } from "@/lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import Dashboard from "@/pages/dashboard";
import Services from "@/pages/services";
import Appointments from "@/pages/appointments";
import Clients from "@/pages/clients";
import Booking from "@/pages/booking";
import Settings from "@/pages/settings";
import AuthPage from "@/pages/auth-page";
import EmailVerificationPage from "@/pages/email-verification-page";
import FinancialReport from "@/pages/financial-report";
import AdminPage from "@/pages/admin-page";
import UsersPage from "@/pages/admin/users-page";
import ProfilePage from "@/pages/profile-page";
import MainNav from "@/components/layout/main-nav";
import MobileNav from "@/components/layout/mobile-nav";
import UserAvatar from "@/components/layout/user-avatar";
import WhatsAppPopup from "@/components/whatsapp-popup";
import { useNotifications } from "@/hooks/use-notifications";
import { 
  Popover,
  PopoverContent,
  PopoverTrigger 
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { AuthProvider } from "@/hooks/use-auth";
import { ProtectedRoute, AdminRoute } from "@/lib/protected-route";
import { useAuth } from "@/hooks/use-auth";
import { useWebSocket } from "@/hooks/use-websocket";
import { useToast } from "@/hooks/use-toast";

function MainLayout({ children }: { children: React.ReactNode }) {
  const { user, logoutMutation } = useAuth();
  const { toast } = useToast();
  const { unreadNotifications, unreadCount, markAsRead, markAllAsRead } = useNotifications();
  
  // Integra o WebSocket para atualizações em tempo real
  const { connected, error } = useWebSocket({
    onMessage: (data) => {
      // Exibe uma notificação quando um agendamento for atualizado
      if (data.type === 'appointment_updated') {
        const appointment = data.data;
        
        let title = "Agendamento atualizado";
        let description = `O agendamento #${appointment.id} foi atualizado.`;
        
        if (appointment.status === 'confirmed') {
          title = "Agendamento confirmado";
          description = `O agendamento #${appointment.id} foi confirmado.`;
        } else if (appointment.status === 'cancelled') {
          title = "Agendamento cancelado";
          description = `O agendamento #${appointment.id} foi cancelado.`;
        } else if (appointment.status === 'completed') {
          title = "Agendamento concluído";
          description = `O agendamento #${appointment.id} foi marcado como concluído.`;
        }
        
        toast({
          title,
          description,
          variant: appointment.status === 'cancelled' ? "destructive" : "default",
        });
      } else if (data.type === 'appointment_created') {
        const appointment = data.data;
        
        // Exibe uma notificação quando um novo agendamento for criado
        toast({
          title: "Novo agendamento recebido!",
          description: `Um novo agendamento foi criado para o dia ${new Date(appointment.date).toLocaleDateString()}.`,
        });
      }
    }
  });
  
  // Registra o toast como um gatilho global para permitir que outros componentes o utilizem
  useEffect(() => {
    window.__TOAST_TRIGGER = toast;
    return () => {
      window.__TOAST_TRIGGER = undefined;
    };
  }, [toast]);
  
  const handleLogout = () => {
    logoutMutation.mutate();
  };
  
  return (
    <div className="flex flex-col min-h-screen">
      {/* WhatsApp Popup */}
      {user && <WhatsAppPopup />}
      
      {/* MAIN NAVIGATION */}
      <nav className="bg-white shadow-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between h-16">
            <div className="flex">
              <div className="flex-shrink-0 flex items-center">
                <span className="text-primary-600 text-xl font-bold">AgendaPro</span>
              </div>
              
              <MainNav />
            </div>
            
            <div className="hidden sm:ml-6 sm:flex sm:items-center">
              {/* Popover para notificações */}
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="ghost" size="icon" className="relative">
                    <span className="sr-only">Ver notificações</span>
                    <svg 
                      xmlns="http://www.w3.org/2000/svg" 
                      width="20" 
                      height="20" 
                      viewBox="0 0 24 24" 
                      fill="none" 
                      stroke="currentColor" 
                      strokeWidth="2" 
                      strokeLinecap="round" 
                      strokeLinejoin="round"
                    >
                      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/>
                      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>
                    </svg>
                    
                    {/* Contador de notificações */}
                    {unreadCount > 0 && (
                      <span className="absolute top-0 right-0 inline-flex items-center justify-center w-4 h-4 text-xs font-bold text-white bg-red-500 rounded-full">
                        {unreadCount > 9 ? '9+' : unreadCount}
                      </span>
                    )}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-80 max-w-sm p-0" align="end">
                  <div className="p-4 border-b border-gray-200">
                    <div className="flex items-center justify-between mb-2">
                      <h3 className="text-sm font-medium">Notificações</h3>
                      {unreadCount > 0 && (
                        <Button 
                          variant="ghost" 
                          size="sm" 
                          onClick={markAllAsRead}
                          className="text-xs"
                        >
                          Marcar todas como lidas
                        </Button>
                      )}
                    </div>
                  </div>
                  <ScrollArea className="h-[300px]">
                    {unreadNotifications.length === 0 ? (
                      <div className="p-4 text-center text-gray-500">
                        Não há notificações não lidas
                      </div>
                    ) : (
                      <div>
                        {unreadNotifications.map((notification) => (
                          <div 
                            key={notification.id}
                            className="p-3 border-b border-gray-100 hover:bg-gray-50"
                            onClick={() => markAsRead(notification.id)}
                          >
                            <div className="flex justify-between items-start">
                              <h4 className="text-sm font-medium">{notification.title}</h4>
                              <span className="text-xs text-gray-500">
                                {format(new Date(notification.createdAt), "dd/MM/yyyy 'às' HH:mm", { locale: ptBR })}
                              </span>
                            </div>
                            <p className="text-sm text-gray-600 mt-1">{notification.message}</p>
                          </div>
                        ))}
                      </div>
                    )}
                  </ScrollArea>
                </PopoverContent>
              </Popover>

              {user && (
                <div className="flex items-center space-x-2">
                  <UserAvatar 
                    name={user.name}
                    email={user.username}
                    imageUrl={user.avatarUrl || undefined}
                  />
                  <button
                    onClick={handleLogout}
                    className="ml-2 px-3 py-1 text-sm text-gray-600 hover:text-gray-900"
                    disabled={logoutMutation.isPending}
                  >
                    Sair
                  </button>
                </div>
              )}
            </div>
            
            <MobileNav />
          </div>
        </div>
      </nav>

      {/* PAGE CONTENT CONTAINER */}
      <main className="flex-1 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {children}
      </main>
    </div>
  );
}

function Router() {
  return (
    <Switch>
      {/* Rotas públicas para autenticação */}
      <Route path="/auth" component={AuthPage} />
      <Route path="/verify-email/:token" component={EmailVerificationPage} />
      
      {/* Rotas públicas para agendamento de clientes (ambos formatos) */}
      <Route path="/booking" component={Booking} />
      <Route path="/booking/:linkId" component={Booking} />
      
      {/* Rotas protegidas que exigem autenticação */}
      <ProtectedRoute 
        path="/" 
        element={
          <MainLayout>
            <Dashboard />
          </MainLayout>
        } 
      />
      
      <ProtectedRoute 
        path="/services" 
        element={
          <MainLayout>
            <Services />
          </MainLayout>
        } 
      />
      
      <ProtectedRoute 
        path="/appointments" 
        element={
          <MainLayout>
            <Appointments />
          </MainLayout>
        } 
      />
      
      <ProtectedRoute 
        path="/clients" 
        element={
          <MainLayout>
            <Clients />
          </MainLayout>
        } 
      />
      
      <ProtectedRoute 
        path="/settings" 
        element={
          <MainLayout>
            <Settings />
          </MainLayout>
        } 
      />
      
      <ProtectedRoute 
        path="/profile" 
        element={
          <MainLayout>
            <ProfilePage />
          </MainLayout>
        } 
      />
      
      <ProtectedRoute 
        path="/financial" 
        element={
          <MainLayout>
            <FinancialReport />
          </MainLayout>
        } 
      />
      
      <AdminRoute 
        path="/admin" 
        element={
          <MainLayout>
            <AdminPage />
          </MainLayout>
        } 
      />
      
      <AdminRoute 
        path="/admin/users" 
        element={
          <MainLayout>
            <UsersPage />
          </MainLayout>
        } 
      />
      
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <TooltipProvider>
          <Toaster />
          <Router />
        </TooltipProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}

export default App;
