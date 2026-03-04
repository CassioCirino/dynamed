import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { useAuth } from "../hooks/useAuth";
import { appointmentStatusLabel, examStatusLabel, formatDate, formatDateTime, riskLevelLabel } from "../lib/format";
import { LoadingState } from "../components/LoadingState";

const bloodTypeOptions = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"];
const riskLevelOptions = ["low", "medium", "high", "critical"];
const initialPatientForm = {
  fullName: "",
  email: "",
  phone: "",
  birthDate: "",
  bloodType: "O+",
  insurance: "",
  allergies: "",
  chronicConditions: "",
  emergencyContact: "",
  riskLevel: "low",
  password: "",
};

export function PatientsPage() {
  const { user } = useAuth();
  const [search, setSearch] = useState("");
  const [patients, setPatients] = useState([]);
  const [selectedPatient, setSelectedPatient] = useState(null);
  const [record, setRecord] = useState(null);
  const [loading, setLoading] = useState(true);
  const [recordLoading, setRecordLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [successMessage, setSuccessMessage] = useState("");
  const [creatingPatient, setCreatingPatient] = useState(false);
  const [newPatient, setNewPatient] = useState(initialPatientForm);

  const canListPatients = useMemo(() => user.role !== "patient", [user.role]);
  const canCreatePatient = useMemo(() => ["receptionist", "admin"].includes(user.role), [user.role]);

  const loadPatients = useCallback(async (searchOverride) => {
    if (!canListPatients) {
      return;
    }
    try {
      setLoading(true);
      const effectiveSearch = typeof searchOverride === "string" ? searchOverride : search;
      const response = await api.get("/patients", { params: { search: effectiveSearch, pageSize: 40 } });
      const fetched = response.data.patients || [];
      setPatients(fetched);
      setSelectedPatient((current) => current || fetched[0]?.id || null);
    } catch (error) {
      setErrorMessage(error?.response?.data?.message || "Falha ao carregar pacientes.");
    } finally {
      setLoading(false);
    }
  }, [canListPatients, search]);

  const loadRecord = useCallback(async (patientId) => {
    if (!patientId) {
      return;
    }
    try {
      setRecordLoading(true);
      const response = await api.get(`/patients/${patientId}/record`);
      setRecord(response.data);
    } catch (error) {
      setErrorMessage(error?.response?.data?.message || "Falha ao carregar prontuário.");
    } finally {
      setRecordLoading(false);
    }
  }, []);

  async function createPatient(event) {
    event.preventDefault();
    try {
      setCreatingPatient(true);
      setErrorMessage("");
      setSuccessMessage("");

      const payload = {
        fullName: newPatient.fullName,
        email: newPatient.email,
        phone: newPatient.phone || undefined,
        birthDate: newPatient.birthDate,
        bloodType: newPatient.bloodType,
        insurance: newPatient.insurance || undefined,
        allergies: newPatient.allergies || undefined,
        chronicConditions: newPatient.chronicConditions || undefined,
        emergencyContact: newPatient.emergencyContact || undefined,
        riskLevel: newPatient.riskLevel,
        password: newPatient.password || undefined,
      };

      const response = await api.post("/patients", payload);
      const createdPatient = response.data.patient;

      setSuccessMessage(`Paciente ${createdPatient.full_name} cadastrado com sucesso.`);
      setNewPatient(initialPatientForm);
      setSearch("");
      await loadPatients("");
      setSelectedPatient(createdPatient.id);
      await loadRecord(createdPatient.id);
    } catch (error) {
      setErrorMessage(error?.response?.data?.message || "Falha ao cadastrar paciente.");
    } finally {
      setCreatingPatient(false);
    }
  }

  useEffect(() => {
    if (canListPatients) {
      void loadPatients();
      return;
    }
    setSelectedPatient(user.id || user.sub);
  }, [canListPatients, loadPatients, user.id, user.sub]);

  useEffect(() => {
    if (!canListPatients) {
      void loadRecord(user.id || user.sub);
      return;
    }
    if (selectedPatient) {
      void loadRecord(selectedPatient);
    }
  }, [selectedPatient, canListPatients, loadRecord, user.id, user.sub]);

  return (
    <section className="page patients-page">
      <header className="page-header">
        <div>
          <p className="eyebrow">PRONTUÁRIO E HISTÓRICO</p>
          <h2>{canListPatients ? "Pacientes" : "Meu Prontuário"}</h2>
        </div>
        {canListPatients ? (
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar paciente" />
        ) : null}
      </header>

      {errorMessage ? <p className="error-banner">{errorMessage}</p> : null}
      {successMessage ? <p className="success-banner">{successMessage}</p> : null}

      {canCreatePatient ? (
        <form className="panel form-grid patients-create-form" onSubmit={createPatient}>
          <h3>Novo paciente (Recepcao)</h3>

          <label>
            Nome completo
            <input
              value={newPatient.fullName}
              onChange={(event) => setNewPatient((old) => ({ ...old, fullName: event.target.value }))}
              required
            />
          </label>

          <label>
            E-mail
            <input
              type="email"
              value={newPatient.email}
              onChange={(event) => setNewPatient((old) => ({ ...old, email: event.target.value }))}
              required
            />
          </label>

          <label>
            Telefone
            <input
              value={newPatient.phone}
              onChange={(event) => setNewPatient((old) => ({ ...old, phone: event.target.value }))}
              placeholder="(11) 99999-9999"
            />
          </label>

          <label>
            Data de nascimento
            <input
              type="date"
              value={newPatient.birthDate}
              onChange={(event) => setNewPatient((old) => ({ ...old, birthDate: event.target.value }))}
              required
            />
          </label>

          <label>
            Tipo sanguineo
            <select
              value={newPatient.bloodType}
              onChange={(event) => setNewPatient((old) => ({ ...old, bloodType: event.target.value }))}
            >
              {bloodTypeOptions.map((bloodType) => (
                <option key={bloodType} value={bloodType}>
                  {bloodType}
                </option>
              ))}
            </select>
          </label>

          <label>
            Nivel de risco
            <select
              value={newPatient.riskLevel}
              onChange={(event) => setNewPatient((old) => ({ ...old, riskLevel: event.target.value }))}
            >
              {riskLevelOptions.map((riskLevel) => (
                <option key={riskLevel} value={riskLevel}>
                  {riskLevelLabel(riskLevel)}
                </option>
              ))}
            </select>
          </label>

          <label>
            Convenio
            <input
              value={newPatient.insurance}
              onChange={(event) => setNewPatient((old) => ({ ...old, insurance: event.target.value }))}
              placeholder="Particular ou plano"
            />
          </label>

          <label>
            Alergias
            <input
              value={newPatient.allergies}
              onChange={(event) => setNewPatient((old) => ({ ...old, allergies: event.target.value }))}
              placeholder="Opcional"
            />
          </label>

          <label>
            Condicoes cronicas
            <input
              value={newPatient.chronicConditions}
              onChange={(event) => setNewPatient((old) => ({ ...old, chronicConditions: event.target.value }))}
              placeholder="Opcional"
            />
          </label>

          <label>
            Contato de emergencia
            <input
              value={newPatient.emergencyContact}
              onChange={(event) => setNewPatient((old) => ({ ...old, emergencyContact: event.target.value }))}
              placeholder="Nome e telefone"
            />
          </label>

          <label>
            Senha inicial (opcional)
            <input
              type="password"
              minLength={6}
              value={newPatient.password}
              onChange={(event) => setNewPatient((old) => ({ ...old, password: event.target.value }))}
              placeholder="Minimo 6 caracteres"
            />
          </label>

          <button type="submit" disabled={creatingPatient}>
            {creatingPatient ? "Cadastrando..." : "Cadastrar paciente"}
          </button>
        </form>
      ) : null}

      <div className="split-layout">
        {canListPatients ? (
          <aside className="panel list-panel">
            {loading ? (
              <LoadingState />
            ) : patients.length === 0 ? (
              <p>Nenhum paciente encontrado.</p>
            ) : (
              <ul>
                {patients.map((patient) => (
                  <li key={patient.id}>
                    <button
                      type="button"
                      className={patient.id === selectedPatient ? "active" : ""}
                      onClick={() => setSelectedPatient(patient.id)}
                    >
                      <strong>{patient.full_name}</strong>
                      <span>{riskLevelLabel(patient.risk_level)}</span>
                      <small>{patient.blood_type}</small>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </aside>
        ) : null}

        <article className="panel">
          {recordLoading || !record ? (
            <LoadingState label="Carregando prontuário..." />
          ) : (
            <>
              <div className="record-header">
                <h3>{record.patient.full_name}</h3>
                <p>
                  {riskLevelLabel(record.patient.risk_level)} | {record.patient.blood_type} | Nasc:{" "}
                  {formatDate(record.patient.birth_date)}
                </p>
              </div>

              <div className="mini-grid">
                <div>
                  <strong>Seguro</strong>
                  <span>{record.patient.insurance}</span>
                </div>
                <div>
                  <strong>Alergias</strong>
                  <span>{record.patient.allergies || "-"}</span>
                </div>
                <div>
                  <strong>Condições crônicas</strong>
                  <span>{record.patient.chronic_conditions || "-"}</span>
                </div>
                <div>
                  <strong>Contato de emergência</strong>
                  <span>{record.patient.emergency_contact || "-"}</span>
                </div>
              </div>

              <h4>Últimos atendimentos</h4>
              <div className="table-wrapper">
                <table>
                  <thead>
                    <tr>
                      <th>Data</th>
                      <th>Status</th>
                      <th>Médico</th>
                      <th>Motivo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {record.appointments.map((item) => (
                      <tr key={item.id}>
                        <td>{formatDateTime(item.scheduled_at)}</td>
                        <td>{appointmentStatusLabel(item.status)}</td>
                        <td>{item.doctor_name}</td>
                        <td>{item.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <h4>Últimos exames</h4>
              <div className="table-wrapper">
                <table>
                  <thead>
                    <tr>
                      <th>Data</th>
                      <th>Exame</th>
                      <th>Status</th>
                      <th>Resultado</th>
                    </tr>
                  </thead>
                  <tbody>
                    {record.exams.map((exam) => (
                      <tr key={exam.id}>
                        <td>{formatDateTime(exam.requested_at)}</td>
                        <td>{exam.exam_type}</td>
                        <td>{examStatusLabel(exam.status)}</td>
                        <td>{exam.result_summary || "-"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </article>
      </div>
    </section>
  );
}
