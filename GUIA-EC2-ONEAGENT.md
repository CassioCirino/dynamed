# Guia Rapido - EC2 com OneAgent

Objetivo: subir esta simulacao em EC2 Linux ja instrumentada com Dynatrace OneAgent.

## 1. Pre-requisitos na EC2

1. Linux com Docker e Docker Compose.
2. Porta de saida liberada para o tenant Dynatrace.
3. `ONEAGENT_INSTALLER_SCRIPT_URL` e `ONEAGENT_INSTALLER_DOWNLOAD_TOKEN` gerados no Dynatrace.

## 2. Configurar .env

No arquivo `.env`, preencha:

```env
ONEAGENT_INSTALLER_SCRIPT_URL=<URL_DO_INSTALLER_NO_DYNATRACE>
ONEAGENT_INSTALLER_DOWNLOAD_TOKEN=<TOKEN_DE_DOWNLOAD>
ONEAGENT_INSTALLER_SKIP_CERT_CHECK=false
ONEAGENT_CONTAINER_READ_ONLY=true
ONEAGENT_HOST_ROOT_MOUNT_MODE=ro
ONEAGENT_ENABLE_VOLUME_STORAGE=true
```

Opcional (seguranca):

- troque `CONTROL_PANEL_PASSWORD`
- troque `SIMULATION_CONTROL_KEY`
- restrinja Security Group para acessar somente de IPs autorizados

## 3. Subida com OneAgent

```bash
chmod +x scripts/start-ec2-com-oneagent.sh
./scripts/start-ec2-com-oneagent.sh
```

Esse comando sobe:

1. app (frontend/backend/postgres/control-panel)
2. container `dynatrace-oneagent` com perfil `dynatrace`

## 4. Validacoes

1. Containers:

```bash
docker compose ps
```

2. Logs do agente:

```bash
docker compose logs --tail=100 dynatrace-oneagent
```

3. No Dynatrace:
- host da EC2 visivel
- containers `hospital-*` visiveis
- servicos do backend aparecendo em Distributed Traces e Services

## 5. URLs da demo

- Frontend principal: `http://IP_DA_EC2:5173`
- Painel de cenarios: `http://IP_DA_EC2:5180`
- API: `http://IP_DA_EC2:4000`

## 6. Observacoes importantes

1. Este perfil do OneAgent foi preparado para host Linux.
2. O painel de cenarios usa `/var/run/docker.sock`, portanto mantenha acesso de rede restrito.
3. Para apresentacao, mantenha o painel em aba separada para ligar/desligar cenarios sem terminal.
