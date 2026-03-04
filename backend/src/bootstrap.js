require("dotenv").config();

const { startServer } = require("./server");
const { logger } = require("./logger");
const { startSimulationJobs } = require("./services/simulation-jobs");
const { ensureDefaultAdmin } = require("./services/default-admin");

async function bootstrap() {
  await ensureDefaultAdmin();
  await startServer();
  startSimulationJobs();
}

bootstrap().catch((error) => {
  logger.error({ error }, "Falha no bootstrap da aplicacao.");
  process.exit(1);
});
