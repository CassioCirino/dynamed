const { query } = require("../db");
const { logger } = require("../logger");
const {
  recordBusinessEvent,
  recordSimulatedSession,
  recordSimulatedLoadRequest,
  setSimulatedSessionsGauge,
} = require("./metrics");

const PROFILE_PRESETS = Object.freeze({
  light: {
    label: "Leve",
    sessions: 35,
    durationSeconds: 180,
    rampUpSeconds: 20,
    requestPacingMs: 1800,
    jitterMs: 400,
  },
  moderate: {
    label: "Medio",
    sessions: 90,
    durationSeconds: 300,
    rampUpSeconds: 35,
    requestPacingMs: 1300,
    jitterMs: 500,
  },
  heavy: {
    label: "Alto",
    sessions: 180,
    durationSeconds: 420,
    rampUpSeconds: 45,
    requestPacingMs: 1000,
    jitterMs: 600,
  },
  extreme: {
    label: "Extremo",
    sessions: 320,
    durationSeconds: 600,
    rampUpSeconds: 60,
    requestPacingMs: 750,
    jitterMs: 700,
  },
});

const ROLE_WEIGHTS = Object.freeze([
  { role: "patient", weight: 60 },
  { role: "doctor", weight: 22 },
  { role: "receptionist", weight: 12 },
  { role: "admin", weight: 6 },
]);

const state = {
  running: false,
  config: null,
  startedAt: null,
  endsAt: null,
  stopReason: null,
  sessions: [],
  sessionPromises: [],
  requestControllers: new Set(),
  stopTimer: null,
  stats: {
    loopsCompleted: 0,
    totalRequests: 0,
    totalErrors: 0,
    successfulLogins: 0,
    failedLogins: 0,
    startedSessions: 0,
    finishedSessions: 0,
    lastErrorAt: null,
    lastErrorMessage: null,
  },
  userPools: {
    patient: [],
    doctor: [],
    receptionist: [],
    admin: [],
  },
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomFrom(items) {
  if (!items || items.length === 0) {
    return null;
  }
  return items[Math.floor(Math.random() * items.length)];
}

function pickRole(allowedRoles) {
  const weighted = ROLE_WEIGHTS.filter((item) => allowedRoles.includes(item.role));
  if (weighted.length === 0) {
    return "patient";
  }

  const total = weighted.reduce((acc, item) => acc + item.weight, 0);
  let target = Math.random() * total;
  for (const item of weighted) {
    target -= item.weight;
    if (target <= 0) {
      return item.role;
    }
  }
  return weighted[weighted.length - 1].role;
}

function parseJsonSafe(text) {
  try {
    return JSON.parse(text);
  } catch (_error) {
    return null;
  }
}

function getBaseUrl() {
  const explicit = process.env.LOAD_TARGET_BASE_URL;
  if (explicit && explicit.trim()) {
    return explicit.trim().replace(/\/$/, "");
  }
  const port = Number(process.env.PORT || 4000);
  return `http://127.0.0.1:${port}/api`;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const externalSignal = options?.signal || null;
  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener("abort", forwardAbort, { once: true });
    }
  }
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  state.requestControllers.add(controller);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
    if (externalSignal) {
      externalSignal.removeEventListener("abort", forwardAbort);
    }
    state.requestControllers.delete(controller);
  }
}

function resetState() {
  if (state.stopTimer) {
    clearTimeout(state.stopTimer);
  }
  if (state.requestControllers.size > 0) {
    for (const controller of state.requestControllers) {
      try {
        controller.abort();
      } catch (_error) {
        // no-op
      }
    }
    state.requestControllers.clear();
  }
  state.running = false;
  state.config = null;
  state.startedAt = null;
  state.endsAt = null;
  state.stopReason = null;
  state.sessions = [];
  state.sessionPromises = [];
  state.stopTimer = null;
  state.stats = {
    loopsCompleted: 0,
    totalRequests: 0,
    totalErrors: 0,
    successfulLogins: 0,
    failedLogins: 0,
    startedSessions: 0,
    finishedSessions: 0,
    lastErrorAt: null,
    lastErrorMessage: null,
  };
  setSimulatedSessionsGauge(0);
}

function getProfileConfig(profile) {
  return PROFILE_PRESETS[profile] || PROFILE_PRESETS.moderate;
}

function snapshotState() {
  const activeSessions = state.sessions.filter((session) => session.active).length;
  return {
    running: state.running,
    config: state.config,
    startedAt: state.startedAt,
    endsAt: state.endsAt,
    stopReason: state.stopReason,
    activeSessions,
    stats: { ...state.stats },
    availableProfiles: PROFILE_PRESETS,
  };
}

