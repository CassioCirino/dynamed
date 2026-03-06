const path = require("node:path");
const crypto = require("node:crypto");
const { Writable } = require("node:stream");
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
const POSTGRES_USER_NAME = String(process.env.POSTGRES_USER || "postgres").trim();
const POSTGRES_DB_NAME = String(process.env.POSTGRES_DB || "hospital_sim").trim();
const RUM_BROWSER_CONTAINER = String(process.env.APP_RUM_BROWSER_CONTAINER || "hospital-rum-browser-load").trim();
const RUM_BROWSER_IMAGE = String(process.env.RUM_BROWSER_IMAGE || "grafana/k6:0.54.0-with-browser").trim();
const RUM_BROWSER_SCRIPT_PATH = String(process.env.RUM_BROWSER_SCRIPT_PATH || "/scripts/k6-rum-browser.js").trim();
const RUM_BROWSER_LOAD_HOST_PATH = String(process.env.RUM_BROWSER_LOAD_HOST_PATH || "").trim();
const PROJECT_ROOT_DIR = String(process.env.PROJECT_ROOT_DIR || "").trim();
const FRONTEND_PUBLIC_PORT = Number(process.env.FRONTEND_PORT || 5173);
const DB_ROOT_CAUSE_APP_PREFIX = "control_panel_db_root_cause";

const BACKEND_INTERNAL_URL = String(process.env.BACKEND_INTERNAL_URL || "http://hospital-backend:4000")
  .trim()
  .replace(/\/$/, "");
const BACKEND_INTERNAL_FALLBACK_URLS = String(
  process.env.BACKEND_INTERNAL_FALLBACK_URLS || "http://hospital-backend:4000",
)
  .split(",")
  .map((item) => item.trim().replace(/\/$/, ""))
  .filter(Boolean);
const DEFAULT_ADMIN_EMAIL = String(process.env.DEFAULT_ADMIN_EMAIL || "admin@hospital.local").trim();
const DEFAULT_ADMIN_PASSWORD = String(process.env.DEFAULT_ADMIN_PASSWORD || "dyantrace").trim();
const SIMULATION_CONTROL_KEY = String(process.env.SIMULATION_CONTROL_KEY || "").trim();
const LOAD_STATE_CACHE_MS = Math.max(1000, Number(process.env.CONTROL_PANEL_LOAD_STATE_CACHE_MS || 15000));
const CONTROL_PANEL_ENABLE_BACKEND_POLL =
  String(process.env.CONTROL_PANEL_ENABLE_BACKEND_POLL || "false").trim().toLowerCase() === "true";
const BACKEND_HTTP_TIMEOUT_MS = Math.max(2000, Number(process.env.CONTROL_PANEL_BACKEND_TIMEOUT_MS || 10000));

const docker = new Docker({ socketPath: "/var/run/docker.sock" });
const scenarioState = new Map();
const backendAuthCache = {
  token: "",
  exp: 0,
  baseUrl: "",
};
const loadStateCache = {
  atMs: 0,
  load: null,
  error: null,
};

const LOAD_SCENARIO_ID = "synthetic-load";
const RUM_SCENARIO_ID = "rum-front";
const CHAOS_ERROR_RATE_SCENARIO_ID = "chaos-error-rate";
const CHAOS_LATENCY_SCENARIO_ID = "chaos-latency";
const PRESET_API_DEGRADADA_SCENARIO_ID = "preset-api-degradada";
const PRESET_DB_CARGA_SCENARIO_ID = "preset-db-carga";
const PRESET_ROOT_DB_SCENARIO_ID = "preset-root-db";
const PRESET_ROOT_BACKEND_SCENARIO_ID = "preset-root-backend";
const PRESET_ROOT_FRONTEND_SCENARIO_ID = "preset-root-frontend";
const ALLOWED_LOAD_PROFILES = new Set(["light", "moderate", "heavy", "extreme", "custom"]);
const ALLOWED_LOAD_ROLES = new Set(["patient", "doctor", "receptionist", "admin"]);
const DEFAULT_LOAD_ROLES = ["patient", "doctor", "receptionist"];
const RUM_MAX_DURATION_MINUTES = 24 * 60;
const RUM_BASELINE_DEFAULTS = Object.freeze({
  RUM_BROWSER_ANONYMOUS_RATE: "0",
  RUM_BROWSER_STEPS_MIN: "10",
  RUM_BROWSER_STEPS_MAX: "24",
  RUM_BROWSER_MIN_ACTIONS: "10",
  RUM_BROWSER_MIN_SESSION_SECONDS: "180",
  RUM_BROWSER_ROLE_WEIGHTS: "patient:60,doctor:20,receptionist:15,admin:5",
  RUM_BROWSER_IDLE_MIN_SECONDS: "45",
  RUM_BROWSER_IDLE_MAX_SECONDS: "180",
  RUM_BROWSER_USER_AGENT:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  K6_BROWSER_HEADLESS: "true",
  K6_BROWSER_ARGS: "no-sandbox,disable-blink-features=AutomationControlled",
});
const rumScheduleState = {
  startTimeout: null,
  stopTimeout: null,
};
const presetAuxState = {
  dbChaosStopTimeout: null,
  dbChaosActiveUntilMs: 0,
};

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

function sleep(ms) {
  const delayMs = Math.max(0, Number(ms || 0));
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function fetchWithTimeout(url, options = {}, timeoutMs = BACKEND_HTTP_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutRef = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs || BACKEND_HTTP_TIMEOUT_MS)));
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutRef);
  }
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

function getBackendBaseUrls(preferred = "") {
  const raw = [preferred, backendAuthCache.baseUrl, BACKEND_INTERNAL_URL, ...BACKEND_INTERNAL_FALLBACK_URLS];
  const unique = [];
  const seen = new Set();
  for (const entry of raw) {
    const value = String(entry || "").trim().replace(/\/$/, "");
    if (!value || seen.has(value)) continue;
    seen.add(value);
    unique.push(value);
  }
  return unique;
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
    const message = String(error?.message || "").toLowerCase();
    const statusCode = Number(error?.statusCode || error?.status || 0);
    const alreadyStopped = statusCode === 304 || message.includes("already stopped") || message.includes("is not running");
    if (!alreadyStopped) {
      throw error;
    }
  }
}

async function startContainerByName(containerName) {
  const container = docker.getContainer(containerName);
  try {
    await container.start();
  } catch (error) {
    const message = String(error?.message || "").toLowerCase();
    const statusCode = Number(error?.statusCode || error?.status || 0);
    const alreadyRunning = statusCode === 304 || message.includes("already started") || message.includes("is already running");
    if (!alreadyRunning) {
      throw error;
    }
  }
}

async function waitForContainerHealthy(containerName, timeoutMs = 90000) {
  const container = docker.getContainer(containerName);
  const startedAt = Date.now();
  let lastStatus = "sem status";

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const inspect = await container.inspect();
      const running = Boolean(inspect?.State?.Running);
      const stateStatus = String(inspect?.State?.Status || "unknown");
      const healthStatus = String(inspect?.State?.Health?.Status || "n/a");
      lastStatus = `state=${stateStatus} health=${healthStatus}`;
      if (running && (healthStatus === "n/a" || healthStatus === "healthy")) {
        return;
      }
    } catch (error) {
      lastStatus = String(error?.message || "erro ao inspecionar container");
    }
    await sleep(1500);
  }

  throw new Error(`Container '${containerName}' nao ficou pronto a tempo (${lastStatus}).`);
}

