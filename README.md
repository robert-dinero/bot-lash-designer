# Bot Studio Lash — Agendamento via WhatsApp

Bot de WhatsApp com IA para agendamento de horários em estúdios de lash designer (extensão de cílios). O cliente conversa naturalmente em português e agenda, cancela ou remarca — tudo pelo WhatsApp, em menos de 2 minutos.

**Stack:** Node.js 20+ · TypeScript · Express · OpenAI gpt-4o-mini · SQLite · [WAHA](https://waha.devlike.pro/) · Nginx · PM2

---

## Funcionalidades

- Agendamento pelo WhatsApp com seleção de serviço, dia e hora
- Cancelamento e remarcação com regra de 6h de antecedência
- Lembretes automáticos: 24h (com confirmação), 12h e 2h antes do horário
- Dashboard admin: a designer visualiza agenda, bloqueia horários e gerencia serviços
- Escalação para o dono quando cliente tenta cancelar/remarcar dentro de 6h

---

## Pré-requisitos

- Node.js 20+
- Docker + Docker Compose
- Conta OpenAI com créditos
- (Produção) Ubuntu 22.04/24.04 · Nginx · PM2 · Certbot

---

## Setup local (desenvolvimento)

### 1. Instalar dependências

```bash
npm install
```

### 2. Configurar variáveis de ambiente

```bash
cp .env.example .env
```

Edite `.env` com seus valores:

```env
PORT=3003

OPENAI_API_KEY=sk-...

WAHA_BASE_URL=http://localhost:3011
WAHA_WEBHOOK_URL=http://host.docker.internal:3003/webhook/waha
WAHA_API_KEY=sua-chave-waha
WAHA_DASHBOARD_USERNAME=admin
WAHA_DASHBOARD_PASSWORD=sua-senha-dashboard

DB_PATH=./data/bot.sqlite

WEBHOOK_API_KEY=sua-chave-webhook
OWNER_PHONE=5521999999999

ADMIN_SECRET=sua-senha-forte

LOG_LEVEL=info
```

Para conferir se o `.env` esta preenchido sem expor segredos:

```bash
npm run check:env
```

Arquivos de ambiente:

| Arquivo | Uso |
|---------|-----|
| `.env` | Local: usado pelo bot e pelo `docker compose` no seu PC |
| `.env.production` | Referencia para o servidor; nao e carregado automaticamente pelo bot local |
| `.env.example` | Modelo sem segredos reais |

Para checar o arquivo de producao localmente:

```bash
npm run check:env:prod
```

### 3. Subir o WAHA

```bash
docker compose up -d
```

Acesse `http://localhost:3011`, vá em **Sessions → default → Start** e escaneie o QR code com o WhatsApp do estúdio.

### 4. Configurar o webhook no WAHA

O `docker-compose.yml` ja usa `WAHA_WEBHOOK_URL`. No ambiente local, mantenha:

```env
PORT=3003
WAHA_WEBHOOK_URL=http://host.docker.internal:3003/webhook/waha
```

Se precisar reconfigurar manualmente a sessao no WAHA:

```bash
curl -X PUT http://localhost:3011/api/sessions/default \
  -H "X-Api-Key: sua-chave-waha" \
  -H "Content-Type: application/json" \
  -d '{"config":{"webhooks":[{"url":"http://host.docker.internal:3003/webhook/waha","events":["message"]}]}}'
```

### 5. Iniciar o bot

```bash
# Desenvolvimento (hot reload)
npm run dev

# Produção
npm run build && npm start
```

---

## Deploy em produção (Azure VM / Ubuntu)

> **Coexistência com o bot-barbeiro:** este bot roda na mesma VM, mas isolado —
> pasta `~/bot-lash-designer`, processo PM2 `bot-lash-designer`, Express na porta
> **3003**, WAHA na **3011** e nginx na **8444**. Não conflita com o bot-barbeiro
> (3002 / 3001 / 8443). Use `deploy.ps1` da sua máquina — ele já aponta para os
> identificadores corretos.

### Primeira vez — setup da VM

```bash
sudo bash scripts/setup-vm.sh seu-dominio.com nome-usuario
```

O script configura automaticamente:
- ufw (firewall) — porta 22, 80, 443 abertas; 3003 e 3011 apenas internos
- SSH hardening — sem senha, apenas chave, máximo 3 tentativas
- fail2ban — proteção contra brute-force
- Docker
- Node.js 20 + PM2
- Nginx com TLS (Let's Encrypt / Certbot)
- Headers de segurança (HSTS, CSP, X-Frame-Options, etc.)

### Deploy do código

```bash
# Na sua máquina — commita e envia para o GitHub
git add .
git commit -m "descrição da mudança"
git push

# No servidor — aplica a mudança
cd ~/bot-lash-designer && git pull && npm run build && pm2 restart bot-lash-designer --update-env
```

### Configurar o webhook no WAHA (produção)

No servidor, deixe o `.env` de producao coerente com a porta do PM2:

```env
PORT=3003
WAHA_BASE_URL=http://localhost:3011
WAHA_WEBHOOK_URL=http://host.docker.internal:3003/webhook/waha
```

O `docker-compose.yml` inclui `host.docker.internal:host-gateway`, entao esse nome tambem funciona no Linux. Depois de alterar `.env`, recrie o container do WAHA para ele reler a variavel:

```bash
docker compose down
docker compose up -d
```

Se precisar reconfigurar manualmente a sessao no WAHA, rode uma vez após o deploy inicial:

```bash
curl -X PUT http://localhost:3011/api/sessions/default \
  -H "X-Api-Key: $WAHA_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"config\":{\"webhooks\":[{\"url\":\"$WAHA_WEBHOOK_URL\",\"events\":[\"message\"]}]}}"
```

### Backup automático

Configure o cron para backup diário às 3h:

```bash
(crontab -l 2>/dev/null; echo "0 3 * * * bash ~/bot-lash-designer/scripts/backup.sh") | crontab -
```

Mantém os últimos 7 dias em `~/bot-lash-designer/backups/`.

---

## Segurança

| Camada | Mecanismo |
|--------|-----------|
| Firewall | ufw — apenas portas 22, 80, 443 abertas |
| SSH | Chave Ed25519, sem senha, máx 3 tentativas |
| Brute-force | fail2ban (SSH + Nginx) |
| TLS | Let's Encrypt via Certbot, renovação automática |
| Headers HTTP | helmet.js + headers Nginx (HSTS, CSP, X-Frame, etc.) |
| Rate limiting | express-rate-limit (60 req/min webhook, 120 req/min admin) + Nginx |
| Webhook origin | Aceita apenas IPs locais/Docker — bloqueado para internet |
| Secrets | Variáveis de ambiente, nunca no código |

---

## Testar localmente com curl

> Cada mensagem precisa de um `payload.id` único — o bot descarta IDs repetidos (deduplicação).

```bash
# Primeira mensagem
curl -s -X POST http://localhost:3003/webhook/waha \
  -H "Content-Type: application/json" \
  -d '{"event":"message","payload":{"id":"msg-001","from":"5521999999999@c.us","fromMe":false,"body":"oi","type":"chat"}}'

# Escolher serviço
curl -s -X POST http://localhost:3003/webhook/waha \
  -H "Content-Type: application/json" \
  -d '{"event":"message","payload":{"id":"msg-002","from":"5521999999999@c.us","fromMe":false,"body":"volume russo","type":"chat"}}'
```

---

## Fluxo de conversa

```
Cliente: oi
Bot:     Olá! Bem-vinda ao Studio Lash! 😊
         Como posso ajudar? Quer agendar um horário?

Cliente: quero agendar volume russo
Bot:     Claro! Temos estes serviços disponíveis:
         👁️ Volume Brasileiro — R$ 180,00
         👁️ Volume Russo — R$ 220,00
         👁️ Lifting de Cílios — R$ 120,00
         👁️ Manutenção — R$ 110,00
         👁️ Remoção — R$ 40,00

Cliente: volume russo
Bot:     Ótimo! Para qual dia você prefere?

Cliente: amanhã de tarde
Bot:     Horários disponíveis para amanhã (sáb 17/05):
         • 14:00
         • --:--
         • 16:30

Cliente: 14h
Bot:     📅 Volume Russo — sábado, 17/05 às 14:00
         ⏰ Lembrete 24h antes.
         Para cancelar, envie CANCELAR com pelo menos 6h de antecedência.
         Qual é o seu nome?

Cliente: Maria
Bot:     ✅ Agendado, Maria! Até sábado às 14h.
```

### Exibição de horários ocupados

Quando o bot lista horários no WhatsApp, ele mantém a grade do expediente em linhas separadas. Horários livres aparecem normalmente, por exemplo `14:30`; horários ocupados ou bloqueados aparecem como `--:--`.

Esse comportamento é apenas visual. A validação de disponibilidade continua sendo feita pelo backend antes de confirmar qualquer horário, então o cliente só consegue agendar um slot que realmente esteja livre.

Exemplo:

```text
• 09:00
• --:--
• 10:00
• 10:30
```

---

## Palavras-chave especiais

| Cliente digita | Ação |
|----------------|------|
| `cancelar` / `CANCELAR` | Cancela o agendamento (se faltar mais de 6h) |
| `remarcar` / `REMARCAR` | Inicia fluxo de remarcação |
| `atendente` / `humano` | Escalação para o dono no WhatsApp |

---

## Dashboard admin

Acesse `https://seu-dominio.com/admin` para gerenciar a agenda.

Autenticação via variáveis de ambiente:
```env
ADMIN_SECRET=sua-senha-forte
```

Funcionalidades do dashboard:
- Visualizar agendamentos do dia e da semana
- Bloquear horários (folga, almoço, etc.)
- Configurar horário de funcionamento por dia da semana
- Cadastrar e editar serviços (nome, duração, preço)
- Cancelar agendamentos (cliente recebe notificação no WhatsApp)

---

## Estrutura do projeto

```
src/
  config/
    env.ts                    # variáveis de ambiente validadas com Zod
    business.ts               # carrega nome do negócio e config
  controllers/
    webhook.controller.ts     # ponto de entrada de cada mensagem WhatsApp
    admin.controller.ts       # API do dashboard admin
    appointment.controller.ts # endpoints de agendamento
  db/
    index.ts                  # Knex + SQLite, initSchema()
  jobs/
    reminder-scheduler.ts     # cron de lembretes (Croner)
  lib/
    dedup.ts                  # deduplicação atômica por payload.id
  routes/
    webhook.ts                # rota /webhook/waha com origin check
    admin.ts                  # rotas /admin
  services/
    ai.service.ts             # prompt builder, OpenAI, extractAppointmentUpdate
    appointment.service.ts    # slots disponíveis, agendamento, remarcação
    cancellation.service.ts   # cancelamento com regra de 6h e escalação
    reminder.service.ts       # envio de lembretes via WAHA
    session.service.ts        # CRUD de sessão e histórico de conversa
    waha.service.ts           # sendText, notifyOwner
  types/
    index.ts                  # AppointmentState, Session, BusinessConfig
  utils/
    logger.ts                 # logger estruturado (masked, step, msg) com LOG_LEVEL
  server.ts
public/
  admin/                      # dashboard estático
scripts/
  setup-vm.sh                 # setup inicial da VM (roda uma vez como root)
  deploy.sh                   # build + PM2 reload
  backup.sh                   # backup diário SQLite (cron)
docker-compose.yml            # WAHA
.env.example                  # template de variáveis de ambiente
```

---

## Variáveis de ambiente

| Variável | Obrigatório | Padrão | Descrição |
|----------|:-----------:|--------|-----------|
| `PORT` | não | `3003` | Porta do servidor Express |
| `OPENAI_API_KEY` | **sim** | — | Chave da API OpenAI |
| `WAHA_BASE_URL` | **sim** | — | URL do WAHA |
| `WAHA_WEBHOOK_URL` | não | `http://host.docker.internal:3003/webhook/waha` | URL que o WAHA chama para entregar mensagens ao bot |
| `WAHA_API_KEY` | **sim** | — | API key do WAHA |
| `WAHA_DASHBOARD_USERNAME` | não | — | Usuário do dashboard WAHA |
| `WAHA_DASHBOARD_PASSWORD` | não | — | Senha do dashboard WAHA |
| `DB_PATH` | não | `./data/bot.sqlite` | Caminho do banco SQLite |
| `WEBHOOK_API_KEY` | não | — | Chave para validar requests ao webhook |
| `OWNER_PHONE` | não | — | Número do dono para escalações |
| `ADMIN_SECRET` | não | — | Senha do dashboard admin |
| `LOG_LEVEL` | não | `info` | Nível de log: debug / info / warn / error |
