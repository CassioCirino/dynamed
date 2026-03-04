const path = require("node:path");
const crypto = require("node:crypto");
const express = require("express");
const Docker = require("dockerode");

const app = express();

const PORT = Number(process.env.PORT || 4180);
const CONTROL_USER = String(process.env.CONTROL_PANEL_USER || "admin").trim();
const CONTROL_PASSWORD = String(process.env.CONTROL_PANEL_PASSWORD || "dyantrace").trim();
const SESSION_SECRET = String(process.env.CONTROL_PANEL_SESSION_SECRET || "controle-local").trim();
const SESSION_TTL_SECONDS = Number(process.env.CONTROL_PANEL_SESSION_TTL_SECONDS || 8 * 60 * 60);

const FRONTEND_CONTAINER = String(process.env.APP_FRONTEND_CONTAINER || "hospital-frontend").trim();
const BACKEND_CONTAINER = String(process.env.APP_BACKEND_CONTAINER || "hospital-backend").trim();
const POSTGRES_CONTAINER = String(process.env.APP_POSTGRES_CONTAINER || "hospital-postgres").trim();

const BACKEND_INTERNAL_URL = String(process.env.BACKEND_INTERNAL_URL || "http://backend:4000").trim().replace(/\/$/, "");
const DEFAULT_ADMIN_EMAIL = String(process.env.DEFAULT_ADMIN_EMAIL || "admin@hospital.local").trim();
const DEFAULT_ADMIN_PASSWORD = String(process.env.DEFAULT_ADMIN_PASSWORD || "dyantrace").trim();
const SIMULATION_CONTROL_KEY = String(process.env.SIMULATION_CONTROL_KEY || "").trim();

const docker = new Docker({ socketPath: "/var/run/docker.sock" });
const scenarioState = new Map();
const backendAuthCache = {
  token: "",
  exp: 0,
};

const LOAD_SCENARIO_ID = "synthetic-load";
const ALLOWED_LOAD_PROFILES = new Set(["light", "moderate", "heavy", "extreme", "custom"]);
const ALLOWED_LOAD_ROLES = new Set(["patient", "doctor", "receptionist", "admin"]);
const DEFAULT_LOAD_ROLES = ["patient", "doctor", "receptionist"];

app.use(express.json({ limit: "128kb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

function base64url(text) {
  return Buffer.from(text).toString("base64url");
}

function sign(text) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(text).digest("base64url");
}

function makeToken(username) {
  const payload = {
    username,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  };
  const encoded = base64url(JSON.stringify(payload));
  const signature = sign(encoded);
  return `${encoded}.${signature}`;
}

function parseToken(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) {
    return null;
  }
  const [encoded, providedSignature] = token.split(".");
  if (!encoded || !providedSignature) {
    return null;
  }
  const expected = sign(encoded);
  if (providedSignature !== expected) {
    return null;
  }
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    const now = Math.floor(Date.now() / 1000);
    if (!payload?.username || payload.exp < now) {
      return null;
    }
    return payload;
  } catch (_error) {
    return null;
  }
}

function parseJwtExp(token) {
  try {
    const [, payload] = String(token || "").split(".");
    if (!payload) {
      return 0;
    }
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return Number(parsed?.exp || 0);
  } catch (_error) {
    return 0;
  }
}

function clampNumber(value, min, max, fallback = null) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

function normalizeLoadRoles(rawRoles) {
  const list = Array.isArray(rawRoles) ? rawRoles : [];
  const roles = list.map((item) => String(item || "").trim()).filter((role) => ALLOWED_LOAD_ROLES.has(role));
  return roles.length ? roles : [...DEFAULT_LOAD_ROLES];
}

function readToken(req) {
  const auth = String(req.headers.authorization || "");
  if (!auth.toLowerCase().startsWith("bearer ")) {
    return "";
  }
  return auth.slice(7).trim();
}

function requireAuth(req, res, next) {
  const token = readToken(req);
  const payload = parseToken(token);
  if (!payload) {
    return res.status(401).json({ message: "Sessao invalida ou expirada." });
  }
  req.session = payload;
  return next();
}

