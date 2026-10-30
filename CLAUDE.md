# CLAUDE.md — tool_whatsapp_alunos

Contexto para agentes (Claude / Cursor Cloud) que forem trabalhar neste repositório.
_Última atualização: 2026-10-30 (sessão de migração para cloud)._

Repo: `github.com/Mikyxx1234/tool_whatsapp_alunos` · Deploy atual: Easypanel, projeto `banco-disparador-whatsapp`

---

## 1. Objetivo do projeto

Ferramenta de **ativação de alunos via WhatsApp** da Universidade Cruzeiro do Sul (EAD).
Ela sobe bases de alunos (XLSX/CSV) por categoria de risco de evasão: matriculados, docs pendentes,
financeiro, acessos Blackboard, processos CAA, provável evasão e aguardando início.
A partir dessas bases, dispara templates WhatsApp em lote pela **Meta Cloud API**, com:

- cooldown por categoria (6h para CAA, 24h para as demais);
- filtro por ciclo (`2026/1`, `2026/2`);
- rate limit de 60 msgs/s (sliding window);
- seleção individual ou em lote no roster.

Também tem **painéis de operação**: fila CAA com janela de 48h, Funil CAA (estoque de protocolos
`open`), Painel D+1 CAA, Conversão de Ativação, "Meu Painel" por consultor e breakdown por ciclo
em todos os relatórios.

O app roda dentro do **dcz-crm-sync** (Flask) via iframe e herda as permissões de lá
(sub-permissões filtram as abas; a identidade do consultor vem do iframe).

---

## 2. Stack

| Camada | Tecnologia |
|---|---|
| Backend | Node 20 + Express 5 (`server/`) |
| Frontend | React 18 + Vite + TypeScript + Tailwind (`src/`), build em `dist/` servido pelo mesmo processo |
| Banco | Postgres 14+ (31 tabelas + `_migrations`) |
| WhatsApp | Meta Cloud API (Graph v20.0) |
| CRM | **Novo CRM EduIT** (`integrations.bwipo.com`). O DataCrazy **não é mais usado** |
| Automação externa | n8n (webhooks de resposta) |
| Deploy | 1 container Docker multi-stage (Node 20 alpine), porta 3001 |

```bash
npm install
npm run migrate      # aplica migrations pendentes
npm run dev          # Vite (5173) + Node (3001) via concurrently
npm run build && npm run server   # preview de produção
docker build -t whatsapp-tool . && docker run -p 3001:3001 --env-file .env whatsapp-tool
```

---

## 3. Estrutura

```
server/
  index.js                     # boot Express + crons internos
  routes/                      # /api/{templates, send-message, campaigns, webhooks, students,
                               #  journeys, scheduled-events, academic-terms, journey-settings,
                               #  reports, base-uploads, activation, maintenance} + /api/health
  services/
    activationService.js       # disparo em lote (preflight + envio)
    novoCrmClient.js           # cliente HTTP do Novo CRM (rate limit, tags)
    novoCrmPersonCacheSyncService.js / novoCrmMatriculadosProvisionService.js
    datacrazyClient.js         # LEGADO, não usar
  utils/
    crmFonte.js                # escolhe a fonte de CRM por request (datacrazy | novo_crm)
    novoCrmStageRules.js       # resolve IDs de etapa/campo (env → JSON PROD → fallback DEV)
    rateLimiter.js
  db/migrations/               # SQL numerado (001…)
src/
  pages/ components/ services/ # services/*Api.ts conversam com /api/*
data/
  novo-crm-prod-ids.json       # IDs de etapas/campos do CRM de PRODUÇÃO
scripts/                       # novo-crm-discover-prod-ids.mjs, reclassify, cache-full-sync…
AGENTS.md                      # fonte de verdade das decisões técnicas (LER antes de mudar lógica)
INTEGRATION.md                 # plano de merge com dcz-crm-sync
```

---

## 4. Decisões tomadas

### Herdadas do histórico (detalhes em `AGENTS.md`)
- O **cooldown configurável** é o único gate de reenvio. Não há dedup por template.
- **CAA usa estoque acumulado**: todos os `caa_protocols` com `status='open'`, não só os do último snapshot.
- **O consultor vem do CRM** (campo customizado), não de quem clica em "Ativar". As migrations 025/026 corrigiram o falso start da 024.
- O UNIQUE de responses é `(external_id, category, dia)`, para permitir a mesma resposta em categorias diferentes.
- Disparo paralelizado (`ACTIVATION_BATCH_CONCURRENCY`), com blocos automáticos acima de 500 itens.

