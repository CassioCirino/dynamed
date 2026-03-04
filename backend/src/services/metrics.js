const client = require("prom-client");

const register = new client.Registry();
client.collectDefaultMetrics({
  register,
  prefix: "hospital_",
});

const httpRequestsTotal = new client.Counter({
  name: "hospital_http_requests_total",
  help: "Total de requisicoes HTTP",
  labelNames: ["method", "route", "status_code"],
  registers: [register],
});

const httpRequestDuration = new client.Histogram({
  name: "hospital_http_request_duration_seconds",
  help: "Duracao de requisicoes HTTP em segundos",
  labelNames: ["method", "route", "status_code"],
  buckets: [0.02, 0.05, 0.1, 0.2, 0.4, 0.8, 1, 2, 5, 10],
  registers: [register],
});

const dbQueryDuration = new client.Histogram({
  name: "hospital_db_query_duration_seconds",
  help: "Duracao de queries no PostgreSQL",
  labelNames: ["operation"],
  buckets: [0.001, 0.005, 0.01, 0.03, 0.06, 0.1, 0.25, 0.5, 1, 2],
  registers: [register],
});

const chaosActionsTotal = new client.Counter({
  name: "hospital_chaos_actions_total",
  help: "Total de acoes de chaos engineering",
  labelNames: ["kind", "result"],
  registers: [register],
});

const businessEventsTotal = new client.Counter({
  name: "hospital_business_events_total",
  help: "Eventos de negocio relevantes para observabilidade",
  labelNames: ["event_type"],
  registers: [register],
});

const activeMemoryHogs = new client.Gauge({
  name: "hospital_chaos_memory_hogs",
  help: "Quantidade de alocacoes de memoria artificiais ativas",
  registers: [register],
});

const activeDiskArtifacts = new client.Gauge({
  name: "hospital_chaos_disk_artifacts",
  help: "Quantidade de artefatos de disco criados para simulacao",
  registers: [register],
});

const simulatedSessionsActive = new client.Gauge({
  name: "hospital_simulated_sessions_active",
  help: "Quantidade de sessoes simuladas de carga atualmente ativas",
  registers: [register],
});

const simulatedSessionsTotal = new client.Counter({
  name: "hospital_simulated_sessions_total",
  help: "Total de sessoes simuladas iniciadas",
  labelNames: ["profile", "result"],
  registers: [register],
});

const simulatedLoadRequestsTotal = new client.Counter({
  name: "hospital_simulated_load_requests_total",
  help: "Total de requisicoes emitidas pelo simulador de carga",
  labelNames: ["role", "endpoint", "result"],
  registers: [register],
});

function normalizeRoute(req) {
  if (req.route?.path) {
    const base = req.baseUrl || "";
    return `${base}${req.route.path}`;
  }
  return req.path || "unknown";
}

function trackRequest(req, res, next) {
  const stopTimer = httpRequestDuration.startTimer({
    method: req.method,
    route: normalizeRoute(req),
    status_code: "pending",
  });

  res.on("finish", () => {
    const labels = {
      method: req.method,
      route: normalizeRoute(req),
      status_code: String(res.statusCode),
    };
    httpRequestsTotal.inc(labels);
    stopTimer(labels);
  });

  next();
}

function observeDbQuery(operation, durationSeconds) {
  dbQueryDuration.observe({ operation }, durationSeconds);
}

function recordChaos(kind, result) {
  chaosActionsTotal.inc({ kind, result });
}

function recordBusinessEvent(eventType) {
  businessEventsTotal.inc({ event_type: eventType });
}

function setChaosGauge(memoryHogsCount, diskArtifactsCount) {
  activeMemoryHogs.set(memoryHogsCount);
  activeDiskArtifacts.set(diskArtifactsCount);
}

function setSimulatedSessionsGauge(activeSessions) {
  simulatedSessionsActive.set(activeSessions);
}

function recordSimulatedSession(profile, result) {
  simulatedSessionsTotal.inc({ profile, result });
}

function recordSimulatedLoadRequest(role, endpoint, result) {
  simulatedLoadRequestsTotal.inc({ role, endpoint, result });
}

module.exports = {
  register,
  trackRequest,
  observeDbQuery,
  recordChaos,
  recordBusinessEvent,
  setChaosGauge,
  setSimulatedSessionsGauge,
  recordSimulatedSession,
  recordSimulatedLoadRequest,
};
