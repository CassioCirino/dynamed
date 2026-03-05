const express = require("express");
const cors = require("cors");
const pinoHttp = require("pino-http");
const { logger } = require("./logger");
const { checkDbReadiness, isDbConnectionError, classifyDbError } = require("./db");
const { trackRequest, register } = require("./services/metrics");
const { faultInjection } = require("./middleware/fault-injection");
const authRoutes = require("./routes/auth");
const dashboardRoutes = require("./routes/dashboard");
const patientsRoutes = require("./routes/patients");
const appointmentsRoutes = require("./routes/appointments");
const examsRoutes = require("./routes/exams");
const operationsRoutes = require("./routes/operations");

function createApp() {
  const app = express();

  app.use(
    cors({
      origin: (process.env.CORS_ORIGIN || "http://localhost:5173").split(","),
    }),
  );
  app.use(express.json({ limit: "2mb" }));
  app.use(
    pinoHttp({
      logger,
    }),
  );
  app.use(trackRequest);
  app.use(faultInjection);

  app.get("/health/live", (_req, res) => {
    res.json({ ok: true, type: "liveness" });
  });

  app.get("/health/ready", async (_req, res) => {
    try {
      const db = await checkDbReadiness();
      res.json({ ok: true, type: "readiness", db: { ok: true, durationSeconds: db.durationSeconds } });
    } catch (error) {
      const kind = classifyDbError(error);
      res.status(503).json({
        ok: false,
        type: "readiness",
        db: {
          ok: false,
          errorKind: kind,
          code: String(error?.code || ""),
        },
      });
    }
  });

  app.get("/metrics", async (_req, res, next) => {
    try {
      res.set("Content-Type", register.contentType);
      res.send(await register.metrics());
    } catch (error) {
      next(error);
    }
  });

  app.use("/api/auth", authRoutes);
  app.use("/api/dashboard", dashboardRoutes);
  app.use("/api/patients", patientsRoutes);
  app.use("/api/appointments", appointmentsRoutes);
  app.use("/api/exams", examsRoutes);
  app.use("/api/operations", operationsRoutes);

  app.use((_req, res) => {
    res.status(404).json({ message: "Endpoint nao encontrado." });
  });

  app.use((error, req, res, _next) => {
    req.log?.error({ error }, "Erro nao tratado.");
    if (isDbConnectionError(error)) {
      return res.status(503).json({
        message: "Banco de dados indisponivel.",
        code: "DB_UNAVAILABLE",
        details: process.env.NODE_ENV === "development" ? error.message : undefined,
      });
    }
    res.status(500).json({
      message: "Erro interno da API.",
      details: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  });

  return app;
}

module.exports = {
  createApp,
};
