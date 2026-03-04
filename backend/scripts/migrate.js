require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");
const { pool } = require("../src/db");

async function migrate() {
  const schemaPath = path.join(__dirname, "..", "sql", "schema.sql");
  const schemaSql = fs.readFileSync(schemaPath, "utf8");
  await pool.query(schemaSql);
  console.log("Schema aplicado com sucesso.");
}

migrate()
  .catch((error) => {
    console.error("Falha na migracao:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
