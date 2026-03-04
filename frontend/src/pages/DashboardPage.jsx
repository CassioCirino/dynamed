import { useEffect, useMemo, useState } from "react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import dayjs from "dayjs";
import { api } from "../lib/api";
import { useAuth } from "../hooks/useAuth";
import { KpiCard } from "../components/KpiCard";
import { LoadingState } from "../components/LoadingState";
import { numberLabel } from "../lib/format";

function formatTimelinePoint(point) {
  return {
    ...point,
    bucketLabel: dayjs(point.bucket).format("DD/MM HH:mm"),
  };
}

export function DashboardPage() {
  const { user } = useAuth();
  const [summary, setSummary] = useState(null);
  const [timeline, setTimeline] = useState([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function loadData() {
      try {
        setLoading(true);
        const [summaryResponse, timelineResponse] = await Promise.all([
          api.get("/dashboard/summary"),
          api.get("/dashboard/timeline"),
        ]);
        if (cancelled) {
          return;
        }
        setSummary(summaryResponse.data);
        setTimeline((timelineResponse.data.points || []).map(formatTimelinePoint));
      } catch (error) {
        if (!cancelled) {
          setErrorMessage(error?.response?.data?.message || "Falha ao carregar painel.");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    loadData();
    const intervalId = setInterval(loadData, 20000);
    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, []);

  const kpis = useMemo(() => {
    const data = summary?.summary || {};
    if (user.role === "patient") {
      return [
        { title: "Consultas Ativas", value: data.activeAppointments },
        { title: "Consultas Concluidas", value: data.completedAppointments },
        { title: "Exames Pendentes", value: data.pendingExams, tone: "warning" },
        { title: "Exames Concluidos", value: data.completedExams },
      ];
    }

    if (user.role === "doctor") {
      return [
        { title: "Agenda Hoje", value: data.appointmentsToday },
        { title: "Consultas em Andamento", value: data.activeConsultations, tone: "warning" },
        { title: "Exames Pendentes", value: data.pendingExams, tone: "critical" },
        { title: "Internacoes Ativas", value: data.activeInpatients },
      ];
    }

    return [
      { title: "Agendamentos Hoje", value: data.scheduledToday },
      { title: "Concluidos Hoje", value: data.completedToday },
      { title: "Perdas Hoje", value: data.lostToday, tone: "warning" },
      { title: "Incidentes Criticos", value: data.criticalIncidents, tone: "critical" },
      { title: "Exames Pendentes", value: data.pendingExams },
      { title: "Incidentes Abertos", value: data.openIncidents, tone: "warning" },
    ];
  }, [summary, user.role]);

  if (loading && !summary) {
    return <LoadingState label="Carregando painel..." />;
  }

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">VISAO OPERACIONAL</p>
          <h2>Painel de {user.role === "patient" ? "Paciente" : "Operacoes Hospitalares"}</h2>
        </div>
        <span className="status-chip">{errorMessage || "Atualizacao a cada 20s"}</span>
      </header>

      <div className="kpi-grid">
        {kpis.map((kpi) => (
          <KpiCard
            key={kpi.title}
            title={kpi.title}
            value={numberLabel(kpi.value)}
            tone={kpi.tone}
            hint={kpi.hint}
          />
        ))}
      </div>

      <article className="panel">
        <div className="panel-header">
          <h3>Fluxo de atendimento (ultimas 48h)</h3>
        </div>
        <div className="chart-box">
          <ResponsiveContainer width="100%" height={280}>
            <AreaChart data={timeline}>
              <defs>
                <linearGradient id="colorCompleted" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#21a67a" stopOpacity={0.8} />
                  <stop offset="95%" stopColor="#21a67a" stopOpacity={0.1} />
                </linearGradient>
                <linearGradient id="colorLost" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#d95843" stopOpacity={0.8} />
                  <stop offset="95%" stopColor="#d95843" stopOpacity={0.1} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#21303b" />
              <XAxis dataKey="bucketLabel" minTickGap={20} />
              <YAxis />
              <Tooltip />
              <Area type="monotone" dataKey="completed" stroke="#21a67a" fillOpacity={1} fill="url(#colorCompleted)" />
              <Area type="monotone" dataKey="lost" stroke="#d95843" fillOpacity={1} fill="url(#colorLost)" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </article>

      {summary?.system ? (
        <article className="panel compact">
          <div className="panel-header">
            <h3>Resumo de infraestrutura e processo</h3>
          </div>
          <div className="mini-grid">
            <div>
              <strong>CPU (nucleos)</strong>
              <span>{summary.system.host.cpuCount}</span>
            </div>
            <div>
              <strong>Media de carga</strong>
              <span>{summary.system.host.loadAverage.join(" / ")}</span>
            </div>
            <div>
              <strong>RSS (MB)</strong>
              <span>{Math.round(summary.system.node.memoryRssBytes / (1024 * 1024))}</span>
            </div>
            <div>
              <strong>Sessoes de caos</strong>
              <span>{summary.system.chaos.activeCpuBurnSessions}</span>
            </div>
          </div>
        </article>
      ) : null}
    </section>
  );
}
