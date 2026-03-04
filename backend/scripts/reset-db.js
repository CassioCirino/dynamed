require("dotenv").config();

const { pool } = require("../src/db");
const fs = require("node:fs");
const path = require("node:path");

async function resetDb() {
  await pool.query(`
    DROP TABLE IF EXISTS chaos_events CASCADE;
    DROP TABLE IF EXISTS audit_events CASCADE;
    DROP TABLE IF EXISTS incidents CASCADE;
    DROP TABLE IF EXISTS inpatient_stays CASCADE;
    DROP TABLE IF EXISTS exams CASCADE;
    DROP TABLE IF EXISTS appointments CASCADE;
    DROP TABLE IF EXISTS doctor_profiles CASCADE;
    DROP TABLE IF EXISTS patient_profiles CASCADE;
    DROP TABLE IF EXISTS users CASCADE;
  `);

  const schemaSql = fs.readFileSync(path.join(__dirname, "..", "sql", "schema.sql"), "utf8");
  await pool.query(schemaSql);
  console.log("Banco resetado com sucesso.");
}

resetDb()
  .catch((error) => {
    console.error("Falha ao resetar banco:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
