# Guia Simples (Nao Tecnico) - Carga e Simulacoes

Este guia foi feito para quem nao e da area tecnica.
Objetivo: abrir o sistema, monitorar e usar a area administrativa de simulacoes com seguranca.

## Onde controlar (resumo rapido)

1. Painel recomendado para a apresentacao (sem terminal):
- URL: `http://localhost:5180`
- Login: `admin` / `dyantrace`
- Controle: ligar/desligar simulacao de carga, cenarios de queda e CPU

2. Painel interno da aplicacao:
- URL: `http://localhost:5173/administracao/simulacoes`
- Login: `admin@hospital.local` / `dyantrace`
- Observacao: essa rota foi separada e redireciona; use o painel `:5180` para controlar simulacoes

3. Tela de monitoramento (sem acionar queda):
- URL: `http://localhost:5173` > **Operacoes**

## 1. Abrir o sistema

Se o sistema ainda nao estiver ligado, execute no terminal:

```bash
docker compose up -d --build
```

Depois abra no navegador:

- `http://localhost:5173`
- `http://localhost:5180` (painel de cenarios da demonstracao)

## 2. Entrar no sistema

Na tela inicial, clique em:

- **Operacoes Demonstracao** (`ops.demo@hospital.local`)

Nao precisa senha.

Opcao de administrador com senha:

- E-mail: `admin@hospital.local`
- Senha: `dyantrace`

## 3. Tela normal de operacoes

No menu da esquerda, clique em:

- **Operacoes**

Essa tela agora e somente para monitoramento e incidentes.

## 4. Area administrativa de simulacoes

Para iniciar/parar simulacoes, use a rota interna:

- `http://localhost:5173/administracao/simulacoes`

Somente perfil **Operacoes** (admin) consegue usar.

Opcao recomendada para apresentacao sem usar terminal:

- `http://localhost:5180`
- Usuario: `admin`
- Senha: `dyantrace`

## 5. Chave de controle (obrigatoria)

Na tela administrativa, informe a **Chave de controle**.
Essa chave vem da variavel `SIMULATION_CONTROL_KEY` no arquivo `.env`.

Exemplo:

```env
SIMULATION_CONTROL_KEY=troque-esta-chave-forte
```

## 6. Iniciar e parar carga manual

Na tela administrativa:

- Clique **Iniciar simulacao** para comecar
- Clique **Parar simulacao** para encerrar

## 7. Rodar como rotina automatica (sem front aberto)

Importante:
- A simulacao normal do sistema gera carga de API (backend).
- Para aparecer **frontend/usuarios reais (RUM)** no Dynatrace, rode a simulacao de navegador (item 7.1).

### 7.1 Simular usuarios de navegador (frontend no Dynatrace)

Execute no terminal:

```bash
docker compose --profile rum run --rm rum-browser-load
```

Esse comando abre navegadores em modo oculto e navega no sistema, gerando sessoes reais de frontend.
Depois de rodar, aguarde 2 a 5 minutos no Dynatrace para visualizar em Applications (RUM).

No arquivo `.env`, ative:

```env
SIMULATION_JOB_ENABLED=true
SIMULATION_JOB_MODE=interval
SIMULATION_JOB_INTERVAL_MINUTES=30
SIMULATION_JOB_CRON=*/30 * * * *
SIMULATION_JOB_TIMEZONE=America/Sao_Paulo
SIMULATION_JOB_PROFILE=light
SIMULATION_JOB_ROLES=patient,doctor,receptionist
SIMULATION_JOB_RUN_ON_START=true
```

Para usar cron real:

- defina `SIMULATION_JOB_MODE=cron`
- ajuste `SIMULATION_JOB_CRON` (ex.: `*/15 * * * *` para cada 15 minutos)

Depois reinicie:

```bash
docker compose up -d --build backend
```

Com isso, o backend dispara simulacao automaticamente no intervalo configurado, sem precisar tela aberta.

Se quiser operar tudo manualmente no painel `:5180`, deixe:

```env
SIMULATION_JOB_ENABLED=false
```

## 8. Verificar se esta funcionando

```bash
docker compose ps
```

Voce deve ver `postgres`, `backend` e `frontend` como `healthy` ou `up`.

## 9. Encerrar tudo no final

```bash
docker compose down
```
