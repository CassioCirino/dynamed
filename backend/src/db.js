const { Pool } = require("pg");
const { observeDbQuery, observeDbQueryError, observeDbReadiness } = require("./services/metrics");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.DB_POOL_MAX || 30),
  ssl:
    process.env.DB_SSL === "true"
      ? {
          rejectUnauthorized: false,
        }
      : undefined,
});

async function query(text, params = []) {
  const start = process.hrtime.bigint();
  const operation = (text.trim().split(/\s+/)[0] || "unknown").toLowerCase();
  try {
    return await pool.query(text, params);
  } catch (error) {
    observeDbQueryError(operation, classifyDbError(error));
    throw error;
  } finally {
    const elapsedNs = process.hrtime.bigint() - start;
    const durationSeconds = Number(elapsedNs) / 1_000_000_000;
    observeDbQuery(operation, durationSeconds);
  }
}

async function transaction(runInTransaction) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await runInTransaction(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function closePool() {
  await pool.end();
}

function classifyDbError(error) {
  const code = String(error?.code || "").toUpperCase();
  const message = String(error?.message || "").toLowerCase();

  if (!code && !message) return "unknown";

  const connectionCodes = new Set([
    "ECONNREFUSED",
    "ECONNRESET",
    "ETIMEDOUT",
    "EHOSTUNREACH",
    "ENOTFOUND",
    "57P01",
    "57P02",
    "57P03",
    "08000",
    "08001",
    "08003",
    "08004",
    "08006",
    "08007",
    "08P01",
  ]);

  if (
    connectionCodes.has(code) ||
    message.includes("connection terminated") ||
    message.includes("terminating connection") ||
    message.includes("connection refused") ||
    message.includes("could not connect")
  ) {
    return "connection";
  }

  if (code === "53300" || message.includes("too many clients")) {
    return "pool_exhausted";
  }

  return "query";
}

function isDbConnectionError(error) {
  return classifyDbError(error) === "connection";
}

async function checkDbReadiness() {
  const start = process.hrtime.bigint();
  try {
    await pool.query("SELECT 1");
    const durationSeconds = Number(process.hrtime.bigint() - start) / 1_000_000_000;
    observeDbReadiness("ok", durationSeconds);
    return { ok: true, durationSeconds };
  } catch (error) {
    const durationSeconds = Number(process.hrtime.bigint() - start) / 1_000_000_000;
    observeDbReadiness("error", durationSeconds);
    throw error;
  }
}

module.exports = {
  pool,
  query,
  transaction,
  closePool,
  classifyDbError,
  isDbConnectionError,
  checkDbReadiness,
};
