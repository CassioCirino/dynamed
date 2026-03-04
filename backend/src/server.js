const { createApp } = require("./app");
const { logger } = require("./logger");
const { closePool } = require("./db");
const { stopSimulationJobs } = require("./services/simulation-jobs");

async function startServer() {
  const app = createApp();
  const port = Number(process.env.PORT || 4000);

  const server = app.listen(port, () => {
    logger.info({ port }, "API hospitalar iniciada.");
  });

  const shutdown = async (signal) => {
    logger.info({ signal }, "Iniciando shutdown gracioso.");
    stopSimulationJobs();
    server.close(async () => {
      try {
        await closePool();
      } catch (error) {
        logger.error({ error }, "Falha no encerramento de recursos.");
      } finally {
        process.exit(0);
      }
    });
  };

  process.on("SIGINT", () => {
    shutdown("SIGINT").catch((error) => {
      logger.error({ error }, "Erro ao finalizar SIGINT.");
      process.exit(1);
    });
  });

  process.on("SIGTERM", () => {
    shutdown("SIGTERM").catch((error) => {
      logger.error({ error }, "Erro ao finalizar SIGTERM.");
      process.exit(1);
    });
  });
}

module.exports = {
  startServer,
};
