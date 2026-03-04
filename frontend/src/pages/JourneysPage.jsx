import { useNavigate } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { roleLabel } from "../lib/format";

function JourneyCard({ title, audience, steps, primaryActionLabel, onPrimaryAction }) {
  return (
    <article className="panel journey-card">
      <p className="eyebrow">JORNADA</p>
      <h3>{title}</h3>
      <p className="journey-audience">{audience}</p>
      <ol className="journey-steps">
        {steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <button type="button" onClick={onPrimaryAction}>
        {primaryActionLabel}
      </button>
    </article>
  );
}

export function JourneysPage() {
  const navigate = useNavigate();
  const { user } = useAuth();

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">NAVEGACAO GUIADA</p>
          <h2>Jornadas de usuario</h2>
        </div>
        <span className="status-chip">Perfil atual: {roleLabel(user.role)}</span>
      </header>

      <div className="journeys-grid">
        <JourneyCard
          title="Jornada do Paciente"
          audience="Cadastro, consulta de agenda, prontuario e exames"
          steps={[
            "Cadastrar conta de paciente ou usar acesso de demonstracao",
            "Acessar painel e conferir proximas consultas",
            "Abrir prontuario para visualizar historico clinico",
            "Ir em exames e acompanhar resultados",
          ]}
          primaryActionLabel="Ir para prontuario"
          onPrimaryAction={() => navigate("/patients")}
        />

        <JourneyCard
          title="Jornada do Medico"
          audience="Atendimento clinico e fluxo de exames"
          steps={[
            "Abrir atendimentos do dia",
            "Atualizar status da consulta (chegada/em andamento/concluido)",
            "Solicitar exame para paciente",
            "Acompanhar exames pendentes e finalizar laudos",
          ]}
          primaryActionLabel="Ir para atendimentos"
          onPrimaryAction={() => navigate("/appointments")}
        />

        <JourneyCard
          title="Jornada de Recepcao"
          audience="Triagem e gestao do fluxo hospitalar"
          steps={[
            "Visualizar pacientes e filas do dia",
            "Ajustar status de atendimento",
            "Abrir incidente operacional quando necessario",
            "Acompanhar painel de operacoes",
          ]}
          primaryActionLabel="Ir para pacientes"
          onPrimaryAction={() => navigate("/patients")}
        />

        <JourneyCard
          title="Jornada de Operacoes"
          audience="Carga simulada, engenharia de caos e observabilidade"
          steps={[
            "Acessar area administrativa para acionar simulacoes",
            "Monitorar requisicoes, erros e sessoes ativas",
            "Acionar caos controlado (latencia, cpu, memoria, disco)",
            "Analisar incidentes e alertas",
          ]}
          primaryActionLabel="Ir para operacoes"
          onPrimaryAction={() => navigate("/operations")}
        />
      </div>
    </section>
  );
}
