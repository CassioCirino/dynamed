import dayjs from "dayjs";

const roleLabels = {
  patient: "Paciente",
  doctor: "Medico",
  nurse: "Enfermagem",
  receptionist: "Recepcao",
  admin: "Operacoes",
  lab: "Laboratorio",
};

const appointmentStatusLabels = {
  scheduled: "Agendado",
  checked_in: "Chegada",
  in_progress: "Em andamento",
  completed: "Concluido",
  cancelled: "Cancelado",
  no_show: "Nao compareceu",
};

const examStatusLabels = {
  requested: "Solicitado",
  in_progress: "Em andamento",
  completed: "Concluido",
  cancelled: "Cancelado",
};

const examPriorityLabels = {
  routine: "Rotina",
  urgent: "Urgente",
  stat: "Imediato",
};

const riskLevelLabels = {
  low: "Baixo",
  medium: "Medio",
  high: "Alto",
  critical: "Critico",
};

const incidentSeverityLabels = {
  info: "Informativo",
  warning: "Alerta",
  critical: "Critico",
};

const incidentStatusLabels = {
  open: "Aberto",
  acknowledged: "Reconhecido",
  resolved: "Resolvido",
};

const loadProfileLabels = {
  light: "Leve",
  moderate: "Medio",
  heavy: "Alto",
  extreme: "Extremo",
  custom: "Personalizado",
};

export function formatDateTime(value) {
  if (!value) {
    return "-";
  }
  return dayjs(value).format("DD/MM/YYYY HH:mm");
}

export function formatDate(value) {
  if (!value) {
    return "-";
  }
  return dayjs(value).format("DD/MM/YYYY");
}

export function roleLabel(role) {
  return roleLabels[role] || role;
}

export function appointmentStatusLabel(status) {
  return appointmentStatusLabels[status] || status;
}

export function examStatusLabel(status) {
  return examStatusLabels[status] || status;
}

export function examPriorityLabel(priority) {
  return examPriorityLabels[priority] || priority;
}

export function riskLevelLabel(level) {
  return riskLevelLabels[level] || level;
}

export function incidentSeverityLabel(level) {
  return incidentSeverityLabels[level] || level;
}

export function incidentStatusLabel(status) {
  return incidentStatusLabels[status] || status;
}

export function loadProfileLabel(profile) {
  return loadProfileLabels[profile] || profile;
}

export function numberLabel(value) {
  return new Intl.NumberFormat("pt-BR").format(Number(value || 0));
}
