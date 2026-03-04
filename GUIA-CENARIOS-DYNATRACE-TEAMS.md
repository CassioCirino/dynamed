# Guia de Cenarios Dynatrace + Teams

Objetivo: demonstrar 3 tipos de problema e enviar acionamento diferente no Teams.

## Onde controlar durante a demo

1. Principal (recomendado):
- `http://localhost:5180`
- Login: `admin` / `dyantrace`
- Aciona: carga de usuarios, DEV front/API, DB e INFRA CPU (liga/desliga)

2. Alternativo dentro da aplicacao:
- `http://localhost:5173/administracao/simulacoes`
- Login: `admin@hospital.local` / `dyantrace`
- Observacao: rota redirecionada. O controle operacional deve ser feito no painel `:5180`.

## 0. Operacao sem terminal (recomendado para apresentacao)

Agora existe um painel separado do app principal:

- `http://localhost:5180`

Login padrao do painel:

- Usuario: `admin`
- Senha: `dyantrace`

Com esse painel voce consegue ligar/desligar cenarios sem digitar comando, e ele continua ativo mesmo se frontend/backend/postgres do app principal forem derrubados na simulacao.
Tambem existe botao para encerrar CPU imediatamente.

## 1. Cenarios que vamos cobrir

1. DEV (indisponibilidade)
- Frontend fora do ar
- API (backend) fora do ar

2. Banco de dados
- PostgreSQL indisponivel

3. Infra
- Pressao de CPU

## 2. Script pronto para disparo rapido

Arquivo:
- `scripts/cenarios-dynatrace.sh`

Permissao de execucao (Linux):

```bash
chmod +x scripts/cenarios-dynatrace.sh
```

Comandos:

```bash
# estado dos containers
./scripts/cenarios-dynatrace.sh status

# DEV: derruba backend por 2 min
./scripts/cenarios-dynatrace.sh dev-api-off 120

# DEV: derruba frontend por 2 min
./scripts/cenarios-dynatrace.sh dev-front-off 120

# DB: derruba postgres por 2 min
./scripts/cenarios-dynatrace.sh db-off 120

# INFRA: queima de CPU por 3 min
./scripts/cenarios-dynatrace.sh infra-cpu 180 0.95 4
```

## 3. Configuracao no Dynatrace (para separar acionamentos)

1. Defina tags nas entidades monitoradas:
- `canal:dev` para frontend e backend
- `canal:db` para postgres
- `canal:infra` para host EC2 e processos de infraestrutura

2. Configure deteccao de problemas:
- DEV backend: evento de indisponibilidade de processo/servico
- DEV frontend: monitor sintetico HTTP para `http://SEU_HOST:5173`
- DB: indisponibilidade de processo do postgres e erros de conexao
- INFRA: anomalia/threshold de CPU no host

3. Opcional:
- crie Management Zones para visao por time
- crie Alerting Profiles apenas se quiser separar notificacoes classicas

## 4. Acionamento diferente no Teams

Use Workflows no Dynatrace (um por cenario) com **Davis problem trigger** filtrando por tag:

1. `WF-DEV-Teams`
- Trigger: problema novo com tag `canal:dev`
- Acao: mensagem no canal Teams de DEV

2. `WF-DB-Teams`
- Trigger: problema novo com tag `canal:db`
- Acao: mensagem no canal Teams de DBA

3. `WF-INFRA-Teams`
- Trigger: problema novo com tag `canal:infra`
- Acao: mensagem no canal Teams de Infra/NOC

## 5. Roteiro de demonstracao (15 minutos)

1. Abrir dashboards e canal Teams lado a lado.
2. Executar `dev-front-off 120` e mostrar alerta DEV.
3. Executar `db-off 120` e mostrar alerta DB.
4. Executar `infra-cpu 180 0.95 4` e mostrar alerta INFRA.
5. Mostrar recuperacao automatica apos termino dos cenarios.

## 6. Observacoes importantes

1. O cenario de CPU usa:
- login admin padrao
- chave `SIMULATION_CONTROL_KEY` do `.env`

2. Se o frontend nao gerar problema de disponibilidade sozinho:
- configure monitor sintetico HTTP para `http://SEU_HOST:5173`
- associe o monitor ao fluxo DEV.