async function getContainerStatusMap() {
  const containers = await docker.listContainers({ all: true });
  const map = {};
  containers.forEach((container) => {
    for (const name of container.Names || []) {
      const normalized = String(name || "").replace(/^\//, "");
      map[normalized] = {
        id: container.Id,
        name: normalized,
        state: container.State,
        status: container.Status,
      };
    }
  });
  return map;
}

async function stopContainerByName(containerName) {
  const container = docker.getContainer(containerName);
  try {
    await container.stop({ t: 10 });
  } catch (error) {
    if (!String(error?.message || "").toLowerCase().includes("is not running")) {
      throw error;
    }
  }
}

async function startContainerByName(containerName) {
  const container = docker.getContainer(containerName);
  await container.start();
}

function scenarioSnapshot() {
  const now = Date.now();
  const scenarios = {};

  for (const [id, data] of scenarioState.entries()) {
    const endsAtMs = Number(data.endsAtMs || 0);
    scenarios[id] = {
      id,
      type: data.type,
      running: Boolean(data.running),
      label: data.label,
      startedAt: data.startedAt,
      endsAt: endsAtMs > 0 ? new Date(endsAtMs).toISOString() : null,
      remainingSeconds: data.running && endsAtMs > 0 ? Math.max(0, Math.ceil((endsAtMs - now) / 1000)) : 0,
      details: data.details || {},
      note: data.note || "",
    };
  }

  return scenarios;
}

async function startOutageScenario({ id, label, containerName, durationSeconds }) {
  const current = scenarioState.get(id);
  if (current?.running) {
    throw new Error(`Cenario '${label}' ja esta ativo.`);
  }

  const safeDuration = Math.max(30, Math.min(3600, Number(durationSeconds || 120)));
  const startedAt = new Date().toISOString();
  const endsAtMs = Date.now() + safeDuration * 1000;

  await stopContainerByName(containerName);

  const timeoutRef = setTimeout(async () => {
    try {
      await startContainerByName(containerName);
    } catch (_error) {
      // no-op: a recuperacao pode ser feita manualmente no painel
    } finally {
      scenarioState.delete(id);
    }
  }, safeDuration * 1000);
  timeoutRef.unref();

  scenarioState.set(id, {
    id,
    type: "outage",
    running: true,
    label,
    containerName,
    startedAt,
    endsAtMs,
    timeoutRef,
    details: {
      durationSeconds: safeDuration,
    },
  });
}

async function stopOutageScenario(id) {
  const current = scenarioState.get(id);
  if (!current) {
    return;
  }

  if (current.timeoutRef) {
    clearTimeout(current.timeoutRef);
  }

  if (current.containerName) {
    await startContainerByName(current.containerName);
  }

  scenarioState.delete(id);
}

async function loginBackendAdmin() {
  const response = await fetch(`${BACKEND_INTERNAL_URL}/api/auth/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email: DEFAULT_ADMIN_EMAIL,
      password: DEFAULT_ADMIN_PASSWORD,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Falha ao autenticar no backend (${response.status}): ${text}`);
  }

  const data = await response.json();
  if (!data?.token) {
    throw new Error("Resposta de login do backend sem token.");
  }
  return data.token;
}

async function getBackendAdminToken(forceRefresh = false) {
  const now = Math.floor(Date.now() / 1000);
  if (!forceRefresh && backendAuthCache.token && backendAuthCache.exp - now > 30) {
    return backendAuthCache.token;
  }

  const token = await loginBackendAdmin();
  const exp = parseJwtExp(token);
  backendAuthCache.token = token;
  backendAuthCache.exp = exp || now + 120;
  return token;
}

