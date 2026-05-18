# Bot Studio Lash — Project Guide

## What This Is

Bot de WhatsApp com IA para agendamento de horários em estúdios de lash designer (extensão de cílios). O cliente conversa com o bot, escolhe o serviço, visualiza horários disponíveis e agenda — tudo pelo WhatsApp. A designer gerencia agenda, serviços e disponibilidade por um dashboard web.

## Stack

- Node.js + TypeScript + Express
- OpenAI GPT (padrão JSON oculto no reply para atualizar estado)
- WAHA (WhatsApp HTTP API) como gateway
- SQLite via Knex
- Vitest para testes

## GSD Workflow

Este projeto usa o GSD (Get Shit Done) para planejamento e execução.

**Comandos principais:**
- `/gsd-plan-phase <N>` — Planejar a próxima fase
- `/gsd-execute-phase <N>` — Executar os planos da fase
- `/gsd-progress` — Ver estado atual do projeto
- `/gsd-discuss-phase <N>` — Discutir abordagem antes de planejar

**Planejamento em `.planning/`:**
- `PROJECT.md` — Contexto e requisitos do projeto
- `REQUIREMENTS.md` — Requisitos v1 com IDs (BOT-*, INF-*, REM-*, ADM-*)
- `ROADMAP.md` — 4 fases com critérios de sucesso
- `STATE.md` — Estado atual do projeto
- `codebase/` — Mapa do codebase existente

## Roadmap (4 fases)

1. **Schema & Data Foundation** — Migrar schema para modelo de agendamento
2. **Core Scheduling Bot** — Cliente agenda horário pelo WhatsApp
3. **Lembretes & Cancelamento** — Lembretes automáticos + cancelamento com regra de 6h
4. **Admin Dashboard** — A designer gerencia agenda, serviços e disponibilidade

## Key Conventions

- Padrão de estado: `deriveStep(appointment)` — máquina de estados que mapeia completude do agendamento para strings de step injetadas no system prompt
- JSON oculto no reply da IA: `extractAppointmentUpdate()` extrai bloco ` ```json``` ` antes de enviar texto ao cliente
- Fire-and-forget webhook: `handleWebhook` retorna 200 imediatamente, processamento é async
- Schema multi-maca: tabela `chairs` existe desde o início; v1 opera com uma maca (id=1)

## Next Step

`/gsd-plan-phase 1`
