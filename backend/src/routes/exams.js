const { randomUUID } = require("node:crypto");
const express = require("express");
const { z } = require("zod");
const { query } = require("../db");
const { authenticate, authorize } = require("../middleware/auth");
const { EXAM_STATUS, ROLES } = require("../constants");
const { recordBusinessEvent } = require("../services/metrics");

const router = express.Router();
router.use(authenticate);

router.get("/", async (req, res, next) => {
  try {
    const status = req.query.status ? String(req.query.status) : null;
    const page = Math.max(1, Number(req.query.page || 1));
    const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize || 25)));
    const params = [];
    const where = [];

    if (status) {
      params.push(status);
      where.push(`e.status = $${params.length}`);
    }
    if (req.user.role === ROLES.PATIENT) {
      params.push(req.user.sub);
      where.push(`e.patient_user_id = $${params.length}`);
    }
    if (req.user.role === ROLES.DOCTOR) {
      params.push(req.user.sub);
      where.push(`e.doctor_user_id = $${params.length}`);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    params.push(pageSize);
    const limitParam = `$${params.length}`;
    params.push((page - 1) * pageSize);
    const offsetParam = `$${params.length}`;

    const result = await query(
      `SELECT e.id, e.exam_type, e.priority, e.status, e.requested_at, e.completed_at, e.result_summary, e.abnormal,
              patient.full_name AS patient_name, doctor.full_name AS doctor_name
       FROM exams e
       JOIN users patient ON patient.id = e.patient_user_id
       LEFT JOIN users doctor ON doctor.id = e.doctor_user_id
       ${whereSql}
       ORDER BY e.requested_at DESC
       LIMIT ${limitParam}
       OFFSET ${offsetParam}`,
      params,
    );

    return res.json({
      page,
      pageSize,
      exams: result.rows,
    });
  } catch (error) {
    return next(error);
  }
});

const examCreateSchema = z.object({
  appointmentId: z.string().uuid().optional(),
  patientUserId: z.string().uuid(),
  doctorUserId: z.string().uuid().optional(),
  examType: z.string().min(3).max(120),
  priority: z.enum(["routine", "urgent", "stat"]),
});

router.post("/", authorize(ROLES.DOCTOR, ROLES.NURSE, ROLES.ADMIN), async (req, res, next) => {
  try {
    const parsed = examCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "Payload invalido.", issues: parsed.error.issues });
    }

    const payload = parsed.data;
    const id = randomUUID();
    const created = await query(
      `INSERT INTO exams (id, appointment_id, patient_user_id, doctor_user_id, exam_type, priority, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'requested')
       RETURNING *`,
      [id, payload.appointmentId || null, payload.patientUserId, payload.doctorUserId || req.user.sub, payload.examType, payload.priority],
    );

    await query(
      `INSERT INTO audit_events (event_type, severity, user_id, payload)
       VALUES ('exam_requested', 'info', $1, $2::jsonb)`,
      [req.user.sub, JSON.stringify({ examId: id, priority: payload.priority })],
    );

    recordBusinessEvent("exam_requested");
    return res.status(201).json({ exam: created.rows[0] });
  } catch (error) {
    return next(error);
  }
});

const examUpdateSchema = z.object({
  status: z.enum(EXAM_STATUS),
  resultSummary: z.string().max(3000).optional(),
  abnormal: z.boolean().optional(),
});

router.patch(
  "/:id",
  authorize(ROLES.DOCTOR, ROLES.NURSE, ROLES.LAB, ROLES.ADMIN),
  async (req, res, next) => {
    try {
      const examId = String(req.params.id);
      const parsed = examUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: "Payload invalido.", issues: parsed.error.issues });
      }

      const fields = ["status = $1"];
      const values = [parsed.data.status];

      if (parsed.data.status === "completed") {
        fields.push("completed_at = NOW()");
      }
      if (typeof parsed.data.resultSummary === "string") {
        values.push(parsed.data.resultSummary);
        fields.push(`result_summary = $${values.length}`);
      }
      if (typeof parsed.data.abnormal === "boolean") {
        values.push(parsed.data.abnormal);
        fields.push(`abnormal = $${values.length}`);
      }

      values.push(examId);
      const updateParam = `$${values.length}`;

      const updated = await query(
        `UPDATE exams
         SET ${fields.join(", ")}
         WHERE id = ${updateParam}
         RETURNING *`,
        values,
      );

      if (updated.rows.length === 0) {
        return res.status(404).json({ message: "Exame nao encontrado." });
      }

      await query(
        `INSERT INTO audit_events (event_type, severity, user_id, payload)
         VALUES ('exam_updated', 'info', $1, $2::jsonb)`,
        [req.user.sub, JSON.stringify({ examId, status: parsed.data.status })],
      );

      recordBusinessEvent("exam_updated");
      return res.json({ exam: updated.rows[0] });
    } catch (error) {
      return next(error);
    }
  },
);

module.exports = router;