### Nesta sessão (2026-10-30)
1. **O `.env` é baseado no `.env.example` atual do repo** (365 linhas), e não no do handoff (113 linhas).
   O repo evoluiu além do `HANDOFF.md`: a integração Novo CRM não aparece no handoff.
2. **DataCrazy desativado.** As credenciais foram comentadas e os crons que ligam sozinhos por padrão foram desligados.
3. **Novo CRM ativado** e apontado para PROD (`integrations.bwipo.com`). Os IDs de etapa/campo **não** vão para o `.env`:
   o código detecta o host PROD e lê `data/novo-crm-prod-ids.json` automaticamente.
4. **Escrita em PROD fica desligada por padrão** (`NOVO_CRM_PROVISION_ALLOW_PROD=0`, crons de escrita em 0).
   O motivo é evitar que duas instâncias (Easypanel antigo + cloud) rodem crons ao mesmo tempo, já que não há lock distribuído.

---

## 5. Trechos de código importantes

### Seleção da fonte de CRM — `server/utils/crmFonte.js`
```js
export function normalizeCrmFonte(raw) {
  const v = String(raw || '').trim().toLowerCase().replace(/[-\s]+/g, '_');
  if (v === 'novo_crm' || v === 'novo' || v === 'new_crm') return 'novo_crm';
  return 'datacrazy';                       // ⚠️ default ainda é datacrazy
}

export function isNovoCrmApiConfigured() {
  const enabled = String(process.env.NOVO_CRM_ENABLED || '').trim() === '1';
  const hasToken = Boolean(String(process.env.NOVO_CRM_API_TOKEN || '').trim());
  return enabled && hasToken;
}
```

### Resolução de IDs PROD — `server/utils/novoCrmStageRules.js`
```js
function envId(key, fallback) {
  const v = String(process.env[key] || '').trim();
  if (v === '-' || v === 'skip' || v === '0') return '';   // desliga o ID
  if (v) return v;                                          // 1º: env explícita
  if (isProdCrmHost()) {                                    // 2º: data/novo-crm-prod-ids.json
    const prodVal = prodIdsMap()?.[key];
    return prodVal ? String(prodVal) : '';                  // em PROD nunca cai no fallback DEV
  }
  return fallback;                                          // 3º: IDs DEV hard-coded
}
// Hosts PROD: integrations.bwipo.com, cruzeiro-ead.bwipo.com, *.crm.eduit.com.br
```

### Cliente Novo CRM sem URL default — `server/services/novoCrmClient.js`
```js
function apiBase() {
  const raw = String(process.env.NOVO_CRM_API_BASE_URL || '').trim().replace(/\/$/, '');
  if (!raw) { const err = new Error('NOVO_CRM_API_BASE_URL não configurado.'); err.status = 503; throw err; }
  return raw;
}
// Rate global: NOVO_CRM_API_RATE_PER_SECOND (default 2, teto 6)
```

### Guard de DataCrazy no disparo — `server/services/activationService.js`
```js
// O caminho DataCrazy responde 503 sem a chave. O caminho novo_crm não depende dela.
if (!process.env.DATACRAZY_API_KEY) {
  const err = new Error('DATACRAZY_API_KEY não configurada no .env'); err.status = 503; throw err;
}
```

