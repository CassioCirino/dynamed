const ROLES = Object.freeze({
  PATIENT: "patient",
  DOCTOR: "doctor",
  NURSE: "nurse",
  RECEPTIONIST: "receptionist",
  ADMIN: "admin",
  LAB: "lab",
});

const APPOINTMENT_STATUS = Object.freeze([
  "scheduled",
  "checked_in",
  "in_progress",
  "completed",
  "cancelled",
  "no_show",
]);

const EXAM_STATUS = Object.freeze(["requested", "in_progress", "completed", "cancelled"]);

const URGENCY_LEVELS = Object.freeze(["low", "medium", "high", "critical"]);

module.exports = {
  ROLES,
  APPOINTMENT_STATUS,
  EXAM_STATUS,
  URGENCY_LEVELS,
};
