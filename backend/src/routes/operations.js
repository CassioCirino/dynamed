const { randomUUID } = require("node:crypto");
const express = require("express");
const { z } = require("zod");
const { query } = require("../db");
const { authenticate, authorize } = require("../middleware/auth");
const { requireSimulationControlKey } = require("../middleware/simulation-control");
const { ROLES } = require("../constants");
const {
  getChaosState,
  getSystemSnapshot,
  setErrorRate,
  setLatency,
  startCpuBurn,
  stopCpuBurn,
  startMemoryPressure,
  startDiskPressure,
} = require("../services/chaos");
const {
  PROFILE_PRESETS,
  getLoadState,
  startLoadSimulation,
  stopLoadSimulation,
} = require("../services/load-simulator");
const {
  getSimulationJobConfig,
  updateSimulationJobConfig,
  runSimulationJobNow,
} = require("../services/simulation-jobs");

const router = express.Router();
router.use(authenticate);

router.get(
  "/state",
  authorize(ROLES.ADMIN, ROLES.RECEPTIONIST, ROLES.DOCTOR),
  async (req, res) => {
    res.json({
      chaos: getChaosState(),
      load: getLoadState(),
      system: getSystemSnapshot(),
    });
  },
);

router.get("/load/state", authorize(ROLES.ADMIN, ROLES.RECEPTIONIST, ROLES.DOCTOR), async (_req, res) => {
  res.json({
    load: getLoadState(),
    profiles: PROFILE_PRESETS,
  });
});

const loadStartSchema = z.object({
  profile: z.enum(["light", "moderate", "heavy", "extreme", "custom"]).default("moderate"),
  sessions: z.number().min(1).max(600).optional(),
  durationSeconds: z.number().min(30).max(7200).optional(),
  rampUpSeconds: z.number().min(0).max(900).optional(),
  requestPacingMs: z.number().min(200).max(20000).optional(),
  jitterMs: z.number().min(0).max(10000).optional(),
  roles: z.array(z.enum(["patient", "doctor", "receptionist", "admin"])).min(1).max(4).optional(),
});

const simulationJobSchema = z.object({
  enabled: z.boolean(),
  mode: z.enum(["interval", "cron"]),
  intervalMinutes: z.number().min(1).max(1440).optional(),
  cronExpression: z.string().min(5).max(120).optional(),
  timezone: z.string().min(1).max(100).optional(),
  runOnStart: z.boolean().optional(),
  startDelaySeconds: z.number().min(0).max(600).optional(),
  payload: loadStartSchema.partial().optional(),
  profile: z.enum(["light", "moderate", "heavy", "extreme", "custom"]).optional(),
  sessions: z.number().min(1).max(600).optional(),
  durationSeconds: z.number().min(30).max(7200).optional(),
  rampUpSeconds: z.number().min(0).max(900).optional(),
  requestPacingMs: z.number().min(200).max(20000).optional(),
  jitterMs: z.number().min(0).max(10000).optional(),
  roles: z.array(z.enum(["patient", "doctor", "receptionist", "admin"])).min(1).max(4).optional(),
});

router.get("/jobs/simulation", authorize(ROLES.ADMIN), async (_req, res) => {
  res.json({
    job: getSimulationJobConfig(),
    load: getLoadState(),
  });
});

router.post("/jobs/simulation", authorize(ROLES.ADMIN), requireSimulationControlKey, async (req, res, next) => {
  try {
    const parsed = simulationJobSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ message: "Payload invalido.", issues: parsed.error.issues });
    }

    const raw = parsed.data;
    const payload = raw.payload || {
      profile: raw.profile,
      sessions: raw.sessions,
      durationSeconds: raw.durationSeconds,
      rampUpSeconds: raw.rampUpSeconds,
      requestPacingMs: raw.requestPacingMs,
      jitterMs: raw.jitterMs,
      roles: raw.roles,
    };

    const nextConfig = updateSimulationJobConfig({
      enabled: raw.enabled,
      mode: raw.mode,
      intervalMinutes: raw.intervalMinutes,
      cronExpression: raw.cronExpression,
      timezone: raw.timezone,
      runOnStart: raw.runOnStart,
      startDelaySeconds: raw.startDelaySeconds,
      payload,
    });

    return res.json({
      message: "Configuracao de agendamento atualizada.",
      job: nextConfig,
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/jobs/simulation/run-now", authorize(ROLES.ADMIN), requireSimulationControlKey, async (req, res, next) => {
  try {
    const parsed = loadStartSchema.partial().safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ message: "Payload invalido.", issues: parsed.error.issues });
    }

    const result = await runSimulationJobNow(parsed.data);
    return res.status(202).json({
      message: "Execucao manual de simulacao iniciada.",
      ...result,
    });
  } catch (error) {
    if (error.message?.includes("Ja existe")) {
      return res.status(409).json({ message: error.message });
    }
    return next(error);
  }
});

router.post("/load/start", authorize(ROLES.ADMIN), requireSimulationControlKey, async (req, res, next) => {
  try {
    const parsed = loadStartSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ message: "Payload invalido.", issues: parsed.error.issues });
    }

    const load = await startLoadSimulation(parsed.data, req.user.sub);
    return res.status(202).json({
      message: "Simulacao de carga iniciada.",
      load,
    });
  } catch (error) {
    if (error.message?.includes("Ja existe")) {
      return res.status(409).json({ message: error.message });
    }
    return next(error);
  }
});

