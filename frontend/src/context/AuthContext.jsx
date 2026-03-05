import { useEffect, useMemo, useState } from "react";
import { api, clearStoredAuth, getStoredAuth, setApiToken, setStoredAuth } from "../lib/api";
import { identifyRumUser } from "../lib/dynatrace-rum";
import { AuthContext } from "./auth-context";

export function AuthProvider({ children }) {
  const [auth, setAuth] = useState(() => getStoredAuth());
  const [initializing, setInitializing] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const initialToken = getStoredAuth()?.token;

    async function bootstrap() {
      if (!initialToken) {
        setInitializing(false);
        return;
      }

      try {
        setApiToken(initialToken);
        const response = await api.get("/auth/me");
        if (!cancelled) {
          const nextAuth = { token: initialToken, user: response.data.user };
          setAuth(nextAuth);
          setStoredAuth(nextAuth);
        }
      } catch {
        if (!cancelled) {
          setAuth(null);
          clearStoredAuth();
          setApiToken(null);
        }
      } finally {
        if (!cancelled) {
          setInitializing(false);
        }
      }
    }

    bootstrap();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    identifyRumUser(auth?.user || null);
  }, [auth?.user]);

  const value = useMemo(
    () => ({
      user: auth?.user || null,
      token: auth?.token || null,
      initializing,
      isAuthenticated: Boolean(auth?.token),
      async loginWithDemoUser(userId) {
        const response = await api.post("/auth/demo-login", { userId });
        const nextAuth = {
          token: response.data.token,
          user: response.data.user,
        };
        setAuth(nextAuth);
        setStoredAuth(nextAuth);
        setApiToken(nextAuth.token);
      },
      async loginWithCredentials(email, password) {
        const response = await api.post("/auth/login", { email, password });
        const nextAuth = {
          token: response.data.token,
          user: response.data.user,
        };
        setAuth(nextAuth);
        setStoredAuth(nextAuth);
        setApiToken(nextAuth.token);
      },
      async registerPatient(payload) {
        const response = await api.post("/auth/register", payload);
        const nextAuth = {
          token: response.data.token,
          user: response.data.user,
        };
        setAuth(nextAuth);
        setStoredAuth(nextAuth);
        setApiToken(nextAuth.token);
      },
      logout() {
        setAuth(null);
        clearStoredAuth();
        setApiToken(null);
      },
    }),
    [auth, initializing],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
