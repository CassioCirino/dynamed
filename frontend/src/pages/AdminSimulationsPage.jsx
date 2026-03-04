import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { useAuth } from "../hooks/useAuth";
import { LoadingState } from "../components/LoadingState";
import { formatDateTime, loadProfileLabel, roleLabel } from "../lib/format";

const fallbackLoadProfiles = {
  light: {
    sessions: 35,
    durationSeconds: 180,
    rampUpSeconds: 20,
    requestPacingMs: 1800,
    jitterMs: 400,
  },
  moderate: {
    sessions: 90,
    durationSeconds: 300,
    rampUpSeconds: 35,
    requestPacingMs: 1300,
    jitterMs: 500,
  },
  heavy: {
    sessions: 180,
    durationSeconds: 420,
    rampUpSeconds: 45,
    requestPacingMs: 1000,
    jitterMs: 600,
  },
  extreme: {
    sessions: 320,
    durationSeconds: 600,
    rampUpSeconds: 60,
    requestPacingMs: 750,
    jitterMs: 700,
  },
};

const defaultChaos = {
  errorRate: { percent: 12, durationSeconds: 120 },
  latency: { baseMs: 300, jitterMs: 450, durationSeconds: 120 },
  cpu: { seconds: 120, intensity: 0.92, workers: 2 },
  memory: { mb: 512, ttlSeconds: 180 },
  disk: { mb: 256, ttlSeconds: 180 },
};

const defaultLoadForm = {
  profile: "moderate",
  sessions: fallbackLoadProfiles.moderate.sessions,
  durationSeconds: fallbackLoadProfiles.moderate.durationSeconds,
  rampUpSeconds: fallbackLoadProfiles.moderate.rampUpSeconds,
  requestPacingMs: fallbackLoadProfiles.moderate.requestPacingMs,
  jitterMs: fallbackLoadProfiles.moderate.jitterMs,
  roles: ["patient", "doctor", "receptionist", "admin"],
};

const defaultJobForm = {
  enabled: true,
  mode: "interval",
  intervalMinutes: 30,
  cronExpression: "*/30 * * * *",
  timezone: "America/Sao_Paulo",
  runOnStart: true,
  startDelaySeconds: 20,
};

const SIMULATION_KEY_STORAGE = "hospital_simulation_control_key";

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

