const express = require("express");
const { query } = require("../db");
const { authenticate } = require("../middleware/auth");
const { ROLES } = require("../constants");
const { getSystemSnapshot } = require("../services/chaos");

const router = express.Router();
router.use(authenticate);

router.get("/summary", async (req, res, next) => {
  try {
    const role = req.user.role;
    const userId = req.user.sub;

    if (role === ROLES.PATIENT) {
      const [appointments, exams] = await Promise.all([
        query(
          `SELECT COUNT(*) FILTER (WHERE status IN ('scheduled', 'checked_in', 'in_progress')) AS active_appointments,
                  COUNT(*) FILTER (WHERE status = 'completed') AS completed_appointments
           FROM appointments
           WHERE patient_user_id = $1`,
          [userId],
        ),
        query(
          `SELECT COUNT(*) FILTER (WHERE status IN ('requested', 'in_progress')) AS pending_exams,
                  COUNT(*) FILTER (WHERE status = 'completed') AS completed_exams
           FROM exams
           WHERE patient_user_id = $1`,
          [userId],
        ),
      ]);

      return res.json({
        summary: {
          activeAppointments: Number(appointments.rows[0].active_appointments || 0),
          completedAppointments: Number(appointments.rows[0].completed_appointments || 0),
          pendingExams: Number(exams.rows[0].pending_exams || 0),
          completedExams: Number(exams.rows[0].completed_exams || 0),
        },
      });
    }

    if (role === ROLES.DOCTOR) {
      const [agenda, exams, occupancy] = await Promise.all([
        query(
          `SELECT COUNT(*) FILTER (WHERE DATE(scheduled_at) = CURRENT_DATE) AS appointments_today,
                  COUNT(*) FILTER (WHERE status IN ('in_progress', 'checked_in')) AS active_consultations
           FROM appointments
           WHERE doctor_user_id = $1`,
          [userId],
        ),
        query(
          `SELECT COUNT(*) FILTER (WHERE status = 'requested') AS pending_exams,
                  COUNT(*) FILTER (WHERE status = 'completed' AND completed_at >= NOW() - INTERVAL '24 hours') AS exams_24h
           FROM exams
           WHERE doctor_user_id = $1`,
          [userId],
        ),
        query(
          `SELECT COUNT(*) AS active_inpatients
           FROM inpatient_stays
           WHERE attending_doctor_user_id = $1 AND status = 'active'`,
          [userId],
        ),
      ]);

      return res.json({
        summary: {
          appointmentsToday: Number(agenda.rows[0].appointments_today || 0),
          activeConsultations: Number(agenda.rows[0].active_consultations || 0),
          pendingExams: Number(exams.rows[0].pending_exams || 0),
          exams24h: Number(exams.rows[0].exams_24h || 0),
          activeInpatients: Number(occupancy.rows[0].active_inpatients || 0),
        },
      });
    }

    const [traffic, exams, incidents, users] = await Promise.all([
      query(
        `SELECT COUNT(*) FILTER (WHERE DATE(scheduled_at) = CURRENT_DATE) AS scheduled_today,
                COUNT(*) FILTER (WHERE status = 'completed' AND DATE(finished_at) = CURRENT_DATE) AS completed_today,
                COUNT(*) FILTER (WHERE status IN ('no_show', 'cancelled') AND DATE(scheduled_at) = CURRENT_DATE) AS lost_today
         FROM appointments`,
      ),
      query(
        `SELECT COUNT(*) FILTER (WHERE status = 'requested') AS pending_exams,
                COUNT(*) FILTER (WHERE status = 'completed' AND completed_at >= NOW() - INTERVAL '24 hours') AS exams_last_24h
         FROM exams`,
      ),
      query(
        `SELECT COUNT(*) FILTER (WHERE status = 'open') AS open_incidents,
                COUNT(*) FILTER (WHERE severity = 'critical' AND status <> 'resolved') AS critical_incidents
         FROM incidents`,
      ),
      query(
        `SELECT role, COUNT(*) AS total
         FROM users
         GROUP BY role`,
      ),
    ]);

    return res.json({
      summary: {
        scheduledToday: Number(traffic.rows[0].scheduled_today || 0),
        completedToday: Number(traffic.rows[0].completed_today || 0),
        lostToday: Number(traffic.rows[0].lost_today || 0),
        pendingExams: Number(exams.rows[0].pending_exams || 0),
        examsLast24h: Number(exams.rows[0].exams_last_24h || 0),
        openIncidents: Number(incidents.rows[0].open_incidents || 0),
        criticalIncidents: Number(incidents.rows[0].critical_incidents || 0),
        usersByRole: users.rows.map((row) => ({
          role: row.role,
          total: Number(row.total),
        })),
      },
      system: getSystemSnapshot(),
    });
  } catch (error) {
    next(error);
  }
});

router.get("/timeline", async (req, res, next) => {
  try {
    const result = await query(
      `SELECT DATE_TRUNC('hour', scheduled_at) AS bucket,
              COUNT(*) FILTER (WHERE status = 'completed') AS completed,
              COUNT(*) FILTER (WHERE status IN ('scheduled', 'checked_in', 'in_progress')) AS active,
              COUNT(*) FILTER (WHERE status IN ('cancelled', 'no_show')) AS lost
       FROM appointments
       WHERE scheduled_at >= NOW() - INTERVAL '48 hours'
       GROUP BY bucket
       ORDER BY bucket ASC`,
    );

    res.json({
      points: result.rows.map((row) => ({
        bucket: row.bucket,
        completed: Number(row.completed),
        active: Number(row.active),
        lost: Number(row.lost),
      })),
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
