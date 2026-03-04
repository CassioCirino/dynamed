import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { useAuth } from "../hooks/useAuth";
import { LoadingState } from "../components/LoadingState";
import { formatDateTime, incidentSeverityLabel, incidentStatusLabel, loadProfileLabel, roleLabel } from "../lib/format";

const CONTROL_PANEL_URL = `${window.location.protocol}//${window.location.hostname}:5180`;

function formatDuration(totalSeconds) {
  const seconds = Number(totalSeconds || 0);
  if (seconds <= 0) {
    return "0s";
  }
  const minutes = Math.floor(seconds / 60);
  const rem = seconds % 60;
  if (minutes === 0) {
    return `${rem}s`;
  }
  if (rem === 0) {
    return `${minutes}min`;
  }
  return `${minutes}min ${rem}s`;
}

export function OperationsPage() {
  const { user } = useAuth();
  const [state, setState] = useState(null);
  const [incidents, setIncidents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState("");
  const [newIncident, setNewIncident] = useState({
    title: "Alerta manual de observabilidade",
    description: "Evento criado para teste de monitoramento e acionamento.",
    severity: "warning",
    source: "painel-operacoes",
  });

  const canOpenIncidents = useMemo(() => ["admin", "receptionist", "doctor"].includes(user.role), [user.role]);
  const loadState = state?.load || null;

  const loadData = useCallback(async () => {
    try {
      setLoading((current) => (!state ? true : current));
      const [stateResponse, incidentsResponse] = await Promise.all([
        api.get("/operations/state"),
        api.get("/operations/incidents"),
      ]);
      setState(stateResponse.data);
      setIncidents(incidentsResponse.data.incidents || []);
    } catch (error) {
      setErrorMessage(error?.response?.data?.message || "Falha ao carregar operacoes.");
    } finally {
      setLoading(false);
    }
  }, [state]);

  useEffect(() => {
    loadData();
    const intervalId = setInterval(loadData, 8000);
    return () => clearInterval(intervalId);
  }, [loadData]);

  async function createIncident(event) {
    event.preventDefault();
    try {
      await api.post("/operations/incidents", newIncident);
      await loadData();
    } catch (error) {
      setErrorMessage(error?.response?.data?.message || "Falha ao abrir incidente.");
    }
  }

  if (loading && !state) {
    return <LoadingState label="Carregando operacao..." />;
  }

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">NOC HOSPITALAR</p>
          <h2>Operacoes e Monitoramento</h2>
        </div>
        <button type="button" onClick={loadData}>
          Atualizar agora
        </button>
      </header>

      {errorMessage ? <p className="error-banner">{errorMessage}</p> : null}

      <article className="panel compact">
        <div className="panel-header">
          <h3>Acionamento de simulacoes</h3>
        </div>
        <p>
          O disparo de carga e caos foi separado em um painel externo exclusivo para {roleLabel("admin")}, mantendo esta tela
          focada em monitoramento.
        </p>
        {user.role === "admin" ? (
          <p>
            Painel externo:{" "}
            <a href={CONTROL_PANEL_URL} target="_blank" rel="noreferrer" className="inline-link-button">
              Abrir controle de simulacoes
            </a>
          </p>
        ) : null}
      </article>

      <article className="panel compact">
        <div className="panel-header">
          <h3>Estado atual</h3>
        </div>
        <div className="mini-grid">
          <div>
            <strong>Erro simulado</strong>
            <span>{state?.chaos?.errorRate?.percent || 0}%</span>
          </div>
          <div>
            <strong>Latencia base</strong>
            <span>{state?.chaos?.latency?.baseMs || 0} ms</span>
          </div>
          <div>
            <strong>Queimas de CPU</strong>
            <span>{state?.chaos?.activeCpuBurnSessions || 0}</span>
          </div>
          <div>
            <strong>Sessoes ativas</strong>
            <span>{loadState?.activeSessions || 0}</span>
          </div>
          <div>
            <strong>Requisicoes simuladas</strong>
            <span>{loadState?.stats?.totalRequests || 0}</span>
          </div>
          <div>
            <strong>Media de carga</strong>
            <span>{state?.system?.host?.loadAverage?.join(" / ") || "0 / 0 / 0"}</span>
          </div>
        </div>
      </article>

      <article className="panel">
        <div className="panel-header">
          <h3>Simulacao em andamento</h3>
          <span className="status-chip">{loadState?.running ? "Rodando" : "Parado"}</span>
        </div>
        <div className="mini-grid">
          <div>
            <strong>Perfil</strong>
            <span>{loadProfileLabel(loadState?.config?.profile) || "-"}</span>
          </div>
          <div>
            <strong>Inicio</strong>
            <span>{loadState?.startedAt ? formatDateTime(loadState.startedAt) : "-"}</span>
          </div>
          <div>
            <strong>Fim previsto</strong>
            <span>{loadState?.endsAt ? formatDateTime(loadState.endsAt) : "-"}</span>
          </div>
          <div>
            <strong>Duracao</strong>
            <span>{formatDuration(loadState?.config?.durationSeconds)}</span>
          </div>
          <div>
            <strong>Ciclos concluidos</strong>
            <span>{loadState?.stats?.loopsCompleted || 0}</span>
          </div>
          <div>
            <strong>Erros totais</strong>
            <span>{loadState?.stats?.totalErrors || 0}</span>
          </div>
        </div>
      </article>

      {canOpenIncidents ? (
        <form className="panel form-grid" onSubmit={createIncident}>
          <h3>Abrir incidente manual</h3>
          <input
            value={newIncident.title}
            onChange={(event) => setNewIncident((old) => ({ ...old, title: event.target.value }))}
            required
          />
          <textarea
            value={newIncident.description}
            onChange={(event) => setNewIncident((old) => ({ ...old, description: event.target.value }))}
            rows={3}
            required
          />
          <select
            value={newIncident.severity}
            onChange={(event) => setNewIncident((old) => ({ ...old, severity: event.target.value }))}
          >
            <option value="info">{incidentSeverityLabel("info")}</option>
            <option value="warning">{incidentSeverityLabel("warning")}</option>
            <option value="critical">{incidentSeverityLabel("critical")}</option>
          </select>
          <input
            value={newIncident.source}
            onChange={(event) => setNewIncident((old) => ({ ...old, source: event.target.value }))}
            required
          />
          <button type="submit">Registrar incidente</button>
        </form>
      ) : null}

      <article className="panel table-panel">
        <h3>Incidentes recentes</h3>
        <table>
          <thead>
            <tr>
              <th>Data</th>
              <th>Titulo</th>
              <th>Severidade</th>
              <th>Status</th>
              <th>Fonte</th>
            </tr>
          </thead>
          <tbody>
            {incidents.map((incident) => (
              <tr key={incident.id}>
                <td>{formatDateTime(incident.created_at)}</td>
                <td>{incident.title}</td>
                <td>{incidentSeverityLabel(incident.severity)}</td>
                <td>{incidentStatusLabel(incident.status)}</td>
                <td>{incident.source}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </article>
    </section>
  );
}
