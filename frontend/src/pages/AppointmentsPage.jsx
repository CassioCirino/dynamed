import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { useAuth } from "../hooks/useAuth";
import { appointmentStatusLabel, formatDateTime } from "../lib/format";
import { LoadingState } from "../components/LoadingState";

const statusOptions = ["scheduled", "checked_in", "in_progress", "completed", "cancelled", "no_show"];
const urgencyColorOptions = [
  { value: "blue", label: "Azul - Nao urgente", backendUrgency: "low" },
  { value: "green", label: "Verde - Pouco urgente", backendUrgency: "low" },
  { value: "yellow", label: "Amarelo - Urgente", backendUrgency: "medium" },
  { value: "orange", label: "Laranja - Muito urgente", backendUrgency: "high" },
  { value: "red", label: "Vermelho - Emergencia", backendUrgency: "critical" },
];

const urgencyColorByBackend = {
  low: "blue",
  medium: "yellow",
  high: "orange",
  critical: "red",
};

const urgencyLabelByBackend = {
  low: "Azul/Verde",
  medium: "Amarelo",
  high: "Laranja",
  critical: "Vermelho",
};

function toSystemDateTimeInputValue(date = new Date()) {
  const localDate = new Date(date);
  localDate.setSeconds(0, 0);
  const tzOffsetMs = localDate.getTimezoneOffset() * 60_000;
  return new Date(localDate.getTime() - tzOffsetMs).toISOString().slice(0, 16);
}

function getUserDisplayName(user) {
  return user?.full_name || user?.fullName || user?.name || "Usuario";
}

function getBackendUrgencyByColor(color) {
  return urgencyColorOptions.find((item) => item.value === color)?.backendUrgency || "medium";
}

function getUrgencyPresentation(urgency) {
  const normalized = String(urgency || "").toLowerCase();
  return {
    color: urgencyColorByBackend[normalized] || "yellow",
    label: urgencyLabelByBackend[normalized] || normalized || "-",
  };
}

