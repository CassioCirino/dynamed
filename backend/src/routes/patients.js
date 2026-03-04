const express = require("express");
const { randomUUID } = require("node:crypto");
const bcrypt = require("bcryptjs");
const { z } = require("zod");
const { query, transaction } = require("../db");
const { authenticate, authorize } = require("../middleware/auth");
const { ROLES } = require("../constants");

const router = express.Router();
router.use(authenticate);

router.get(
  "/",
  authorize(ROLES.DOCTOR, ROLES.NURSE, ROLES.RECEPTIONIST, ROLES.ADMIN),
  async (req, res, next) => {
    try {
      const page = Math.max(1, Number(req.query.page || 1));
      const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize || 20)));
      const search = (req.query.search || "").toString().trim();

      const params = [];
      const whereClauses = [`u.role = 'patient'`];
      if (search) {
        params.push(`%${search}%`);
        whereClauses.push(`(u.full_name ILIKE $${params.length} OR u.email ILIKE $${params.length})`);
      }

      params.push(pageSize);
      const limitParam = `$${params.length}`;
      params.push((page - 1) * pageSize);
      const offsetParam = `$${params.length}`;

      const sql = `
        SELECT u.id, u.full_name, u.email, u.phone, p.birth_date, p.blood_type, p.risk_level, p.insurance
        FROM users u
        JOIN patient_profiles p ON p.user_id = u.id
        WHERE ${whereClauses.join(" AND ")}
        ORDER BY p.risk_level DESC, u.full_name ASC
        LIMIT ${limitParam}
        OFFSET ${offsetParam}`;

      const result = await query(sql, params);
      return res.json({
        page,
        pageSize,
        patients: result.rows,
      });
    } catch (error) {
      return next(error);
    }
  },
);

const patientIdSchema = z.object({
  id: z.string().uuid(),
});

const patientCreateSchema = z.object({
  fullName: z.string().min(4).max(120),
  email: z.string().email(),
  phone: z.string().min(8).max(40).optional(),
  birthDate: z.string().min(8).max(20),
  bloodType: z.enum(["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"]).default("O+"),
  allergies: z.string().max(220).optional(),
  chronicConditions: z.string().max(220).optional(),
  insurance: z.string().max(120).optional(),
  emergencyContact: z.string().max(180).optional(),
  riskLevel: z.enum(["low", "medium", "high", "critical"]).default("low"),
  password: z.string().min(6).max(128).optional(),
});

router.post("/", authorize(ROLES.RECEPTIONIST, ROLES.ADMIN), async (req, res, next) => {
  try {
    const parsed = patientCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "Payload invalido.", issues: parsed.error.issues });
    }

    const payload = parsed.data;
    const normalizedEmail = payload.email.toLowerCase();
    const existing = await query(`SELECT id FROM users WHERE email = $1`, [normalizedEmail]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ message: "Ja existe paciente com este email." });
    }

    const patientId = randomUUID();
    const passwordHash = payload.password ? await bcrypt.hash(payload.password, 10) : null;

    const createdPatient = await transaction(async (client) => {
      const userResult = await client.query(
        `INSERT INTO users (id, role, full_name, email, password_hash, department, phone, is_demo)
         VALUES ($1, 'patient', $2, $3, $4, 'Clinica Medica', $5, false)
         RETURNING id, full_name, email, phone`,
        [patientId, payload.fullName, normalizedEmail, passwordHash, payload.phone || null],
      );

      await client.query(
        `INSERT INTO patient_profiles (
          user_id,
          birth_date,
          blood_type,
          allergies,
          chronic_conditions,
          insurance,
          risk_level,
          emergency_contact,
          updated_at
        )
        VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8, NOW())`,
        [
          patientId,
          payload.birthDate,
          payload.bloodType,
          payload.allergies || "Sem alergias declaradas",
          payload.chronicConditions || "Sem condicoes cronicas declaradas",
          payload.insurance || "Particular",
          payload.riskLevel,
          payload.emergencyContact || null,
        ],
      );

      await client.query(
        `INSERT INTO audit_events (event_type, severity, user_id, payload)
         VALUES ('patient_created', 'info', $1, $2::jsonb)`,
        [
          req.user.sub,
          JSON.stringify({
            patientId,
            createdByRole: req.user.role,
            hasPassword: Boolean(passwordHash),
          }),
        ],
      );

      return userResult.rows[0];
    });

    return res.status(201).json({
      patient: {
        ...createdPatient,
        birth_date: payload.birthDate,
        blood_type: payload.bloodType,
        risk_level: payload.riskLevel,
        insurance: payload.insurance || "Particular",
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/:id/record", async (req, res, next) => {
  try {
    const parsed = patientIdSchema.safeParse(req.params);
    if (!parsed.success) {
      return res.status(400).json({ message: "Paciente invalido." });
    }
    const patientId = parsed.data.id;

    const isPatient = req.user.role === ROLES.PATIENT;
    if (isPatient && req.user.sub !== patientId) {
      return res.status(403).json({ message: "Acesso negado ao prontuario solicitado." });
    }

    const profile = await query(
      `SELECT u.id, u.full_name, u.email, u.phone,
              p.birth_date, p.blood_type, p.allergies, p.chronic_conditions, p.insurance, p.risk_level, p.emergency_contact
       FROM users u
       JOIN patient_profiles p ON p.user_id = u.id
       WHERE u.id = $1`,
      [patientId],
    );
    if (profile.rows.length === 0) {
      return res.status(404).json({ message: "Paciente nao encontrado." });
    }

    const [appointments, exams, stays] = await Promise.all([
      query(
        `SELECT a.id, a.scheduled_at, a.status, a.urgency, a.reason, a.room, a.notes,
                d.full_name AS doctor_name, d.department AS doctor_department
         FROM appointments a
         JOIN users d ON d.id = a.doctor_user_id
         WHERE a.patient_user_id = $1
         ORDER BY a.scheduled_at DESC
         LIMIT 30`,
        [patientId],
      ),
      query(
        `SELECT e.id, e.exam_type, e.priority, e.status, e.requested_at, e.completed_at, e.result_summary, e.abnormal
         FROM exams e
         WHERE e.patient_user_id = $1
         ORDER BY e.requested_at DESC
         LIMIT 30`,
        [patientId],
      ),
      query(
        `SELECT id, admitted_at, discharged_at, ward, bed, diagnosis, status
         FROM inpatient_stays
         WHERE patient_user_id = $1
         ORDER BY admitted_at DESC
         LIMIT 10`,
        [patientId],
      ),
    ]);

    return res.json({
      patient: profile.rows[0],
      appointments: appointments.rows,
      exams: exams.rows,
      inpatientStays: stays.rows,
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