### Bloco relevante do `.env` (sem segredos)
```dotenv
# DataCrazy desativado
# DATACRAZY_API_KEY=
DATACRAZY_CACHE_ENABLED=0
DATACRAZY_DISPATCH_NOTE_ENABLED=false

# CRM ativo: Novo CRM EduIT
NOVO_CRM_ENABLED=1
NOVO_CRM_API_BASE_URL=https://integrations.bwipo.com
NOVO_CRM_API_TOKEN=            # PENDENTE
NOVO_CRM_DATABASE_URL=         # PENDENTE
NOVO_CRM_CACHE_ENABLED=1
NOVO_CRM_CACHE_SOURCE=api
NOVO_CRM_CACHE_FETCH_DEAL_FIELDS=0
NOVO_CRM_CACHE_FULL_HOUR_UTC=5          # 02:00 BRT
NOVO_CRM_API_RATE_PER_SECOND=2
NOVO_CRM_PROVISION_ALLOW_PROD=0         # escrita em PROD desligada
NOVO_CRM_PROVISION_ENABLED=0
NOVO_CRM_FIELDS_SYNC_ENABLED=0          # receita PROD = 1 (após cutover)
NOVO_CRM_FLAGS_SYNC_ENABLED=0           # manter 0 em PROD (botão manual)

# Já preenchidos: PORT, NODE_ENV, DATABASE_URL, DATABASE_SSL, WHATSAPP_*,
# TEMPLATES_PROVIDER/MESSAGES_PROVIDER=whatsapp, WEBHOOK_*, SCHEDULER_*, EMAIL_PROVIDER=mock
```

---

## 6. O que já foi feito (nesta sessão)

- [x] Lido o `project-cloud-handoff.zip` (`HANDOFF.md`, `TIMELINE.md`, `README.md`, `.env`, `.env.example`).
- [x] Clonado o repositório (último commit `cac1985`, "Criacao de leads ignora RGM que ja esta em outro negocio").
- [x] `.env` montado a partir do `.env.example` do repo, com os valores reais do zip; confirmado que o Node carrega todas as variáveis.
- [x] DataCrazy desativado no `.env`; Novo CRM ativado com receita de cache PROD e escrita bloqueada.
- [x] Confirmado que os IDs PROD resolvem via JSON (ex.: Acolhimento → `cmrwmcq0m0nuzpa01htp153zg`).
- [x] Confirmado que o `.env` está no `.gitignore`.

## 7. O que falta

**Bloqueante**
- [ ] Preencher `NOVO_CRM_API_TOKEN` (`eduit_...` PROD) e `NOVO_CRM_DATABASE_URL`.
- [ ] Trocar o default `crm_fonte: 'datacrazy'` para `novo_crm` no frontend: `src/services/painelApi.ts:263`.
      Revisar também `normalizeCrmFonte` (default `datacrazy`) e as chamadas em `activationApi.ts` / `meuPainelApi.ts`.
- [ ] `npm install` + `npm run migrate` + subir o app no ambiente cloud. Nada disso foi testado: o sandbox desta sessão não alcança o banco nem as APIs.

**Decisão de cutover**
- [ ] Definir se a instância cloud substitui o Easypanel ou se as duas rodam juntas por um tempo.
      Quando a cloud for a oficial: `NOVO_CRM_PROVISION_ALLOW_PROD=1` e `NOVO_CRM_FIELDS_SYNC_ENABLED=1`, e desligar os crons da instância antiga.

**Verificações**
- [ ] Validar se o `WHATSAPP_API_KEY` (vindo de um `.env` de 28/05) ainda é válido. Precisa ser token permanente de System User.
- [ ] Rotacionar os tokens depois da migração, já que eles circularam dentro de um zip.
- [ ] Revisar o fluxo n8n. O handshake via `origem_ativacao` e o envio de `consultor_responsavel_nome` foram desenhados para o DataCrazy e provavelmente precisam ser adaptados ao Novo CRM.
- [ ] Os pendentes do handoff ligados ao DataCrazy (`DATACRAZY_CONSULTOR_RESPONSAVEL_FIELD_ID`, `DATACRAZY_DESFECHO_CAA_FIELD_ID`) ficam **obsoletos**. Confirmar o equivalente no Novo CRM (o "Meu Painel" usa `conversation_close_tabulations`, pergunta "Retido?").

**Débitos técnicos**
- [ ] Chunk do frontend > 500KB (code-split opcional).
- [ ] Lock distribuído nos crons, se escalar para mais de 1 réplica.

---

## 8. Regras para agentes

- Leia `AGENTS.md` antes de mudar qualquer regra de negócio. Ele explica o **porquê** das decisões.
- Nunca comite `.env` e nunca coloque tokens em código, docs ou logs.
- Não ative escrita em PROD (`ALLOW_PROD`, `*_SYNC_ENABLED`, `PROVISION_ENABLED`) sem confirmação explícita.
- Código novo de CRM vai para o Novo CRM. `datacrazyClient.js` e afins são legado.
- Dados de teste: RGM `47277581`.
