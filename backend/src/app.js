const express = require("express");
const cors = require("cors");
const pinoHttp = require("pino-http");
const { logger } = require("./logger");
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

  app.get("/health/ready", (_req, res) => {
    res.json({ ok: true, type: "readiness" });
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
