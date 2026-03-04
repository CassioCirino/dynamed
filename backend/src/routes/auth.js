const express = require("express");
const { randomUUID } = require("node:crypto");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const { z } = require("zod");
const { query } = require("../db");
const { authenticate, authorize } = require("../middleware/auth");
const { ROLES } = require("../constants");
const { recordBusinessEvent } = require("../services/metrics");

const router = express.Router();

const loginSchema = z.object({
  userId: z.string().uuid(),
});

const credentialsLoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6).max(128),
});

const registerSchema = z.object({
  fullName: z.string().min(4).max(120),
  email: z.string().email(),
  password: z.string().min(6).max(128),
  phone: z.string().min(8).max(40).optional(),
  birthDate: z.string().min(8).max(20),
  bloodType: z.enum(["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"]).default("O+"),
  allergies: z.string().max(220).optional(),
  chronicConditions: z.string().max(220).optional(),
  insurance: z.string().max(120).optional(),
  emergencyContact: z.string().max(180).optional(),
});

function issueToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      name: user.full_name,
      role: user.role,
      email: user.email,
      department: user.department,
    },
    process.env.JWT_SECRET || "dev-secret",
    {
      expiresIn: "12h",
    },
  );
}

function toAuthUser(user) {
  return {
    id: user.id,
    fullName: user.full_name,
    role: user.role,
    email: user.email,
    department: user.department,
  };
}

router.get("/demo-users", async (req, res, next) => {
  try {
    const role = req.query.role ? String(req.query.role) : null;
    const limit = Number(req.query.limit || 30);
    const sql = role
      ? `SELECT id, full_name, email, role, department, is_demo
         FROM users
         WHERE role = $1
         ORDER BY is_demo DESC, created_at ASC
         LIMIT $2`
      : `SELECT id, full_name, email, role, department, is_demo
         FROM users
         ORDER BY is_demo DESC, created_at ASC
         LIMIT $1`;

    const params = role ? [role, limit] : [limit];
    const result = await query(sql, params);
    res.json({ users: result.rows });
  } catch (error) {
    next(error);
  }
});

router.post("/demo-login", async (req, res, next) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "Payload invalido.", issues: parsed.error.issues });
    }

    const result = await query(
      `SELECT id, full_name, role, email, department
       FROM users
       WHERE id = $1`,
      [parsed.data.userId],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Usuario nao encontrado." });
    }

    const user = result.rows[0];

    await query(`UPDATE users SET last_login_at = NOW() WHERE id = $1`, [user.id]);

    const token = issueToken(user);

    recordBusinessEvent("demo_login");

    return res.json({
      token,
      user: toAuthUser(user),
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/login", async (req, res, next) => {
  try {
    const parsed = credentialsLoginSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "Payload invalido.", issues: parsed.error.issues });
    }

    const payload = parsed.data;
    const result = await query(
      `SELECT id, full_name, role, email, department, password_hash
       FROM users
       WHERE email = $1`,
      [payload.email.toLowerCase()],
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ message: "Email ou senha invalidos." });
    }

    const user = result.rows[0];
    if (!user.password_hash) {
      return res.status(401).json({ message: "Conta sem senha. Use login demo ou cadastre uma nova conta." });
    }

    const validPassword = await bcrypt.compare(payload.password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ message: "Email ou senha invalidos." });
    }

    await query(`UPDATE users SET last_login_at = NOW() WHERE id = $1`, [user.id]);

    const token = issueToken(user);
    recordBusinessEvent("credentials_login");

    return res.json({
      token,
      user: toAuthUser(user),
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/register", async (req, res, next) => {
  try {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "Payload invalido.", issues: parsed.error.issues });
    }

    const payload = parsed.data;
    const existing = await query(`SELECT id FROM users WHERE email = $1`, [payload.email.toLowerCase()]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ message: "Ja existe conta cadastrada com este email." });
    }

    const id = randomUUID();
    const passwordHash = await bcrypt.hash(payload.password, 10);

    const createdUser = await query(
      `INSERT INTO users (id, role, full_name, email, password_hash, department, phone, is_demo)
       VALUES ($1, 'patient', $2, $3, $4, 'Clínica Médica', $5, false)
       RETURNING id, full_name, role, email, department`,
      [id, payload.fullName, payload.email.toLowerCase(), passwordHash, payload.phone || null],
    );

    await query(
      `INSERT INTO patient_profiles (
        user_id,
        birth_date,
        blood_type,
        allergies,
        chronic_conditions,
        insurance,
        risk_level,
        emergency_contact
      )
      VALUES ($1, $2::date, $3, $4, $5, $6, 'low', $7)`,
      [
        id,
        payload.birthDate,
        payload.bloodType,
        payload.allergies || "Sem alergias declaradas",
        payload.chronicConditions || "Sem condicoes cronicas declaradas",
        payload.insurance || "Particular",
        payload.emergencyContact || null,
      ],
    );

    await query(`UPDATE users SET last_login_at = NOW() WHERE id = $1`, [id]);

    const user = createdUser.rows[0];
    const token = issueToken(user);
    recordBusinessEvent("user_registered");

    return res.status(201).json({
      token,
      user: toAuthUser(user),
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/me", authenticate, async (req, res, next) => {
  try {
    const result = await query(
      `SELECT id, full_name, role, email, department, last_login_at
       FROM users
       WHERE id = $1`,
      [req.user.sub],
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Usuario nao encontrado." });
    }
    return res.json({ user: result.rows[0] });
  } catch (error) {
    return next(error);
  }
});

router.get(
  "/users-lookup",
  authenticate,
  authorize(ROLES.DOCTOR, ROLES.NURSE, ROLES.RECEPTIONIST, ROLES.ADMIN, ROLES.LAB),
  async (req, res, next) => {
    try {
      const role = String(req.query.role || "").trim();
      const allowedRoles = new Set(["patient", "doctor", "nurse", "receptionist", "admin", "lab"]);
      if (!allowedRoles.has(role)) {
        return res.status(400).json({ message: "Role invalido para busca." });
      }

      const search = String(req.query.search || "").trim();
      const limit = Math.min(50, Math.max(1, Number(req.query.limit || 12)));
      const searchLike = `%${search}%`;

      const result = await query(
        `SELECT u.id, u.full_name, u.email, u.role, u.department, u.is_demo,
                p.risk_level
         FROM users u
         LEFT JOIN patient_profiles p ON p.user_id = u.id
         WHERE u.role = $1
           AND ($2 = '' OR u.full_name ILIKE $3 OR u.email ILIKE $3)
         ORDER BY u.is_demo DESC, u.full_name ASC
         LIMIT $4`,
        [role, search, searchLike, limit],
      );

      return res.json({
        users: result.rows,
      });
    } catch (error) {
      return next(error);
    }
  },
);

module.exports = router;