async function persistLoadEvent(status, payload, triggeredBy) {
  try {
    await query(
      `INSERT INTO chaos_events (kind, status, config, triggered_by, ended_at)
       VALUES ('synthetic_load', $1, $2::jsonb, $3, $4)`,
      [status, JSON.stringify(payload || {}), triggeredBy || null, status === "started" ? null : new Date().toISOString()],
    );
  } catch (error) {
    logger.warn({ error }, "Falha ao registrar evento de carga.");
  }
}

async function loadUsersForRoles(roles) {
  const result = await query(
    `SELECT id, role
     FROM users
     WHERE role = ANY($1::text[])
     ORDER BY is_demo DESC, created_at ASC
     LIMIT 5000`,
    [roles],
  );

  const pools = {
    patient: [],
    doctor: [],
    receptionist: [],
    admin: [],
  };

  result.rows.forEach((row) => {
    if (pools[row.role]) {
      pools[row.role].push(row.id);
    }
  });
  return pools;
}

async function runRoleActions(baseUrl, role, token, userId) {
  const authHeaders = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  const actions = [];
  if (role === "patient") {
    actions.push(
      { endpoint: "/dashboard/summary", method: "GET" },
      { endpoint: "/appointments?day=upcoming&pageSize=20", method: "GET" },
      { endpoint: "/exams?status=requested&pageSize=20", method: "GET" },
      { endpoint: `/patients/${userId}/record`, method: "GET" },
    );
  } else if (role === "doctor") {
    actions.push(
      { endpoint: "/dashboard/summary", method: "GET" },
      { endpoint: "/appointments?day=today&pageSize=20", method: "GET" },
      { endpoint: "/exams?status=requested&pageSize=20", method: "GET" },
    );
  } else if (role === "receptionist") {
    actions.push(
      { endpoint: "/dashboard/summary", method: "GET" },
      { endpoint: "/patients?pageSize=20", method: "GET" },
      { endpoint: "/appointments?day=today&pageSize=20", method: "GET" },
    );
  } else {
    actions.push(
      { endpoint: "/operations/state", method: "GET" },
      { endpoint: "/operations/incidents", method: "GET" },
      {
        endpoint: "/operations/incidents",
        method: "POST",
        body: {
          title: "Incidente gerado por simulacao de carga",
          description: "Evento automatico para estresse operacional e monitoramento.",
          severity: "warning",
          source: "simulador-interno",
        },
      },
    );
  }

  for (const action of actions) {
    if (!state.running) {
      break;
    }
    try {
      state.stats.totalRequests += 1;
      const response = await fetchWithTimeout(`${baseUrl}${action.endpoint}`, {
        method: action.method,
        headers: authHeaders,
        body: action.body ? JSON.stringify(action.body) : undefined,
      });
      const ok = response.status < 500;
      recordSimulatedLoadRequest(role, action.endpoint.split("?")[0], ok ? "ok" : "error");
      if (!ok) {
        state.stats.totalErrors += 1;
      }
    } catch (error) {
      state.stats.totalRequests += 1;
      state.stats.totalErrors += 1;
      state.stats.lastErrorAt = new Date().toISOString();
      state.stats.lastErrorMessage = error.message;
      recordSimulatedLoadRequest(role, action.endpoint.split("?")[0], "error");
    }
  }
}