const loadStopSchema = z.object({
  reason: z.string().min(3).max(120).optional(),
});

router.post("/load/stop", authorize(ROLES.ADMIN), requireSimulationControlKey, async (req, res, next) => {
  try {
    const parsed = loadStopSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ message: "Payload invalido.", issues: parsed.error.issues });
    }

    const load = await stopLoadSimulation(parsed.data.reason || "manual_stop", req.user.sub);
    return res.json({
      message: "Simulacao de carga encerrada.",
      load,
    });
  } catch (error) {
    return next(error);
  }
});

const errorRateSchema = z.object({
  percent: z.number().min(0).max(100),
  durationSeconds: z.number().min(1).max(3600),
});

router.post("/chaos/error-rate", authorize(ROLES.ADMIN), requireSimulationControlKey, async (req, res, next) => {
  try {
    const parsed = errorRateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "Payload invalido.", issues: parsed.error.issues });
    }
    const state = await setErrorRate(parsed.data.percent, parsed.data.durationSeconds, req.user.sub);
    return res.json({ chaos: state });
  } catch (error) {
    return next(error);
  }
});

const latencySchema = z.object({
  baseMs: z.number().min(0).max(15000),
  jitterMs: z.number().min(0).max(15000),
  durationSeconds: z.number().min(1).max(3600),
});

router.post("/chaos/latency", authorize(ROLES.ADMIN), requireSimulationControlKey, async (req, res, next) => {
  try {
    const parsed = latencySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "Payload invalido.", issues: parsed.error.issues });
    }
    const state = await setLatency(parsed.data.baseMs, parsed.data.jitterMs, parsed.data.durationSeconds, req.user.sub);
    return res.json({ chaos: state });
  } catch (error) {
    return next(error);
  }
});

const cpuSchema = z.object({
  seconds: z.number().min(1).max(1200),
  intensity: z.number().min(0.05).max(1),
  workers: z.number().min(1).max(64),
});

router.post("/chaos/cpu-burn", authorize(ROLES.ADMIN), requireSimulationControlKey, async (req, res, next) => {
  try {
    const parsed = cpuSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "Payload invalido.", issues: parsed.error.issues });
    }
    const state = await startCpuBurn(parsed.data.seconds, parsed.data.intensity, parsed.data.workers, req.user.sub);
    return res.json({ chaos: state });
  } catch (error) {
    return next(error);
  }
});

router.post("/chaos/cpu-stop", authorize(ROLES.ADMIN), requireSimulationControlKey, async (req, res, next) => {
  try {
    const state = await stopCpuBurn(req.user.sub);
    return res.json({ chaos: state });
  } catch (error) {
    return next(error);
  }
});

const memorySchema = z.object({
  mb: z.number().min(1).max(4096),
  ttlSeconds: z.number().min(5).max(3600),
});

router.post("/chaos/memory-pressure", authorize(ROLES.ADMIN), requireSimulationControlKey, async (req, res, next) => {
  try {
    const parsed = memorySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "Payload invalido.", issues: parsed.error.issues });
    }
    const state = await startMemoryPressure(parsed.data.mb, parsed.data.ttlSeconds, req.user.sub);
    return res.json({ chaos: state });
  } catch (error) {
    return next(error);
  }
});

const diskSchema = z.object({
  mb: z.number().min(1).max(4096),
  ttlSeconds: z.number().min(5).max(3600),
});

router.post("/chaos/disk-pressure", authorize(ROLES.ADMIN), requireSimulationControlKey, async (req, res, next) => {
  try {
    const parsed = diskSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "Payload invalido.", issues: parsed.error.issues });
    }
    const state = await startDiskPressure(parsed.data.mb, parsed.data.ttlSeconds, req.user.sub);
    return res.json({ chaos: state });
  } catch (error) {
    return next(error);
  }
});

router.get("/incidents", authorize(ROLES.ADMIN, ROLES.RECEPTIONIST, ROLES.DOCTOR), async (req, res, next) => {
  try {
    const result = await query(
      `SELECT id, title, description, severity, status, source, created_at, resolved_at
       FROM incidents
       ORDER BY created_at DESC
       LIMIT 200`,
    );
    res.json({ incidents: result.rows });
  } catch (error) {
    next(error);
  }
});

const incidentSchema = z.object({
  title: z.string().min(5).max(120),
  description: z.string().min(10).max(5000),
  severity: z.enum(["info", "warning", "critical"]),
  source: z.string().min(2).max(80),
});

router.post("/incidents", authorize(ROLES.ADMIN, ROLES.RECEPTIONIST, ROLES.DOCTOR), async (req, res, next) => {
  try {
    const parsed = incidentSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "Payload invalido.", issues: parsed.error.issues });
    }
    const payload = parsed.data;
    const id = randomUUID();
    const created = await query(
      `INSERT INTO incidents (id, title, description, severity, status, source, created_by)
       VALUES ($1, $2, $3, $4, 'open', $5, $6)
       RETURNING *`,
      [id, payload.title, payload.description, payload.severity, payload.source, req.user.sub],
    );
    return res.status(201).json({ incident: created.rows[0] });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
