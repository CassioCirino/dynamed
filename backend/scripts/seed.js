require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { fakerPT_BR } = require("@faker-js/faker");
const { pool } = require("../src/db");

const faker = fakerPT_BR;
faker.seed(20260226);

const FORCE_SEED = (process.env.FORCE_SEED || "false").toLowerCase() === "true";
const TOTAL_PATIENTS = Number(process.env.SEED_PATIENTS || 5000);
const TOTAL_DOCTORS = Number(process.env.SEED_DOCTORS || 80);
const TOTAL_APPOINTMENTS = Number(process.env.SEED_APPOINTMENTS || 18000);
const TOTAL_EXAMS = Number(process.env.SEED_EXAMS || 14000);
const TOTAL_NURSES = Number(process.env.SEED_NURSES || 120);
const TOTAL_RECEPTIONISTS = Number(process.env.SEED_RECEPTIONISTS || 40);
const TOTAL_ADMINS = Number(process.env.SEED_ADMINS || 12);
const TOTAL_LABS = Number(process.env.SEED_LABS || 30);

const departments = [
  "Pronto Atendimento",
  "Clínica Médica",
  "Cardiologia",
  "Pediatria",
  "Ortopedia",
  "Neurologia",
  "UTI",
  "Laboratório",
  "Centro Cirúrgico",
  "Oncologia",
  "Dermatologia",
  "Oftalmologia",
];

const specialties = [
  "Clínico Geral",
  "Cardiologista",
  "Pediatra",
  "Ortopedista",
  "Neurologista",
  "Intensivista",
  "Cirurgião Geral",
  "Oncologista",
  "Dermatologista",
  "Endocrinologista",
  "Gastroenterologista",
  "Psiquiatra",
];

const examTypes = [
  "Hemograma Completo",
  "Tomografia de Tórax",
  "Ressonância Magnética de Crânio",
  "Painel Hormonal",
  "Doppler de Membros Inferiores",
  "Raio-X de Tórax",
  "Ultrassonografia Abdominal",
  "PCR e Marcadores Inflamatórios",
  "Troponina",
  "Eletrocardiograma",
  "Gasometria Arterial",
  "Função Renal",
  "Função Hepática",
];

const appointmentReasons = [
  "Dor torácica",
  "Retorno de consulta",
  "Avaliação pré-operatória",
  "Tontura persistente",
  "Dor lombar",
  "Dispneia",
  "Acompanhamento de diabetes",
  "Febre e tosse",
  "Controle de hipertensão",
  "Dor abdominal",
  "Check-up anual",
  "Pós-alta hospitalar",
  "Avaliação neurológica",
  "Lesão esportiva",
  "Alteração de exame laboratorial",
];

const insuranceCompanies = [
  "Saúde Integrada",
  "Vida Plena",
  "Blue Health",
  "MediCare Plus",
  "UniSaúde",
  "Particular",
];

function randomPhone() {
  return faker.phone.number("+55 11 9####-####");
}

function randomFrom(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function pickWeighted(weighted) {
  const total = weighted.reduce((acc, item) => acc + item.weight, 0);
  let target = Math.random() * total;
  for (const item of weighted) {
    target -= item.weight;
    if (target <= 0) {
      return item.value;
    }
  }
  return weighted[weighted.length - 1].value;
}

function randomDateBetween(start, end) {
  return new Date(start.getTime() + Math.random() * (end.getTime() - start.getTime()));
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60_000);
}

function truncate(text, maxLength) {
  if (!text) {
    return text;
  }
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(0, maxLength);
}

async function ensureSchema() {
  const schemaSql = fs.readFileSync(path.join(__dirname, "..", "sql", "schema.sql"), "utf8");
  await pool.query(schemaSql);
}

async function insertInChunks(client, table, columns, rows, chunkSize = 1000) {
  if (!rows.length) {
    return;
  }

  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const values = [];
    const placeholders = [];

    chunk.forEach((row, rowIndex) => {
      const params = row.map((_value, columnIndex) => `$${rowIndex * columns.length + columnIndex + 1}`);
      placeholders.push(`(${params.join(", ")})`);
      values.push(...row);
    });

    const sql = `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${placeholders.join(", ")}`;
    await client.query(sql, values);
  }
}

