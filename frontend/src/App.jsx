import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./hooks/useAuth";
import { LoadingState } from "./components/LoadingState";
import { AppLayout } from "./components/AppLayout";
import { LoginPage } from "./pages/LoginPage";
import { DashboardPage } from "./pages/DashboardPage";
import { AppointmentsPage } from "./pages/AppointmentsPage";
import { PatientsPage } from "./pages/PatientsPage";
import { ExamsPage } from "./pages/ExamsPage";
import { OperationsPage } from "./pages/OperationsPage";
import { JourneysPage } from "./pages/JourneysPage";

const ADMIN_SIMULATIONS_ROUTE = "/administracao/simulacoes";
const LEGACY_ADMIN_SIMULATIONS_ROUTE = "/controle-interno/simulacoes-7f91";

function ProtectedLayout() {
  const { isAuthenticated } = useAuth();
  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }
  return <AppLayout />;
}

function RedirectIfAuthenticated() {
  const { isAuthenticated } = useAuth();
  return isAuthenticated ? <Navigate to="/" replace /> : <LoginPage />;
}

export default function App() {
  const { initializing } = useAuth();

  if (initializing) {
    return (
      <main className="boot-screen">
        <LoadingState label="Inicializando sessao..." />
      </main>
    );
  }

  return (
    <Routes>
      <Route path="/login" element={<RedirectIfAuthenticated />} />

      <Route path="/" element={<ProtectedLayout />}>
        <Route index element={<DashboardPage />} />
        <Route path="journeys" element={<JourneysPage />} />
        <Route path="appointments" element={<AppointmentsPage />} />
        <Route path="patients" element={<PatientsPage />} />
        <Route path="exams" element={<ExamsPage />} />
        <Route path="operations" element={<OperationsPage />} />
        <Route path={ADMIN_SIMULATIONS_ROUTE.replace(/^\//, "")} element={<Navigate to="/operations" replace />} />
        <Route
          path={LEGACY_ADMIN_SIMULATIONS_ROUTE.replace(/^\//, "")}
          element={<Navigate to="/operations" replace />}
        />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