export function AppointmentsPage() {
  const { user } = useAuth();
  const [appointments, setAppointments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState("");
  const [filters, setFilters] = useState({ day: "today", status: "" });
  const [creating, setCreating] = useState(false);
  const [patientQuery, setPatientQuery] = useState("");
  const [doctorQuery, setDoctorQuery] = useState("");
  const [patientResults, setPatientResults] = useState([]);
  const [doctorResults, setDoctorResults] = useState([]);
  const [selectedPatient, setSelectedPatient] = useState(null);
  const [selectedDoctor, setSelectedDoctor] = useState(null);
  const [lookupLoading, setLookupLoading] = useState({ patient: false, doctor: false });
  const [newAppointment, setNewAppointment] = useState({
    scheduledAt: toSystemDateTimeInputValue(),
    urgencyColor: "green",
    reason: "",
    room: "Sala-12",
  });

  const canManage = useMemo(
    () => ["doctor", "nurse", "receptionist", "admin"].includes(user.role),
    [user.role],
  );

  useEffect(() => {
    if (user.role === "doctor") {
      const doctorName = getUserDisplayName(user);
      setSelectedDoctor({
        id: user.id,
        full_name: doctorName,
        email: user.email,
      });
      setDoctorQuery(doctorName);
    }
  }, [user]);

  const loadAppointments = useCallback(async () => {
    try {
      setLoading(true);
      const response = await api.get("/appointments", { params: { day: filters.day, status: filters.status || undefined } });
      setAppointments(response.data.appointments || []);
    } catch (error) {
      setErrorMessage(error?.response?.data?.message || "Falha ao carregar atendimentos.");
    } finally {
      setLoading(false);
    }
  }, [filters.day, filters.status]);

  useEffect(() => {
    loadAppointments();
    const intervalId = setInterval(loadAppointments, 25000);
    return () => clearInterval(intervalId);
  }, [loadAppointments]);

  const fetchLookupUsers = useCallback(async (role, search, setter, loadingKey) => {
    try {
      setLookupLoading((old) => ({ ...old, [loadingKey]: true }));
      const response = await api.get("/auth/users-lookup", {
        params: {
          role,
          search: search.trim(),
          limit: 12,
        },
      });
      setter(response.data.users || []);
    } catch {
      setter([]);
    } finally {
      setLookupLoading((old) => ({ ...old, [loadingKey]: false }));
    }
  }, []);

  useEffect(() => {
    if (!canManage) {
      return;
    }
    const timeoutId = setTimeout(() => {
      fetchLookupUsers("patient", patientQuery, setPatientResults, "patient");
    }, 250);
    return () => clearTimeout(timeoutId);
  }, [canManage, patientQuery, fetchLookupUsers]);

  useEffect(() => {
    if (!canManage || user.role === "doctor") {
      return;
    }
    const timeoutId = setTimeout(() => {
      fetchLookupUsers("doctor", doctorQuery, setDoctorResults, "doctor");
    }, 250);
    return () => clearTimeout(timeoutId);
  }, [canManage, doctorQuery, fetchLookupUsers, user.role]);

  async function updateStatus(appointmentId, status) {
    try {
      await api.patch(`/appointments/${appointmentId}/status`, { status });
      await loadAppointments();
    } catch (error) {
      setErrorMessage(error?.response?.data?.message || "Falha ao atualizar status.");
    }
  }

  function clearFormAfterCreate() {
    setNewAppointment((prev) => ({
      ...prev,
      reason: "",
      scheduledAt: toSystemDateTimeInputValue(),
      urgencyColor: "green",
    }));
    setSelectedPatient(null);
    setPatientQuery("");
    setPatientResults([]);
    if (user.role !== "doctor") {
      setSelectedDoctor(null);
      setDoctorQuery("");
      setDoctorResults([]);
    }
  }

  async function createAppointment(event) {
    event.preventDefault();
    if (!selectedPatient?.id) {
      setErrorMessage("Selecione um paciente cadastrado.");
      return;
    }
    if (!selectedDoctor?.id) {
      setErrorMessage("Selecione um medico cadastrado.");
      return;
    }

    try {
      setCreating(true);
      setErrorMessage("");
      await api.post("/appointments", {
        patientUserId: selectedPatient.id,
        doctorUserId: selectedDoctor.id,
        scheduledAt: new Date(newAppointment.scheduledAt).toISOString(),
        urgency: getBackendUrgencyByColor(newAppointment.urgencyColor),
        reason: newAppointment.reason,
        room: newAppointment.room,
      });
      clearFormAfterCreate();
      await loadAppointments();
    } catch (error) {
      setErrorMessage(error?.response?.data?.message || "Falha ao criar atendimento.");
    } finally {
      setCreating(false);
    }
  }

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">JORNADA DE ATENDIMENTO</p>
          <h2>Atendimentos e Triagem</h2>
        </div>
        <div className="row gap">
          <select value={filters.day} onChange={(event) => setFilters((old) => ({ ...old, day: event.target.value }))}>
            <option value="today">Hoje</option>
            <option value="upcoming">Proximos</option>
            <option value="past">Passados</option>
          </select>
          <select value={filters.status} onChange={(event) => setFilters((old) => ({ ...old, status: event.target.value }))}>
            <option value="">Todos status</option>
            {statusOptions.map((status) => (
              <option key={status} value={status}>
                {appointmentStatusLabel(status)}
              </option>
            ))}
          </select>
        </div>
      </header>

      {errorMessage ? <p className="error-banner">{errorMessage}</p> : null}

      {canManage ? (
        <form className="panel appointment-form" onSubmit={createAppointment}>
          <h3>Novo Atendimento</h3>

          <div className="lookup-field">
            <label>Buscar paciente cadastrado</label>
            <input
              value={patientQuery}
              onChange={(event) => {
                setPatientQuery(event.target.value);
                setSelectedPatient(null);
              }}
              placeholder="Digite nome ou e-mail do paciente"
              required
            />
            {lookupLoading.patient ? <small>Buscando paciente...</small> : null}
            {patientResults.length > 0 ? (
              <div className="lookup-dropdown">
                {patientResults.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className="lookup-option"
                    onClick={() => {
                      setSelectedPatient(item);
                      setPatientQuery(item.full_name);
                      setPatientResults([]);
                    }}
                  >
                    <span>{item.full_name}</span>
                    <small>{item.email}</small>
                  </button>
                ))}
              </div>
            ) : null}
            {selectedPatient ? <small className="selected-hint">Paciente: {selectedPatient.full_name}</small> : null}
          </div>

          <div className="lookup-field">
            <label>Medico responsavel</label>
            <input
              value={doctorQuery}
              onChange={(event) => {
                if (user.role === "doctor") {
                  return;
                }
                setDoctorQuery(event.target.value);
                setSelectedDoctor(null);
              }}
              placeholder={user.role === "doctor" ? "Definido pelo seu usuario" : "Digite nome ou e-mail do medico"}
              required
              disabled={user.role === "doctor"}
            />
            {user.role !== "doctor" && lookupLoading.doctor ? <small>Buscando medico...</small> : null}
            {user.role !== "doctor" && doctorResults.length > 0 ? (
              <div className="lookup-dropdown">
                {doctorResults.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className="lookup-option"
                    onClick={() => {
                      setSelectedDoctor(item);
                      setDoctorQuery(item.full_name);
                      setDoctorResults([]);
                    }}
                  >
                    <span>{item.full_name}</span>
                    <small>{item.email}</small>
                  </button>
                ))}
              </div>
            ) : null}
            {selectedDoctor ? <small className="selected-hint">Medico: {selectedDoctor.full_name}</small> : null}
          </div>

          <label>
            Data e hora (sistema)
            <input
              type="datetime-local"
              value={newAppointment.scheduledAt}
              onChange={(event) => setNewAppointment((old) => ({ ...old, scheduledAt: event.target.value }))}
              required
            />
            <button
              type="button"
              className="time-now-button"
              onClick={() => setNewAppointment((old) => ({ ...old, scheduledAt: toSystemDateTimeInputValue() }))}
            >
              Usar hora atual do sistema
            </button>
          </label>

          <label>
            Urgencia (escala de cores)
            <select
              value={newAppointment.urgencyColor}
              onChange={(event) => setNewAppointment((old) => ({ ...old, urgencyColor: event.target.value }))}
              className={`urgency-select urgency-${newAppointment.urgencyColor}`}
            >
              {urgencyColorOptions.map((urgency) => (
                <option key={urgency.value} value={urgency.value}>
                  {urgency.label}
                </option>
              ))}
            </select>
          </label>

          <label>
            Sala
            <input
              value={newAppointment.room}
              onChange={(event) => setNewAppointment((old) => ({ ...old, room: event.target.value }))}
              placeholder="Sala"
              required
            />
          </label>

          <label>
            Motivo
            <input
              value={newAppointment.reason}
              onChange={(event) => setNewAppointment((old) => ({ ...old, reason: event.target.value }))}
              placeholder="Motivo do atendimento"
              required
            />
          </label>

          <button type="submit" disabled={creating}>
            {creating ? "Criando..." : "Criar atendimento"}
          </button>
        </form>
      ) : null}

      {loading ? (
        <LoadingState />
      ) : (
        <article className="panel table-panel">
          <table>
            <thead>
              <tr>
                <th>Horario</th>
                <th>Paciente</th>
                <th>Medico</th>
                <th>Status</th>
                <th>Urgencia</th>
                <th>Sala</th>
                {canManage ? <th>Acao</th> : null}
              </tr>
            </thead>
            <tbody>
              {appointments.map((appointment) => {
                const urgency = getUrgencyPresentation(appointment.urgency);
                return (
                  <tr key={appointment.id}>
                    <td>{formatDateTime(appointment.scheduled_at)}</td>
                    <td>{appointment.patient_name}</td>
                    <td>{appointment.doctor_name}</td>
                    <td>{appointmentStatusLabel(appointment.status)}</td>
                    <td>
                      <span className={`urgency-pill urgency-${urgency.color}`}>{urgency.label}</span>
                    </td>
                    <td>{appointment.room}</td>
                    {canManage ? (
                      <td>
                        <select value={appointment.status} onChange={(event) => updateStatus(appointment.id, event.target.value)}>
                          {statusOptions.map((status) => (
                            <option key={status} value={status}>
                              {appointmentStatusLabel(status)}
                            </option>
                          ))}
                        </select>
                      </td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </article>
      )}
    </section>
  );
}