async function runSession(session) {
  const baseUrl = state.config.baseUrl;
  const pacingMs = state.config.requestPacingMs;
  const jitterMs = state.config.jitterMs;

  session.active = true;
  state.stats.startedSessions += 1;
  setSimulatedSessionsGauge(state.sessions.filter((item) => item.active).length);
  recordSimulatedSession(state.config.profile, "started");

  while (state.running && session.active) {
    if (state.endsAt && Date.now() >= state.endsAt) {
      break;
    }

    const userId = randomFrom(state.userPools[session.role]);
    if (!userId) {
      await sleep(500);
      continue;
    }

    let token = "";
    try {
      const loginResponse = await fetchWithTimeout(`${baseUrl}/auth/demo-login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      if (!loginResponse.ok) {
        state.stats.failedLogins += 1;
        state.stats.totalErrors += 1;
        recordSimulatedLoadRequest(session.role, "/auth/demo-login", "error");
        await sleep(300);
        continue;
      }

      const parsed = parseJsonSafe(await loginResponse.text());
      token = parsed?.token || "";
      if (!token) {
        state.stats.failedLogins += 1;
        state.stats.totalErrors += 1;
        recordSimulatedLoadRequest(session.role, "/auth/demo-login", "error");
        continue;
      }

      state.stats.successfulLogins += 1;
      state.stats.totalRequests += 1;
      recordSimulatedLoadRequest(session.role, "/auth/demo-login", "ok");
      if (!state.running || !session.active) {
        break;
      }
      await runRoleActions(baseUrl, session.role, token, userId);
      state.stats.loopsCompleted += 1;
    } catch (error) {
      state.stats.totalErrors += 1;
      state.stats.lastErrorAt = new Date().toISOString();
      state.stats.lastErrorMessage = error.message;
      recordSimulatedLoadRequest(session.role, "/session", "error");
    }

    const randomJitter = Math.round(Math.random() * jitterMs);
    await sleep(pacingMs + randomJitter);
  }

  session.active = false;
  state.stats.finishedSessions += 1;
  setSimulatedSessionsGauge(state.sessions.filter((item) => item.active).length);
  recordSimulatedSession(state.config.profile, "finished");
}

async function stopLoadSimulation(reason = "manual_stop", triggeredBy = null) {
  if (!state.running) {
    return snapshotState();
  }

  state.running = false;
  state.stopReason = reason;
  for (const session of state.sessions) {
    session.active = false;
  }
  if (state.requestControllers.size > 0) {
    for (const controller of state.requestControllers) {
      try {
        controller.abort();
      } catch (_error) {
        // no-op
      }
    }
  }
  if (state.stopTimer) {
    clearTimeout(state.stopTimer);
    state.stopTimer = null;
  }

  await Promise.race([
    Promise.allSettled(state.sessionPromises),
    sleep(4000),
  ]);

  await persistLoadEvent(
    "finished",
    {
      reason,
      config: state.config,
      stats: state.stats,
    },
    triggeredBy,
  );

  const snapshot = snapshotState();
  setSimulatedSessionsGauge(0);
  recordBusinessEvent("load_simulation_stopped");
  resetState();
  return snapshot;
}

function buildConfig(payload) {
  const preset = getProfileConfig(payload.profile);
  const sessions = clamp(Number(payload.sessions || preset.sessions), 1, 600);
  const durationSeconds = clamp(Number(payload.durationSeconds || preset.durationSeconds), 30, 7200);
  const rampUpSeconds = clamp(Number(payload.rampUpSeconds || preset.rampUpSeconds), 0, 900);
  const requestPacingMs = clamp(Number(payload.requestPacingMs || preset.requestPacingMs), 200, 20000);
  const jitterMs = clamp(Number(payload.jitterMs || preset.jitterMs), 0, 10000);
  const roles = payload.roles && payload.roles.length ? payload.roles : ["patient", "doctor", "receptionist", "admin"];
  return {
    profile: payload.profile,
    sessions,
    durationSeconds,
    rampUpSeconds,
    requestPacingMs,
    jitterMs,
    roles,
    baseUrl: getBaseUrl(),
  };
}

async function startLoadSimulation(payload, triggeredBy = null) {
  if (state.running) {
    throw new Error("Ja existe uma simulacao de carga em execucao.");
  }

  const config = buildConfig(payload);
  const pools = await loadUsersForRoles(config.roles);
  const totalUsers = config.roles.reduce((acc, role) => acc + (pools[role]?.length || 0), 0);
  if (totalUsers === 0) {
    throw new Error("Nao ha usuarios para os perfis selecionados.");
  }

  state.running = true;
  state.config = config;
  state.startedAt = new Date().toISOString();
  state.endsAt = Date.now() + config.durationSeconds * 1000;
  state.userPools = pools;
  state.stopReason = null;
  state.sessions = [];
  state.sessionPromises = [];
  if (state.requestControllers.size > 0) {
    for (const controller of state.requestControllers) {
      try {
        controller.abort();
      } catch (_error) {
        // no-op
      }
    }
    state.requestControllers.clear();
  }
  setSimulatedSessionsGauge(0);

  const rampDelayPerSession = config.rampUpSeconds > 0 ? (config.rampUpSeconds * 1000) / config.sessions : 0;
  for (let index = 0; index < config.sessions; index += 1) {
    const role = pickRole(config.roles);
    const session = {
      id: `session-${index + 1}`,
      role,
      active: false,
    };
    state.sessions.push(session);

    const sessionPromise = (async () => {
      if (rampDelayPerSession > 0) {
        await sleep(Math.round(index * rampDelayPerSession));
      }
      if (!state.running) {
        return;
      }
      await runSession(session);
    })();
    state.sessionPromises.push(sessionPromise);
  }

  state.stopTimer = setTimeout(() => {
    stopLoadSimulation("duration_elapsed", triggeredBy).catch((error) => {
      logger.error({ error }, "Falha ao encerrar simulacao automaticamente.");
    });
  }, config.durationSeconds * 1000);

  await persistLoadEvent("started", { config }, triggeredBy);
  recordBusinessEvent("load_simulation_started");

  return snapshotState();
}

module.exports = {
  PROFILE_PRESETS,
  getLoadState: snapshotState,
  startLoadSimulation,
  stopLoadSimulation,
};
