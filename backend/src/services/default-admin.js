const { randomUUID } = require("node:crypto");
const bcrypt = require("bcryptjs");
const { query } = require("../db");
const { logger } = require("../logger");

function toBool(value, fallback = false) {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

async function ensureDefaultAdmin() {
  const enabled = toBool(process.env.DEFAULT_ADMIN_ENABLED || "true", true);
  if (!enabled) {
    logger.info("Administrador padrao desativado.");
    return;
  }

  const email = String(process.env.DEFAULT_ADMIN_EMAIL || "admin@hospital.local").trim().toLowerCase();
  const password = String(process.env.DEFAULT_ADMIN_PASSWORD || "dyantrace").trim();
  const fullName = String(process.env.DEFAULT_ADMIN_NAME || "Administrador Padrao").trim();
  const department = String(process.env.DEFAULT_ADMIN_DEPARTMENT || "NOC Hospitalar").trim();

  if (!email || !password || password.length < 6) {
    logger.warn("Administrador padrao nao configurado: email/senha invalidos.");
    return;
  }

  const found = await query(
    `SELECT id, role, password_hash
     FROM users
     WHERE email = $1
     LIMIT 1`,
    [email],
  );

  const passwordHash = await bcrypt.hash(password, 10);

  if (found.rows.length === 0) {
    const id = randomUUID();
    await query(
      `INSERT INTO users (id, role, full_name, email, password_hash, department, phone, is_demo)
       VALUES ($1, 'admin', $2, $3, $4, $5, NULL, false)`,
      [id, fullName, email, passwordHash, department],
    );
    logger.info({ email }, "Administrador padrao criado.");
    return;
  }

  const current = found.rows[0];
  if (current.role !== "admin" || !current.password_hash) {
    await query(
      `UPDATE users
       SET role = 'admin',
           full_name = COALESCE(NULLIF(full_name, ''), $1),
           password_hash = $2,
           department = COALESCE(NULLIF(department, ''), $3)
       WHERE id = $4`,
      [fullName, passwordHash, department, current.id],
    );
    logger.info({ email }, "Administrador padrao atualizado.");
  } else {
    logger.info({ email }, "Administrador padrao ja existente.");
  }
}

module.exports = {
  ensureDefaultAdmin,
};