async function seed() {
  await ensureSchema();

  const existingUsers = await pool.query("SELECT COUNT(*)::int AS total FROM users");
  if (existingUsers.rows[0].total > 0 && !FORCE_SEED) {
    console.log("Banco ja possui dados. Seed ignorado. Use FORCE_SEED=true para recriar.");
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (existingUsers.rows[0].total > 0 && FORCE_SEED) {
      await client.query(`
        TRUNCATE TABLE
          chaos_events,
          audit_events,
          incidents,
          inpatient_stays,
          exams,
          appointments,
          doctor_profiles,
          patient_profiles,
          users
        RESTART IDENTITY CASCADE
      `);
    }

    const now = new Date();
    const past90Days = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    const past45Days = new Date(now.getTime() - 45 * 24 * 60 * 60 * 1000);
    const future30Days = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    const usersRows = [];
    const patientProfilesRows = [];
    const doctorProfilesRows = [];
    const appointmentsRows = [];
    const examsRows = [];
    const staysRows = [];
    const incidentsRows = [];
    const auditRows = [];

    const patientIds = [];
    const doctorIds = [];
    const staffIds = [];

    const createUser = ({ role, fullName, email, department, isDemo = false }) => {
      const id = randomUUID();
      usersRows.push([
        id,
        role,
        truncate(fullName, 120),
        email.toLowerCase(),
        null,
        truncate(department || "", 80),
        randomPhone(),
        isDemo,
        null,
        randomDateBetween(past90Days, now),
      ]);
      return id;
    };

    const demoPatientId = createUser({
      role: "patient",
      fullName: "Paciente Demonstracao",
      email: "paciente.demo@hospital.local",
      department: "Clínica Médica",
      isDemo: true,
    });
    patientIds.push(demoPatientId);
    patientProfilesRows.push([
      demoPatientId,
      faker.date.birthdate({ min: 25, max: 72, mode: "age" }),
      "O+",
      "Nenhuma alergia conhecida",
      "Hipertensão controlada",
      "MediCare Plus",
      "medium",
      "Contato Demo (11) 98888-7777",
      now,
    ]);

    const demoDoctorId = createUser({
      role: "doctor",
      fullName: "Dr. Demonstracao",
      email: "medico.demo@hospital.local",
      department: "Pronto Atendimento",
      isDemo: true,
    });
    doctorIds.push(demoDoctorId);
    doctorProfilesRows.push([demoDoctorId, "Clínico Geral", "CRM-SP-900001", "morning", 12, now]);

    const demoReceptionistId = createUser({
      role: "receptionist",
      fullName: "Recepcao Demonstracao",
      email: "recepcao.demo@hospital.local",
      department: "Pronto Atendimento",
      isDemo: true,
    });
    staffIds.push(demoReceptionistId);

    const demoAdminId = createUser({
      role: "admin",
      fullName: "Operacoes Demonstracao",
      email: "ops.demo@hospital.local",
      department: "NOC Hospitalar",
      isDemo: true,
    });
    staffIds.push(demoAdminId);

    const demoLabId = createUser({
      role: "lab",
      fullName: "Laboratorio Demonstracao",
      email: "lab.demo@hospital.local",
      department: "Laboratório",
      isDemo: true,
    });
    staffIds.push(demoLabId);

    for (let i = 0; i < TOTAL_DOCTORS; i += 1) {
      const specialty = randomFrom(specialties);
      const doctorId = createUser({
        role: "doctor",
        fullName: faker.person.fullName(),
        email: `doctor.${i}.${faker.string.alphanumeric(6).toLowerCase()}@hospital.local`,
        department: randomFrom(departments),
      });
      doctorIds.push(doctorId);
      doctorProfilesRows.push([
        doctorId,
        specialty,
        `CRM-SP-${200000 + i}`,
        pickWeighted([
          { value: "morning", weight: 3 },
          { value: "afternoon", weight: 3 },
          { value: "night", weight: 2 },
          { value: "on_call", weight: 1 },
        ]),
        faker.number.int({ min: 2, max: 35 }),
        randomDateBetween(past90Days, now),
      ]);
    }

    for (let i = 0; i < TOTAL_PATIENTS; i += 1) {
      const patientId = createUser({
        role: "patient",
        fullName: faker.person.fullName(),
        email: `patient.${i}.${faker.string.alphanumeric(7).toLowerCase()}@hospital.local`,
        department: "Clínica Médica",
      });
      patientIds.push(patientId);
      patientProfilesRows.push([
        patientId,
        faker.date.birthdate({ min: 1, max: 95, mode: "age" }),
        randomFrom(["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"]),
        truncate(faker.helpers.arrayElement(["Sem alergias", "Alergia a dipirona", "Alergia a penicilina", "Rinite alérgica"]), 220),
        truncate(
          faker.helpers.arrayElement([
            "Sem comorbidades",
            "Diabetes tipo 2",
            "Hipertensão",
            "Doença renal crônica",
            "Asma controlada",
            "Obesidade",
          ]),
          220,
        ),
        randomFrom(insuranceCompanies),
        pickWeighted([
          { value: "low", weight: 55 },
          { value: "medium", weight: 28 },
          { value: "high", weight: 12 },
          { value: "critical", weight: 5 },
        ]),
        truncate(`${faker.person.fullName()} - ${randomPhone()}`, 180),
        randomDateBetween(past90Days, now),
      ]);
    }

    function createStaffMembers(total, role, fallbackDepartment) {
      for (let i = 0; i < total; i += 1) {
        const id = createUser({
          role,
          fullName: faker.person.fullName(),
          email: `${role}.${i}.${faker.string.alphanumeric(7).toLowerCase()}@hospital.local`,
          department: role === "lab" ? "Laboratório" : fallbackDepartment || randomFrom(departments),
        });
        staffIds.push(id);
      }
    }

    createStaffMembers(TOTAL_NURSES, "nurse", "Pronto Atendimento");
    createStaffMembers(TOTAL_RECEPTIONISTS, "receptionist", "Recepção");
    createStaffMembers(TOTAL_ADMINS, "admin", "NOC Hospitalar");
    createStaffMembers(TOTAL_LABS, "lab", "Laboratório");

    const appointmentSnapshots = [];
    for (let i = 0; i < TOTAL_APPOINTMENTS; i += 1) {
      const appointmentId = randomUUID();
      const patientUserId = randomFrom(patientIds);
      const doctorUserId = randomFrom(doctorIds);
      const scheduledAt = randomDateBetween(past45Days, future30Days);
      const isPast = scheduledAt < now;

      let status;
      if (!isPast) {
        status = pickWeighted([
          { value: "scheduled", weight: 80 },
          { value: "cancelled", weight: 15 },
          { value: "no_show", weight: 5 },
        ]);
      } else {
        status = pickWeighted([
          { value: "completed", weight: 72 },
          { value: "in_progress", weight: 6 },
          { value: "checked_in", weight: 8 },
          { value: "cancelled", weight: 8 },
          { value: "no_show", weight: 6 },
        ]);
      }

      const urgency = pickWeighted([
        { value: "low", weight: 34 },
        { value: "medium", weight: 42 },
        { value: "high", weight: 18 },
        { value: "critical", weight: 6 },
      ]);

      let checkInAt = null;
      let startedAt = null;
      let finishedAt = null;
      if (["checked_in", "in_progress", "completed"].includes(status)) {
        checkInAt = addMinutes(scheduledAt, faker.number.int({ min: -15, max: 25 }));
      }
      if (["in_progress", "completed"].includes(status)) {
        startedAt = addMinutes(checkInAt || scheduledAt, faker.number.int({ min: 3, max: 25 }));
      }
      if (status === "completed") {
        finishedAt = addMinutes(startedAt || scheduledAt, faker.number.int({ min: 12, max: 180 }));
      }

      const reason = randomFrom(appointmentReasons);
      const room = `Sala-${faker.number.int({ min: 1, max: 55 })}`;
      const notes = pickWeighted([
        { value: "", weight: 35 },
        { value: truncate(faker.lorem.sentence({ min: 8, max: 20 }), 500), weight: 65 },
      ]);

      appointmentsRows.push([
        appointmentId,
        patientUserId,
        doctorUserId,
        scheduledAt,
        checkInAt,
        startedAt,
        finishedAt,
        status,
        urgency,
        reason,
        notes || null,
        room,
        randomDateBetween(past45Days, now),
        randomDateBetween(past45Days, now),
      ]);

      appointmentSnapshots.push({
        id: appointmentId,
        patientUserId,
        doctorUserId,
        scheduledAt,
        status,
      });
    }

    for (let i = 0; i < TOTAL_EXAMS; i += 1) {
      const examId = randomUUID();
      const appointment = randomFrom(appointmentSnapshots);
      const requestedAt = addMinutes(appointment.scheduledAt, faker.number.int({ min: -120, max: 240 }));

      let status = "requested";
      if (appointment.status === "completed") {
        status = pickWeighted([
          { value: "completed", weight: 82 },
          { value: "requested", weight: 12 },
          { value: "in_progress", weight: 6 },
        ]);
      } else if (appointment.status === "in_progress") {
        status = pickWeighted([
          { value: "in_progress", weight: 60 },
          { value: "requested", weight: 40 },
        ]);
      } else if (["cancelled", "no_show"].includes(appointment.status)) {
        status = pickWeighted([
          { value: "cancelled", weight: 50 },
          { value: "requested", weight: 50 },
        ]);
      } else if (appointment.scheduledAt < now) {
        status = pickWeighted([
          { value: "completed", weight: 45 },
          { value: "requested", weight: 40 },
          { value: "in_progress", weight: 15 },
        ]);
      }

      const completedAt = status === "completed" ? addMinutes(requestedAt, faker.number.int({ min: 20, max: 720 })) : null;
      const abnormal = status === "completed" ? Math.random() < 0.21 : false;
      const resultSummary =
        status === "completed"
          ? truncate(
              abnormal
                ? `Achados alterados: ${faker.lorem.sentence({ min: 6, max: 15 })}`
                : `Sem alteracoes relevantes. ${faker.lorem.sentence({ min: 4, max: 10 })}`,
              400,
            )
          : null;

      examsRows.push([
        examId,
        appointment.id,
        appointment.patientUserId,
        appointment.doctorUserId,
        randomFrom(examTypes),
        pickWeighted([
          { value: "routine", weight: 63 },
          { value: "urgent", weight: 28 },
          { value: "stat", weight: 9 },
        ]),
        status,
        requestedAt,
        completedAt,
        resultSummary,
        abnormal,
      ]);
    }

    const activeStayCandidates = new Set();
    for (let i = 0; i < Math.floor(TOTAL_PATIENTS * 0.08); i += 1) {
      const stayId = randomUUID();
      const patientUserId = randomFrom(patientIds);
      const doctorUserId = randomFrom(doctorIds);
      const admittedAt = randomDateBetween(past45Days, now);
      const isActive = Math.random() < 0.28;
      const dischargedAt = isActive ? null : addMinutes(admittedAt, faker.number.int({ min: 360, max: 14400 }));
      const status = isActive ? "active" : "discharged";

      staysRows.push([
        stayId,
        patientUserId,
        doctorUserId,
        admittedAt,
        dischargedAt,
        randomFrom(["UTI", "Clínica Médica", "Cardiologia", "Ortopedia", "Pediatria"]),
        `Leito-${faker.number.int({ min: 1, max: 80 })}`,
        truncate(faker.lorem.sentence({ min: 4, max: 10 }), 180),
        status,
      ]);

      if (isActive) {
        activeStayCandidates.add(patientUserId);
      }
    }

    for (let i = 0; i < 420; i += 1) {
      const severity = pickWeighted([
        { value: "info", weight: 35 },
        { value: "warning", weight: 45 },
        { value: "critical", weight: 20 },
      ]);
      const status = pickWeighted([
        { value: "resolved", weight: 58 },
        { value: "acknowledged", weight: 18 },
        { value: "open", weight: 24 },
      ]);
      const createdAt = randomDateBetween(past45Days, now);
      const resolvedAt = status === "resolved" ? addMinutes(createdAt, faker.number.int({ min: 10, max: 640 })) : null;
      incidentsRows.push([
        randomUUID(),
        truncate(
          randomFrom([
            "Aumento de latencia em API de exames",
            "Fila de atendimento acima da media",
            "Erro recorrente em integracao laboratorial",
            "Uso elevado de CPU no backend",
            "Volume de disco em limite de alerta",
            "Burst de trafego em login demo",
          ]),
          120,
        ),
        truncate(faker.lorem.sentences({ min: 1, max: 3 }), 500),
        severity,
        status,
        randomFrom(["backend", "frontend", "database", "infra", "load-generator"]),
        randomFrom(staffIds),
        createdAt,
        resolvedAt,
      ]);
    }

    for (let i = 0; i < 2500; i += 1) {
      const eventType = pickWeighted([
        { value: "appointment_viewed", weight: 35 },
        { value: "patient_record_viewed", weight: 20 },
        { value: "exam_requested", weight: 18 },
        { value: "exam_updated", weight: 12 },
        { value: "appointment_status_changed", weight: 15 },
      ]);
      const severity = eventType.includes("updated") ? "warning" : "info";
      auditRows.push([
        eventType,
        severity,
        randomFrom([...doctorIds, ...staffIds, demoDoctorId, demoAdminId]),
        {
          traceHint: faker.string.uuid(),
          entityId: faker.string.uuid(),
          source: "seed",
          message: truncate(faker.lorem.sentence({ min: 4, max: 12 }), 180),
        },
        randomDateBetween(past45Days, now),
      ]);
    }

    await insertInChunks(
      client,
      "users",
      ["id", "role", "full_name", "email", "password_hash", "department", "phone", "is_demo", "last_login_at", "created_at"],
      usersRows,
      1000,
    );
    await insertInChunks(
      client,
      "patient_profiles",
      [
        "user_id",
        "birth_date",
        "blood_type",
        "allergies",
        "chronic_conditions",
        "insurance",
        "risk_level",
        "emergency_contact",
        "updated_at",
      ],
      patientProfilesRows,
      1000,
    );
    await insertInChunks(
      client,
      "doctor_profiles",
      ["user_id", "specialty", "crm", "shift", "years_experience", "updated_at"],
      doctorProfilesRows,
      800,
    );
    await insertInChunks(
      client,
      "appointments",
      [
        "id",
        "patient_user_id",
        "doctor_user_id",
        "scheduled_at",
        "check_in_at",
        "started_at",
        "finished_at",
        "status",
        "urgency",
        "reason",
        "notes",
        "room",
        "created_at",
        "updated_at",
      ],
      appointmentsRows,
      1200,
    );
    await insertInChunks(
      client,
      "exams",
      [
        "id",
        "appointment_id",
        "patient_user_id",
        "doctor_user_id",
        "exam_type",
        "priority",
        "status",
        "requested_at",
        "completed_at",
        "result_summary",
        "abnormal",
      ],
      examsRows,
      1200,
    );
    await insertInChunks(
      client,
      "inpatient_stays",
      [
        "id",
        "patient_user_id",
        "attending_doctor_user_id",
        "admitted_at",
        "discharged_at",
        "ward",
        "bed",
        "diagnosis",
        "status",
      ],
      staysRows,
      800,
    );
    await insertInChunks(
      client,
      "incidents",
      ["id", "title", "description", "severity", "status", "source", "created_by", "created_at", "resolved_at"],
      incidentsRows,
      400,
    );
    await insertInChunks(
      client,
      "audit_events",
      ["event_type", "severity", "user_id", "payload", "created_at"],
      auditRows,
      1200,
    );

    await client.query("COMMIT");

    console.log("Seed finalizado com sucesso.");
    console.log(
      JSON.stringify(
        {
          users: usersRows.length,
          patients: patientProfilesRows.length,
          doctors: doctorProfilesRows.length,
          appointments: appointmentsRows.length,
          exams: examsRows.length,
          inpatientStays: staysRows.length,
          incidents: incidentsRows.length,
          auditEvents: auditRows.length,
          demoUsers: [
            "paciente.demo@hospital.local",
            "medico.demo@hospital.local",
            "recepcao.demo@hospital.local",
            "ops.demo@hospital.local",
            "lab.demo@hospital.local",
          ],
        },
        null,
        2,
      ),
    );
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

seed()
  .catch((error) => {
    console.error("Falha no seed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
