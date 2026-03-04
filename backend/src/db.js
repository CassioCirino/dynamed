const { Pool } = require("pg");
const { observeDbQuery } = require("./services/metrics");

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
  try {
    return await pool.query(text, params);
  } finally {
    const elapsedNs = process.hrtime.bigint() - start;
    const durationSeconds = Number(elapsedNs) / 1_000_000_000;
    const operation = (text.trim().split(/\s+/)[0] || "unknown").toLowerCase();
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

module.exports = {
  pool,
  query,
  transaction,
  closePool,
};
