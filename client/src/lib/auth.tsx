import { createContext, useCallback, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, apiGet, clearSession, onUnauthorized, signIn, signOut } from './api.ts';
import type { Permission, RoleKey } from '@shared/constants.ts';

export interface SessionUser {
  id: number;
  email: string;
  name: string;
  role: RoleKey;
  must_change_password: boolean;
  uses_default_password: boolean;
}

export interface AppInfo {
  version: string;
  reporting_currency: string;
  organisation_name: string;
  demo_data_present: boolean;
  demo_observations: number;
  real_observations: number;
}

interface MeResponse {
  user: SessionUser;
  permissions: Permission[];
  app: AppInfo;
}

interface AuthState {
  status: 'loading' | 'signed-out' | 'signed-in';
  user: SessionUser | null;
  app: AppInfo | null;
  can: (permission: Permission) => boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const me = useQuery({
    queryKey: ['auth', 'me'],
    queryFn: async () => {
      try {
        return await apiGet<MeResponse>('/auth/me');
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
    staleTime: 60_000,
    retry: false,
  });

  useEffect(
    () =>
      onUnauthorized(() => {
        clearSession();
        client.setQueryData(['auth', 'me'], null);
      }),
    [client],
  );

  const login = useCallback(
    async (email: string, password: string) => {
      await signIn(email, password);
      // Drop anything cached for a previous user, then reload the session (the active observer refetches).
      client.removeQueries({ predicate: (q) => q.queryKey[0] !== 'auth' });
      await client.invalidateQueries({ queryKey: ['auth', 'me'] });
    },
    [client],
  );
  const logout = useCallback(async () => {
    await signOut().catch(() => undefined);
    client.setQueryData(['auth', 'me'], null);
    client.removeQueries({ predicate: (q) => q.queryKey[0] !== 'auth' });
  }, [client]);
  const refresh = useCallback(async () => {
    await client.invalidateQueries({ queryKey: ['auth', 'me'] });
  }, [client]);

  const value = useMemo<AuthState>(() => {
    const data = me.data ?? null;
    const permissions = new Set(data?.permissions ?? []);
    return {
      status: me.isPending ? 'loading' : data ? 'signed-in' : 'signed-out',
      user: data?.user ?? null,
      app: data?.app ?? null,
      can: (permission) => permissions.has(permission),
      login,
      logout,
      refresh,
    };
  }, [me.data, me.isPending, login, logout, refresh]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

/** Convenience: boolean for a permission (re-renders with the session). */
export function useCan(permission: Permission): boolean {
  return useAuth().can(permission);
}
