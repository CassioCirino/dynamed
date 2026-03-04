# PulseCare Sim - Hospital Demo for Dynatrace OneAgent

Full stack app to simulate a real hospital operation for observability labs in Dynatrace.

This project is configured for Dynatrace OneAgent on containers (not OpenTelemetry).

Guia em portugues para pessoa nao tecnica:
- `GUIA-USO-NAO-TECNICO.md`
- `GUIA-CENARIOS-DYNATRACE-TEAMS.md`
- `GUIA-EC2-ONEAGENT.md`

## Onde controlar

1. Controle principal de cenarios (recomendado para apresentacao):
- URL: `http://localhost:5180`
- Login: `admin` / `dyantrace`
- Aciona: simulacao de carga de usuarios + queda de frontend + queda de API + queda de banco + pressao de CPU (liga/desliga)

2. Tela administrativa interna da aplicacao:
- URL: `http://localhost:5173/administracao/simulacoes`
- Login: `admin@hospital.local` / `dyantrace`
- Observacao: rota interna redirecionada para monitoramento; use o painel `:5180` para controle

3. Monitoramento operacional (sem acionar queda):
- URL: `http://localhost:5173` > menu **Operacoes**

## Stack

- `frontend/`: React + Vite
- `backend/`: Node.js + Express
- `postgres`: PostgreSQL
- `load/`: k6 load and spike scenarios
- `docker-compose.yml`: full environment orchestration

## Implemented user journeys

1. Patient
- one-click demo login
- email/password login
- patient self-registration
- appointments and exams view
- own medical record view

2. Doctor
- daily schedule
- appointment status updates
- exam request and exam updates

3. Reception
- triage workflow
- patient and schedule operations
- manual incident creation

4. Operations (admin)
- system state panel
- controlled chaos actions in a dedicated admin route:
  - HTTP error rate injection
  - latency injection
  - CPU burn
  - memory pressure
  - disk pressure

5. Guided journeys UI
- in-app page `Jornadas` with guided clickable flows for each user profile

## Fake data scale

Default seed size (configurable by env):

- 5,000 patients
- 90 doctors
- support staff (nurse/reception/admin/lab)
- 22,000 appointments
- 17,000 exams
- inpatient stays, incidents, and audit events

## Demo login users

- `paciente.demo@hospital.local`
- `medico.demo@hospital.local`
- `recepcao.demo@hospital.local`
- `ops.demo@hospital.local`
- `lab.demo@hospital.local`

Use the login screen and click to enter as any role.

## Run with Docker

1. Create env file:

```bash
cp .env.example .env
```

2. Start core stack:

```bash
docker compose up --build -d
```

3. Access:

- Frontend: `http://localhost:5173`
- Backend API: `http://localhost:4000`
- Metrics endpoint: `http://localhost:4000/metrics`
- Scenario control panel (separate): `http://localhost:5180`

Default admin credentials (email/password):

- `admin@hospital.local`
- `dyantrace`

Control panel credentials (username/password):

- `admin`
- `dyantrace`

## Protected simulation controls

- Admin simulation UI route:
  - `http://localhost:5173/administracao/simulacoes`
- Start/stop load and chaos actions require:
  - role `admin`
  - request header `x-simulacao-chave`

Set in `.env`:

```env
SIMULATION_CONTROL_KEY=troque-esta-chave-forte
```

## Automatic simulation jobs (backend only)

You can run simulations as scheduled jobs without frontend open.

Set in `.env`:

```env
SIMULATION_JOB_ENABLED=true
SIMULATION_JOB_MODE=interval
SIMULATION_JOB_INTERVAL_MINUTES=30
SIMULATION_JOB_CRON=*/30 * * * *
SIMULATION_JOB_TIMEZONE=America/Sao_Paulo
SIMULATION_JOB_PROFILE=light
SIMULATION_JOB_ROLES=patient,doctor,receptionist
SIMULATION_JOB_RUN_ON_START=true
SIMULATION_JOB_START_DELAY_SECONDS=20
```

`SIMULATION_JOB_MODE=cron` enables cron expression mode using `SIMULATION_JOB_CRON`.

Then restart backend:

```bash
docker compose up -d --build backend
```

## Run load and traffic spikes (k6)

```bash
docker compose --profile load up k6-load
```

The script `load/k6-hospital.js` generates mixed traffic:

- patient ramp-up and spikes
- continuous doctor and reception flows
- ops chaos actions during traffic

## Generate frontend real-user sessions (RUM)

Important:
- `k6` and backend scheduled simulation generate API traffic (services), but not real browser sessions.
- To make frontend user sessions appear in Dynatrace Applications (RUM), run browser-based load:

```bash
docker compose --profile rum run --rm rum-browser-load
```

Optional tuning in `.env`:

```env
RUM_BROWSER_VUS=5
RUM_BROWSER_DURATION=3m
K6_BROWSER_HEADLESS=true
K6_BROWSER_ARGS=no-sandbox
```

## Quick scenario triggers (Linux)

Use script:

```bash
chmod +x scripts/cenarios-dynatrace.sh
./scripts/cenarios-dynatrace.sh status
./scripts/cenarios-dynatrace.sh dev-api-off 120
./scripts/cenarios-dynatrace.sh db-off 120
./scripts/cenarios-dynatrace.sh infra-cpu 180 0.95 4
```

## Dynatrace OneAgent no host da VM

Use o OneAgent instalado direto no sistema operacional da VM (fora do Docker).
Este compose nao sobe mais OneAgent em container.

Fluxo recomendado em Linux:

1. Instale o OneAgent no host da VM pelo instalador oficial do Dynatrace.
2. Suba a stack da aplicacao:

```bash
docker compose up -d --build
```

3. Depois da instalacao do OneAgent, reinicie os containers monitorados:

```bash
docker compose restart backend frontend control-panel
```

4. Valide no Dynatrace se servicos e RUM estao aparecendo.

## Operational endpoints

- `POST /api/operations/chaos/error-rate`
- `POST /api/operations/chaos/latency`
- `POST /api/operations/chaos/cpu-burn`
- `POST /api/operations/chaos/memory-pressure`
- `POST /api/operations/chaos/disk-pressure`
- `GET /api/operations/state`
- `GET /api/operations/incidents`

## Self-healing lab hooks

Current compose already includes:

- service health checks
- restart policy

With Dynatrace you can attach:

1. alerting profile + problem notifications
2. workflow automation actions
3. remediation actions such as `docker compose restart backend`

## Dynatrace references

- Docker monitoring with OneAgent:
  https://docs.dynatrace.com/docs/ingest-from/setup-on-container-platforms/docker
- OneAgent Docker image:
  https://docs.dynatrace.com/docs/ingest-from/setup-on-container-platforms/docker/set-up-dynatrace-oneagent-as-docker-container
- Alerting profiles:
  https://docs.dynatrace.com/docs/discover-dynatrace/platform/davis-ai/anomaly-detection/set-up-a-customized-alerting-profile