async function backendRequest(pathname, options = {}) {
  const {
    method = "GET",
    payload = undefined,
    requiresControlKey = false,
    retryAuth = true,
  } = options;

  if (requiresControlKey && !SIMULATION_CONTROL_KEY) {
    throw new Error("SIMULATION_CONTROL_KEY nao configurada no painel de controle.");
  }

  const token = await getBackendAdminToken(false);
  const headers = {
    Authorization: `Bearer ${token}`,
  };
  if (payload !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  if (requiresControlKey) {
    headers["x-simulacao-chave"] = SIMULATION_CONTROL_KEY;
  }

  let response;
  try {
    response = await fetch(`${BACKEND_INTERNAL_URL}${pathname}`, {
      method,
      headers,
      body: payload !== undefined ? JSON.stringify(payload) : undefined,
    });
  } catch (error) {
    throw new Error(`Backend indisponivel: ${error.message}`);
  }

  if (response.status === 401 && retryAuth) {
    backendAuthCache.token = "";
    backendAuthCache.exp = 0;
    return backendRequest(pathname, {
      method,
      payload,
      requiresControlKey,
      retryAuth: false,
    });
  }

  const text = await response.text();
  let parsedBody = {};
  if (text) {
    try {
      parsedBody = JSON.parse(text);
    } catch (_error) {
      parsedBody = { raw: text };
    }
  }

  if (!response.ok) {
    throw new Error(parsedBody?.message || `Falha no backend (${response.status}).`);
  }

  return parsedBody;
}

function buildLoadPayload(rawPayload) {
  const profile = ALLOWED_LOAD_PROFILES.has(rawPayload?.profile) ? rawPayload.profile : "moderate";
  const roles = normalizeLoadRoles(rawPayload?.roles);

  const payload = { profile, roles };

  const sessions = clampNumber(rawPayload?.sessions, 1, 600, null);
  const durationSeconds = clampNumber(rawPayload?.durationSeconds, 30, 7200, null);
  const rampUpSeconds = clampNumber(rawPayload?.rampUpSeconds, 0, 900, null);
  const requestPacingMs = clampNumber(rawPayload?.requestPacingMs, 200, 20000, null);
  const jitterMs = clampNumber(rawPayload?.jitterMs, 0, 10000, null);

  if (sessions != null) payload.sessions = sessions;
  if (durationSeconds != null) payload.durationSeconds = durationSeconds;
  if (rampUpSeconds != null) payload.rampUpSeconds = rampUpSeconds;
  if (requestPacingMs != null) payload.requestPacingMs = requestPacingMs;
  if (jitterMs != null) payload.jitterMs = jitterMs;

  return payload;
}

function syncLoadScenario(loadState) {
  if (!loadState?.running) {
    scenarioState.delete(LOAD_SCENARIO_ID);
    return;
  }

  const current = scenarioState.get(LOAD_SCENARIO_ID);
  const endsAtMs = Number(loadState?.endsAt || 0);
  const nextEndsAtMs = endsAtMs > 0 ? endsAtMs : Number(current?.endsAtMs || 0);
  const startedAt = loadState?.startedAt || current?.startedAt || new Date().toISOString();

  scenarioState.set(LOAD_SCENARIO_ID, {
    id: LOAD_SCENARIO_ID,
    type: "load",
    running: true,
    label: "Simulacao de carga de usuarios",
    startedAt,
    endsAtMs: nextEndsAtMs,
    details: {
      profile: loadState?.config?.profile || "-",
      sessions: loadState?.config?.sessions || 0,
      durationSeconds: loadState?.config?.durationSeconds || 0,
      activeSessions: loadState?.activeSessions || 0,
      totalRequests: loadState?.stats?.totalRequests || 0,
      totalErrors: loadState?.stats?.totalErrors || 0,
    },
    note: "Carga sintetica em execucao no backend.",
  });
}

async function startLoadFromControlPanel(rawPayload) {
  const payload = buildLoadPayload(rawPayload || {});
  const data = await backendRequest("/api/operations/load/start", {
    method: "POST",
    payload,
    requiresControlKey: true,
  });
  syncLoadScenario(data?.load || null);
  return data;
}

async function stopLoadFromControlPanel(reason = "manual_stop_via_control_panel") {
  const data = await backendRequest("/api/operations/load/stop", {
    method: "POST",
    payload: { reason },
    requiresControlKey: true,
  });
  syncLoadScenario(data?.load || null);
  return data;
}

async function triggerCpuChaos({ seconds, intensity, workers }) {
  const safeSeconds = Math.max(30, Math.min(1200, Number(seconds || 180)));
  const safeIntensity = Math.max(0.05, Math.min(1, Number(intensity || 0.95)));
  const safeWorkers = Math.max(1, Math.min(16, Number(workers || 4)));
  const result = await backendRequest("/api/operations/chaos/cpu-burn", {
    method: "POST",
    requiresControlKey: true,
    payload: {
      seconds: safeSeconds,
      intensity: safeIntensity,
      workers: safeWorkers,
    },
  });

  const id = "infra-cpu";
  const endsAtMs = Date.now() + safeSeconds * 1000;
  const startedAt = new Date().toISOString();

  if (scenarioState.has(id)) {
    const previous = scenarioState.get(id);
    if (previous?.timeoutRef) {
      clearTimeout(previous.timeoutRef);
    }
  }

  const timeoutRef = setTimeout(() => {
    scenarioState.delete(id);
  }, safeSeconds * 1000);
  timeoutRef.unref();

  scenarioState.set(id, {
    id,
    type: "chaos_cpu",
    running: true,
    label: "Infra - Pressao de CPU",
    startedAt,
    endsAtMs,
    timeoutRef,
    details: {
      seconds: safeSeconds,
      intensity: safeIntensity,
      workers: safeWorkers,
    },
    note: "CPU encerra automaticamente ao fim da duracao configurada.",
  });

  return result;
}

async function stopCpuChaos() {
  const response = await backendRequest("/api/operations/chaos/cpu-stop", {
    method: "POST",
    requiresControlKey: true,
    payload: {
      reason: "manual_stop_via_control_panel",
    },
  });

  if (scenarioState.has("infra-cpu")) {
    const current = scenarioState.get("infra-cpu");
    if (current?.timeoutRef) {
      clearTimeout(current.timeoutRef);
    }
    scenarioState.delete("infra-cpu");
  }

  return response;
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "control-panel",
    now: new Date().toISOString(),
  });
});

