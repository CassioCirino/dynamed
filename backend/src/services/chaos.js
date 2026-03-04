const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { Worker } = require("node:worker_threads");
const { randomUUID } = require("node:crypto");
const { query } = require("../db");
const { logger } = require("../logger");
const { recordChaos, setChaosGauge } = require("./metrics");

const CHAOS_DIR = path.join(process.cwd(), "tmp", "chaos");

const state = {
  errorRate: {
    percent: 0,
    until: 0,
  },
  latency: {
    baseMs: 0,
    jitterMs: 0,
    until: 0,
  },
  cpuBurnSessions: new Map(),
  memoryHogs: new Map(),
  diskArtifacts: new Map(),
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function getChaosState() {
  return {
    errorRate: state.errorRate,
    latency: state.latency,
    activeCpuBurnSessions: state.cpuBurnSessions.size,
    activeCpuWorkers: [...state.cpuBurnSessions.values()].reduce((acc, session) => acc + session.workers.length, 0),
    memoryPressureMb: [...state.memoryHogs.values()].reduce((acc, item) => acc + item.mb, 0),
    diskPressureMb: [...state.diskArtifacts.values()].reduce((acc, item) => acc + item.mb, 0),
    memoryHogsCount: state.memoryHogs.size,
    diskArtifactsCount: state.diskArtifacts.size,
  };
}

function updateGauge() {
  setChaosGauge(state.memoryHogs.size, state.diskArtifacts.size);
}

function nowISO() {
  return new Date().toISOString();
}

async function writeChaosEvent(kind, status, config, triggeredBy, endedAt = null) {
  try {
    await query(
      `INSERT INTO chaos_events (kind, status, config, triggered_by, ended_at)
       VALUES ($1, $2, $3::jsonb, $4, $5)`,
      [kind, status, JSON.stringify(config || {}), triggeredBy || null, endedAt],
    );
  } catch (error) {
    logger.warn({ error, kind, status }, "Falha ao persistir evento de chaos.");
  }
}

async function setErrorRate(percent, durationSeconds, triggeredBy) {
  const safePercent = clamp(Number(percent || 0), 0, 100);
  const safeDuration = clamp(Number(durationSeconds || 0), 0, 3600);
  const until = Date.now() + safeDuration * 1000;
  state.errorRate = {
    percent: safePercent,
    until,
  };

  recordChaos("error_rate", "started");
  await writeChaosEvent(
    "error_rate",
    "started",
    {
      percent: safePercent,
      durationSeconds: safeDuration,
      until: new Date(until).toISOString(),
    },
    triggeredBy,
  );

  return getChaosState();
}

async function setLatency(baseMs, jitterMs, durationSeconds, triggeredBy) {
  const safeBase = clamp(Number(baseMs || 0), 0, 15000);
  const safeJitter = clamp(Number(jitterMs || 0), 0, 15000);
  const safeDuration = clamp(Number(durationSeconds || 0), 0, 3600);
  const until = Date.now() + safeDuration * 1000;
  state.latency = {
    baseMs: safeBase,
    jitterMs: safeJitter,
    until,
  };

  recordChaos("latency", "started");
  await writeChaosEvent(
    "latency",
    "started",
    {
      baseMs: safeBase,
      jitterMs: safeJitter,
      durationSeconds: safeDuration,
      until: new Date(until).toISOString(),
    },
    triggeredBy,
  );

  return getChaosState();
}

function createCpuWorker(durationMs, intensity) {
  const workerCode = `
    const { parentPort, workerData } = require("node:worker_threads");
    const shared = new Int32Array(new SharedArrayBuffer(4));
    const endAt = Date.now() + workerData.durationMs;
    const level = Math.max(0.05, Math.min(1, workerData.intensity));
    const cycle = 50;

    while (Date.now() < endAt) {
      const busy = Math.max(1, Math.floor(cycle * level));
      const idle = cycle - busy;
      const busyUntil = Date.now() + busy;
      while (Date.now() < busyUntil) {
        Math.random() * Math.random();
      }
      if (idle > 0) {
        Atomics.wait(shared, 0, 0, idle);
      }
    }
    parentPort.postMessage("done");
  `;

  return new Worker(workerCode, {
    eval: true,
    workerData: {
      durationMs,
      intensity,
    },
  });
}

async function startCpuBurn(seconds, intensity, workers, triggeredBy) {
  const safeSeconds = clamp(Number(seconds || 0), 1, 1200);
  const safeIntensity = clamp(Number(intensity || 0.95), 0.05, 1);
  const safeWorkers = clamp(Number(workers || 1), 1, Math.max(1, os.cpus().length * 2));
  const sessionId = randomUUID();

  const createdWorkers = [];
  for (let i = 0; i < safeWorkers; i += 1) {
    const worker = createCpuWorker(safeSeconds * 1000, safeIntensity);
    createdWorkers.push(worker);
  }

  state.cpuBurnSessions.set(sessionId, {
    startedAt: nowISO(),
    workers: createdWorkers,
  });

  const finishSession = async (status, errorMessage = null) => {
    if (!state.cpuBurnSessions.has(sessionId)) {
      return;
    }
    state.cpuBurnSessions.delete(sessionId);
    recordChaos("cpu_burn", status === "finished" ? "finished" : "failed");
    await writeChaosEvent(
      "cpu_burn",
      status,
      {
        sessionId,
        seconds: safeSeconds,
        intensity: safeIntensity,
        workers: safeWorkers,
        errorMessage,
      },
      triggeredBy,
      new Date().toISOString(),
    );
  };

  let pendingWorkers = safeWorkers;
  createdWorkers.forEach((worker) => {
    worker.on("message", async () => {
      pendingWorkers -= 1;
      if (pendingWorkers <= 0) {
        await finishSession("finished");
      }
    });

    worker.on("error", async (error) => {
      logger.error({ error }, "Worker de cpu burn falhou.");
      await finishSession("failed", error.message);
    });

    worker.on("exit", async (code) => {
      if (code !== 0) {
        await finishSession("failed", `Worker finalizado com codigo ${code}`);
      }
    });
  });

  recordChaos("cpu_burn", "started");
  await writeChaosEvent(
    "cpu_burn",
    "started",
    {
      sessionId,
      seconds: safeSeconds,
      intensity: safeIntensity,
      workers: safeWorkers,
    },
    triggeredBy,
  );

  return {
    sessionId,
    ...getChaosState(),
  };
}

async function stopCpuBurn(triggeredBy) {
  let stoppedSessions = 0;
  let stoppedWorkers = 0;

  for (const [sessionId, session] of state.cpuBurnSessions.entries()) {
    stoppedSessions += 1;
    for (const worker of session.workers || []) {
      stoppedWorkers += 1;
      try {
        await worker.terminate();
      } catch (_error) {
        // no-op
      }
    }
    state.cpuBurnSessions.delete(sessionId);
  }

  if (stoppedSessions > 0) {
    recordChaos("cpu_burn", "finished");
    await writeChaosEvent(
      "cpu_burn",
      "finished",
      {
        stoppedManually: true,
        stoppedSessions,
        stoppedWorkers,
      },
      triggeredBy,
      new Date().toISOString(),
    );
  }

  return {
    stoppedSessions,
    stoppedWorkers,
    ...getChaosState(),
  };
}

async function startMemoryPressure(mb, ttlSeconds, triggeredBy) {
  const safeMb = clamp(Number(mb || 0), 1, 4096);
  const safeTtl = clamp(Number(ttlSeconds || 60), 5, 3600);
  const id = randomUUID();

  const chunks = [];
  for (let i = 0; i < safeMb; i += 1) {
    chunks.push(Buffer.alloc(1024 * 1024, 1));
  }

  state.memoryHogs.set(id, {
    mb: safeMb,
    chunks,
    expiresAt: Date.now() + safeTtl * 1000,
  });
  updateGauge();

  setTimeout(async () => {
    state.memoryHogs.delete(id);
    updateGauge();
    await writeChaosEvent(
      "memory_pressure",
      "finished",
      {
        id,
        mb: safeMb,
      },
      triggeredBy,
      new Date().toISOString(),
    );
  }, safeTtl * 1000).unref();

  recordChaos("memory_pressure", "started");
  await writeChaosEvent(
    "memory_pressure",
    "started",
    {
      id,
      mb: safeMb,
      ttlSeconds: safeTtl,
    },
    triggeredBy,
  );

  return {
    id,
    ...getChaosState(),
  };
}

async function startDiskPressure(mb, ttlSeconds, triggeredBy) {
  const safeMb = clamp(Number(mb || 0), 1, 4096);
  const safeTtl = clamp(Number(ttlSeconds || 60), 5, 3600);
  const id = randomUUID();
  const createdFiles = [];

  fs.mkdirSync(CHAOS_DIR, { recursive: true });

  for (let i = 0; i < safeMb; i += 1) {
    const filePath = path.join(CHAOS_DIR, `${id}_${i}.bin`);
    fs.writeFileSync(filePath, Buffer.alloc(1024 * 1024, i % 255));
    createdFiles.push(filePath);
  }

  state.diskArtifacts.set(id, {
    mb: safeMb,
    files: createdFiles,
    expiresAt: Date.now() + safeTtl * 1000,
  });
  updateGauge();

  setTimeout(async () => {
    for (const filePath of createdFiles) {
      try {
        fs.unlinkSync(filePath);
      } catch (error) {
        logger.warn({ error, filePath }, "Falha ao limpar artefato de disco.");
      }
    }
    state.diskArtifacts.delete(id);
    updateGauge();
    await writeChaosEvent(
      "disk_pressure",
      "finished",
      {
        id,
        mb: safeMb,
      },
      triggeredBy,
      new Date().toISOString(),
    );
  }, safeTtl * 1000).unref();

  recordChaos("disk_pressure", "started");
  await writeChaosEvent(
    "disk_pressure",
    "started",
    {
      id,
      mb: safeMb,
      ttlSeconds: safeTtl,
      directory: CHAOS_DIR,
    },
    triggeredBy,
  );

  return {
    id,
    ...getChaosState(),
  };
}

function shouldBypassFault(pathname) {
  return pathname.startsWith("/health") || pathname.startsWith("/metrics") || pathname.startsWith("/api/auth");
}

function evaluateFault(pathname) {
  if (shouldBypassFault(pathname)) {
    return {
      injectError: false,
      delayMs: 0,
    };
  }

  const now = Date.now();
  const isErrorWindowOpen = state.errorRate.until > now;
  const isLatencyWindowOpen = state.latency.until > now;

  let delayMs = 0;
  if (isLatencyWindowOpen) {
    const jitter = Math.random() * state.latency.jitterMs;
    delayMs = Math.round(state.latency.baseMs + jitter);
  }

  let injectError = false;
  if (isErrorWindowOpen) {
    injectError = Math.random() * 100 < state.errorRate.percent;
  }

  return {
    injectError,
    delayMs,
  };
}

function getSystemSnapshot() {
  const mem = process.memoryUsage();
  return {
    node: {
      version: process.version,
      uptimeSeconds: Math.floor(process.uptime()),
      memoryRssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
      externalBytes: mem.external,
    },
    host: {
      platform: os.platform(),
      cpuCount: os.cpus().length,
      loadAverage: os.loadavg(),
      totalMemoryBytes: os.totalmem(),
      freeMemoryBytes: os.freemem(),
      uptimeSeconds: os.uptime(),
    },
    chaos: getChaosState(),
  };
}

module.exports = {
  getChaosState,
  setErrorRate,
  setLatency,
  startCpuBurn,
  stopCpuBurn,
  startMemoryPressure,
  startDiskPressure,
  evaluateFault,
  getSystemSnapshot,
};
