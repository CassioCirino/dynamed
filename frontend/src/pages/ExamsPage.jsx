import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { examPriorityLabel, examStatusLabel, formatDateTime } from "../lib/format";
import { useAuth } from "../hooks/useAuth";
import { LoadingState } from "../components/LoadingState";

const statusOptions = ["requested", "in_progress", "completed", "cancelled"];
const priorityOptions = ["routine", "urgent", "stat"];

export function ExamsPage() {
  const { user } = useAuth();
  const [exams, setExams] = useState([]);
  const [statusFilter, setStatusFilter] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [updatingExamId, setUpdatingExamId] = useState("");
  const [newExam, setNewExam] = useState({
    appointmentId: "",
    patientUserId: "",
    doctorUserId: "",
    examType: "Hemograma Completo",
    priority: "routine",
  });

  const canManage = useMemo(() => ["doctor", "nurse", "lab", "admin"].includes(user.role), [user.role]);

  const loadExams = useCallback(async () => {
    try {
      setLoading(true);
      const response = await api.get("/exams", { params: { status: statusFilter || undefined } });
      setExams(response.data.exams || []);
    } catch (error) {
      setErrorMessage(error?.response?.data?.message || "Falha ao carregar exames.");
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    loadExams();
    const intervalId = setInterval(loadExams, 25000);
    return () => clearInterval(intervalId);
  }, [loadExams]);

  async function updateExamStatus(examId, status) {
    try {
      setUpdatingExamId(examId);
      await api.patch(`/exams/${examId}`, {
        status,
        resultSummary: status === "completed" ? "Resultado validado em ambiente de simulação." : undefined,
        abnormal: status === "completed" ? Math.random() < 0.2 : undefined,
      });
      await loadExams();
    } catch (error) {
      setErrorMessage(error?.response?.data?.message || "Falha ao atualizar exame.");
    } finally {
      setUpdatingExamId("");
    }
  }

  async function createExam(event) {
    event.preventDefault();
    try {
      await api.post("/exams", newExam);
      setNewExam((prev) => ({ ...prev, appointmentId: "", patientUserId: "", doctorUserId: "" }));
      await loadExams();
    } catch (error) {
      setErrorMessage(error?.response?.data?.message || "Falha ao solicitar exame.");
    }
  }

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">FLUXO LABORATORIAL</p>
          <h2>Exames</h2>
        </div>
        <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
          <option value="">Todos status</option>
          {statusOptions.map((status) => (
            <option key={status} value={status}>
              {examStatusLabel(status)}
            </option>
          ))}
        </select>
      </header>

      {errorMessage ? <p className="error-banner">{errorMessage}</p> : null}

      {canManage ? (
        <form className="panel form-grid" onSubmit={createExam}>
          <h3>Solicitar exame</h3>
          <input
            value={newExam.appointmentId}
            onChange={(event) => setNewExam((old) => ({ ...old, appointmentId: event.target.value }))}
            placeholder="ID do atendimento (opcional)"
          />
          <input
            value={newExam.patientUserId}
            onChange={(event) => setNewExam((old) => ({ ...old, patientUserId: event.target.value }))}
            placeholder="ID do paciente"
            required
          />
          <input
            value={newExam.doctorUserId}
            onChange={(event) => setNewExam((old) => ({ ...old, doctorUserId: event.target.value }))}
            placeholder="ID do medico (opcional)"
          />
          <input
            value={newExam.examType}
            onChange={(event) => setNewExam((old) => ({ ...old, examType: event.target.value }))}
            placeholder="Tipo de exame"
            required
          />
          <select
            value={newExam.priority}
            onChange={(event) => setNewExam((old) => ({ ...old, priority: event.target.value }))}
          >
            {priorityOptions.map((priority) => (
              <option key={priority} value={priority}>
                {examPriorityLabel(priority)}
              </option>
            ))}
          </select>
          <button type="submit">Solicitar</button>
        </form>
      ) : null}

      {loading ? (
        <LoadingState />
      ) : (
        <article className="panel table-panel">
          <table>
            <thead>
              <tr>
                <th>Solicitação</th>
                <th>Paciente</th>
                <th>Médico</th>
                <th>Exame</th>
                <th>Prioridade</th>
                <th>Status</th>
                <th>Resultado</th>
                {canManage ? <th>Ação</th> : null}
              </tr>
            </thead>
            <tbody>
              {exams.map((exam) => (
                <tr key={exam.id}>
                  <td>{formatDateTime(exam.requested_at)}</td>
                  <td>{exam.patient_name}</td>
                  <td>{exam.doctor_name || "-"}</td>
                  <td>{exam.exam_type}</td>
                  <td>{examPriorityLabel(exam.priority)}</td>
                  <td>{examStatusLabel(exam.status)}</td>
                  <td>{exam.result_summary || "-"}</td>
                  {canManage ? (
                    <td>
                      <select
                        value={exam.status}
                        onChange={(event) => updateExamStatus(exam.id, event.target.value)}
                        disabled={updatingExamId === exam.id}
                      >
                        {statusOptions.map((status) => (
                          <option key={status} value={status}>
                            {examStatusLabel(status)}
                          </option>
                        ))}
                      </select>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </article>
      )}
    </section>
  );
}
