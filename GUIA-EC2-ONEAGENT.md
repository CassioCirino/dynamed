# Guia Rapido - VM Linux com OneAgent no host

Objetivo: subir esta simulacao em Linux com OneAgent instalado direto na VM (fora do Docker).

## 1. Pre-requisitos na VM

1. Linux com Docker e Docker Compose.
2. OneAgent instalado no host da VM pelo instalador oficial do Dynatrace.
3. Saida HTTPS liberada da VM para o tenant Dynatrace.

## 2. Configurar .env

No arquivo `.env`, ajuste pelo menos:

- `CONTROL_PANEL_PASSWORD`
- `SIMULATION_CONTROL_KEY`
- `DEFAULT_ADMIN_PASSWORD`

Observacao: nao existe mais profile de OneAgent em container neste projeto.

## 3. Subida da stack

```bash
chmod +x scripts/start-ec2-com-oneagent.sh
./scripts/start-ec2-com-oneagent.sh
```

Esse comando sobe:

1. `postgres`
2. `backend`
3. `frontend`
4. `control-panel`

## 4. Validacoes

1. Containers:

```bash
docker compose ps
```

2. Verificar bibliotecas do OneAgent dentro dos processos:

```bash
docker exec hospital-backend sh -lc "cat /proc/1/maps | grep -i oneagent | head"
docker exec hospital-frontend sh -lc "cat /proc/1/maps | grep -i oneagent | head"
```

3. No Dynatrace:

- host da VM visivel
- servicos do backend visiveis
- RUM do frontend visivel apos navegacao/carga de navegador

## 5. URLs da demo

- Frontend principal: `http://IP_DA_VM:5173`
- Painel de controle: `http://IP_DA_VM:5180`
- API: `http://IP_DA_VM:4000`

## 6. Observacoes importantes

1. Para instrumentacao consistente, instale o OneAgent no host e depois reinicie os containers da app.
2. O painel de controle usa `/var/run/docker.sock`; restrinja acesso de rede.
3. Em apresentacao, use painel em aba separada para ligar/desligar cenarios sem terminal.