function normalizeNumber(value, fallback = undefined) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function AdminSimulationsPage() {
  const { user } = useAuth();
  const [controlKey, setControlKey] = useState(() => sessionStorage.getItem(SIMULATION_KEY_STORAGE) || "");
  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(true);
  const [runningAction, setRunningAction] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [successMessage, setSuccessMessage] = useState("");
  const [chaosForms, setChaosForms] = useState(defaultChaos);
  const [loadForm, setLoadForm] = useState(defaultLoadForm);
  const [jobConfig, setJobConfig] = useState(null);
  const [jobForm, setJobForm] = useState(defaultJobForm);
  const [formsInitialized, setFormsInitialized] = useState(false);

  const profileOptions = state?.load?.availableProfiles || fallbackLoadProfiles;
  const loadState = state?.load || null;
  const isAdmin = useMemo(() => user.role === "admin", [user.role]);

  useEffect(() => {
    sessionStorage.setItem(SIMULATION_KEY_STORAGE, controlKey);
  }, [controlKey]);

  function getControlHeaders() {
    return {
      headers: {
        "x-simulacao-chave": controlKey.trim(),
      },
    };
  }

  function requireKeyOrFail() {
    if (!controlKey.trim()) {
      setErrorMessage("Informe a chave de controle para executar simulacoes.");
      return false;
    }
    return true;
  }

  const loadData = useCallback(async () => {
    try {
      setLoading((current) => (!state ? true : current));
      const [stateResponse, jobResponse] = await Promise.all([
        api.get("/operations/state"),
        api.get("/operations/jobs/simulation"),
      ]);
      setState(stateResponse.data);
      const fetchedJob = jobResponse.data.job || null;
      setJobConfig(fetchedJob);

      if (!formsInitialized && fetchedJob) {
        setJobForm({
          enabled: Boolean(fetchedJob.enabled),
          mode: fetchedJob.mode || "interval",
          intervalMinutes: fetchedJob.intervalMinutes || 30,
          cronExpression: fetchedJob.cronExpression || "*/30 * * * *",
          timezone: fetchedJob.timezone || "America/Sao_Paulo",
          runOnStart: Boolean(fetchedJob.runOnStart),
          startDelaySeconds: fetchedJob.startDelaySeconds ?? 20,
        });

        const payload = fetchedJob.payload || {};
        setLoadForm((old) => ({
          ...old,
          profile: payload.profile || old.profile,
          sessions: payload.sessions ?? old.sessions,
          durationSeconds: payload.durationSeconds ?? old.durationSeconds,
          rampUpSeconds: payload.rampUpSeconds ?? old.rampUpSeconds,
          requestPacingMs: payload.requestPacingMs ?? old.requestPacingMs,
          jitterMs: payload.jitterMs ?? old.jitterMs,
          roles: payload.roles || old.roles,
        }));
        setFormsInitialized(true);
      }
    } catch (error) {
      setErrorMessage(error?.response?.data?.message || "Falha ao carregar administracao de simulacoes.");
    } finally {
      setLoading(false);
    }
  }, [formsInitialized, state]);

  useEffect(() => {
    if (!isAdmin) {
      setLoading(false);
      return;
    }
    loadData();
    const intervalId = setInterval(loadData, 8000);
    return () => clearInterval(intervalId);
  }, [isAdmin, loadData]);

  function applyProfile(profile) {
    const preset = profileOptions[profile] || fallbackLoadProfiles.moderate;
    setLoadForm((old) => ({
      ...old,
      profile,
      sessions: preset.sessions ?? old.sessions,
      durationSeconds: preset.durationSeconds ?? old.durationSeconds,
      rampUpSeconds: preset.rampUpSeconds ?? old.rampUpSeconds,
      requestPacingMs: preset.requestPacingMs ?? old.requestPacingMs,
      jitterMs: preset.jitterMs ?? old.jitterMs,
    }));
  }

  function toggleRole(role) {
    setLoadForm((old) => {
      const exists = old.roles.includes(role);
      if (exists) {
        const next = old.roles.filter((item) => item !== role);
        return {
          ...old,
          roles: next.length ? next : old.roles,
        };
      }
      return {
        ...old,
        roles: [...old.roles, role],
      };
    });
  }

  function buildLoadPayload() {
    return {
      profile: loadForm.profile,
      sessions: normalizeNumber(loadForm.sessions),
      durationSeconds: normalizeNumber(loadForm.durationSeconds),
      rampUpSeconds: normalizeNumber(loadForm.rampUpSeconds),
      requestPacingMs: normalizeNumber(loadForm.requestPacingMs),
      jitterMs: normalizeNumber(loadForm.jitterMs),
      roles: loadForm.roles,
    };
  }

  async function saveJobConfig() {
    if (!requireKeyOrFail()) {
      return;
    }
    try {
      setRunningAction("job-save");
      setErrorMessage("");
      setSuccessMessage("");
      const payload = {
        enabled: Boolean(jobForm.enabled),
        mode: jobForm.mode,
        intervalMinutes: normalizeNumber(jobForm.intervalMinutes),
        cronExpression: String(jobForm.cronExpression || "").trim(),
        timezone: String(jobForm.timezone || "").trim(),
        runOnStart: Boolean(jobForm.runOnStart),
        startDelaySeconds: normalizeNumber(jobForm.startDelaySeconds),
        payload: buildLoadPayload(),
      };
      await api.post("/operations/jobs/simulation", payload, getControlHeaders());
      setSuccessMessage("Agendamento salvo com sucesso.");
      await loadData();
    } catch (error) {
      setErrorMessage(error?.response?.data?.message || "Falha ao salvar agendamento.");
    } finally {
      setRunningAction("");
    }
  }

  async function runJobNow() {
    if (!requireKeyOrFail()) {
      return;
    }
    try {
      setRunningAction("job-run-now");
      setErrorMessage("");
      setSuccessMessage("");
      await api.post("/operations/jobs/simulation/run-now", buildLoadPayload(), getControlHeaders());
      setSuccessMessage("Execucao manual da rotina iniciada.");
      await loadData();
    } catch (error) {
      setErrorMessage(error?.response?.data?.message || "Falha ao executar job agora.");
    } finally {
      setRunningAction("");
    }
  }

  async function runChaosAction(actionName, endpoint, payload) {
    if (!requireKeyOrFail()) {
      return;
    }
    try {
      setRunningAction(actionName);
      setErrorMessage("");
      setSuccessMessage("");
      await api.post(endpoint, payload, getControlHeaders());
      await loadData();
    } catch (error) {
      setErrorMessage(error?.response?.data?.message || `Falha ao executar ${actionName}.`);
    } finally {
      setRunningAction("");
    }
  }

  async function startLoad() {
    if (!requireKeyOrFail()) {
      return;
    }
    try {
      setRunningAction("load-start");
      setErrorMessage("");
      setSuccessMessage("");
      await api.post("/operations/load/start", buildLoadPayload(), getControlHeaders());
      await loadData();
    } catch (error) {
      setErrorMessage(error?.response?.data?.message || "Falha ao iniciar simulacao de carga.");
    } finally {
      setRunningAction("");
    }
  }

  async function stopLoad() {
    if (!requireKeyOrFail()) {
      return;
    }
    try {
      setRunningAction("load-stop");
      setErrorMessage("");
      setSuccessMessage("");
      await api.post("/operations/load/stop", { reason: "manual_stop_via_ui" }, getControlHeaders());
      await loadData();
    } catch (error) {
      setErrorMessage(error?.response?.data?.message || "Falha ao parar simulacao de carga.");
    } finally {
      setRunningAction("");
    }
  }

  if (!isAdmin) {
    return (
      <section className="page">
        <header className="page-header">
          <div>
            <p className="eyebrow">ADMINISTRACAO</p>
            <h2>Simulacoes</h2>
          </div>
        </header>
        <article className="panel">
          <h3>Acesso restrito</h3>
          <p>Somente o perfil de {roleLabel("admin")} pode acionar simulacoes de carga e caos.</p>
        </article>
      </section>
    );
  }

  if (loading && !state) {
    return <LoadingState label="Carregando administracao de simulacoes..." />;
  }

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">ADMINISTRACAO</p>
          <h2>Simulacoes de Carga e Caos</h2>
        </div>
        <button type="button" onClick={loadData}>
          Atualizar agora
        </button>
      </header>

      {errorMessage ? <p className="error-banner">{errorMessage}</p> : null}
      {successMessage ? <p className="success-banner">{successMessage}</p> : null}

      <article className="panel compact">
        <div className="panel-header">
          <h3>Controle de acesso</h3>
        </div>
        <p>Esta pagina exige chave de controle no servidor para iniciar/parar simulacoes e agendamentos.</p>
        <label className="key-field">
          Chave de controle
          <input
            type="password"
            value={controlKey}
            onChange={(event) => setControlKey(event.target.value)}
            placeholder="Digite a chave configurada no backend"
          />
        </label>
      </article>

      <article className="panel">
        <div className="panel-header">
          <h3>Agendamento automatico (cron ou intervalo)</h3>
          <span className="status-chip">{jobConfig?.enabled ? "Ativo" : "Inativo"}</span>
        </div>

        <div className="mini-grid job-stats-grid">
          <div>
            <strong>Modo atual</strong>
            <span>{jobConfig?.mode === "cron" ? "Cron" : "Intervalo"}</span>
          </div>
          <div>
            <strong>Ultima execucao</strong>
            <span>{jobConfig?.stats?.lastRunAt ? formatDateTime(jobConfig.stats.lastRunAt) : "-"}</span>
          </div>
          <div>
            <strong>Status da ultima execucao</strong>
            <span>{jobConfig?.stats?.lastRunStatus || "-"}</span>
          </div>
          <div>
            <strong>Gatilho</strong>
            <span>{jobConfig?.stats?.lastTrigger || "-"}</span>
          </div>
          <div>
            <strong>Total de execucoes</strong>
            <span>{jobConfig?.stats?.runs || 0}</span>
          </div>
          <div>
            <strong>Ignoradas (carga ativa)</strong>
            <span>{jobConfig?.stats?.skipped || 0}</span>
          </div>
        </div>

        <div className="form-grid" style={{ marginTop: "0.9rem" }}>
          <h3>Configurar rotina automatica</h3>

          <label>
            Agendamento
            <select
              value={jobForm.enabled ? "enabled" : "disabled"}
              onChange={(event) => setJobForm((old) => ({ ...old, enabled: event.target.value === "enabled" }))}
            >
              <option value="enabled">Ativo</option>
              <option value="disabled">Inativo</option>
            </select>
            <small className="input-hint">Ative para disparo automatico sem precisar abrir frontend.</small>
          </label>

          <label>
            Modo de agenda
            <select value={jobForm.mode} onChange={(event) => setJobForm((old) => ({ ...old, mode: event.target.value }))}>
              <option value="interval">Intervalo (minutos)</option>
              <option value="cron">Cron (expressao)</option>
            </select>
            <small className="input-hint">Cron permite regras como `*/15 * * * *`.</small>
          </label>

          {jobForm.mode === "interval" ? (
            <label>
              Intervalo em minutos
              <input
                type="number"
                min={1}
                max={1440}
                value={jobForm.intervalMinutes}
                onChange={(event) => setJobForm((old) => ({ ...old, intervalMinutes: Number(event.target.value) }))}
              />
              <small className="input-hint">Exemplo: `30` roda a cada 30 minutos.</small>
            </label>
          ) : (
            <>
              <label>
                Expressao cron
                <input
                  value={jobForm.cronExpression}
                  onChange={(event) => setJobForm((old) => ({ ...old, cronExpression: event.target.value }))}
                  placeholder="*/30 * * * *"
                />
                <small className="input-hint">Formato: minuto hora dia mes dia-semana.</small>
              </label>

              <label>
                Fuso horario
                <input
                  value={jobForm.timezone}
                  onChange={(event) => setJobForm((old) => ({ ...old, timezone: event.target.value }))}
                  placeholder="America/Sao_Paulo"
                />
                <small className="input-hint">Use o fuso da operacao, exemplo `America/Sao_Paulo`.</small>
              </label>
            </>
          )}

          <label>
            Executar ao iniciar backend
            <select
              value={jobForm.runOnStart ? "yes" : "no"}
              onChange={(event) => setJobForm((old) => ({ ...old, runOnStart: event.target.value === "yes" }))}
            >
              <option value="yes">Sim</option>
              <option value="no">Nao</option>
            </select>
            <small className="input-hint">Se ativo, roda uma vez apos subir o backend.</small>
          </label>

          <label>
            Atraso inicial (segundos)
            <input
              type="number"
              min={0}
              max={600}
              value={jobForm.startDelaySeconds}
              onChange={(event) => setJobForm((old) => ({ ...old, startDelaySeconds: Number(event.target.value) }))}
            />
            <small className="input-hint">Tempo de espera antes da primeira execucao automatica.</small>
          </label>

          <button type="button" disabled={runningAction === "job-save"} onClick={saveJobConfig}>
            {runningAction === "job-save" ? "Salvando..." : "Salvar agendamento"}
          </button>

          <button type="button" className="ghost-button" disabled={runningAction === "job-run-now"} onClick={runJobNow}>
            {runningAction === "job-run-now" ? "Executando..." : "Executar rotina agora"}
          </button>
        </div>
      </article>

      <article className="panel">
        <div className="panel-header">
          <h3>Simulacao de carga de sessoes</h3>
          <span className="status-chip">{loadState?.running ? "Rodando" : "Parado"}</span>
        </div>

        <div className="mini-grid">
          <div>
            <strong>Perfil ativo</strong>
            <span>{loadProfileLabel(loadState?.config?.profile) || "-"}</span>
          </div>
          <div>
            <strong>Duracao da rodada</strong>
            <span>{formatDuration(loadState?.config?.durationSeconds)}</span>
          </div>
          <div>
            <strong>Ciclos concluidos</strong>
            <span>{loadState?.stats?.loopsCompleted || 0}</span>
          </div>
          <div>
            <strong>Requisicoes simuladas</strong>
            <span>{loadState?.stats?.totalRequests || 0}</span>
          </div>
          <div>
            <strong>Sessoes ativas agora</strong>
            <span>{loadState?.activeSessions || 0}</span>
          </div>
          <div>
            <strong>Erros acumulados</strong>
            <span>{loadState?.stats?.totalErrors || 0}</span>
          </div>
        </div>

        <div className="form-grid" style={{ marginTop: "0.9rem" }}>
          <h3>Configurar e disparar agora</h3>
          <label>
            Perfil de carga
            <select value={loadForm.profile} onChange={(event) => applyProfile(event.target.value)} disabled={Boolean(loadState?.running)}>
              <option value="light">Leve</option>
              <option value="moderate">Medio</option>
              <option value="heavy">Alto</option>
              <option value="extreme">Extremo</option>
              <option value="custom">Personalizado</option>
            </select>
            <small className="input-hint">Perfil define valores base de sessoes e ritmo.</small>
          </label>

          <label>
            Sessoes simultaneas
            <input
              type="number"
              min={1}
              max={600}
              value={loadForm.sessions}
              onChange={(event) => setLoadForm((old) => ({ ...old, sessions: Number(event.target.value) }))}
              disabled={Boolean(loadState?.running)}
            />
            <small className="input-hint">Quantidade de usuarios virtuais ativos ao mesmo tempo.</small>
          </label>

          <label>
            Duracao total (segundos)
            <input
              type="number"
              min={30}
              max={7200}
              value={loadForm.durationSeconds}
              onChange={(event) => setLoadForm((old) => ({ ...old, durationSeconds: Number(event.target.value) }))}
              disabled={Boolean(loadState?.running)}
            />
            <small className="input-hint">Tempo total da rodada de simulacao.</small>
          </label>

          <label>
            Aceleracao inicial (segundos)
            <input
              type="number"
              min={0}
              max={900}
              value={loadForm.rampUpSeconds}
              onChange={(event) => setLoadForm((old) => ({ ...old, rampUpSeconds: Number(event.target.value) }))}
              disabled={Boolean(loadState?.running)}
            />
            <small className="input-hint">Tempo para atingir todas as sessoes previstas.</small>
          </label>

          <label>
            Ritmo base por sessao (ms)
            <input
              type="number"
              min={200}
              max={20000}
              value={loadForm.requestPacingMs}
              onChange={(event) => setLoadForm((old) => ({ ...old, requestPacingMs: Number(event.target.value) }))}
              disabled={Boolean(loadState?.running)}
            />
            <small className="input-hint">Intervalo medio entre uma acao e outra do usuario virtual.</small>
          </label>

          <label>
            Variacao aleatoria de ritmo (ms)
            <input
              type="number"
              min={0}
              max={10000}
              value={loadForm.jitterMs}
              onChange={(event) => setLoadForm((old) => ({ ...old, jitterMs: Number(event.target.value) }))}
              disabled={Boolean(loadState?.running)}
            />
            <small className="input-hint">Ruido para evitar trafego artificial muito uniforme.</small>
          </label>

          <div className="role-selector">
            <strong>Perfis simulados</strong>
            {["patient", "doctor", "receptionist", "admin"].map((role) => (
              <label key={role}>
                <input
                  type="checkbox"
                  checked={loadForm.roles.includes(role)}
                  onChange={() => toggleRole(role)}
                  disabled={Boolean(loadState?.running)}
                />
                {roleLabel(role)}
              </label>
            ))}
          </div>

          <button type="button" disabled={Boolean(loadState?.running) || runningAction === "load-start"} onClick={startLoad}>
            {runningAction === "load-start" ? "Iniciando..." : "Iniciar simulacao"}
          </button>

          <button type="button" className="ghost-button" disabled={!loadState?.running || runningAction === "load-stop"} onClick={stopLoad}>
            {runningAction === "load-stop" ? "Parando..." : "Parar simulacao"}
          </button>
        </div>
      </article>

      <div className="chaos-grid">
        <article className="panel form-grid">
          <h3>Erro HTTP 500</h3>
          <label>
            Percentual de erro (%)
            <input
              type="number"
              value={chaosForms.errorRate.percent}
              onChange={(event) =>
                setChaosForms((old) => ({
                  ...old,
                  errorRate: { ...old.errorRate, percent: Number(event.target.value) },
                }))
              }
              min={0}
              max={100}
            />
            <small className="input-hint">Percentual de respostas que retornarao erro 500 durante o periodo.</small>
          </label>
          <label>
            Duracao do erro (segundos)
            <input
              type="number"
              value={chaosForms.errorRate.durationSeconds}
              onChange={(event) =>
                setChaosForms((old) => ({
                  ...old,
                  errorRate: { ...old.errorRate, durationSeconds: Number(event.target.value) },
                }))
              }
              min={1}
            />
            <small className="input-hint">Tempo total com erro injetado na aplicacao.</small>
          </label>
          <button
            type="button"
            disabled={runningAction === "errorRate"}
            onClick={() => runChaosAction("errorRate", "/operations/chaos/error-rate", chaosForms.errorRate)}
          >
            {runningAction === "errorRate" ? "Executando..." : "Aplicar erro"}
          </button>
        </article>

        <article className="panel form-grid">
          <h3>Latencia</h3>
          <label>
            Latencia base (ms)
            <input
              type="number"
              value={chaosForms.latency.baseMs}
              onChange={(event) =>
                setChaosForms((old) => ({
                  ...old,
                  latency: { ...old.latency, baseMs: Number(event.target.value) },
                }))
              }
            />
            <small className="input-hint">Atraso minimo adicionado a cada requisicao.</small>
          </label>
          <label>
            Variacao de latencia (ms)
            <input
              type="number"
              value={chaosForms.latency.jitterMs}
              onChange={(event) =>
                setChaosForms((old) => ({
                  ...old,
                  latency: { ...old.latency, jitterMs: Number(event.target.value) },
                }))
              }
            />
            <small className="input-hint">Variacao aleatoria em torno da latencia base.</small>
          </label>
          <label>
            Duracao da latencia (segundos)
            <input
              type="number"
              value={chaosForms.latency.durationSeconds}
              onChange={(event) =>
                setChaosForms((old) => ({
                  ...old,
                  latency: { ...old.latency, durationSeconds: Number(event.target.value) },
                }))
              }
            />
            <small className="input-hint">Tempo total com latencia artificial ativa.</small>
          </label>
          <button
            type="button"
            disabled={runningAction === "latency"}
            onClick={() => runChaosAction("latency", "/operations/chaos/latency", chaosForms.latency)}
          >
            {runningAction === "latency" ? "Executando..." : "Aplicar latencia"}
          </button>
        </article>

        <article className="panel form-grid">
          <h3>Queima de CPU</h3>
          <label>
            Duracao da queima (segundos)
            <input
              type="number"
              value={chaosForms.cpu.seconds}
              onChange={(event) =>
                setChaosForms((old) => ({ ...old, cpu: { ...old.cpu, seconds: Number(event.target.value) } }))
              }
            />
            <small className="input-hint">Tempo em que a CPU ficara pressionada.</small>
          </label>
          <label>
            Intensidade (0.05 a 1)
            <input
              type="number"
              step="0.01"
              value={chaosForms.cpu.intensity}
              onChange={(event) =>
                setChaosForms((old) => ({ ...old, cpu: { ...old.cpu, intensity: Number(event.target.value) } }))
              }
            />
            <small className="input-hint">Quanto mais perto de 1, maior o consumo de CPU.</small>
          </label>
          <label>
            Numero de processos
            <input
              type="number"
              value={chaosForms.cpu.workers}
              onChange={(event) =>
                setChaosForms((old) => ({ ...old, cpu: { ...old.cpu, workers: Number(event.target.value) } }))
              }
            />
            <small className="input-hint">Quantidade de processos simultaneos para a queima.</small>
          </label>
          <button type="button" disabled={runningAction === "cpu"} onClick={() => runChaosAction("cpu", "/operations/chaos/cpu-burn", chaosForms.cpu)}>
            {runningAction === "cpu" ? "Executando..." : "Iniciar queima de CPU"}
          </button>
        </article>

        <article className="panel form-grid">
          <h3>Pressao de memoria</h3>
          <label>
            Memoria reservada (MB)
            <input
              type="number"
              value={chaosForms.memory.mb}
              onChange={(event) =>
                setChaosForms((old) => ({ ...old, memory: { ...old.memory, mb: Number(event.target.value) } }))
              }
            />
            <small className="input-hint">Quantidade aproximada de memoria alocada durante o teste.</small>
          </label>
          <label>
            Duracao da pressao (segundos)
            <input
              type="number"
              value={chaosForms.memory.ttlSeconds}
              onChange={(event) =>
                setChaosForms((old) => ({
                  ...old,
                  memory: { ...old.memory, ttlSeconds: Number(event.target.value) },
                }))
              }
            />
            <small className="input-hint">Tempo total mantendo a pressao de memoria.</small>
          </label>
          <button
            type="button"
            disabled={runningAction === "memory"}
            onClick={() => runChaosAction("memory", "/operations/chaos/memory-pressure", chaosForms.memory)}
          >
            {runningAction === "memory" ? "Executando..." : "Pressionar memoria"}
          </button>
        </article>

        <article className="panel form-grid">
          <h3>Pressao de disco</h3>
          <label>
            Volume em disco (MB)
            <input
              type="number"
              value={chaosForms.disk.mb}
              onChange={(event) =>
                setChaosForms((old) => ({ ...old, disk: { ...old.disk, mb: Number(event.target.value) } }))
              }
            />
            <small className="input-hint">Dados temporarios gerados em disco durante a simulacao.</small>
          </label>
          <label>
            Duracao da pressao (segundos)
            <input
              type="number"
              value={chaosForms.disk.ttlSeconds}
              onChange={(event) =>
                setChaosForms((old) => ({ ...old, disk: { ...old.disk, ttlSeconds: Number(event.target.value) } }))
              }
            />
            <small className="input-hint">Tempo mantendo o consumo de disco acima do normal.</small>
          </label>
          <button
            type="button"
            disabled={runningAction === "disk"}
            onClick={() => runChaosAction("disk", "/operations/chaos/disk-pressure", chaosForms.disk)}
          >
            {runningAction === "disk" ? "Executando..." : "Pressionar disco"}
          </button>
        </article>
      </div>
    </section>
  );
}