app.post("/api/login", (req, res) => {
  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "").trim();

  if (username !== CONTROL_USER || password !== CONTROL_PASSWORD) {
    return res.status(401).json({ message: "Usuario ou senha invalidos." });
  }

  const token = makeToken(username);
  return res.json({
    message: "Login realizado.",
    token,
    username,
    expiresInSeconds: SESSION_TTL_SECONDS,
  });
});

app.get("/api/status", requireAuth, async (_req, res, next) => {
  try {
    const containers = await getContainerStatusMap();
    let load = null;
    let loadError = null;

    try {
      const state = await backendRequest("/api/operations/state", { method: "GET" });
      load = state?.load || null;
      syncLoadScenario(load);
    } catch (error) {
      loadError = error.message;
      syncLoadScenario(null);
    }

    return res.json({
      now: new Date().toISOString(),
      containers: {
        frontend: containers[FRONTEND_CONTAINER] || null,
        backend: containers[BACKEND_CONTAINER] || null,
        postgres: containers[POSTGRES_CONTAINER] || null,
      },
      load,
      loadError,
      scenarios: scenarioSnapshot(),
    });
  } catch (error) {
    return next(error);
  }
});

app.post("/api/scenarios/dev-front/start", requireAuth, async (req, res, next) => {
  try {
    await startOutageScenario({
      id: "dev-front",
      label: "DEV - Frontend indisponivel",
      containerName: FRONTEND_CONTAINER,
      durationSeconds: req.body?.durationSeconds,
    });
    return res.json({ message: "Cenario DEV frontend iniciado.", scenarios: scenarioSnapshot() });
  } catch (error) {
    return next(error);
  }
});

