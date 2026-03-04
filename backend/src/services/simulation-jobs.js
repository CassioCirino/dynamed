const cron = require("node-cron");
const { logger } = require("../logger");
const { getLoadState, startLoadSimulation, PROFILE_PRESETS } = require("./load-simulator");

const ALLOWED_PROFILES = new Set(["light", "moderate", "heavy", "extreme", "custom"]);
const ALLOWED_ROLES = new Set(["patient", "doctor", "receptionist", "admin"]);

const jobState = {
  intervalRef: null,
  startupTimeoutRef: null,
  cronTask: null,
  config: null,
  stats: {
    runs: 0,
    skipped: 0,
    lastRunAt: null,
    lastRunStatus: null,
    lastErrorMessage: null,
    lastTrigger: null,
  },
};

function toInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.trunc(parsed);
}

function toBool(value, fallback = false) {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function clamp(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

function normalizeRoles(rawRoles, fallback = ["patient", "doctor", "receptionist"]) {
  const list = Array.isArray(rawRoles)
    ? rawRoles
    : String(rawRoles || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);

  const filtered = list.filter((role) => ALLOWED_ROLES.has(role));
  return filtered.length ? filtered : fallback;
}

function sanitizePayload(rawPayload, fallbackPayload) {
  const fallback = fallbackPayload || {
    profile: "moderate",
    roles: ["patient", "doctor", "receptionist"],
  };

  const profile = ALLOWED_PROFILES.has(rawPayload?.profile) ? rawPayload.profile : fallback.profile;
  const roles = normalizeRoles(rawPayload?.roles, fallback.roles);

  const payload = {
    profile,
    roles,
  };

  const sessions = clamp(rawPayload?.sessions, 1, 600, null);
  const durationSeconds = clamp(rawPayload?.durationSeconds, 30, 7200, null);
  const rampUpSeconds = clamp(rawPayload?.rampUpSeconds, 0, 900, null);
  const requestPacingMs = clamp(rawPayload?.requestPacingMs, 200, 20000, null);
  const jitterMs = clamp(rawPayload?.jitterMs, 0, 10000, null);

  if (sessions != null) payload.sessions = sessions;
  if (durationSeconds != null) payload.durationSeconds = durationSeconds;
  if (rampUpSeconds != null) payload.rampUpSeconds = rampUpSeconds;
  if (requestPacingMs != null) payload.requestPacingMs = requestPacingMs;
  if (jitterMs != null) payload.jitterMs = jitterMs;

  return payload;
}

function clearScheduler() {
  if (jobState.intervalRef) {
    clearInterval(jobState.intervalRef);
    jobState.intervalRef = null;
  }
  if (jobState.startupTimeoutRef) {
    clearTimeout(jobState.startupTimeoutRef);
    jobState.startupTimeoutRef = null;
  }
  if (jobState.cronTask) {
    try {
      jobState.cronTask.stop();
      jobState.cronTask.destroy();
    } catch (_error) {
      // no-op
    }
    jobState.cronTask = null;
  }
}

function snapshot() {
  return {
    ...jobState.config,
    stats: { ...jobState.stats },
    availableProfiles: PROFILE_PRESETS,
  };
}

function normalizeConfig(rawConfig, fallbackConfig) {
  const fallback = fallbackConfig || {
    enabled: false,
    mode: "interval",
    intervalMinutes: 60,
    cronExpression: "*/30 * * * *",
    timezone: process.env.SIMULATION_JOB_TIMEZONE || "America/Sao_Paulo",
    runOnStart: false,
    startDelaySeconds: 30,
    payload: {
      profile: "moderate",
      roles: ["patient", "doctor", "receptionist"],
    },
  };

  const enabled = typeof rawConfig?.enabled === "boolean" ? rawConfig.enabled : fallback.enabled;
  const mode = rawConfig?.mode === "cron" ? "cron" : rawConfig?.mode === "interval" ? "interval" : fallback.mode;
  const intervalMinutes = clamp(rawConfig?.intervalMinutes, 1, 1440, fallback.intervalMinutes);
  const cronExpression = String(rawConfig?.cronExpression || fallback.cronExpression || "*/30 * * * *").trim();
  const timezone = String(rawConfig?.timezone || fallback.timezone || "America/Sao_Paulo").trim();
  const runOnStart = typeof rawConfig?.runOnStart === "boolean" ? rawConfig.runOnStart : fallback.runOnStart;
  const startDelaySeconds = clamp(rawConfig?.startDelaySeconds, 0, 600, fallback.startDelaySeconds);
  const payload = sanitizePayload(rawConfig?.payload || rawConfig || {}, fallback.payload);

  return {
    enabled,
    mode,
    intervalMinutes,
    cronExpression,
    timezone,
    runOnStart,
    startDelaySeconds,
    payload,
  };
}

function buildConfigFromEnv() {
  const envModeRaw = String(process.env.SIMULATION_JOB_MODE || "").trim().toLowerCase();
  const envCron = String(process.env.SIMULATION_JOB_CRON || "").trim();
  const mode = envModeRaw === "cron" ? "cron" : "interval";

  return normalizeConfig({
    enabled: toBool(process.env.SIMULATION_JOB_ENABLED, false),
    mode,
    intervalMinutes: toInt(process.env.SIMULATION_JOB_INTERVAL_MINUTES, 60),
    cronExpression: envCron || "*/30 * * * *",
    timezone: process.env.SIMULATION_JOB_TIMEZONE || "America/Sao_Paulo",
    runOnStart: toBool(process.env.SIMULATION_JOB_RUN_ON_START, false),
    startDelaySeconds: toInt(process.env.SIMULATION_JOB_START_DELAY_SECONDS, 30),
    profile: process.env.SIMULATION_JOB_PROFILE || "moderate",
    roles: normalizeRoles(process.env.SIMULATION_JOB_ROLES),
    sessions: process.env.SIMULATION_JOB_SESSIONS,
    durationSeconds: process.env.SIMULATION_JOB_DURATION_SECONDS,
    rampUpSeconds: process.env.SIMULATION_JOB_RAMP_UP_SECONDS,
    requestPacingMs: process.env.SIMULATION_JOB_REQUEST_PACING_MS,
    jitterMs: process.env.SIMULATION_JOB_JITTER_MS,
  });
}

async function runScheduledJob(trigger = "timer", overridePayload = null) {
  const payload = sanitizePayload(overridePayload || {}, jobState.config?.payload);
  const current = getLoadState();
  const now = new Date().toISOString();

  if (current.running) {
    jobState.stats.skipped += 1;
    jobState.stats.lastRunAt = now;
    jobState.stats.lastRunStatus = "ignorado_em_execucao";
    jobState.stats.lastTrigger = trigger;
    return { status: "ignorado_em_execucao", load: current };
  }

  try {
    const load = await startLoadSimulation(payload, null);
    jobState.stats.runs += 1;
    jobState.stats.lastRunAt = now;
    jobState.stats.lastRunStatus = "iniciado";
    jobState.stats.lastErrorMessage = null;
    jobState.stats.lastTrigger = trigger;
    return { status: "iniciado", load };
  } catch (error) {
    jobState.stats.runs += 1;
    jobState.stats.lastRunAt = now;
    jobState.stats.lastRunStatus = "erro";
    jobState.stats.lastErrorMessage = error.message;
    jobState.stats.lastTrigger = trigger;
    throw error;
  }
}

function schedule(config) {
  clearScheduler();
  jobState.config = config;

  if (!config.enabled) {
    logger.info("Job de simulacao desativado.");
    return;
  }

  if (config.runOnStart) {
    jobState.startupTimeoutRef = setTimeout(() => {
      runScheduledJob("inicio").catch((error) => {
        logger.warn({ error }, "Falha no job inicial de simulacao.");
      });
    }, config.startDelaySeconds * 1000);
  }

  if (config.mode === "cron") {
    if (!cron.validate(config.cronExpression)) {
      logger.warn({ cronExpression: config.cronExpression }, "Expressao cron invalida. Job nao agendado.");
      return;
    }
    jobState.cronTask = cron.schedule(
      config.cronExpression,
      () => {
        runScheduledJob("cron").catch((error) => {
          logger.warn({ error }, "Falha no job cron de simulacao.");
        });
      },
      {
        timezone: config.timezone || undefined,
      },
    );
    jobState.cronTask.start();
    logger.info(
      {
        cronExpression: config.cronExpression,
        timezone: config.timezone,
        runOnStart: config.runOnStart,
        startDelaySeconds: config.startDelaySeconds,
        payload: config.payload,
      },
      "Agendador de simulacao em modo cron inicializado.",
    );
    return;
  }

  jobState.intervalRef = setInterval(() => {
    runScheduledJob("intervalo").catch((error) => {
      logger.warn({ error }, "Falha no job recorrente de simulacao.");
    });
  }, config.intervalMinutes * 60 * 1000);

  logger.info(
    {
      intervalMinutes: config.intervalMinutes,
      runOnStart: config.runOnStart,
      startDelaySeconds: config.startDelaySeconds,
      payload: config.payload,
    },
    "Agendador de simulacao em modo intervalo inicializado.",
  );
}

function startSimulationJobs() {
  schedule(buildConfigFromEnv());
}

function stopSimulationJobs() {
  clearScheduler();
}

function getSimulationJobConfig() {
  return snapshot();
}

function updateSimulationJobConfig(rawConfig) {
  const nextConfig = normalizeConfig(rawConfig, jobState.config || buildConfigFromEnv());
  schedule(nextConfig);
  return snapshot();
}

async function runSimulationJobNow(payloadOverride = null) {
  const result = await runScheduledJob("manual", payloadOverride || jobState.config?.payload || {});
  return {
    ...result,
    job: snapshot(),
  };
}

module.exports = {
  startSimulationJobs,
  stopSimulationJobs,
  getSimulationJobConfig,
  updateSimulationJobConfig,
  runSimulationJobNow,
};