async function ensureCoreServicesHealthy() {
  const criticalContainers = [POSTGRES_CONTAINER, BACKEND_CONTAINER, FRONTEND_CONTAINER];
  for (const containerName of criticalContainers) {
    await startContainerByName(containerName);
  }
  for (const containerName of criticalContainers) {
    await waitForContainerHealthy(containerName, 90000);
  }
}

function quoteSqlLiteral(value) {
  return `'${String(value || "").replace(/'/g, "''")}'`;
}

function buildPostgresShellCommand(sql) {
  const compactSql = String(sql || "").trim().replace(/\s+/g, " ");
  const escapedSql = compactSql.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `psql -v ON_ERROR_STOP=1 -U "${POSTGRES_USER_NAME}" -d "${POSTGRES_DB_NAME}" -c "${escapedSql}"`;
}

async function runExecInContainer(containerName, shellCommand, options = {}) {
  const detach = Boolean(options?.detach);
  const timeoutMs = Math.max(2000, Number(options?.timeoutMs || 20000));
  const ignoreExitCode = Boolean(options?.ignoreExitCode);
  const container = docker.getContainer(containerName);
  const exec = await container.exec({
    AttachStdout: !detach,
    AttachStderr: !detach,
    Tty: false,
    Cmd: ["sh", "-lc", shellCommand],
  });

  if (detach) {
    await exec.start({ Detach: true, Tty: false });
    return { exitCode: 0, stdout: "", stderr: "" };
  }

  const stream = await exec.start({ Detach: false, Tty: false });
  const stdoutChunks = [];
  const stderrChunks = [];
  const stdoutStream = new Writable({
    write(chunk, _encoding, callback) {
      stdoutChunks.push(Buffer.from(chunk));
      callback();
    },
  });
  const stderrStream = new Writable({
    write(chunk, _encoding, callback) {
      stderrChunks.push(Buffer.from(chunk));
      callback();
    },
  });
  docker.modem.demuxStream(stream, stdoutStream, stderrStream);

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Exec em '${containerName}' excedeu timeout (${timeoutMs}ms).`));
    }, timeoutMs);

    const finish = (handler) => (value) => {
      clearTimeout(timer);
      handler(value);
    };
    stream.on("end", finish(resolve));
    stream.on("close", finish(resolve));
    stream.on("error", finish(reject));
  });

  const inspect = await exec.inspect();
  const exitCode = Number(inspect?.ExitCode || 0);
  const stdout = Buffer.concat(stdoutChunks).toString("utf8").trim();
  const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
  if (exitCode !== 0 && !ignoreExitCode) {
    throw new Error(`Exec em '${containerName}' falhou (exit=${exitCode}): ${stderr || stdout || "sem detalhe"}`);
  }

  return { exitCode, stdout, stderr };
}

async function runPostgresSql(sql, options = {}) {
  const command = buildPostgresShellCommand(sql);
  return runExecInContainer(POSTGRES_CONTAINER, command, options);
}

async function runPostgresSqlDetached(sql) {
  const command = buildPostgresShellCommand(sql);
  return runExecInContainer(POSTGRES_CONTAINER, command, { detach: true });
}

function clearDbRootCauseTimers() {
  if (presetAuxState.dbChaosStopTimeout) {
    clearTimeout(presetAuxState.dbChaosStopTimeout);
    presetAuxState.dbChaosStopTimeout = null;
  }
}

async function stopDbRootCauseChaos() {
  clearDbRootCauseTimers();
  presetAuxState.dbChaosActiveUntilMs = 0;

  const terminateSql = `
    SELECT pg_terminate_backend(pid)
    FROM pg_stat_activity
    WHERE application_name LIKE ${quoteSqlLiteral(`${DB_ROOT_CAUSE_APP_PREFIX}%`)}
      AND pid <> pg_backend_pid();
  `;
  try {
    await runPostgresSql(terminateSql, { timeoutMs: 12000, ignoreExitCode: true });
  } catch (_error) {
    // no-op: pode falhar se o banco estiver realmente indisponivel
  }
}

async function startDbRootCauseChaos(durationSeconds, anomalyMode = false) {
  await stopDbRootCauseChaos();
  const safeDuration = Math.max(60, Math.min(3600, Number(durationSeconds || 300)));
  const untilMs = Date.now() + safeDuration * 1000;
  const stressWorkers = anomalyMode ? 8 : 5;
  const stressSeriesSize = anomalyMode ? 600000 : 420000;

  const lockSql = `
    SET application_name = ${quoteSqlLiteral(`${DB_ROOT_CAUSE_APP_PREFIX}_lock`)};
    BEGIN;
    LOCK TABLE appointments, exams, patients IN ACCESS EXCLUSIVE MODE;
    SELECT pg_sleep(${safeDuration});
    COMMIT;
  `;
  await runPostgresSqlDetached(lockSql);

  for (let i = 0; i < stressWorkers; i += 1) {
    const stressSql = `
      SET application_name = ${quoteSqlLiteral(`${DB_ROOT_CAUSE_APP_PREFIX}_stress`)};
      DO $$
      DECLARE
        until_ts timestamptz := clock_timestamp() + make_interval(secs => ${safeDuration});
      BEGIN
        WHILE clock_timestamp() < until_ts LOOP
          PERFORM sum((g::bigint * 31) % 97)
          FROM generate_series(1, ${stressSeriesSize}) AS g;
        END LOOP;
      END $$;
    `;
    runPostgresSqlDetached(stressSql).catch(() => {
      // no-op: worker pode terminar por timeout/encerramento durante reset
    });
    if (i % 2 === 1) {
      await sleep(60);
    }
  }

  presetAuxState.dbChaosActiveUntilMs = untilMs;
  presetAuxState.dbChaosStopTimeout = setTimeout(() => {
    stopDbRootCauseChaos().catch(() => {
      // no-op
    });
  }, safeDuration * 1000 + 4000);
  presetAuxState.dbChaosStopTimeout.unref();

  return {
    durationSeconds: safeDuration,
    workerCount: stressWorkers,
    lockTables: ["appointments", "exams", "patients"],
    mode: "transaction_lock_plus_stress",
    stressSeriesSize,
  };
}

function clearRumScheduleTimers() {
  if (rumScheduleState.startTimeout) {
    clearTimeout(rumScheduleState.startTimeout);
    rumScheduleState.startTimeout = null;
  }
  if (rumScheduleState.stopTimeout) {
    clearTimeout(rumScheduleState.stopTimeout);
    rumScheduleState.stopTimeout = null;
  }
}

function compactObject(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => compactObject(item))
      .filter((item) => item !== undefined);
  }

  if (value && typeof value === "object") {
    const out = {};
    for (const [key, nestedValue] of Object.entries(value)) {
      const compacted = compactObject(nestedValue);
      if (compacted !== undefined) {
        out[key] = compacted;
      }
    }
    return out;
  }

  if (value === undefined || value === null) {
    return undefined;
  }

  return value;
}

function envListToMap(envList) {
  const map = {};
  for (const entry of Array.isArray(envList) ? envList : []) {
    const raw = String(entry || "");
    const idx = raw.indexOf("=");
    if (idx <= 0) continue;
    const key = raw.slice(0, idx);
    const value = raw.slice(idx + 1);
    map[key] = value;
  }
  return map;
}

function envMapToList(envMap) {
  return Object.entries(envMap || {}).map(([key, value]) => `${key}=${String(value)}`);
}

function parseDateTime(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

function parseK6DurationToMinutes(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return 0;

  let totalSeconds = 0;
  let matched = false;
  const tokenRegex = /(\d+(?:\.\d+)?)(ms|s|m|h|d)/g;
  let tokenMatch = tokenRegex.exec(raw);
  while (tokenMatch) {
    matched = true;
    const amount = Number(tokenMatch[1]);
    const unit = tokenMatch[2];
    if (Number.isFinite(amount) && amount > 0) {
      if (unit === "ms") totalSeconds += amount / 1000;
      else if (unit === "s") totalSeconds += amount;
      else if (unit === "m") totalSeconds += amount * 60;
      else if (unit === "h") totalSeconds += amount * 3600;
      else if (unit === "d") totalSeconds += amount * 86400;
    }
    tokenMatch = tokenRegex.exec(raw);
  }

  if (!matched) {
    const plainSeconds = Number(raw);
    if (Number.isFinite(plainSeconds) && plainSeconds > 0) {
      totalSeconds = plainSeconds;
    }
  }

  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) {
    return 0;
  }
  return Math.max(1, Math.round(totalSeconds / 60));
}

function getRumBaselineEnv() {
  const baseline = {};
  for (const [key, fallback] of Object.entries(RUM_BASELINE_DEFAULTS)) {
    const raw = String(process.env[key] || "").trim();
    baseline[key] = raw || fallback;
  }
  return baseline;
}

function preferPositiveNumber(primaryValue, fallbackValue = 0) {
  const primary = Number(primaryValue || 0);
  if (Number.isFinite(primary) && primary > 0) {
    return primary;
  }
  const fallback = Number(fallbackValue || 0);
  if (Number.isFinite(fallback) && fallback > 0) {
    return fallback;
  }
  return 0;
}

function scheduleRumAutoStop(endAtMs) {
  if (!Number.isFinite(endAtMs) || endAtMs <= Date.now()) {
    return;
  }

  if (rumScheduleState.stopTimeout) {
    clearTimeout(rumScheduleState.stopTimeout);
  }

  const delayMs = Math.max(1000, endAtMs - Date.now());
  rumScheduleState.stopTimeout = setTimeout(async () => {
    try {
      await stopContainerByName(RUM_BROWSER_CONTAINER);
    } catch (_error) {
      // no-op
    } finally {
      scenarioState.delete(RUM_SCENARIO_ID);
      rumScheduleState.stopTimeout = null;
    }
  }, delayMs);
  rumScheduleState.stopTimeout.unref();
}

function buildRumRuntimeConfig(rawPayload) {
  const payload = rawPayload || {};
  const sessionsPerMinute = clampNumber(payload.sessionsPerMinute, 0, 1200, 0);
  const vus = clampNumber(payload.vus, 1, 120, 3);
  const durationMinutesInput = clampNumber(payload.durationMinutes, 1, RUM_MAX_DURATION_MINUTES, 60);

  const startAtMs = parseDateTime(payload.startAt);
  const requestedEndAtMs = parseDateTime(payload.endAt);
  let durationMinutes = durationMinutesInput;
  let endAtMs = null;

  if (startAtMs && requestedEndAtMs && requestedEndAtMs > startAtMs) {
    durationMinutes = Math.max(1, Math.ceil((requestedEndAtMs - startAtMs) / 60000));
    endAtMs = requestedEndAtMs;
  } else if (!startAtMs && requestedEndAtMs && requestedEndAtMs > Date.now()) {
    durationMinutes = Math.max(1, Math.ceil((requestedEndAtMs - Date.now()) / 60000));
    endAtMs = requestedEndAtMs;
  }
  durationMinutes = Math.min(RUM_MAX_DURATION_MINUTES, durationMinutes);

  const env = {
    ...getRumBaselineEnv(),
    RUM_BROWSER_DURATION: `${durationMinutes}m`,
    RUM_BROWSER_VUS: String(vus),
    RUM_BROWSER_SESSIONS_PER_MINUTE: String(sessionsPerMinute),
  };

  if (sessionsPerMinute > 0) {
    const preAllocated = clampNumber(payload.preAllocatedVus, 1, 300, Math.max(2, Math.ceil(sessionsPerMinute / 2)));
    const maxVus = clampNumber(payload.maxVus, preAllocated, 1000, Math.max(preAllocated + 2, sessionsPerMinute * 2));
    env.RUM_BROWSER_PREALLOCATED_VUS = String(preAllocated);
    env.RUM_BROWSER_MAX_VUS = String(maxVus);
  }

  return {
    sessionsPerMinute,
    vus,
    durationMinutes,
    startAtMs,
    endAtMs,
    env,
  };
}

async function recreateRumBrowserContainer(envOverrides = {}) {
  const container = docker.getContainer(RUM_BROWSER_CONTAINER);
  let inspect;
  try {
    inspect = await container.inspect();
  } catch (error) {
    if (!isContainerNotFoundError(error)) {
      throw error;
    }
    inspect = null;
  }

  if (inspect) {
    const envMap = envListToMap(inspect?.Config?.Env || []);
    Object.entries(envOverrides || {}).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        envMap[key] = String(value);
      }
    });

    const createOptions = compactObject({
      name: RUM_BROWSER_CONTAINER,
      Image: inspect?.Config?.Image,
      Cmd: inspect?.Config?.Cmd,
      Entrypoint: inspect?.Config?.Entrypoint,
      Env: envMapToList(envMap),
      Labels: inspect?.Config?.Labels || {},
      WorkingDir: inspect?.Config?.WorkingDir,
      User: inspect?.Config?.User,
      HostConfig: {
        AutoRemove: inspect?.HostConfig?.AutoRemove,
        Binds: inspect?.HostConfig?.Binds || [],
        NetworkMode: inspect?.HostConfig?.NetworkMode || "host",
        RestartPolicy: inspect?.HostConfig?.RestartPolicy || { Name: "no" },
        Privileged: inspect?.HostConfig?.Privileged,
        CapAdd: inspect?.HostConfig?.CapAdd,
        CapDrop: inspect?.HostConfig?.CapDrop,
        ExtraHosts: inspect?.HostConfig?.ExtraHosts,
        SecurityOpt: inspect?.HostConfig?.SecurityOpt,
        ShmSize: inspect?.HostConfig?.ShmSize,
        Tmpfs: inspect?.HostConfig?.Tmpfs,
        Ulimits: inspect?.HostConfig?.Ulimits,
        LogConfig: inspect?.HostConfig?.LogConfig,
      },
    });

    try {
      await container.stop({ t: 5 });
    } catch (stopError) {
      const message = getErrorMessage(stopError);
      const statusCode = Number(stopError?.statusCode || stopError?.status || 0);
      const alreadyStopped = statusCode === 304 || message.includes("already stopped") || message.includes("is not running");
      if (!alreadyStopped && !isContainerNotFoundError(stopError)) {
        throw stopError;
      }
    }

    try {
      await container.remove({ force: true });
    } catch (removeError) {
      if (!isContainerNotFoundError(removeError)) {
        throw removeError;
      }
    }

    const created = await docker.createContainer(createOptions);
    await created.start();
    return;
  }

  const bindSource = await resolveRumLoadBindSource();
  if (!bindSource) {
    throw new Error(
      "Container RUM removido e caminho de scripts nao encontrado. Configure PROJECT_ROOT_DIR ou RUM_BROWSER_LOAD_HOST_PATH no control-panel.",
    );
  }

  await ensureImageAvailable(RUM_BROWSER_IMAGE);
  const envMap = {
    FRONTEND_URL: `http://localhost:${FRONTEND_PUBLIC_PORT}`,
    ...getRumBaselineEnv(),
  };
  Object.entries(envOverrides || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null) {
      envMap[key] = String(value);
    }
  });

  const createOptions = compactObject({
    name: RUM_BROWSER_CONTAINER,
    Image: RUM_BROWSER_IMAGE,
    Cmd: ["run", RUM_BROWSER_SCRIPT_PATH],
    Entrypoint: null,
    Env: envMapToList(envMap),
    Labels: {
      "com.dynamed.managed-by": "control-panel",
      "com.dynamed.service": "rum-browser-load",
    },
    WorkingDir: null,
    User: null,
    HostConfig: {
      AutoRemove: false,
      Binds: [`${bindSource}:/scripts:ro`],
      NetworkMode: "host",
      RestartPolicy: { Name: "no" },
    },
  });
  const created = await docker.createContainer(createOptions);
  await created.start();
}

