CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY,
    role TEXT NOT NULL CHECK (role IN ('patient', 'doctor', 'nurse', 'receptionist', 'admin', 'lab')),
    full_name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT,
    department TEXT,
    phone TEXT,
    is_demo BOOLEAN NOT NULL DEFAULT FALSE,
    last_login_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS password_hash TEXT;

CREATE TABLE IF NOT EXISTS patient_profiles (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    birth_date DATE NOT NULL,
    blood_type TEXT NOT NULL,
    allergies TEXT,
    chronic_conditions TEXT,
    insurance TEXT,
    risk_level TEXT NOT NULL CHECK (risk_level IN ('low', 'medium', 'high', 'critical')),
    emergency_contact TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS doctor_profiles (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    specialty TEXT NOT NULL,
    crm TEXT NOT NULL UNIQUE,
    shift TEXT NOT NULL CHECK (shift IN ('morning', 'afternoon', 'night', 'on_call')),
    years_experience INTEGER NOT NULL CHECK (years_experience >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS appointments (
    id UUID PRIMARY KEY,
    patient_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    doctor_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    scheduled_at TIMESTAMPTZ NOT NULL,
    check_in_at TIMESTAMPTZ,
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    status TEXT NOT NULL CHECK (status IN ('scheduled', 'checked_in', 'in_progress', 'completed', 'cancelled', 'no_show')),
    urgency TEXT NOT NULL CHECK (urgency IN ('low', 'medium', 'high', 'critical')),
    reason TEXT NOT NULL,
    notes TEXT,
    room TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS exams (
    id UUID PRIMARY KEY,
    appointment_id UUID REFERENCES appointments(id) ON DELETE SET NULL,
    patient_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    doctor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    exam_type TEXT NOT NULL,
    priority TEXT NOT NULL CHECK (priority IN ('routine', 'urgent', 'stat')),
    status TEXT NOT NULL CHECK (status IN ('requested', 'in_progress', 'completed', 'cancelled')),
    requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    result_summary TEXT,
    abnormal BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS inpatient_stays (
    id UUID PRIMARY KEY,
    patient_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    attending_doctor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    admitted_at TIMESTAMPTZ NOT NULL,
    discharged_at TIMESTAMPTZ,
    ward TEXT NOT NULL,
    bed TEXT NOT NULL,
    diagnosis TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'discharged'))
);

CREATE TABLE IF NOT EXISTS incidents (
    id UUID PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
    status TEXT NOT NULL CHECK (status IN ('open', 'acknowledged', 'resolved')),
    source TEXT NOT NULL,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS audit_events (
    id BIGSERIAL PRIMARY KEY,
    event_type TEXT NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'error')),
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS chaos_events (
    id BIGSERIAL PRIMARY KEY,
    kind TEXT NOT NULL,
    config JSONB NOT NULL DEFAULT '{}'::jsonb,
    status TEXT NOT NULL CHECK (status IN ('started', 'finished', 'failed')),
    triggered_by UUID REFERENCES users(id) ON DELETE SET NULL,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_last_login ON users(last_login_at DESC);
CREATE INDEX IF NOT EXISTS idx_appointments_patient ON appointments(patient_user_id);
CREATE INDEX IF NOT EXISTS idx_appointments_doctor ON appointments(doctor_user_id);
CREATE INDEX IF NOT EXISTS idx_appointments_status_scheduled ON appointments(status, scheduled_at DESC);
CREATE INDEX IF NOT EXISTS idx_exams_status_requested ON exams(status, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_exams_patient ON exams(patient_user_id);
CREATE INDEX IF NOT EXISTS idx_incidents_status_created ON incidents(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_created ON audit_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chaos_events_started ON chaos_events(started_at DESC);