app.post("/api/scenarios/dev-front/stop", requireAuth, async (_req, res, next) => {
  try {
    await stopOutageScenario("dev-front");
    return res.json({ message: "Cenario DEV frontend encerrado.", scenarios: scenarioSnapshot() });
  } catch (error) {
    return next(error);
  }
});

app.post("/api/scenarios/dev-api/start", requireAuth, async (req, res, next) => {
  try {
    await startOutageScenario({
      id: "dev-api",
      label: "DEV - API indisponivel",
      containerName: BACKEND_CONTAINER,
      durationSeconds: req.body?.durationSeconds,
    });
    return res.json({ message: "Cenario DEV API iniciado.", scenarios: scenarioSnapshot() });
  } catch (error) {
    return next(error);
  }
});

app.post("/api/scenarios/dev-api/stop", requireAuth, async (_req, res, next) => {
  try {
    await stopOutageScenario("dev-api");
    return res.json({ message: "Cenario DEV API encerrado.", scenarios: scenarioSnapshot() });
  } catch (error) {
    return next(error);
  }
});

app.post("/api/scenarios/db/start", requireAuth, async (req, res, next) => {
  try {
    await startOutageScenario({
      id: "db",
      label: "Banco - PostgreSQL indisponivel",
      containerName: POSTGRES_CONTAINER,
      durationSeconds: req.body?.durationSeconds,
    });
    return res.json({ message: "Cenario DB iniciado.", scenarios: scenarioSnapshot() });
  } catch (error) {
    return next(error);
  }
});

app.post("/api/scenarios/db/stop", requireAuth, async (_req, res, next) => {
  try {
    await stopOutageScenario("db");
    return res.json({ message: "Cenario DB encerrado.", scenarios: scenarioSnapshot() });
  } catch (error) {
    return next(error);
  }
});

app.post("/api/scenarios/infra-cpu/start", requireAuth, async (req, res, next) => {
  try {
    const data = await triggerCpuChaos({
      seconds: req.body?.seconds,
      intensity: req.body?.intensity,
      workers: req.body?.workers,
    });
    return res.json({
      message: "Cenario INFRA de CPU iniciado.",
      result: data,
      scenarios: scenarioSnapshot(),
    });
  } catch (error) {
    return next(error);
  }
});

app.post("/api/scenarios/infra-cpu/stop", requireAuth, async (_req, res, next) => {
  try {
    const result = await stopCpuChaos();
    return res.json({
      message: "Cenario INFRA de CPU encerrado.",
      result,
      scenarios: scenarioSnapshot(),
    });
  } catch (error) {
    return next(error);
  }
});

app.post("/api/scenarios/load/start", requireAuth, async (req, res, next) => {
  try {
    const data = await startLoadFromControlPanel(req.body || {});
    return res.json({
      message: "Simulacao de carga iniciada.",
      result: data,
      scenarios: scenarioSnapshot(),
    });
  } catch (error) {
    return next(error);
  }
});

app.post("/api/scenarios/load/stop", requireAuth, async (_req, res, next) => {
  try {
    const data = await stopLoadFromControlPanel();
    return res.json({
      message: "Simulacao de carga encerrada.",
      result: data,
      scenarios: scenarioSnapshot(),
    });
  } catch (error) {
    return next(error);
  }
});

app.post("/api/scenarios/stop-all", requireAuth, async (_req, res, next) => {
  try {
    await stopOutageScenario("dev-front");
    await stopOutageScenario("dev-api");
    await stopOutageScenario("db");
    try {
      await stopCpuChaos();
    } catch (_error) {
      // no-op
    }
    try {
      await stopLoadFromControlPanel();
    } catch (_error) {
      // no-op
    }
    return res.json({
      message: "Todos os cenarios foram encerrados.",
      note: "Parada geral executada no painel de controle.",
      scenarios: scenarioSnapshot(),
    });
  } catch (error) {
    return next(error);
  }
});

app.use((error, _req, res, _next) => {
  const message = error?.message || "Falha interna do painel de controle.";
  return res.status(500).json({ message });
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[control-panel] escutando em http://0.0.0.0:${PORT}`);
});
