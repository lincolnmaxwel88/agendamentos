import React from "react";
import { useLocation } from "wouter";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { User, Settings, LogOut } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";

interface UserAvatarProps {
  name: string;
  email: string;
  imageUrl?: string;
}

const UserAvatar: React.FC<UserAvatarProps> = ({ name, email, imageUrl }) => {
  const [, navigate] = useLocation();
  const { logoutMutation } = useAuth();
  
  // Extract initials from name
  const initials = name 
    ? name
        .split(" ")
        .filter(n => n) // Remove empty strings
        .map((n) => n[0] || '')
        .join("")
        .toUpperCase()
        .substring(0, 2)
    : "U";
    
  const handleNavigateToProfile = () => {
    navigate("/profile");
  };
  
  const handleNavigateToSettings = () => {
    navigate("/settings");
  };
  
  const handleLogout = () => {
    logoutMutation.mutate();
  };

  return (
    <div className="ml-3 relative">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="bg-white flex text-sm rounded-full focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500"
          >
            <span className="sr-only">Abrir menu do usuário</span>
            <Avatar>
              {imageUrl ? (
                <AvatarImage src={imageUrl} alt={name} />
              ) : null}
              <AvatarFallback>{initials}</AvatarFallback>
            </Avatar>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel>
            <div className="font-normal">
              <p className="text-sm font-medium leading-none">{name}</p>
              <p className="text-xs text-muted-foreground mt-1">{email}</p>
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={handleNavigateToProfile}>
            <User className="mr-2 h-4 w-4" />
            <span>Perfil</span>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={handleNavigateToSettings}>
            <Settings className="mr-2 h-4 w-4" />
            <span>Configurações</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={handleLogout}>
            <LogOut className="mr-2 h-4 w-4" />
            <span>Sair</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
};

export default UserAvatar;
