const { randomUUID } = require("node:crypto");
const express = require("express");
const { z } = require("zod");
const { query } = require("../db");
const { authenticate, authorize } = require("../middleware/auth");
const { APPOINTMENT_STATUS, ROLES, URGENCY_LEVELS } = require("../constants");
const { recordBusinessEvent } = require("../services/metrics");

const router = express.Router();
router.use(authenticate);

router.get("/", async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page || 1));
    const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize || 25)));
    const status = req.query.status ? String(req.query.status) : null;
    const day = req.query.day ? String(req.query.day) : null;

    const params = [];
    const where = [];

    if (status) {
      params.push(status);
      where.push(`a.status = $${params.length}`);
    }

    if (day === "today") {
      where.push(`DATE(a.scheduled_at) = CURRENT_DATE`);
    } else if (day === "upcoming") {
      where.push(`a.scheduled_at >= NOW()`);
    } else if (day === "past") {
      where.push(`a.scheduled_at < NOW()`);
    }

    if (req.user.role === ROLES.PATIENT) {
      params.push(req.user.sub);
      where.push(`a.patient_user_id = $${params.length}`);
    }
    if (req.user.role === ROLES.DOCTOR) {
      params.push(req.user.sub);
      where.push(`a.doctor_user_id = $${params.length}`);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    params.push(pageSize);
    const limitParam = `$${params.length}`;
    params.push((page - 1) * pageSize);
    const offsetParam = `$${params.length}`;

    const result = await query(
      `SELECT a.id, a.scheduled_at, a.status, a.urgency, a.reason, a.room, a.notes,
              patient.id AS patient_user_id, patient.full_name AS patient_name,
              doctor.id AS doctor_user_id, doctor.full_name AS doctor_name
       FROM appointments a
       JOIN users patient ON patient.id = a.patient_user_id
       JOIN users doctor ON doctor.id = a.doctor_user_id
       ${whereSql}
       ORDER BY a.scheduled_at ASC
       LIMIT ${limitParam}
       OFFSET ${offsetParam}`,
      params,
    );

    return res.json({
      page,
      pageSize,
      appointments: result.rows,
    });
  } catch (error) {
    return next(error);
  }
});

const appointmentCreateSchema = z.object({
  patientUserId: z.string().uuid(),
  doctorUserId: z.string().uuid(),
  scheduledAt: z.coerce.date(),
  urgency: z.enum(URGENCY_LEVELS),
  reason: z.string().min(5).max(300),
  room: z.string().min(2).max(40).optional(),
});

router.post(
  "/",
  authorize(ROLES.DOCTOR, ROLES.NURSE, ROLES.RECEPTIONIST, ROLES.ADMIN),
  async (req, res, next) => {
    try {
      const parsed = appointmentCreateSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: "Payload invalido.", issues: parsed.error.issues });
      }

      const payload = parsed.data;
      const id = randomUUID();
      if (payload.patientUserId === payload.doctorUserId) {
        return res.status(400).json({ message: "Paciente e medico nao podem ser o mesmo usuario." });
      }

      const usersValidation = await query(
        `SELECT id, role
         FROM users
         WHERE id = ANY($1::uuid[])`,
        [[payload.patientUserId, payload.doctorUserId]],
      );

      const usersById = new Map(usersValidation.rows.map((row) => [row.id, row.role]));
      if (usersById.get(payload.patientUserId) !== ROLES.PATIENT) {
        return res.status(400).json({ message: "Paciente informado nao e valido." });
      }
      if (usersById.get(payload.doctorUserId) !== ROLES.DOCTOR) {
        return res.status(400).json({ message: "Medico informado nao e valido." });
      }

      const created = await query(
        `INSERT INTO appointments (id, patient_user_id, doctor_user_id, scheduled_at, status, urgency, reason, room)
         VALUES ($1, $2, $3, $4, 'scheduled', $5, $6, $7)
         RETURNING *`,
        [id, payload.patientUserId, payload.doctorUserId, payload.scheduledAt, payload.urgency, payload.reason, payload.room || null],
      );

      await query(
        `INSERT INTO audit_events (event_type, severity, user_id, payload)
         VALUES ('appointment_created', 'info', $1, $2::jsonb)`,
        [req.user.sub, JSON.stringify({ appointmentId: id, urgency: payload.urgency })],
      );

      recordBusinessEvent("appointment_created");
      return res.status(201).json({ appointment: created.rows[0] });
    } catch (error) {
      return next(error);
    }
  },
);

const appointmentStatusSchema = z.object({
  status: z.enum(APPOINTMENT_STATUS),
  notes: z.string().max(2000).optional(),
});

router.patch(
  "/:id/status",
  authorize(ROLES.DOCTOR, ROLES.NURSE, ROLES.RECEPTIONIST, ROLES.ADMIN),
  async (req, res, next) => {
    try {
      const id = String(req.params.id);
      const parsed = appointmentStatusSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: "Payload invalido.", issues: parsed.error.issues });
      }

      const fields = ["status = $1", "updated_at = NOW()"];
      const values = [parsed.data.status];

      if (parsed.data.status === "checked_in") {
        fields.push("check_in_at = COALESCE(check_in_at, NOW())");
      }
      if (parsed.data.status === "in_progress") {
        fields.push("started_at = COALESCE(started_at, NOW())");
      }
      if (parsed.data.status === "completed") {
        fields.push("finished_at = COALESCE(finished_at, NOW())");
      }

      if (typeof parsed.data.notes === "string") {
        values.push(parsed.data.notes);
        fields.push(`notes = $${values.length}`);
      }

      values.push(id);
      const updateParam = `$${values.length}`;

      const updated = await query(
        `UPDATE appointments
         SET ${fields.join(", ")}
         WHERE id = ${updateParam}
         RETURNING *`,
        values,
      );

      if (updated.rows.length === 0) {
        return res.status(404).json({ message: "Atendimento nao encontrado." });
      }

      await query(
        `INSERT INTO audit_events (event_type, severity, user_id, payload)
         VALUES ('appointment_status_changed', 'info', $1, $2::jsonb)`,
        [req.user.sub, JSON.stringify({ appointmentId: id, newStatus: parsed.data.status })],
      );

      recordBusinessEvent("appointment_status_changed");
      return res.json({ appointment: updated.rows[0] });
    } catch (error) {
      return next(error);
    }
  },
);

module.exports = router;
