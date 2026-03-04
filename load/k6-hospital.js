import http from "k6/http";
import { check, group, sleep } from "k6";

const BASE_URL = __ENV.BASE_URL || "http://backend:4000/api";

export const options = {
  scenarios: {
    patient_flow: {
      executor: "ramping-arrival-rate",
      exec: "patientJourney",
      startRate: 8,
      timeUnit: "1s",
      preAllocatedVUs: 60,
      maxVUs: 500,
      stages: [
        { target: 10, duration: "2m" },
        { target: 35, duration: "4m" },
        { target: 120, duration: "3m" },
        { target: 18, duration: "2m" },
      ],
    },
    doctor_flow: {
      executor: "constant-vus",
      exec: "doctorJourney",
      vus: 28,
      duration: "11m",
    },
    reception_flow: {
      executor: "constant-vus",
      exec: "receptionJourney",
      vus: 14,
      duration: "11m",
    },
    ops_chaos: {
      executor: "per-vu-iterations",
      exec: "opsChaosJourney",
      vus: 1,
      iterations: 12,
      maxDuration: "12m",
      startTime: "30s",
    },
  },
  thresholds: {
    http_req_duration: ["p(95)<2500", "p(99)<5000"],
    http_req_failed: ["rate<0.18"],
  },
};

function randomFrom(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function login(userId) {
  const payload = JSON.stringify({ userId });
  const response = http.post(`${BASE_URL}/auth/demo-login`, payload, {
    headers: { "Content-Type": "application/json" },
    tags: { endpoint: "demo-login" },
  });
  check(response, {
    "demo-login status 200": (res) => res.status === 200,
  });
  if (response.status !== 200) {
    return null;
  }
  return response.json("token");
}

function authHeaders(token) {
  return {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  };
}

function getDemoUsers(role, limit = 120) {
  const response = http.get(`${BASE_URL}/auth/demo-users?role=${role}&limit=${limit}`, {
    tags: { endpoint: "demo-users" },
  });
  check(response, {
    "demo-users status 200": (res) => res.status === 200,
  });
  if (response.status !== 200) {
    return [];
  }
  return response.json("users") || [];
}

export function setup() {
  return {
    patients: getDemoUsers("patient", 300),
    doctors: getDemoUsers("doctor", 200),
    receptionists: getDemoUsers("receptionist", 80),
    admins: getDemoUsers("admin", 20),
  };
}

export function patientJourney(data) {
  const user = randomFrom(data.patients);
  if (!user) {
    return;
  }
  const token = login(user.id);
  if (!token) {
    sleep(1);
    return;
  }

  group("patient-dashboard-and-appointments", () => {
    http.get(`${BASE_URL}/dashboard/summary`, authHeaders(token));
    http.get(`${BASE_URL}/appointments?day=upcoming&pageSize=20`, authHeaders(token));
    http.get(`${BASE_URL}/exams?status=requested&pageSize=20`, authHeaders(token));
    http.get(`${BASE_URL}/patients/${user.id}/record`, authHeaders(token));
  });

  sleep(Math.random() * 2);
}

export function doctorJourney(data) {
  const user = randomFrom(data.doctors);
  if (!user) {
    return;
  }
  const token = login(user.id);
  if (!token) {
    sleep(1);
    return;
  }

  group("doctor-operational-flow", () => {
    const appointments = http.get(`${BASE_URL}/appointments?day=today&pageSize=25`, authHeaders(token));
    http.get(`${BASE_URL}/dashboard/summary`, authHeaders(token));
    http.get(`${BASE_URL}/exams?status=requested&pageSize=20`, authHeaders(token));

    if (appointments.status === 200) {
      const list = appointments.json("appointments") || [];
      if (list.length > 0 && Math.random() < 0.45) {
        const picked = randomFrom(list);
        const statuses = ["checked_in", "in_progress", "completed"];
        const status = randomFrom(statuses);
        http.patch(
          `${BASE_URL}/appointments/${picked.id}/status`,
          JSON.stringify({ status }),
          authHeaders(token),
        );
      }
    }
  });

  sleep(Math.random() * 2);
}

export function receptionJourney(data) {
  const user = randomFrom(data.receptionists);
  if (!user) {
    return;
  }
  const token = login(user.id);
  if (!token) {
    sleep(1);
    return;
  }

  group("reception-triage-flow", () => {
    http.get(`${BASE_URL}/dashboard/summary`, authHeaders(token));
    http.get(`${BASE_URL}/patients?pageSize=25`, authHeaders(token));
    http.get(`${BASE_URL}/appointments?day=today&pageSize=25`, authHeaders(token));
    if (Math.random() < 0.18) {
      http.post(
        `${BASE_URL}/operations/incidents`,
        JSON.stringify({
          title: "Fila acima da meta no pronto atendimento",
          description: "Incidente gerado pelo fluxo de carga para testar alerting profile.",
          severity: "warning",
          source: "k6-reception-journey",
        }),
        authHeaders(token),
      );
    }
  });

  sleep(Math.random() * 1.5);
}

export function opsChaosJourney(data) {
  const admin = randomFrom(data.admins);
  if (!admin) {
    sleep(10);
    return;
  }

  const token = login(admin.id);
  if (!token) {
    sleep(10);
    return;
  }

  group("ops-chaos-actions", () => {
    http.post(
      `${BASE_URL}/operations/chaos/latency`,
      JSON.stringify({
        baseMs: 250,
        jitterMs: 400,
        durationSeconds: 45,
      }),
      authHeaders(token),
    );

    if (Math.random() < 0.7) {
      http.post(
        `${BASE_URL}/operations/chaos/error-rate`,
        JSON.stringify({
          percent: 8,
          durationSeconds: 30,
        }),
        authHeaders(token),
      );
    }

    if (Math.random() < 0.35) {
      http.post(
        `${BASE_URL}/operations/chaos/cpu-burn`,
        JSON.stringify({
          seconds: 40,
          intensity: 0.9,
          workers: 1,
        }),
        authHeaders(token),
      );
    }
  });

  sleep(45);
}
