import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { useAuth } from "../hooks/useAuth";
import { LoadingState } from "../components/LoadingState";
import { roleLabel } from "../lib/format";

const roleOrder = ["patient", "doctor", "receptionist", "admin"];

const initialRegisterForm = {
  fullName: "",
  email: "",
  password: "",
  birthDate: "",
  phone: "",
  bloodType: "O+",
  insurance: "",
  allergies: "",
  chronicConditions: "",
  emergencyContact: "",
};

export function LoginPage() {
  const navigate = useNavigate();
  const { loginWithDemoUser, loginWithCredentials, registerPatient, isAuthenticated } = useAuth();
  const [usersByRole, setUsersByRole] = useState({});
  const [loadingDemoUsers, setLoadingDemoUsers] = useState(true);
  const [activeTab, setActiveTab] = useState("credentials");
  const [loggingInUserId, setLoggingInUserId] = useState(null);
  const [submittingCredentials, setSubmittingCredentials] = useState(false);
  const [submittingRegister, setSubmittingRegister] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [credentialsForm, setCredentialsForm] = useState({ email: "", password: "" });
  const [registerForm, setRegisterForm] = useState(initialRegisterForm);

  useEffect(() => {
    if (isAuthenticated) {
      navigate("/", { replace: true });
    }
  }, [isAuthenticated, navigate]);

  useEffect(() => {
    let cancelled = false;

    async function loadDemoUsers() {
      try {
        setLoadingDemoUsers(true);
        const responses = await Promise.all(
          roleOrder.map((role) => api.get("/auth/demo-users", { params: { role, limit: 8 } })),
        );
        if (cancelled) {
          return;
        }
        const mapped = {};
        roleOrder.forEach((role, index) => {
          mapped[role] = responses[index].data.users || [];
        });
        setUsersByRole(mapped);
      } catch (error) {
        if (!cancelled) {
          setErrorMessage(error?.response?.data?.message || "Falha ao carregar usuarios de demonstracao.");
        }
      } finally {
        if (!cancelled) {
          setLoadingDemoUsers(false);
        }
      }
    }

    loadDemoUsers();
    return () => {
      cancelled = true;
    };
  }, []);

  const availableRoles = useMemo(() => roleOrder.filter((role) => (usersByRole[role] || []).length > 0), [usersByRole]);

  async function handleDemoLogin(userId) {
    try {
      setErrorMessage("");
      setLoggingInUserId(userId);
      await loginWithDemoUser(userId);
      navigate("/", { replace: true });
    } catch (error) {
      setErrorMessage(error?.response?.data?.message || "Falha no acesso de demonstracao.");
    } finally {
      setLoggingInUserId(null);
    }
  }

  async function handleCredentialsLogin(event) {
    event.preventDefault();
    try {
      setErrorMessage("");
      setSubmittingCredentials(true);
      await loginWithCredentials(credentialsForm.email, credentialsForm.password);
      navigate("/", { replace: true });
    } catch (error) {
      setErrorMessage(error?.response?.data?.message || "Falha no acesso por email e senha.");
    } finally {
      setSubmittingCredentials(false);
    }
  }

  async function handleRegister(event) {
    event.preventDefault();
    try {
      setErrorMessage("");
      setSubmittingRegister(true);
      await registerPatient(registerForm);
      navigate("/", { replace: true });
    } catch (error) {
      setErrorMessage(error?.response?.data?.message || "Falha ao cadastrar nova conta.");
    } finally {
      setSubmittingRegister(false);
    }
  }

  return (
    <section className="login-page">
      <div className="login-hero">
        <p className="eyebrow">SIMULADOR OPERACIONAL</p>
        <h1>Hospital Digital de Simulacao</h1>
        <p>
          Ambiente com jornadas reais de atendimento, exames e operacoes. Use acesso de demonstracao, entre com email/senha ou
          crie uma conta de paciente.
        </p>
      </div>

      {errorMessage ? <p className="error-banner">{errorMessage}</p> : null}

      <article className="panel">
        <div className="auth-tabs">
          <button
            type="button"
            className={activeTab === "credentials" ? "tab-button active" : "tab-button"}
            onClick={() => setActiveTab("credentials")}
          >
            Entrar com e-mail
          </button>
          <button
            type="button"
            className={activeTab === "register" ? "tab-button active" : "tab-button"}
            onClick={() => setActiveTab("register")}
          >
            Cadastrar paciente
          </button>
          <button
            type="button"
            className={activeTab === "demo" ? "tab-button active" : "tab-button"}
            onClick={() => setActiveTab("demo")}
          >
            Acesso demonstracao
          </button>
        </div>

        {activeTab === "credentials" ? (
          <form className="auth-form auth-form-credentials" onSubmit={handleCredentialsLogin}>
            <h3>Entrar com e-mail e senha</h3>
            <label>
              E-mail
              <input
                type="email"
                value={credentialsForm.email}
                onChange={(event) => setCredentialsForm((old) => ({ ...old, email: event.target.value }))}
                required
              />
            </label>
            <label>
              Senha
              <input
                type="password"
                value={credentialsForm.password}
                onChange={(event) => setCredentialsForm((old) => ({ ...old, password: event.target.value }))}
                required
              />
            </label>
            <button type="submit" disabled={submittingCredentials}>
              {submittingCredentials ? "Entrando..." : "Entrar"}
            </button>
          </form>
        ) : null}

        {activeTab === "register" ? (
          <form className="auth-form auth-form-register" onSubmit={handleRegister}>
            <h3>Cadastrar conta de paciente</h3>
            <label>
              Nome completo
              <input
                value={registerForm.fullName}
                onChange={(event) => setRegisterForm((old) => ({ ...old, fullName: event.target.value }))}
                required
              />
            </label>
            <label>
              E-mail
              <input
                type="email"
                value={registerForm.email}
                onChange={(event) => setRegisterForm((old) => ({ ...old, email: event.target.value }))}
                required
              />
            </label>
            <label>
              Senha
              <input
                type="password"
                value={registerForm.password}
                onChange={(event) => setRegisterForm((old) => ({ ...old, password: event.target.value }))}
                required
              />
            </label>
            <label>
              Data de nascimento
              <input
                type="date"
                value={registerForm.birthDate}
                onChange={(event) => setRegisterForm((old) => ({ ...old, birthDate: event.target.value }))}
                required
              />
            </label>
            <label>
              Telefone
              <input
                value={registerForm.phone}
                onChange={(event) => setRegisterForm((old) => ({ ...old, phone: event.target.value }))}
              />
            </label>
            <label>
              Tipo sanguineo
              <select
                value={registerForm.bloodType}
                onChange={(event) => setRegisterForm((old) => ({ ...old, bloodType: event.target.value }))}
              >
                {["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"].map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Convenio
              <input
                value={registerForm.insurance}
                onChange={(event) => setRegisterForm((old) => ({ ...old, insurance: event.target.value }))}
              />
            </label>
            <label>
              Alergias
              <input
                value={registerForm.allergies}
                onChange={(event) => setRegisterForm((old) => ({ ...old, allergies: event.target.value }))}
              />
            </label>
            <label>
              Condicoes cronicas
              <input
                value={registerForm.chronicConditions}
                onChange={(event) => setRegisterForm((old) => ({ ...old, chronicConditions: event.target.value }))}
              />
            </label>
            <label>
              Contato de emergencia
              <input
                value={registerForm.emergencyContact}
                onChange={(event) => setRegisterForm((old) => ({ ...old, emergencyContact: event.target.value }))}
              />
            </label>
            <button type="submit" disabled={submittingRegister}>
              {submittingRegister ? "Cadastrando..." : "Cadastrar e entrar"}
            </button>
          </form>
        ) : null}

        {activeTab === "demo" ? (
          <>
            {loadingDemoUsers ? <LoadingState label="Carregando usuarios de demonstracao..." /> : null}
            <div className="demo-grid">
              {availableRoles.map((role) => (
                <article key={role} className="demo-card">
                  <header>
                    <h2>{roleLabel(role)}</h2>
                    <span>{usersByRole[role].length} usuarios</span>
                  </header>
                  <div className="demo-list">
                    {usersByRole[role].map((user) => (
                      <button
                        className="demo-user-button"
                        key={user.id}
                        onClick={() => handleDemoLogin(user.id)}
                        type="button"
                        disabled={Boolean(loggingInUserId)}
                      >
                        <span>
                          {user.full_name}
                          <small>{user.email}</small>
                        </span>
                        <strong>{loggingInUserId === user.id ? "Entrando..." : "Entrar"}</strong>
                      </button>
                    ))}
                  </div>
                </article>
              ))}
            </div>
          </>
        ) : null}
      </article>
    </section>
  );
}