async function ensureImageAvailable(imageName) {
  const image = docker.getImage(imageName);
  try {
    await image.inspect();
    return;
  } catch (_error) {
    // pull below
  }

  const stream = await docker.pull(imageName);
  await new Promise((resolve, reject) => {
    docker.modem.followProgress(stream, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function resolveRumLoadBindSource() {
  if (RUM_BROWSER_LOAD_HOST_PATH) {
    return normalizeHostPath(RUM_BROWSER_LOAD_HOST_PATH);
  }

  if (PROJECT_ROOT_DIR) {
    return normalizeHostPath(path.join(PROJECT_ROOT_DIR, "load"));
  }

  const candidates = [BACKEND_CONTAINER, FRONTEND_CONTAINER];
  for (const candidate of candidates) {
    try {
      const inspect = await docker.getContainer(candidate).inspect();
      const labels = inspect?.Config?.Labels || {};
      const workingDir = String(labels["com.docker.compose.project.working_dir"] || "").trim();
      if (workingDir) {
        return normalizeHostPath(path.join(workingDir, "load"));
      }
    } catch (_error) {
      // try next
    }
  }

  return "";
}

function normalizeHostPath(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  return trimmed.replace(/\\/g, "/");
}

function getErrorMessage(error) {
  return String(error?.message || "").toLowerCase();
}

function isContainerNotFoundError(error) {
  return getErrorMessage(error).includes("no such container");
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

function setTimedScenarioState({ id, type, label, durationSeconds, details = {}, note = "" }) {
  const safeDuration = Math.max(1, Number(durationSeconds || 1));
  const endsAtMs = Date.now() + safeDuration * 1000;
  const startedAt = new Date().toISOString();

  scenarioState.set(id, {
    id,
    type,
    running: true,
    label,
    startedAt,
    endsAtMs,
    details,
    note,
  });

  setTimeout(() => {
    const current = scenarioState.get(id);
    if (!current) return;
    const stillRunning = Boolean(current.running);
    const sameWindow = Number(current.endsAtMs || 0) <= endsAtMs + 1500;
    if (stillRunning && sameWindow) {
      scenarioState.delete(id);
    }
  }, safeDuration * 1000).unref();
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

async function stopOutageScenario(id, options = {}) {
  const ignoreStartErrors = Boolean(options?.ignoreStartErrors);
  const current = scenarioState.get(id);
  if (!current) {
    return;
  }

  if (current.timeoutRef) {
    clearTimeout(current.timeoutRef);
  }

  try {
    if (current.containerName) {
      await startContainerByName(current.containerName);
    }
  } catch (error) {
    if (!ignoreStartErrors) {
      throw error;
    }
  } finally {
    scenarioState.delete(id);
  }
}

async function loginBackendAdmin() {
  const errors = [];
  const baseUrls = getBackendBaseUrls();

  for (const baseUrl of baseUrls) {
    let response;
    try {
      response = await fetchWithTimeout(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email: DEFAULT_ADMIN_EMAIL,
          password: DEFAULT_ADMIN_PASSWORD,
        }),
      }, BACKEND_HTTP_TIMEOUT_MS);
    } catch (error) {
      errors.push(`${baseUrl}: ${error.message}`);
      continue;
    }

    if (!response.ok) {
      const text = await response.text();
      errors.push(`${baseUrl}: auth ${response.status} ${text}`);
      continue;
    }

    const data = await response.json();
    if (!data?.token) {
      errors.push(`${baseUrl}: resposta sem token`);
      continue;
    }

    return {
      token: data.token,
      baseUrl,
    };
  }

  throw new Error(`Backend indisponivel: ${errors.join(" | ") || "sem resposta"}`);
}

async function getBackendAdminToken(forceRefresh = false) {
  const now = Math.floor(Date.now() / 1000);
  if (!forceRefresh && backendAuthCache.token && backendAuthCache.exp - now > 30) {
    return backendAuthCache.token;
  }

  const login = await loginBackendAdmin();
  const exp = parseJwtExp(login.token);
  backendAuthCache.token = login.token;
  backendAuthCache.exp = exp || now + 120;
  backendAuthCache.baseUrl = login.baseUrl || "";
  return login.token;
}

async function backendRequest(pathname, options = {}) {
  const {
    method = "GET",
    payload = undefined,
    requiresControlKey = false,
    retryAuth = true,
    timeoutMs = BACKEND_HTTP_TIMEOUT_MS,
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

  const errors = [];
  const baseUrls = getBackendBaseUrls();

  let response = null;
  let responseBaseUrl = "";
  for (const baseUrl of baseUrls) {
    try {
      response = await fetchWithTimeout(`${baseUrl}${pathname}`, {
        method,
        headers,
        body: payload !== undefined ? JSON.stringify(payload) : undefined,
      }, timeoutMs);
      responseBaseUrl = baseUrl;
      break;
    } catch (error) {
      errors.push(`${baseUrl}: ${error.message}`);
    }
  }
  if (!response) {
    throw new Error(`Backend indisponivel: ${errors.join(" | ") || "fetch failed"}`);
  }
  backendAuthCache.baseUrl = responseBaseUrl || backendAuthCache.baseUrl;

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
    throw new Error(parsedBody?.message || `Falha no backend (${response.status}) via ${responseBaseUrl}.`);
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

async function inspectRumContainerRuntime() {
  const container = docker.getContainer(RUM_BROWSER_CONTAINER);
  let inspect;
  try {
    inspect = await container.inspect();
  } catch (_error) {
    return null;
  }

  if (!inspect?.State?.Running) {
    return null;
  }

  const envMap = envListToMap(inspect?.Config?.Env || []);
  const sessionsPerMinute = clampNumber(envMap.RUM_BROWSER_SESSIONS_PER_MINUTE, 0, 1200, 0);
  const vus = clampNumber(envMap.RUM_BROWSER_VUS, 1, 500, 0);
  const durationMinutes = parseK6DurationToMinutes(envMap.RUM_BROWSER_DURATION);
  const startedAtMs = Date.parse(String(inspect?.State?.StartedAt || ""));
  const endsAtMs = Number.isFinite(startedAtMs) && durationMinutes > 0 ? startedAtMs + durationMinutes * 60 * 1000 : 0;

  return {
    startedAt: Number.isFinite(startedAtMs) ? new Date(startedAtMs).toISOString() : new Date().toISOString(),
    endsAtMs,
    mode: sessionsPerMinute > 0 ? "sessions_per_minute" : "vus",
    sessionsPerMinute,
    vus,
    durationMinutes,
    containerStatus: String(inspect?.State?.Status || "running"),
    source: "container-detected",
  };
}

async function syncRumScenario(containers) {
  const rum = containers?.[RUM_BROWSER_CONTAINER];
  const current = scenarioState.get(RUM_SCENARIO_ID);

  if (!rum || rum.state !== "running") {
    if (current?.details?.status === "scheduled" || current?.details?.status === "error") {
      return;
    }
    scenarioState.delete(RUM_SCENARIO_ID);
    return;
  }

  const shouldInspectContainer =
    preferPositiveNumber(current?.details?.sessionsPerMinute, 0) <= 0 &&
    preferPositiveNumber(current?.details?.vus, 0) <= 0 &&
    preferPositiveNumber(current?.details?.durationMinutes, 0) <= 0;

  let runtime = null;
  if (shouldInspectContainer) {
    runtime = await inspectRumContainerRuntime();
  }

  const sessionsPerMinute = preferPositiveNumber(current?.details?.sessionsPerMinute, runtime?.sessionsPerMinute);
  const vus = preferPositiveNumber(current?.details?.vus, runtime?.vus);
  const durationMinutes = preferPositiveNumber(current?.details?.durationMinutes, runtime?.durationMinutes);
  const nowIso = new Date().toISOString();
  scenarioState.set(RUM_SCENARIO_ID, {
    id: RUM_SCENARIO_ID,
    type: "rum_browser",
    running: true,
    label: "Frontend RUM (navegador real)",
    startedAt: current?.startedAt || runtime?.startedAt || nowIso,
    endsAtMs: Number(current?.endsAtMs || 0) || Number(runtime?.endsAtMs || 0),
    details: {
      mode: sessionsPerMinute > 0 ? "sessions_per_minute" : current?.details?.mode || runtime?.mode || "vus",
      sessionsPerMinute,
      vus,
      durationMinutes,
      status: "running",
      container: RUM_BROWSER_CONTAINER,
      containerStatus: runtime?.containerStatus || rum.status || "running",
      source: current?.details?.source || runtime?.source || "panel",
    },
    note:
      runtime?.source === "container-detected"
        ? "RUM ativo detectado no container (estado recuperado automaticamente no painel)."
        : "Sessoes reais de navegador para alimentar frontend e backend.",
  });
}

async function startRumBrowserScenario(rawPayload = {}) {
  clearRumScheduleTimers();

  const runtime = buildRumRuntimeConfig(rawPayload);
  const nowMs = Date.now();
  const hasFutureStart = Number.isFinite(runtime.startAtMs) && runtime.startAtMs > nowMs;
  const startAtMs = hasFutureStart ? runtime.startAtMs : nowMs;
  const endAtMs = runtime.endAtMs || startAtMs + runtime.durationMinutes * 60 * 1000;
  const mode = runtime.sessionsPerMinute > 0 ? "sessions_per_minute" : "vus";

  const baseDetails = {
    mode,
    sessionsPerMinute: runtime.sessionsPerMinute,
    vus: runtime.vus,
    durationMinutes: runtime.durationMinutes,
    startAt: new Date(startAtMs).toISOString(),
    endAt: new Date(endAtMs).toISOString(),
    container: RUM_BROWSER_CONTAINER,
  };

  if (hasFutureStart) {
    scenarioState.set(RUM_SCENARIO_ID, {
      id: RUM_SCENARIO_ID,
      type: "rum_browser",
      running: false,
      label: "Frontend RUM (navegador real)",
      startedAt: new Date(startAtMs).toISOString(),
      endsAtMs: endAtMs,
      details: {
        ...baseDetails,
        status: "scheduled",
      },
      note: `Agendado para iniciar em ${new Date(startAtMs).toLocaleString("pt-BR")}.`,
    });

    const delayMs = Math.max(1000, startAtMs - nowMs);
    rumScheduleState.startTimeout = setTimeout(async () => {
      try {
        await recreateRumBrowserContainer(runtime.env);
        scenarioState.set(RUM_SCENARIO_ID, {
          id: RUM_SCENARIO_ID,
          type: "rum_browser",
          running: true,
          label: "Frontend RUM (navegador real)",
          startedAt: new Date().toISOString(),
          endsAtMs: endAtMs,
          details: {
            ...baseDetails,
            status: "running",
          },
          note: "Frontend RUM em execucao.",
        });
        scheduleRumAutoStop(endAtMs);
      } catch (error) {
        scenarioState.set(RUM_SCENARIO_ID, {
          id: RUM_SCENARIO_ID,
          type: "rum_browser",
          running: false,
          label: "Frontend RUM (navegador real)",
          startedAt: new Date(startAtMs).toISOString(),
          endsAtMs: 0,
          details: {
            ...baseDetails,
            status: "error",
          },
          note: `Falha ao iniciar RUM: ${error.message}`,
        });
      } finally {
        rumScheduleState.startTimeout = null;
      }
    }, delayMs);
    rumScheduleState.startTimeout.unref();
    scheduleRumAutoStop(endAtMs);

    return {
      scheduled: true,
      startAt: new Date(startAtMs).toISOString(),
      endAt: new Date(endAtMs).toISOString(),
      mode,
    };
  }

  await recreateRumBrowserContainer(runtime.env);
  scenarioState.set(RUM_SCENARIO_ID, {
    id: RUM_SCENARIO_ID,
    type: "rum_browser",
    running: true,
    label: "Frontend RUM (navegador real)",
    startedAt: new Date().toISOString(),
    endsAtMs: endAtMs,
    details: {
      ...baseDetails,
      status: "running",
    },
    note: "Frontend RUM em execucao.",
  });
  scheduleRumAutoStop(endAtMs);

  return {
    scheduled: false,
    startAt: new Date(startAtMs).toISOString(),
    endAt: new Date(endAtMs).toISOString(),
    mode,
  };
}

async function stopRumBrowserScenario() {
  clearRumScheduleTimers();
  try {
    await stopContainerByName(RUM_BROWSER_CONTAINER);
  } catch (error) {
    const message = getErrorMessage(error);
    const statusCode = Number(error?.statusCode || error?.status || 0);
    const alreadyStopped = statusCode === 304 || message.includes("already stopped") || message.includes("is not running");
    if (isContainerNotFoundError(error) || alreadyStopped) {
      return;
    }
    throw error;
  } finally {
    scenarioState.delete(RUM_SCENARIO_ID);
  }
}

async function startLoadFromControlPanel(rawPayload) {
  const payload = buildLoadPayload(rawPayload || {});
  const data = await backendRequest("/api/operations/load/start", {
    method: "POST",
    payload,
    requiresControlKey: true,
  });
  syncLoadScenario(data?.load || null);
  loadStateCache.atMs = Date.now();
  loadStateCache.load = data?.load || null;
  loadStateCache.error = null;
  return data;
}

async function stopLoadFromControlPanel(reason = "manual_stop_via_control_panel") {
  const maxAttempts = 3;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const data = await backendRequest("/api/operations/load/stop", {
        method: "POST",
        payload: { reason },
        requiresControlKey: true,
        timeoutMs: Math.max(BACKEND_HTTP_TIMEOUT_MS, 25000),
      });
      syncLoadScenario(data?.load || null);
      loadStateCache.atMs = Date.now();
      loadStateCache.load = data?.load || null;
      loadStateCache.error = null;
      return data;
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        await sleep(500 * attempt);
      }
    }
  }

  const message = `Falha ao encerrar carga backend: ${lastError?.message || "sem detalhe"}`;
  loadStateCache.atMs = Date.now();
  loadStateCache.error = message;
  throw new Error(message);
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

async function startApiErrorRateChaos({ percent, durationSeconds }) {
  const safePercent = Math.max(1, Math.min(100, Number(percent || 30)));
  const safeDuration = Math.max(10, Math.min(3600, Number(durationSeconds || 300)));

  const response = await backendRequest("/api/operations/chaos/error-rate", {
    method: "POST",
    requiresControlKey: true,
    payload: {
      percent: safePercent,
      durationSeconds: safeDuration,
    },
  });

  setTimedScenarioState({
    id: CHAOS_ERROR_RATE_SCENARIO_ID,
    type: "chaos_error_rate",
    label: "API - Erros intermitentes",
    durationSeconds: safeDuration,
    details: {
      percent: safePercent,
      durationSeconds: safeDuration,
    },
    note: `Falhas HTTP 500 em ${safePercent}% das chamadas da API (exceto /api/auth).`,
  });

  return response;
}

async function startApiLatencyChaos({ baseMs, jitterMs, durationSeconds }) {
  const safeBaseMs = Math.max(50, Math.min(15000, Number(baseMs || 1200)));
  const safeJitterMs = Math.max(0, Math.min(15000, Number(jitterMs || 800)));
  const safeDuration = Math.max(10, Math.min(3600, Number(durationSeconds || 300)));

  const response = await backendRequest("/api/operations/chaos/latency", {
    method: "POST",
    requiresControlKey: true,
    payload: {
      baseMs: safeBaseMs,
      jitterMs: safeJitterMs,
      durationSeconds: safeDuration,
    },
  });

  setTimedScenarioState({
    id: CHAOS_LATENCY_SCENARIO_ID,
    type: "chaos_latency",
    label: "API - Latencia elevada",
    durationSeconds: safeDuration,
    details: {
      baseMs: safeBaseMs,
      jitterMs: safeJitterMs,
      durationSeconds: safeDuration,
    },
    note: `Atraso artificial de ${safeBaseMs}ms + jitter ate ${safeJitterMs}ms por requisicao da API.`,
  });

  return response;
}

async function resetApiChaosScenarios() {
  const errors = [];
  try {
    await backendRequest("/api/operations/chaos/error-rate", {
      method: "POST",
      requiresControlKey: true,
      payload: {
        percent: 0,
        durationSeconds: 1,
      },
    });
  } catch (error) {
    errors.push(`error-rate: ${error.message}`);
  }

  try {
    await backendRequest("/api/operations/chaos/latency", {
      method: "POST",
      requiresControlKey: true,
      payload: {
        baseMs: 0,
        jitterMs: 0,
        durationSeconds: 1,
      },
    });
  } catch (error) {
    errors.push(`latency: ${error.message}`);
  }

  scenarioState.delete(CHAOS_ERROR_RATE_SCENARIO_ID);
  scenarioState.delete(CHAOS_LATENCY_SCENARIO_ID);
  if (errors.length) {
    throw new Error(`Reset parcial do chaos API: ${errors.join(" | ")}`);
  }
}

async function disableSimulationJobScheduler() {
  const payload = {
    enabled: false,
    mode: "interval",
    intervalMinutes: 30,
    runOnStart: false,
    payload: {
      profile: "moderate",
      roles: ["patient", "doctor", "receptionist"],
      sessions: 40,
      durationSeconds: 300,
      rampUpSeconds: 30,
      requestPacingMs: 1200,
      jitterMs: 450,
    },
  };

  return backendRequest("/api/operations/jobs/simulation", {
    method: "POST",
    payload,
    requiresControlKey: true,
  });
}

async function stopAllScenarios(options = {}) {
  const strict = Boolean(options?.strict);
  const errors = [];
  const runStep = async (label, fn) => {
    try {
      await fn();
    } catch (error) {
      errors.push(`${label}: ${error.message || error}`);
    }
  };

  await runStep("simulation-job", () => disableSimulationJobScheduler());
  await runStep("dev-front", () => stopOutageScenario("dev-front", { ignoreStartErrors: true }));
  await runStep("dev-api", () => stopOutageScenario("dev-api", { ignoreStartErrors: true }));
  await runStep("db", () => stopOutageScenario("db", { ignoreStartErrors: true }));
  await runStep("infra-cpu", () => stopCpuChaos());
  await runStep("load", () => stopLoadFromControlPanel("manual_stop_via_control_panel"));
  await runStep("rum", () => stopRumBrowserScenario());
  await runStep("db-root-cause-chaos", () => stopDbRootCauseChaos());
  await runStep("api-chaos-reset", () => resetApiChaosScenarios());
  await runStep("core-services-healthy", () => ensureCoreServicesHealthy());
  await runStep("load-final-guard", () => stopLoadFromControlPanel("manual_stop_final_guard"));

  scenarioState.delete(PRESET_API_DEGRADADA_SCENARIO_ID);
  scenarioState.delete(PRESET_DB_CARGA_SCENARIO_ID);
  scenarioState.delete(PRESET_ROOT_DB_SCENARIO_ID);
  scenarioState.delete(PRESET_ROOT_BACKEND_SCENARIO_ID);
  scenarioState.delete(PRESET_ROOT_FRONTEND_SCENARIO_ID);
  loadStateCache.atMs = Date.now();
  loadStateCache.load = null;
  loadStateCache.error = errors.length ? `Parada parcial: ${errors.join(" | ")}` : null;

  if (strict && errors.length) {
    throw new Error(`Parada geral parcial: ${errors.join(" | ")}`);
  }
}

function resolvePresetDurationSeconds(rawOptions = {}, fallbackSeconds = 300) {
  const explicitSeconds = clampNumber(rawOptions?.durationSeconds, 60, 14400, null);
  if (explicitSeconds != null) {
    return Math.round(explicitSeconds);
  }
  const explicitMinutes = clampNumber(rawOptions?.durationMinutes, 1, 240, null);
  if (explicitMinutes != null) {
    return Math.round(explicitMinutes * 60);
  }
  return Math.round(fallbackSeconds);
}

async function startEvidenceTraffic({
  durationSeconds,
  loadProfile,
  loadSessions,
  requestPacingMs,
  jitterMs,
  roles,
  rumSessionsPerMinute,
  enableRum = true,
  rumVus = 3,
}) {
  await startLoadFromControlPanel({
    profile: loadProfile,
    sessions: loadSessions,
    durationSeconds,
    rampUpSeconds: 35,
    requestPacingMs,
    jitterMs,
    roles,
  });

  if (!enableRum || Number(rumSessionsPerMinute || 0) <= 0) {
    return {
      rumDurationMinutes: 0,
      rumSessionsPerMinute: 0,
      rumVus: 0,
    };
  }

  const rumDurationMinutes = Math.max(1, Math.ceil(durationSeconds / 60));
  await startRumBrowserScenario({
    sessionsPerMinute: Math.max(1, Number(rumSessionsPerMinute || 1)),
    vus: Math.max(1, Number(rumVus || 1)),
    durationMinutes: rumDurationMinutes,
  });

  return {
    rumDurationMinutes,
    rumSessionsPerMinute: Math.max(1, Number(rumSessionsPerMinute || 1)),
    rumVus: Math.max(1, Number(rumVus || 1)),
  };
}

async function startPresetApiDegradada(durationSeconds = 300, anomalyMode = false) {
  let safeDuration = resolvePresetDurationSeconds({ durationSeconds }, 300);
  if (anomalyMode) {
    safeDuration = Math.max(900, safeDuration);
  }
  const cpuSeconds = Math.max(60, Math.min(900, safeDuration));
  const errorRatePercent = anomalyMode ? 50 : 35;
  const latencyBaseMs = anomalyMode ? 2600 : 1800;
  const latencyJitterMs = anomalyMode ? 1400 : 1200;
  const cpuIntensity = anomalyMode ? 0.95 : 0.92;
  const cpuWorkers = anomalyMode ? 6 : 4;

  await startApiErrorRateChaos({ percent: errorRatePercent, durationSeconds: safeDuration });
  await startApiLatencyChaos({ baseMs: latencyBaseMs, jitterMs: latencyJitterMs, durationSeconds: safeDuration });
  await triggerCpuChaos({ seconds: cpuSeconds, intensity: cpuIntensity, workers: cpuWorkers });

  setTimedScenarioState({
    id: PRESET_API_DEGRADADA_SCENARIO_ID,
    type: "preset_combo",
    label: "Preset - API degradada",
    durationSeconds: safeDuration,
    details: {
      preset: "api-degradada",
      anomalyMode,
      errorRatePercent,
      latencyBaseMs,
      latencyJitterMs,
      cpuSeconds,
      cpuIntensity,
      cpuWorkers,
    },
    note: "Erro intermitente + latencia + pressao de CPU para gerar degradacao visivel.",
  });
}

async function startPresetDbCarga(durationSeconds = 300, anomalyMode = false) {
  let safeDuration = resolvePresetDurationSeconds({ durationSeconds }, 300);
  if (anomalyMode) {
    safeDuration = Math.max(900, safeDuration);
  }
  const profile = anomalyMode ? "extreme" : "heavy";
  const sessions = anomalyMode ? 220 : 150;
  const requestPacingMs = anomalyMode ? 800 : 1000;
  const jitterMs = anomalyMode ? 300 : 450;

  await startLoadFromControlPanel({
    profile,
    sessions,
    durationSeconds: safeDuration,
    rampUpSeconds: 35,
    requestPacingMs,
    jitterMs,
    roles: ["patient", "doctor", "receptionist"],
  });
  await startOutageScenario({
    id: "db",
    label: "Banco - PostgreSQL indisponivel",
    containerName: POSTGRES_CONTAINER,
    durationSeconds: safeDuration,
  });

  setTimedScenarioState({
    id: PRESET_DB_CARGA_SCENARIO_ID,
    type: "preset_combo",
    label: "Preset - Banco indisponivel com carga",
    durationSeconds: safeDuration,
    details: {
      preset: "db-carga",
      anomalyMode,
      loadProfile: profile,
      sessions,
      dbOutageSeconds: safeDuration,
    },
    note: "Carga ativa e banco indisponivel para forcar erro/latencia no backend e frontend.",
  });
}

async function startPresetRootDb(durationSeconds = 300, anomalyMode = false) {
  let safeDuration = resolvePresetDurationSeconds({ durationSeconds }, 300);
  if (anomalyMode) {
    safeDuration = Math.max(900, safeDuration);
  }
  const profile = anomalyMode ? "heavy" : "moderate";
  const sessions = anomalyMode ? 90 : 55;
  const requestPacingMs = anomalyMode ? 950 : 1200;
  const jitterMs = anomalyMode ? 220 : 320;
  const rumSessionsPerMinute = 0;

  await stopAllScenarios();
  await ensureCoreServicesHealthy();
  await resetApiChaosScenarios();

  const rumTraffic = await startEvidenceTraffic({
    durationSeconds: safeDuration,
    loadProfile: profile,
    loadSessions: sessions,
    requestPacingMs,
    jitterMs,
    roles: ["patient", "doctor", "receptionist"],
    rumSessionsPerMinute,
    enableRum: false,
  });
  const dbChaos = await startDbRootCauseChaos(safeDuration, anomalyMode);

  setTimedScenarioState({
    id: PRESET_ROOT_DB_SCENARIO_ID,
    type: "preset_root_cause",
    label: "Causa raiz - Banco",
    durationSeconds: safeDuration,
    details: {
      target: "db",
      anomalyMode,
      loadProfile: profile,
      sessions,
      rumSessionsPerMinute: rumTraffic.rumSessionsPerMinute,
      rumVus: rumTraffic.rumVus,
      dbChaosMode: dbChaos.mode,
      dbChaosWorkers: dbChaos.workerCount,
      dbChaosDurationSeconds: dbChaos.durationSeconds,
      dbChaosLockTables: dbChaos.lockTables,
    },
    note:
      "Banco degradado por lock transacional em tabelas operacionais + stress SQL, mantendo frontend e backend ativos.",
  });
}

async function startPresetRootBackend(durationSeconds = 300, anomalyMode = false) {
  let safeDuration = resolvePresetDurationSeconds({ durationSeconds }, 300);
  if (anomalyMode) {
    safeDuration = Math.max(900, safeDuration);
  }
  const profile = anomalyMode ? "extreme" : "heavy";
  const sessions = anomalyMode ? 280 : 180;
  const requestPacingMs = anomalyMode ? 700 : 900;
  const jitterMs = anomalyMode ? 250 : 380;
  const errorRatePercent = anomalyMode ? 75 : 55;
  const latencyBaseMs = anomalyMode ? 3200 : 2200;
  const latencyJitterMs = anomalyMode ? 1200 : 900;
  const rumSessionsPerMinute = anomalyMode ? 24 : 14;

  await stopAllScenarios();
  await ensureCoreServicesHealthy();

  const rumTraffic = await startEvidenceTraffic({
    durationSeconds: safeDuration,
    loadProfile: profile,
    loadSessions: sessions,
    requestPacingMs,
    jitterMs,
    roles: ["patient", "doctor", "receptionist", "admin"],
    rumSessionsPerMinute,
  });

  await startApiErrorRateChaos({ percent: errorRatePercent, durationSeconds: safeDuration });
  await startApiLatencyChaos({ baseMs: latencyBaseMs, jitterMs: latencyJitterMs, durationSeconds: safeDuration });

  setTimedScenarioState({
    id: PRESET_ROOT_BACKEND_SCENARIO_ID,
    type: "preset_root_cause",
    label: "Causa raiz - Backend",
    durationSeconds: safeDuration,
    details: {
      target: "backend",
      anomalyMode,
      loadProfile: profile,
      sessions,
      rumSessionsPerMinute: rumTraffic.rumSessionsPerMinute,
      rumVus: rumTraffic.rumVus,
      errorRatePercent,
      latencyBaseMs,
      latencyJitterMs,
    },
    note: "Somente o backend recebe erro/latencia; banco e frontend continuam saudaveis com carga ativa.",
  });
}

async function startPresetRootFrontend(durationSeconds = 300, anomalyMode = false) {
  let safeDuration = resolvePresetDurationSeconds({ durationSeconds }, 300);
  if (anomalyMode) {
    safeDuration = Math.max(900, safeDuration);
  }
  const profile = anomalyMode ? "heavy" : "moderate";
  const sessions = anomalyMode ? 150 : 95;
  const requestPacingMs = anomalyMode ? 950 : 1200;
  const jitterMs = anomalyMode ? 280 : 420;
  const rumSessionsPerMinute = anomalyMode ? 26 : 18;

  await stopAllScenarios();
  await ensureCoreServicesHealthy();

  const rumTraffic = await startEvidenceTraffic({
    durationSeconds: safeDuration,
    loadProfile: profile,
    loadSessions: sessions,
    requestPacingMs,
    jitterMs,
    roles: ["patient", "doctor", "receptionist"],
    rumSessionsPerMinute,
  });

  await startOutageScenario({
    id: "dev-front",
    label: "DEV - Frontend indisponivel",
    containerName: FRONTEND_CONTAINER,
    durationSeconds: safeDuration,
  });

  setTimedScenarioState({
    id: PRESET_ROOT_FRONTEND_SCENARIO_ID,
    type: "preset_root_cause",
    label: "Causa raiz - Frontend",
    durationSeconds: safeDuration,
    details: {
      target: "frontend",
      anomalyMode,
      loadProfile: profile,
      sessions,
      rumSessionsPerMinute: rumTraffic.rumSessionsPerMinute,
      rumVus: rumTraffic.rumVus,
      frontendOutageSeconds: safeDuration,
    },
    note: "Somente o frontend fica indisponivel; backend e banco permanecem ativos com carga para evidenciar causa raiz.",
  });
}

async function startPresetScenario(presetId, options = {}) {
  const durationSeconds = resolvePresetDurationSeconds(options, 300);
  const anomalyMode = String(options?.anomalyMode ?? "true").trim().toLowerCase() !== "false";
  const durationMinutes = Math.round(durationSeconds / 60);
  const preset = String(presetId || "").trim();
  if (preset === "api-degradada") {
    await startPresetApiDegradada(durationSeconds, anomalyMode);
    return {
      preset,
      durationMinutes,
      message: `Preset API degradada iniciado por ${durationMinutes} min.`,
    };
  }
  if (preset === "db-carga") {
    await startPresetDbCarga(durationSeconds, anomalyMode);
    return {
      preset,
      durationMinutes,
      message: `Preset banco indisponivel com carga iniciado por ${durationMinutes} min.`,
    };
  }
  if (preset === "root-db") {
    await startPresetRootDb(durationSeconds, anomalyMode);
    return {
      preset,
      durationMinutes,
      message: `Preset de causa raiz Banco iniciado por ${durationMinutes} min.`,
    };
  }
  if (preset === "root-backend") {
    await startPresetRootBackend(durationSeconds, anomalyMode);
    return {
      preset,
      durationMinutes,
      message: `Preset de causa raiz Backend iniciado por ${durationMinutes} min.`,
    };
  }
  if (preset === "root-frontend") {
    await startPresetRootFrontend(durationSeconds, anomalyMode);
    return {
      preset,
      durationMinutes,
      message: `Preset de causa raiz Frontend iniciado por ${durationMinutes} min.`,
    };
  }
  throw new Error("Preset invalido.");
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
    await syncRumScenario(containers);
    const nowMs = Date.now();

    if (CONTROL_PANEL_ENABLE_BACKEND_POLL && nowMs - loadStateCache.atMs >= LOAD_STATE_CACHE_MS) {
      try {
        const state = await backendRequest("/api/operations/state", { method: "GET" });
        loadStateCache.load = state?.load || null;
        loadStateCache.error = null;
        loadStateCache.atMs = nowMs;
        syncLoadScenario(loadStateCache.load);
      } catch (error) {
        loadStateCache.error = error.message;
        loadStateCache.atMs = nowMs;
        if (!loadStateCache.load) {
          syncLoadScenario(null);
        }
      }
    } else if (!CONTROL_PANEL_ENABLE_BACKEND_POLL) {
      loadStateCache.error = null;
    }

    return res.json({
      now: new Date().toISOString(),
      containers: {
        frontend: containers[FRONTEND_CONTAINER] || null,
        backend: containers[BACKEND_CONTAINER] || null,
        postgres: containers[POSTGRES_CONTAINER] || null,
        rumBrowser: containers[RUM_BROWSER_CONTAINER] || null,
      },
      load: loadStateCache.load,
      loadError: loadStateCache.error,
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

app.post("/api/scenarios/chaos/error-rate/start", requireAuth, async (req, res, next) => {
  try {
    const result = await startApiErrorRateChaos({
      percent: req.body?.percent,
      durationSeconds: req.body?.durationSeconds,
    });
    return res.json({
      message: "Cenario de erro intermitente na API iniciado.",
      result,
      scenarios: scenarioSnapshot(),
    });
  } catch (error) {
    return next(error);
  }
});

app.post("/api/scenarios/chaos/latency/start", requireAuth, async (req, res, next) => {
  try {
    const result = await startApiLatencyChaos({
      baseMs: req.body?.baseMs,
      jitterMs: req.body?.jitterMs,
      durationSeconds: req.body?.durationSeconds,
    });
    return res.json({
      message: "Cenario de latencia na API iniciado.",
      result,
      scenarios: scenarioSnapshot(),
    });
  } catch (error) {
    return next(error);
  }
});

app.post("/api/scenarios/chaos/reset", requireAuth, async (_req, res, next) => {
  try {
    await resetApiChaosScenarios();
    return res.json({
      message: "Cenarios de chaos de API resetados.",
      scenarios: scenarioSnapshot(),
    });
  } catch (error) {
    return next(error);
  }
});

app.post("/api/scenarios/presets/start", requireAuth, async (req, res, next) => {
  try {
    const result = await startPresetScenario(req.body?.preset, req.body || {});
    return res.json({
      message: result.message,
      result,
      scenarios: scenarioSnapshot(),
    });
  } catch (error) {
    return next(error);
  }
});

app.post("/api/scenarios/presets/reset", requireAuth, async (_req, res, next) => {
  try {
    await stopAllScenarios({ strict: true });
    return res.json({
      message: "Reset geral executado (chaos, indisponibilidade e cargas).",
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

app.post("/api/scenarios/rum-front/start", requireAuth, async (req, res, next) => {
  try {
    const result = await startRumBrowserScenario(req.body || {});
    return res.json({
      message: result?.scheduled ? "Carga de frontend RUM agendada." : "Carga de frontend RUM iniciada.",
      result,
      scenarios: scenarioSnapshot(),
    });
  } catch (error) {
    return next(error);
  }
});

app.post("/api/scenarios/rum-front/stop", requireAuth, async (_req, res, next) => {
  try {
    await stopRumBrowserScenario();
    return res.json({
      message: "Carga de frontend RUM encerrada.",
      scenarios: scenarioSnapshot(),
    });
  } catch (error) {
    return next(error);
  }
});

app.post("/api/scenarios/stop-all", requireAuth, async (_req, res, next) => {
  try {
    await stopAllScenarios({ strict: true });
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
