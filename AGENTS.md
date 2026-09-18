# AGENTS.md — convenções e decisões técnicas

Este arquivo é a fonte de verdade para decisões estruturais do projeto.
Subagentes devem consultar antes de questionar/refazer escolhas já avaliadas.

## Decisões técnicas

### 2026-09-18 — Criação diária também cobre 2º RGM (buraco do Gustavo)
- **Modelo usado:** Grok.
- **Caso:** RGM `49825089` Gustavo Nascimento Barbosa — EM CURSO Ciência de Dados, Relação do dia. Já tinha deal do RGM antigo `48317667` (Contábeis CANCELADO). `mode=new` agrupava por CPF e `cacheCoverageKind` pulava a pessoa inteira se o CPF já estava no espelho. Dedupe de órfãos também não pega (órfão = contact sem deal).
- **Medido (17/09):** Relação × espelho — **826** RGMs EM CURSO sem deal cujo CPF já tem card (738 pessoas). +326 EM CURSO com CPF novo (o botão antigo já pegaria).
- **Decisão:** Att de etapas **não cria** card (não muda). O buraco fecha no botão **«3. Criação de leads novos»**:
  1. Seleção passa a ser **RGM faltante**, não «pessoa ausente». CPF/e-mail/telefone no cache **não** escondem um RGM novo.
  2. Pessoa nova → contact + deal (igual).
  3. Pessoa já no CRM → cria **só** o deal do RGM que falta **no contact existente** (`cpfToContactId` do espelho; senão `findExistingContact`). Não cria 2º contact.
  4. Live `listDeals` no contact: deal **sem RGM** (captura WhatsApp) → **preenche** CPF/RGM/SIAA no card que já existe e move etapa se não for intocável. Só cria deal extra se ainda sobrar RGM depois de preencher **e** `dealCount < N RGMs SIAA`. `dealCount >= N` → não clona (anti-spam Naionara/Everton).
  5. Match só por e-mail/telefone exige `namesPlausiblyMatch`.
  6. **Overlay do espelho antes de preencher.** `GET /deals` / lista por contact muitas vezes volta sem `dealPanelFields` (array vazio conta como «tem panel»). Prévia PROD 18/09: **1.404 preencher + 127 extra** — a conta 149+1404=1553 fecha, mas o live via RGM vazio em card que o cache já tinha (ex. Gustavo `48317667`). Aplicar pisaria o RGM antigo. Fill só se live **e** cache dizem vazio; se o cache tem RGM e o GET não mapeou o deal, cria extra em vez de preencher.
- **Contadores:** `filled_existing_deals`, `created_extra_deals`, `skipped_live_rgm_covered`, `skipped_cpf_capacity`, `skipped_name_mismatch`. Cap 1500 conta pessoas provisionadas (novo + fill + extra).
- **Ops:** **não Aplicar** a prévia 1.404/127. Merge `raphael` + rebuild. Nova prévia: fill deve cair (~card WhatsApp sem identidade); extra sobe (~2º RGM, incl. Gustavo). Apply só depois. Cron provision continua OFF.
- **Não mudou:** Att/fields não cria; 1 deal por RGM; rate 2; intocáveis.

### 2026-09-10 — Base «Inadimplente Pós SIAA» alimenta o campo Financeira
- **Modelo usado:** Opus.
- **Pedido:** upload de base nova (inadimplentes da Pós) e, quem aparecer nela, campo **Financeira** = Sim.
- **Campo:** «Financeira» = `situacaofinanceira` = `cmrwtc7xp00fnpf015srkz771` = `NOVO_CRM_FIELD_INADIMPLENTE` = `fieldIds.inadimplente`. **Não** confundir com «Dia 10» (`dia`, `NOVO_CRM_FIELD_FINANCEIRO`), que continua vindo só da base `financeiro`.
- **Base:** `inadimplentes-pos-siaa` (migration `044`). Export SIAA «Relação de Alunos Inadimplentes por Polo», arquivo único com todos os polos concatenados (13 no exemplo de 10/09).
- **Import (`server/utils/inadPosSiaaImport.js`):** a 1ª linha é o **título** do relatório, então o parser genérico usa o título como header e o header real (`ID_POLO`, `NOME_POL`, `RGM_ALUN`, `NOME`, `NOM_FILI`, `DTA_VCTO`, `ATRASO`) cai como dado. `promoteInadPosSiaaHeader` promove esse header e **descarta as linhas de virada de polo** (título+header repetidos). Regra do descarte = linha **sem RGM** (o título repetido carrega o código do polo, então não dá pra detectar por `ID_POLO`). Metadata: `inad_pos_siaa_header_promoted` / `..._separator_rows_dropped`. O export só traz **RGM** — CPF/e-mail/telefone vêm do enrich pela Relação.
- **Escopo das linhas:** o relatório lista **qualquer título em aberto** (MENSALIDADE, ACORDO \*, CONF.DIVIDA, MATRÍCULA) e mistura filiais (PÓS-EAD, Cursos Livres, Graduação UNICID/Cruzeiro). Só **MENSALIDADE** conta como inadimplência (quem negociou a dívida fica fora). Filtro em `baseRowFilterForCategory(category)` aplicado nos loaders de índice — o snapshot fica **fiel ao arquivo** (não perde quem está em acordo).
- **Regra na Att:** `inad = mergeIdentityIndexes(inadGrad, inadPos)`. União nas **duas pontas**: só entrada faria o passo de saída limpar para «Não» todo aluno da Pós (ausente do relatório da Graduação) e vice-versa. `nRows` soma, então o guard de sanidade 70% continua proporcional. Mesma união no provision `mode=new` e nos órfãos.
- **Cuidado:** `loadIdSetFromBase` dos provisionamentos lia só `RGM`/`rgm`/`Rgm` — passou a ler `RGM_ALUN` (o `pickIdentityFromRow` da Att já lia).
- **Blindagem (a falha aqui é destrutiva — limpar flag de ~600 em massa):**
 1. `mergeIdentityIndexes` marca a fusão como quebrada se uma base **tem snapshot mas 0 identidades** (`cpf.size === 0 && rgm.size === 0` — testar `nRows` **não** serve, ele conta linha e sobrevive quando a coluna de identidade some). Nesse caso zera `nRows` → o guard 70% pula a saída da flag inteira e o `console.warn` nomeia a base. Prova empírica: snapshot Pós sem coluna de RGM → `exit_skipped_sanity: {"inadimplente":4}`, nada limpo.
 2. `isInadPosSiaaMensalidadeRow` é **fail-open**: sem coluna de tipo de título reconhecida (`DESCRICA`/`DESCRICA_2`/`DES_TITU`, em qualquer ordem) a linha **conta**. Fail-closed faria o índice vir vazio em silêncio e a Att limparia a Pós inteira.
 3. Descarte de separador roda mesmo sem promoção de cabeçalho (variante já parseada certa continua repetindo título/cabeçalho por polo), e só quando existe coluna `RGM_ALUN` — arquivo de outra base passa intacto.
- **Uma base não zera a outra:** `getLatestSnapshot` é `order by created_at desc limit 1`, sem filtro de data — base não atualizada ≠ base vazia. Subir só a Graduação não encosta nas tabelas da Pós. Contrapartida: a flag é tão fresca quanto o último upload de cada base.
- **Medido (10/09):** 684 linhas · 681 alunos · 670 na Relação · 636 com deal (109 Financeira vazia, 520 «Não», 9 já «Sim»). Dry-run `flags_stage`: **721** flags (741 sem o filtro de MENSALIDADE), `exit_skipped_sanity` vazio, 0 erros.
- **Ops:** migration `044` já aplicada. Merge `raphael` + rebuild antes de clicar Att — sem o deploy o snapshot fica parado (o cron `mode=fields` das 05:00 **não** escreve flags).
- **Não mudou:** «Dia 10»; cron FLAGS/provision off; rate 2.

### 2026-09-01 — Fields da madrugada não pisa o card Att
- **Modelo usado:** Grok.
- **Fato:** cron `mode=fields` (~05:00) usa o mesmo job que o botão Att. Gravava em `flags_stage_last` → o card «Att de etapas» mostrava a madrugada (ex. 01/09 07:27, 0 flags · 320 etapas · fila 25k = campos SIAA) como se fosse Att, e a barra dizia «Att rodando».
- **Código:** `mode=fields` persiste em `fields_last` / `last_fields_sync`. Residual antigo com `mode=fields` no `flags_stage_last` some do card Att. UI: Att só mostra última `flags_stage`; bloco «De noite» mostra última Att campos. Job fields na barra = «Att campos (madrugada)».
- **Não mudou:** cron FLAGS off; fields ainda move etapa (remat/turma); mutex único (não roda Att e fields juntos).

### 2026-08-31 — API PROD: integrations.bwipo.com (token só nesse host)
- **Modelo usado:** Grok.
- **Fato:** token novo `eduit_…` autentica em `https://integrations.bwipo.com`. O host antigo `cruzeiro-ead.bwipo.com` responde 401: tokens de API só são aceitos no domínio de integrações. Mesma org (`cmrmbn2lh0uz2nm016beqgbwb`); `/api/tags` 232 · deals 42.797 · contacts 43.282 · IDs de etapa/campo iguais (CPF/CAA/Situação/Marco ok).
- **Ops Easypanel:** `NOVO_CRM_API_BASE_URL=https://integrations.bwipo.com` (sem path `/pipeline`) e o token novo em `NOVO_CRM_API_TOKEN`. Manter `NOVO_CRM_PROVISION_ALLOW_PROD=1`. `NOVO_CRM_DATABASE_URL` só muda se o banco também migrou. Sem rebuild + env, Att/Full/Sync no host velho quebram com 401.
- **Código:** `isProdCrmHost()` aceita `integrations.bwipo.com` (e os hosts antigos) para carregar `data/novo-crm-prod-ids.json`. Token não vai pro repo.
- **Não mudou:** IDs de etapa/campo; cron FLAGS/provision off; rate 2.

### 2026-08-31 — Fora da Relação → Perdido (A/B/D); Acolhimento por turma (C)
- **Modelo usado:** Grok.
- **Pedido:** residual no funil (Juliana/Eliana/Anas + cards sem identidade). Relação do dia = ainda é aluno. Fixa só prova histórico; **não** é gate — A e B ambos vão a Perdido.
- **Regra na Att/fields** (após tentar RGM/CPF/e-mail/telefone único na Relação):
  - **A/B:** tem CPF ou RGM, etapa mexível, fora da Relação → **Perdido**.
  - **C:** quem **está** na Relação segue `classifyMatriculado` (Acolhimento por turma 2026/2: ago→25/08, set→25/09, out→25/10, nov→25/11).
  - **D:** sem CPF/RGM → busca celular (e e-mail) na Relação; achou = aluno (classifica); não achou → **Perdido** (igual Lead de Entrada).
  - No relatório remat e fora da Relação → **Sem Rematrícula** (não Perdido).
  - Intocáveis / já em Retenção / tag `limpeza_duplicata_*` / já Perdido = não mexe.
  - CAA open ≤72h fora da Relação → **Retenção**, não Perdido.
  - Data Matrícula no card nos últimos **5 dias** e fora da Relação → **não** Perdido (Relação pode atrasar).
  - Limpeza Perdido **só no Att** (`flags_stage`/`both`). Cron `mode=fields` 05:00 **não** faz essa limpeza.
- **Sanity:** Relação `< 10k` linhas ou `< 70%` do snapshot anterior → não limpa (`exit_skipped_sanity.fora_relacao`).
- **Ops:** não rebuild enquanto Att atual escreve. Depois do `ok`: merge + rebuild; próxima Att aplica. Contadores `stages_fora_relacao` / `stages_sem_identidade` / `stages_remat_sem_relacao`.
- **Não mudou:** cron FLAGS off; Fixa continua só datas; CAA 72h / Cancel-Tranc.

### 2026-08-31 — Acolhimento por turma (1ª mensalidade), não cutoff único do ciclo
- **Modelo usado:** Grok.
- **Fato:** `2026/2` → `2026-08-25` tirava **todo mundo** de Acolhimento no dia 25. A janela não acaba: cada turma de ingresso tem o próprio 1º vencimento. Duas turmas podem coexistir na coluna até a data da 1ª mensalidade de cada uma.
- **Turmas 2026/2 (Data Matrícula → fica até):**
  - Agosto: 13/05–16/08 → **25/08**
  - Setembro: 17/08–13/09 → **25/09**
  - Outubro: 14/09–11/10 → **25/10**
  - Novembro: 12/10–17/11 → **25/11**
- **2027/1:** ingresso a partir de **18/11/2026** — sem turma/cutoff ainda; **não** entra em Acolhimento 2026/2.
- **Código:** `ACOLHIMENTO_TURMAS` + `resolveAcolhimentoWindow` casa a Data Matrícula na faixa; hoje BRT ≤ `acolhimentoAte`. Cai o fallback “dia 25 do mês da matrícula” e o cutoff único por ciclo. Prioridade de etapa não muda (Cancel/Tranc → CAA 72h → remat → acolhimento → Pós/Grad). Acolhimento continua **não** intocável: passou o vencimento da turma, Att move.
- **Ops:** merge `raphael` + rebuild **depois** da Att atual. Sem isso a Att de 31/08 trata setembro como fora da janela.
- **Não mudou:** intocáveis Ganho/Cancelado/Em Atendimento; remat vence acolhimento.

### 2026-08-31 — Att inútil: writeback no espelho após PUT
- **Modelo usado:** Grok.
- **Fato:** Att `flags_stage` 31/08 ~11:18 BRT fila **11.846** (~2 h a 2 rps). Sábado já tinha gravado ~10k flags no CRM. O espelho não atualiza no PUT; Full FETCH=0 não relê customFields → cache ainda vazio → `vazio→Sim` de novo. PUT inútil, CRM já estava certo.
- **Código:** após `updateDealCustomFields` ok, `applyDealCustomFieldWrites` grava os mesmos pares em `raw_data.dealsById[dealId].customFields` (e CPF/RGM se for o caso). Sem GET extra. `content_hash` intacto (FETCH=0 skip continua). Fila leva `contactId`. Falha de writeback só loga.
- **Ops:** **não rebuild** enquanto a Att atual escreve. Esta run não pega o fix. Depois do `ok`: merge `raphael` + rebuild. A **próxima** Att ainda pode ser ~11k (cache desta run continua velho); a seguinte fica pequena. Opcional após `ok` e 0 erros: carimbar o cache das flags já gravadas (sem PUT) pra pular esse 11k.
- **Não mudou:** política vazio→Sim / vazio→Não skip; cron FLAGS off; rate 2; não aquecer deal a deal com GET.

### 2026-08-31 — Fields da madrugada só grava SIAA se o cache divergir
- **Modelo usado:** Grok.
- **Fato:** cron `mode=fields` 31/08 05:00–10:24 BRT (após Full #59 FETCH=0) `matched=38342` · `fields_updated=38338` · `skipped_unchanged=0` · `flags=0` · `stages=7` · 5 h 23 min. A UI de Att mostrava isso como “Att rodando” (mesmo job).
- **Causa:** `doFields` empilhava CPF/RGM/curso/polo/situação/Marco/datas em **todo** match, sem comparar com o deal do espelho. Flags já tinham política vazio/diverge; fields não.
- **Código:** `pushChangedField` — vazio→preenche, igual (normalizado)→skip, diverge→corrige. Não limpa campo vazio. Curso/polo/data/CPF comparam forma canônica pra não regravar “Pedagogia” vs “PEDAGOGIA (…)”. Etapa e flags não mudam.
- **Ops:** merge `raphael` + rebuild **antes** das 05:00. Sem rebuild a madrugada repeate 38k PUTs. Não clicar Att por causa do fields.
- **Não mudou:** cron FLAGS/provision off; FETCH=0 + rate 2; Fixa vence Relação nas datas.

### 2026-08-29 — Full #57 FETCH=0 zerou colunas CPF/RGM (JSON intacto)
- **Modelo usado:** Grok.
- **Fato:** Full `id=57` 29/08 02:00–02:53 BRT (`FETCH_DEAL_FIELDS=0`, 53 min, `seen=42961/42961`, `deleted=0`, `status=ok`). KPI: 42.965 ativos · Sem CPF/RGM 42.962 · 58.701 alertas. Não é o #54: o Full completou e não marcou apagados.
- **Causa:** `mergePreserveIdentity` lia `existing.cpf_norm`, mas `loadExisting` **não selecionava** essas colunas → incoming vazio ganhava. O JSON `raw_data.dealsById.*.customFields` do #56 **foi preservado** (~36,6k CPF / ~36,5k RGM).
- **Código:** `loadExisting` passa a ler `cpf_norm`/`rgm_norm`; após o merge, se a coluna ainda estiver vazia, extrai do JSON (nome ou id PROD). Recalcula `filled_field_count` do raw mesclado.
- **Ops:** restore SQL `scripts/novo-crm-restore-cache-identity-from-raw.mjs` (só Postgres). Merge `raphael` + rebuild **antes** do Full 02:00 — senão quem mudar nome/etapa no CRM muda o hash e o upsert FETCH=0 zera de novo. Não clicar Full com FETCH=0 até o rebuild. Fields 05:00 já rodou no CRM (não depende do KPI). Alertas 58k = residual #55 (FETCH=0 não gerou data-loss novo).
- **Não mudou:** cron FLAGS/provision off; `FETCH_DEAL_FIELDS=0` + rate 2 no dia-a-dia.

### 2026-08-28 — CAA e Data Rematrícula sumiram do CRM; PUT de campos recusa o lote
- **Modelo usado:** Grok.
- **Fato:** criação de 26 leads novos (28/08): contato + negócio nasceram; `PUT /api/deals/:id/custom-fields` 500 Prisma `deal_custom_field_values_customFieldId_fkey`. Catálogo live (`GET /api/custom-fields?entity=deal`, 30 campos) **não tem** `caa` (`cmt7ndc0k00nnp801ngjfqf98`) nem `data_de_rematricula` (`cmt7bc5opxal0la01nad5ahj5`). O provision mandava CAA=Não em todo deal novo → FK derruba CPF/RGM/data.
- **Código:** `updateDealCustomFields` consulta o catálogo e **descarta** fieldId desconhecido (o resto do PUT segue). JSON PROD sem esses dois IDs. Apply em contact já existente preenche o deal vazio (não cria outro).
- **Ops:** campos recriados 28/08 (ids novos). CAA = Texto `caa` `cmtdlx1kr0phlmp01equyxx8s`. Data Rematricula = DATE `data_rematricula` `cmtdlxb4z0phvmp01u7o3oji1`. Easypanel: esses ids (não os velhos, não `-`). Não clicar Criar até rebuild — os 26 já existem vazios; a apply preenche. EMAIL/NASC continuam sem campo no deal (`-`).
- **Não mudou:** cron FLAGS/provision off; Marco/Dia 10/Atualizado? continuam no catálogo.

### 2026-08-27 — Full #54 incompleto marcou 25k como apagados
- **Modelo usado:** Grok.
- **Fato:** Full 27/08 13:50 BRT (`id=54`) `contacts_total=42715` · `contacts_seen=17000` · `status=ok` · `contacts_deleted=25811`. Parou cedo (página curta) e o `markDeleted` rodou. KPI: 18k ativos, 16k sem CPF/RGM, 340k alertas (FETCH=0 apagando customFields no upsert).
- **Limpeza (Postgres, sem tocar CRM):** undelete `is_deleted` → **42.817 ativos**; ack dos `novo_crm_data_loss_events` abertos. Residual ~16.8k sem CPF/RGM = os 17k que o #54 sobrescreveu (FETCH=0). Os ~24k restaurados mantêm CPF/RGM.
- **Código:** `markDeleted` só se `seen ≥ 95%` do total; full incompleto grava `status=error`. `upsertSnapshot` preserva CPF/RGM/customFields se o incoming vier vazio. Não loga data-loss nesse caso.
- **Ops:** merge `raphael` + rebuild **antes** do Full das 02:00 — senão o #54 se repete. `FETCH_DEAL_FIELDS=0` ok com o preserve.
- **Não mudou:** cron FLAGS/provision off; fields 05:00.

### 2026-08-27 — Prévia de leads novos filtra o espelho (e-mail/telefone) antes da API
- **Modelo usado:** Grok.
- **Problema:** Full Sync com `FETCH_DEAL_FIELDS=0` não preenche `cpf_norm`/`rgm_norm`. A prévia de leads novos só pulava por CPF/RGM → live-check 1 a 1 em ~36k da Relação (`GET /contacts?search=`). Com rate 2 rps, horas.
- **Decisão:** `loadExistingCpfRgmSets` também lê `email_norm`/`phone_norm` do contact. Antes do loop ao vivo, filtra quem já está no espelho por CPF **ou** RGM **ou** e-mail (pessoal/AD) **ou** telefone (DDD+8). Só o gap vai à API. Contadores `skipped_cache_email` / `skipped_cache_phone`. Apply continua conferindo o gap ao vivo. Botão **Parar** na prévia/criação (cancel cooperativo).
- **Ops:** a prévia 36k em andamento **não** pega o filtro — rebuild (ou restart do processo) para matar o job. Depois: Prévia de novo; deve fechar em segundos/minutos.
- **Não mudou:** cap 1500/run; cron provision off; live check do residual.

### 2026-08-27 — CRM PROD mudou de domínio (EduIT → Bwipo)
- **Modelo usado:** Grok.
- **Fato:** UI/API passaram de `crm.eduit.com.br` (503) para `https://cruzeiro-ead.bwipo.com`. Mesma org (`cmrmbn2lh0uz2nm016beqgbwb`); o token atual autentica em `/api/tags`.
- **Ops Easypanel:** `NOVO_CRM_API_BASE_URL=https://cruzeiro-ead.bwipo.com` (sem path `/pipeline`). Manter `NOVO_CRM_API_TOKEN` e `NOVO_CRM_PROVISION_ALLOW_PROD=1`. `NOVO_CRM_DATABASE_URL` é outro Postgres — só muda se o banco também migrou.
- **Código:** `isProdCrmHost()` aceita o host novo **e** o antigo, para carregar `data/novo-crm-prod-ids.json` (sem isso a Att cairia nos IDs de DEV). Gate de escrita PROD sem ALLOW_PROD continua bloqueado.
- **Catch-up (dump de domingo):** Full Sync **antes** de criação/Att. Ritmo: `NOVO_CRM_CACHE_FETCH_DEAL_FIELDS=0` (pula GET por deal — maior ganho) · `NOVO_CRM_API_RATE_PER_SECOND=5` · `NOVO_CRM_CACHE_BATCH_DELAY_MS=50`. Teto do código **6** (era 3). Depois do catch-up voltar rate **2**. Não repetir 8 rps + 5 workers da Att de 25/08.
- **Não mudou:** IDs de etapa/campo; cron FLAGS off.

### 2026-08-26 — Dedupe: tag no catálogo antes de mover para Perdido
- **Modelo usado:** Grok.
- **Incidente:** apply 26/08 ~15:41 BRT moveu 25 duplicados para Perdido, mas `limpeza_duplicata_26.08.2026` (e a de 25/08) **não existiam** no catálogo. `POST /api/deals/:id/tags { tagName }` tenta criar a tag; o CRM 500 (`org_number_counters` / "Erro ao criar tag."). A etapa mesmo assim muda — falha de tag só logava. Filtro por tag no Kanban fica vazio.
- **Decisão:** apply **aborta** se a tag do dia não estiver no catálogo (`ensureTagByName` → cria ou falha visível). Só então move. Attach usa `tagId`. Contadores `tags_applied` / `tags_failed`. Plano da prévia **não é consumido** se a tag falhar.
- **Ops:** se o CRM não criar tag nova, criar `limpeza_duplicata_DD.MM.YYYY` na UI Tags (mesmo nome) e reaplicar / carimbar. EduIT precisa da tabela/sequência `org_number_counters`.
- **Não mudou:** Att; cron FLAGS off.

### 2026-08-26 — Prévia de duplicados lê o espelho, não a API
- **Modelo usado:** Grok.
- **Problema:** dry `scope=duplicates` fazia `GET /api/deals/:id` em todo cartão do grupo (~7,7k grupos × 2+ = ~15k req). Com rate 2 rps a prévia levava ~1–2 h. Os deals já estão em `novo_crm_person_cache`.
- **Decisão:** **prévia (dry_run)** classifica survivor/loser pelo snapshot local (etapa, RGM/CPF, dono, campos, nome, e-mail, telefone). Conversas/notes não estão no espelho — peso menor no score. **Apply** continua GET live antes de mover para Perdido.
- **Ops:** Parar a prévia live em andamento; merge `main` + rebuild. Próxima prévia deve fechar em segundos/minutos (CPU no Postgres), não horas na API.
- **Não mudou:** apply ainda confirma ao vivo; intocáveis / Perdido / multi-RGM.

### 2026-08-25 — Att/sync mais lenta: não saturar o CRM
- **Modelo usado:** Grok.
- **Incidente:** Att `flags_stage` 25/08 ~11:03 BRT (backfill CAA Sim, fila 5509) com 5 workers + ~4 rps deixou o CRM EduIT lento/travado. Progresso congelou em 4300/5509 (fetch sem timeout). Cancel cooperativo às 11:41: `flags_updated=3707` · `stages_moved=76` · `cancelled=true`. ~1.8k restantes — próxima Att retoma (Sim já gravado não reescreve).
- **Decisão:**
  1. `NOVO_CRM_API_RATE_PER_SECOND` default **2**, teto **6** (era 3; catch-up Full Sync 27/08). Env 8+ ainda não passa. Dia-a-dia: **2**.
  2. Att concurrency default **2**, teto **4** (era 5/24).
  3. Dedupe/órfão concurrency default **2**, teto **4**.
  4. `fetch` com `AbortSignal.timeout` **15s** (`NOVO_CRM_API_TIMEOUT_MS`) — worker não fica preso; Parar consegue encerrar.
- **Ops:** merge `main` + rebuild. No Easypanel, se `NOVO_CRM_API_RATE_PER_SECOND` ou `FLAGS_SYNC_CONCURRENCY` estiverem altos, baixar ou remover (o teto do código segura). Não disparar Att até o CRM normalizar.
- **Não mudou:** cron FLAGS off; provision noturno off.

### 2026-08-24 — Flag CAA (Sim/Não) ≠ etapa Retenção (só 72h)
- **Modelo usado:** Grok.
- **Pedido:** botão no deal (como Dia 10 / docs). Quem **já apareceu** em CAA = **Sim** (gruda). **Retenção** só se estiver na janela de **72h** (`NOVO_CRM_CAA_RETENCAO_HOURS`).
- **Campo CRM (PROD live):** label **CAA**, internal name **`caa`**, type **SELECT**, id **`cmt7ndc0k00nnp801ngjfqf98`** → `NOVO_CRM_FIELD_CAA` / `getNovoCrmDealFieldIds().caa`. Opção na UI hoje **Sim** (igual Dia 10). Att grava **Sim** em quem já apareceu; **não** faz Sim→Não. Sem id = Att **não grava**.
- **Por que sticky:** o export CAA é **relatório diário D−1** — quem estava ontem **não** está hoje; ausência no arquivo **não** é saída. Não usar o snapshot do dia como índice de exit nem o sanity 70% dele.
- **Regra:**
  1. **Flag Sim** = identidade em `caa_protocols` (qualquer status; histórico de uploads). Att **não** faz Sim→Não nesta flag.
  2. **Etapa Retenção** = `status=open` **e** T0=`first_seen_at` ≤ 72h. Fora da janela segue SIAA. Retenção sem CAA open = keep (manual).
- **Onde grava:** Att `flags_stage` / `both` (não o fields noturno). Provision `mode=new` e órfãos também, se o id existir.
- **Não mudou:** Cancel/Tranc SIAA vence CAA. Intocáveis Ganho/Cancelado/Em Atendimento. Cron FLAGS continua OFF.

### 2026-08-24 — Fixa de datas: 1ª aparição = Matrícula; última diferente = Rematrícula
- **Modelo usado:** Grok.
- **Problema:** a Relação do dia **sobrescreve** Data Matrícula com a data da rematrícula. O fields noturno gravava essa data no CRM e apagava o histórico (ex. Sueli `41301854`: 1ª matrícula **2024-09-06**, CRM tinha **2025-12-19**).
- **Campo CRM (PROD live):** label **Data de Rematricula**, internal name **`data_de_rematricula`**, type **TEXT**, id **`cmt7bc5opxal0la01nad5ahj5`** → `NOVO_CRM_FIELD_DATA_REMATRICULA` / `getNovoCrmDealFieldIds().data_rematricula`. Data de Matrícula continua DATE `data_de_matricula`. Valor escrito **ISO `YYYY-MM-DD`** nos dois. Vazio de rematrícula **não** limpa em massa.
- **Fonte:** Relação histórica 2022.1→2026.1 (Downloads) + Relação 2026.2 do dia (snapshot matriculados). Por **RGM**: 1ª aparição = Data de Matrícula; aparição posterior com data **diferente** = rematriculou; última data = Data Rematrícula. Uma só aparição: preenche matrícula, rematrícula vazia. **Não** reclassifica tipo do card (quem rematriculou permanece Rematrícula mesmo com data antiga recuperada).
- **Persistência:** `data/fixa-matricula-dates.json` (~89.776 RGMs; ~37k ainda na Relação 2026.2; ~41k rematriculou). Builder `scripts/build-fixa-matricula-dates.mjs`. Loader `server/utils/fixaMatriculaDates.js`. Overlay no fields noturno, provision `mode=new` e órfãos: Fixa vence Relação; sem RGM na Fixa cai no fallback Relação.
- **Ops:** apply `scripts/novo-crm-fixa-dates-apply.mjs` (RGM no deal, rate 4, conc 2). Docker **deve** `COPY data/fixa-matricula-dates.json`. Merge `main` + rebuild **antes** do fields das 05:00 — senão a Relação do dia volta a stomp Data de Matrícula.
- **Não mudou:** Marco Pré/Pós (lista RGM-only). Tipo de matrícula no card.

### 2026-08-19 — Marco: arquivo 25.2 certo (substitui o de 18/08)
- **Modelo usado:** Grok.
- **Problema:** o `matriculados_25.2.xlsx` de 18/08 era o relatório errado. SIAA marcava calouro 2026 como VETERANO (data jul/2026; RGM > `46415114`) e o apply gravou **Pré** (~15.671 deals). Ex.: Beatriz #105559 RGM `48654973`.
- **Fonte certa:** `matriculados_25.2 (1).xlsx`. Mesma regra: **VETERANO** = Pré; **INGRESSANTE** só com Data Matrícula **≤ 2025-09-13**. Gravação **RGM-only** (sem CPF).
- **Lista nova:** `data/marco-pre-rgms.json` (~21.479 RGMs). Arquivo errado guardado em `data/marco-pre-rgms-errado-20260818.json` (~16.498). Delta: **+9.447** Pré (ingressante ≤ 13/09 que faltavam) · **−4.466** (calouro/falso veterano → Pós). Beatriz/Larissa/Guthielli saem; Mário Germinário (`44792425`, data 02/08/2025) permanece Pré.
- **Ops:** `scripts/build-marco-pre-rgms.mjs` + realign (Pós nos removidos, Pré nos adicionados). **19/08 ~05:00 e 20/08 ~05:00:** fields no `main` ainda usava **data SIAA** → regravou Pós. Restore 19/08: `scripts/novo-crm-marco-pre-restore.mjs`. **20/08:** lista + classificador RGM-only + `COPY data/marco-pre-rgms.json` no `main` (rebuild Easypanel). Sem isso a madrugada zera de novo.
- **Supersede:** lista 25.2 de 18/08 (entrada abaixo).

### 2026-08-18 — Marco: lista 2025/2 (veterano + ingressante ≤ 13/09/2025)
- **Status:** **Arquivo-fonte inválido** — supersedida em 19/08 pela entrada acima. A regra (VETERANO + ingressante ≤ 13/09) permanece; só a planilha estava errada.
- **Modelo usado:** Grok.
- **Fonte Pré (errada):** `matriculados_25.2.xlsx` (emissão 14/08/2026). **VETERANO** = todos Pré. **INGRESSANTE** só com Data Matrícula **≤ 2025-09-13**. Quem não está nessa lista → **Pós**.
- **Persistência:** RGMs/CPFs Pré em `data/marco-pre-rgms.json`. Classificador (`marcoRegulatorio.js`) consulta a lista; não usa data SIAA atual nem teto numérico de RGM. Docker **deve** `COPY data/marco-pre-rgms.json`.
- **Cruzamento 18/08 vs Relação atual (com arquivo errado):** dos Pré da 25.2, **15.652** RGMs ainda na Relação do dia (~15.589 Em Curso); **15.640** já têm negócio no CRM.
- **Supersede:** corte por RGM ≤ `46415114` (mesmo dia, entrada abaixo).

### 2026-08-18 — Marco: corte pelo RGM sequencial (não pela data)
- **Status:** **Supersedida** no mesmo dia pela lista 2025/2 (entrada acima).
- **Modelo usado:** Grok.
- **Por quê:** no SIAA, rematrícula **sobrescreve** Data Matrícula com o dia da rematrícula — a Att só-data desta madrugada marcou **0 Pré**. RGM sobe a cada matrícula nova e não muda na remat.
- **Âncoras (pedido 18/08):** últimos Pré em **13/09/2025** = `46412387`, `46412751`, `46415114`. Primeiros Pós em **15/09/2025** = `46420029`, `46422099`, `46424806`, `46431101`, `46433091`, `46434101`.
- **Regra:** RGM **≤ `cutoffRgmMaxPre` `46415114`** → **Pré**; RGM **maior** → **Pós**. Vale para Nova / Recompra / Rematrícula / Retorno. Sem RGM → não grava. Data e série fora.
- **Arquivos:** `data/marco-regulatorio.json`, `server/utils/marcoRegulatorio.js`. Gravação continua no fields noturno.

### 2026-08-18 — Marco: data primeiro; Retorno usa prefixo do RGM
- **Status:** **Supersedida** no mesmo dia pela entrada do corte por RGM sequencial (acima). Data SIAA não distingue pré/pós após remat; prefixo 46 misturava matrículas de 13/09 (Pré) e 15/09 (Pós).

### 2026-08-17 — Marco regulatório: id PROD + fields noturno grava Pré/Pós
- **Modelo usado:** Composer.
- **Campo CRM (PROD live):** label **Marco Regulatorio**, internal name **`marco_regulatorio_2`**, type **SELECT** (opções **Pré** / **Pós**), id **`cmst97c9q01a7mp019n6671ji`** → `NOVO_CRM_FIELD_MARCO` / `getNovoCrmDealFieldIds().marco`. Valor escrito **exatamente** `Pré` / `Pós`.
- **Decisão:** o `mode=fields` da madrugada (`NOVO_CRM_FIELDS_SYNC_ENABLED=1`, ~05:00 BRT) já chamava `marcoFieldPair`; faltava o id. Com o JSON PROD preenchido, o job noturno marca quem tem match SIAA. Sem classificação (tipo indefinido / sem data) **não grava** (deixa vazio).
- **Regras:** `data/marco-regulatorio.json` + `data/marco-pre-rgms.json` + `server/utils/marcoRegulatorio.js`. **Supersedido 18/08 (noite):** lista 2025/2 (ver entrada do dia). Docker **deve** `COPY` os dois JSON.
- **Ops:** merge `main` + rebuild **antes** do fields das 05:00. Não setar `NOVO_CRM_FIELD_MARCO=-` no Easypanel. Att manual `flags_stage` **não** grava este campo (`doFields=false`); é o fields noturno (ou `mode=both`).
- **Não mudou:** cron de provisionamento continua OFF.

### 2026-08-17 — Criação de leads novos (`mode=new`) de volta no Sync
- **Modelo usado:** Composer.
- **Motivo:** ~1.2k RGMs na Relação de matriculados do dia sem negócio no CRM (criação off desde 06/08). Att/fields não cria cartão.
- **Decisão:**
  1. API `POST …/provision-matriculados-novo-crm?mode=new` deixa de devolver 410. Botão **«3. Criação de leads novos»** volta no `NovoCrmSyncPanel` (prévia async + confirmação inline + apply). Cap UI **1500**/run (hard cap 2000).
  2. Seleção = snapshot atual ausente do espelho (CPF **ou** RGM) + live check. **Sem** filtro delta vs snapshot anterior — o buraco já estava no SIAA ontem.
  3. Cron noturno continua **OFF** (`NOVO_CRM_PROVISION_ENABLED≠1`). `mode=all` ainda exige essa env. Escrita PROD continua no gate `NOVO_CRM_PROVISION_ALLOW_PROD=1`.
- **Ops:** Disparador → Sync → Prévia leads novos → Criar. Rode Full Sync depois para o espelho acompanhar.
- **Não mudou:** Dedupe órfãos (anti-spam / sibling). Marco regulatório: id PROD mapeado no mesmo dia (ver entrada acima).

### 2026-08-12 — Dedupe em quarentena: Att/fields nunca move tag `limpeza_duplicata_*`
- **Incidente:** os ~2.329 perdedores enviados a **Perdido** em 11/08 não foram apagados naquele dia. O `fields` noturno (05:00 BRT) também alinha etapas desde 03/08; como Perdido não era intocável, a classificação SIAA/rematrícula recolocou cards em Graduação/Sem Rematrícula. Escritas perto de 06:44 são compatíveis com a fila iniciada às 05:00. A Att manual posterior de 12/08 concluiu 13:01 BRT com `stages_moved=2937` e podia repetir o mesmo caminho.
- **Decisão:** qualquer deal com tag cujo nome começa por `limpeza_duplicata_` é **quarentena de etapa**. `fields`, `flags_stage` e `both` podem continuar atualizando campos/flags, mas nunca fazem `updateDeal(stageId)` nesse deal, esteja ele em Perdido ou já fora.
- **Garantia contra cache stale:** toda troca automática de etapa agora faz `GET /api/deals/:id` antes do PUT e confere a tag ao vivo. Não basta o espelho: a tag pode ter sido aplicada depois do último Full Sync. O espelho API também passa a persistir `detail.tags` para dry-run/diagnóstico.
- **Observabilidade:** contador `stages_skipped_limpeza_duplicata` no resultado e no `flags_stage_last`.
- **Operação do incidente:** usuário optou por hard-delete dos deals com tag `limpeza_duplicata_11.08.2026`; **não restaurar para Perdido**. O filtro deve incluir a tag em todas as etapas, inclusive os revividos em Sem Rematrícula/Graduação.
- **Escopo:** não tornou Perdido globalmente intocável; a trava é por tag para preservar casos futuros em que o produto queira reclassificar um Perdido sem origem no dedupe. O provisionamento de órfãos não recria enquanto existir sibling/deal; hard-delete pode tornar o cadastro órfão. `mode=new` voltou no botão de dia (17/08); o cron de provisionamento deve permanecer OFF em PROD.

### 2026-08-11 — CRM redondo: apply por scope (incomplete → duplicates → orphans)
- **Modelo usado:** Composer.
- **Ops PROD (crm.eduit.com.br, ALLOW_PROD):** sem novo dry 3h; apply sequencial CLI `scripts/novo-crm-orphan-dedupe-scope-apply.mjs` com live_check, conc=3, rate~3–4.
  1. **incomplete** (~10 min, N=2820): `enriched=21`, `no_match=2719`, `live_already_ok=40`, sibling→Perdido contados, `created=0`, `errors=0`. Residuais sem match SIAA (e-mail/tel) — não dá pra preencher CPF/RGM automático.
  2. **duplicates** em 2 passes: 1ª cap `NOVO_CRM_DEDUPE_MAX_MOVES=1000` (default service) → 1000→Perdido; 2ª com max 15k → +1329 (total sessão ~2329 moves), 3805 grupos varridos, `dup_resolved_live` alto no 2º pass, 1 erro, tag `limpeza_duplicata_DD.MM.YYYY`.
  3. **orphans** N=84, maxCreates=100: `created_deals=7` (sibling multicurso), `skipped_cpf_capacity=52` (anti-spam), `no_match=26`.
- **UI:** seletor de escopo no card Dedupe (default **incomplete**; opções duplicates/orphans/both) — já em main line com progresso 296ed8b.
- **Não refez:** Att em massa / full dry both / multi-dup DELETE residual (Perdido cobre spam de cartão).
- **Cache:** contadores incompletos no espelho só mudam após Full Sync noturno (writes no CRM não invalidam KPI SQL).
- **Amanhã:** Full Sync (já 05:00); residual multi-dup opcional se `dup_deal_groups` ainda alto pós-cache; incompletos no_match = limpeza manual / classificação não-aluno.

### 2026-08-11 — Dedupe prévia: progresso rich + reattach + Parar (como Att)
- **Modelo usado:** Composer.
- **Problema:** dry `scope=both` rodava minutos sem UI de progresso; refresh só via 409 "Provisionamento de órfãos já em andamento"; logs floodavam `live deal read failed … Negócio não encontrado` (cache stale).
- **Decisão:**
  1. Job em memória expõe fase (`load_matriculados` → `scan_mirror` → `live_check_orphans` → `process_incomplete` → `duplicates` → `done`), contadores (`orphans_*/incomplete_*/dup_groups_*`, `already_has_deal`, `would_create`, `deal_not_found`, `errors`) e `eta_ms`.
  2. `GET …/cache-status` inclui `running_orphan_dedupe` (reattach pós-refresh). Status detalhado em `GET …/provision-orphan-alunos-novo-crm-status`.
  3. Cancel cooperativo: `cancel_requested` + `POST …/provision-orphan-alunos-novo-crm-stop` (`requestCancelOrphanAlunoProvision`) — para no próximo item; não torna apply mais agressivo.
  4. UI card (barra %, fase, contadores, ETA, Parar); 409 reanexa job em andamento.
  5. Soft-log de deals apagados (`not_found` contado no progresso); 3 primeiras + a cada 100.
- **Arquivos:** `novoCrmOrphanAlunoProvisionService.js`, `maintenance.js`, `maintenanceApi.ts`, `NovoCrmSyncPanel.tsx`.
- **Escopo:** só UX/progresso da dry_run preview (+ cancel); apply inalterado em agressividade.

### 2026-08-11 — Sync panel: stop Att/Full + progresso real + fim do “1903” de prévia
- **Modelo usado:** Composer.
- **Problema:** Att parecia travada (só texto); sem botão parar; confirmar Att rodava dry_run com `max=2000` que todo dia batia ~1900 matches (amostra do espelho, não resultado real).
- **Decisão:**
  1. **Cancel cooperativo** Att: `cancel_requested` no job + `POST /api/maintenance/sync-flags-stage-novo-crm-stop` (`requestCancelFlagsStageSync`). Loops scan/write checam e gravam status `cancelled` + `last_flags_sync` (parcial ok).
  2. **Cancel Full Sync:** `POST /api/maintenance/sync-novo-crm-cache-stop` — flag em memória; quebra o while; **não** roda `markDeleted` nem atualiza cursor (espelho parcial seguro).
  3. **Progresso Att:** job expõe `phase`, `processed/total`, `matched`, `flags_updated`, `stages_moved`, `eta_ms`; status API inclui `running_flags` para reanexar após refresh.
  4. **UI:** barra % + fase + Parar; `last_flags_sync` detalhado (scanned/match/flags/etapas) como verdade do último apply — sem dry pré-confirmação amostrado.
  5. Dry sync API sem `max` default agora **50000** (antes 500) se alguém chamar dry de script.
- **Arquivos:** `novoCrmFlagsStageSyncService.js`, `novoCrmPersonCacheSyncService.js`, `maintenance.js`, `maintenanceApi.ts`, `NovoCrmSyncPanel.tsx`.
- **Follow-up:** cancel + progresso rico do **Dedupe** (mesma data) — ver entrada acima.

### 2026-08-11 — Att flag **Financeiro** (base `financeiro`) → CRM **Dia 10** (`dia`)
- **Modelo usado:** Composer/Auto.
- **Produto:** Grad mensalidade vence dia **25** → base **Inadimplentes vencidos** grava **Situação Financeira** (`situacaofinanceira` / `NOVO_CRM_FIELD_INADIMPLENTE`). Até o dia **10** ainda há desconto; quem está na base **Financeiro** (snapshot slug `financeiro`) = mensalidade em aberto **ainda no prazo** → grava SELECT **Dia 10** no deal.
- **Campo CRM (PROD live 2026-08-11):** label **Dia 10**, internal name **`dia`**, type **SELECT**, id **`cmsoqzzbwgs3yom01n0c5txvi`** → `NOVO_CRM_FIELD_FINANCEIRO` / `getNovoCrmDealFieldIds().financeiro`. Valor escrito **exatamente** `Sim` / `Não` (helpers `simNao`). **Não** existe field name/label `financeiro` no CRM.
- **Decisão:** mirror do pipeline doc_pendentes/inad:
  1. `loadIdentityIndexFromBase('financeiro')` + `classification.flags.financeiro` — só quem está no relatório/base Financeiro fica Sim.
  2. Write Sim/Não com empty→Não skip (mesma política).
  3. Passo saída: Sim→Não fora do índice + sanity ratio.
  4. Aliases de leitura: `dia 10`, `dia10`, `dia`, `financeiro`. **NÃO** misturar com `situacaofinanceira` (aliases inad: `inadimplente`, `situacaofinanceira`, `situacao financeira`, `financeira`).
- **Arquivos:** `data/novo-crm-prod-ids.json`, `novoCrmStageRules.js`, `novoCrmFlagsStageSyncService.js`, `novoCrmMatriculadosProvisionService.js`, `novoCrmOrphanAlunoProvisionService.js`, `novo-crm-discover-prod-ids.mjs`, `.env.example`.
- **Docker:** runtime **deve** `COPY data/novo-crm-prod-ids.json` → `/app/data/` (lido por `novoCrmStageRules.js` via `server/utils` → `../../data/…`); sem o arquivo, `NOVO_CRM_FIELD_FINANCEIRO` / Dia 10 fica vazio em PROD mesmo com o JSON no repo.

### 2026-08-06 — Sync: sem "Criação de leads novos"; tag limpeza em Perdido (dedupe)
- **Status:** criação `mode=new` **reativada em 17/08** (card + API). Cron continua OFF. Tag de limpeza em Perdido permanece.
- **Modelo usado:** Composer.
- **UI:** card **«Criação de leads novos»** removido do `NovoCrmSyncPanel` (Disparador → Sync). Fluxo diário = Full Sync + Att + Dedupe. Service `novoCrmMatriculadosProvisionService` **não apagado** (backfill `mode=all` ainda possível).
- **API:** `POST /api/maintenance/provision-matriculados-novo-crm` com `mode=new` (default) → **410** `PROVISION_NEW_DISABLED` (fecha buraco de mass-create). `mode=all` continua com `NOVO_CRM_PROVISION_ENABLED=1`.
- **Tag CRM em limpeza de duplicata:** em `novoCrmOrphanAlunoProvisionService`, todo deal movido a **Perdido** (incompleto→sibling ou grupo RGM duplicado) recebe tag `limpeza_duplicata_DD.MM.YYYY` (America/Sao_Paulo), via `addTagToDeal({ tagName })` (create-or-attach). Falha de tag só loga — **não desfaz** move de etapa. Não cobre Att/SIAA→Perdido nem DELETE multi-curso.
- **Não merge main** sem pedido; commits na `raphael`.

### 2026-08-06 — Multi-curso: fields/Att RGM-only + órfão anti-spam + DELETE clones
- **Modelo usado:** Composer. Pedido do usuário (incidente Naionara CPF 33559094836, 9 negócios).
- **Root cause:**
  1. `mode=fields` / Att casava deal → SIAA por **CPF singleton** (`byCpf` 1 linha) e **sempre sobrescrevia** RGM/curso/nível/polo — multi-curso (Grad+Pós) virava todos Grad (RGM 47014237).
  2. Órfão sibling recriava deal quando live **não “via” RGM** (writeback vazio) mesmo com deals já cobrindo o N de RGMs SIAA do CPF.
- **Fix código:**
  1. `novoCrmFlagsStageSyncService.js`: se CPF tem **2+ RGMs** no SIAA, match canônico = **RGM no deal**; sem RGM no deal → **skip** (não stomp via CPF/email/fone). Contador `skipped_multi_rgm_no_deal_rgm`.
  2. `novoCrmOrphanAlunoProvisionService.js`: se sibling `dealCount >= N RGMs SIAA` **mesmo CPF**, ou live com deals mas `rgms.size===0` (empty writeback), **não recria**. Claim de RGM no memo pós-create mesmo se fields falhar.
- **Cleanup ops (DELETE, não Perdido):** `scripts/novo-crm-multi-dup-cleanup.mjs` dry → `--apply`. API `deleteDeal` (`DELETE /api/deals/:id`) existe e funciona. Keep 1 deal/RGM SIAA; se Pós sumiu do stamp, **rebuild fields+stage** no spare antes de apagar clones. Scan cache: `scripts/_scan-multi-dup-cache.mjs`.
- **Naionara (PROD apply 06/08):** 7 DELETEs (404 re-GET) · rebuild #106003 → RGM **48074594** Pós · keep #59479 Grad **47014237**. Francilaine clone removido. **0 Perdido**.
- **Não merge main** sem pedido; commits na `raphael`.

### 2026-08-04 — Atualizado?=Sim só com escrita de campos SIAA
- **Modelo usado:** Composer. Decisão do usuário (Raphael).
- **Problema:** marcar `Atualizado?=Sim` em todo deal que a Att/fields tocava (stage-only, flags-only, orphan→Perdido) **quebra a verificação em 2 passos** no Kanban (filtro Atualizado=Sim espera deals preenchidos).
- **Regra:** `ensureAtualizadoSim` só roda se `hasSiaaFieldWrite(values, fieldIds)` — ao menos um campo core SIAA com valor **não-vazio** no PUT: cpf, rgm, curso, polo, situacao (de `resolveSituacaoCrm` / map SIAA), nivel, email, email_ad, nasc.
- **NÃO marca Sim:** move-only (etapa), 4 flags sozinhas, clear situacao `''`, exit_remat_orphan→Perdido sem mat data, qualquer PUT sem core SIAA.
- **Provision** de lead novo continua gravando Sim junto com CPF/RGM/polo/… (já são writes SIAA). Backfill em massa de Sim falsos = ops separada (fora do escopo).
- **Arquivos:** `novoCrmFlagsStageSyncService.js` (`hasSiaaFieldWrite`), `.env.example`, `novoCrmStageRules.js` (comentário).

### 2026-08-03 — Perdido + Situação "Sem Rematrícula" (~34 UI) — LIVE re-verify + fix
- **Modelo usado:** Composer. Live GET PROD (`crm.eduit.com.br`), não só cache.
- **Por que o repair anterior "27 sit + 10 stage" não limpou a UI:**
  1. Script `novo-crm-repair-perdido-sem-remat.mjs` escaneava **person cache**, não o filtro live do Kanban.
  2. Várias pessoas tinham **2+ cards** (ex. JUDI #92736 sit já Cancelado vs **#72612** ainda Sem Rematrícula; JULIA #92743 vs **#72726**; LETICIA #cms0td… vs **#74804**). O apply tocou um id; a UI filtrava o outro.
  3. Logs "apply" misturam dry-runs posteriores; o apply real (timestamp 1785775295497) só cobriu deal ids do cache.
- **Fonte live correta:** `GET /api/deals?stageId=Perdido&search=Sem Rematrícula` → **total=34** (= UI). stageId=`cmrwd5vuo014hpd01imhgkp0y`, sit field=`cmrmexuw818tjnm01igvkevn1`.
- **Diagnóstico 34 live GET:**
  | SIAA / remat | n | fix |
  |---|---|---|
  | Cancelado + remat file | 10 | sit→**Cancelado**, fica Perdido |
  | Em Curso + still remat | 23 | stage→**Sem Rematricula** (reentry) |
  | Em Curso out remat | 1 (VIVIANE #104438) | sit→Em Curso + stage→**Graduação** |
- **Apply LIVE** (`scripts/_live-fix-perdido-ui34.mjs --apply`): sit **11** · stage **24** · errors **0** · cada um HTTP 200 + re-GET ok · **api list after = 0**. Amostras UI: #59702 William → Sem Rematricula; #72612 Judi / #72726 Julia / #74804 Leticia → Perdido+Cancelado.
- **Root code (prevenir resíduo):**
  1. `exit_remat_orphan` → Perdido: se sit=="Sem Rematrícula", **limpa** carousel (não inventa Cancelado sem SIAA).
  2. Dedupe/incompleto → move Perdido: grava Situação via `resolveSituacaoCrm(..., inRematricula:false)` (Cancelado/Em Curso, nunca força Sem Rematrícula no lixo de duplicata).
- **Não tocou:** Em Atendimento.

### 2026-08-03 — Perdido + Situação "Sem Rematrícula" (~34 UI) após Att (histórico; supersedido pela entrada LIVE acima)
- **Modelo usado:** Composer. Investigação + repair apply PROD (parcial / cache-only).
- **Sintoma:** Kanban/filter **34** deals em etapa **Perdido** com carousel Situação ainda **Sem Rematrícula** (tags remat*, data 03/08).
- **Quebra (cache PROD, pós-Att ~16:11 UTC):**
  | path | n | expected | repair |
  |---|---|---|---|
  | SIAA Cancelado (muitos ainda no remat file) | 14 | sit→**Cancelado**, stage Perdido ok | sit-only |
  | SIAA Trancado | 10 | sit→**Trancado**, stage Perdido ok | sit-only |
  | EM CURSO + still remat | 7 | stage→**Sem Rematricula** (sit ok) | stage reentry |
  | EM CURSO out remat | 3 | stage→**Graduação** + sit→Em Curso | stage+sit |
- **Root cause (regra, não só dado):**
  1. **Cancel/Tranc → Perdido sem rewrite de Situação** sob o buraco pré-piggyback global: `mode=flags_stage` só piggybackava Situação quando `classification.stageName === 'Sem Rematricula'`. Mover p/ Perdido (cancel) deixava sit "Sem Rematrícula" se já viesse da fila remat. (Fix piggyback any-target no mesmo dia — se Att rodou **antes** do deploy / ou deals já em Perdido sem reentry de sit.)
  2. **exit_remat_orphan** (Sem Remat + fora remat + **sem matRow** → Perdido): **só move etapa**, `valores` vazios — Sit "Sem Rematrícula" **permanece** (sem SIAA não inventamos Cancelado). Contador `stages_exit_remat_orphan` 135 no Att.
  3. Deals cancelados **já em Perdido** com sit stale só se corrigem no loop principal se piggyback global estiver ativo e houver mat match.
- **Não é:** Em Atendimento (intocável; nenhum dos 34).
- **Repair aplicado (PROD, script `novo-crm-repair-perdido-sem-remat.mjs --apply`):** queue 34 · sit written **27** · stages moved **10** · errors **0** — **incompleto** (só deal ids do person cache; ver entrada LIVE).
- **Próxima Att:** piggyback any-target cobre sit Cancelado/Trancado em Perdido; reentry EM CURSO+remat move de volta p/ Sem Rematricula.
- **Scripts:** `_live-fix-perdido-ui34.mjs` (fonte Kanban), `novo-crm-repair-perdido-sem-remat.mjs` (cache).

### 2026-08-03 — Att ~11:14 não fechou remat: buraco Situação + evidência
- **Modelo usado:** Composer (investigação + fix pontual).
- **Fatos (repo local, BRT 03/08):**
  1. Botão Att = `POST …/sync-flags-stage-novo-crm?mode=flags_stage&dry_run=0&async=1` (UI: prévia `max=2000`, apply sem max). Default mode `flags_stage`; dry_run true se não mandar `dry_run=0`.
  2. **Sem log local de Att apply ~11:14** — últimos `data/flags-stage-apply-*.log` são 28–29/07. Hoje só: audit remat 11:34, `_fix-remat-fields-apply` (mode=fields, queue=37553, log interrompido cedo), `remat-situacao-align` apply parcial 2055/2525 (~11:42–11:54), dry pós-trava queue **2364**.
  3. Remat snapshot audit: ~5396 RGM / ~5340 CPF. File de job em memória (`activationJobsRegistry` / flags jobs) não sobrevive restart — `flags_stage_last` no Postgres é o rastreador de PROD.
- **Buraco de regra confirmado (código):** em `runFlagsStageSync`, piggyback de carousel **Situação** só rodava se `classification.stageName === 'Sem Rematricula'`. Com `mode=flags_stage` (`doFields=false`), deals com **etapa já ok** mas Sit vazia/errada (ex. `sit:∅→Em Curso|out_remat` ~680, `∅→Cancelado` ~767 no dry 2364) iam pra `skipped_unchanged` **sem write**. O align script (`novo-crm-remat-situacao-align.mjs`) **sempre** alinhava Sit — daí a diferença de fila.
- **O que a Att JÁ fazia (não é hole):** mover Grad→Sem Remat (in remat), Sem Remat→Grad/Acol/Pós/Perdido (exit + matRow), cancel SIAA→Perdido; intocáveis Ganho/Cancelado/**Em Atendimento**; Retenção sem CAA open = keep; exit sanity 70%.
- **Números dry pós-trava (queue 2364):** ~60% sit-only fill; ~264 exit SemRemat→Graduação+sit; ~75 Grad→SemRemat (in_remat); ~155 Grad→Acolhimento; Em Atendimento deixou de aparecer como `stage:?` (agora intocável).
- **Fix:** piggyback Situação com `resolveSituacaoCrm(inRematricula=identityInIndex(remat))` **sempre** que `canMoveStages` (qualquer stage alvo), se cache divergir. Counters `situacao_sem_remat_*` passam a contar qualquer sit align (nome legado).
- **Arquivo:** `novoCrmFlagsStageSyncService.js`.
- **Ops:** re-rodar Att (`flags_stage`) ou align; fields noturno também cobre Sit via `doFields`.

### 2026-08-03 — Em Atendimento intocável para etapa + por que remat não alinhou na Att
- **Modelo usado:** Composer. Pedido do usuário.
- **Por que a Att / Sync de etapas não fechou remat sozinha em PROD:**
  1. `NOVO_CRM_FLAGS_SYNC_ENABLED=0` — cron de etapas/flags **off**; só fields noturno rodava.
  2. `mode=fields` **antes de 03/08** só escrevia custom fields (curso/polo/Situação…) e **não movia etapa** — daí Graduação + Situação Sem Rematrícula (situação ok se no remat; etapa errada).
  3. Botão Att (`flags_stage`) realinhava etapa, mas **precisa ser disparado**; não era o job da madrugada.
- **Decisão 03/08 (já):** fields noturno passa a poder mover etapa + saída remat (ver entrada acima).
- **Em Atendimento (`cmrxn1r190v2vo101kaqh4cup`):** **não move etapa** (intocável junto com Ganho/Cancelado). Atualiza campos/flags/Situação normalmente. Fila humana do consultor.
- **Arquivos:** `novoCrmStageRules.js` (`getUntouchableStageIds` + ID no stage map), `novo-crm-prod-ids.json`, script `novo-crm-remat-situacao-align.mjs` (usa o mesmo guard).

### 2026-08-03 — Fields sync alinha etapa remat + Situação Cancelado vence "Sem Rematrícula"
- **Modelo usado:** Composer. Pedido do usuário (Graduação com Situação Sem Rematrícula no Kanban).
- **Problema:** mode=fields (noite PROD; FLAGS off) só gravava carousel Situação. Quem ainda está no relatório remat mas com **etapa Graduação** ficava inconsistente (filtros Situação=Sem Rematrícula + coluna Graduação). Quem **saiu** do remat (rematriculou) ou **cancelou** no SIAA não recebia realinhamento de etapa/Situação na saída (só flags_stage). `resolveSituacaoCrm` forçava "Sem Rematrícula" mesmo com SIAA CANCELADO/TRANCADO.
- **Decisão:**
  1. `resolveSituacaoCrm`: **Cancelado/Trancado SIAA vence** rematrícula; senão remat → "Sem Rematrícula"; senão situacao SIAA (Em Curso…).
  2. **mode=fields também move etapa** (`canMoveStages = doFlags || doFields`) — noturno corrige Graduação→Sem Rematrícula se ainda no remat; Sem Rematrícula→Graduação/Pós/Perdido se saiu/cancelou (intocáveis preservados).
  3. Passo inverso de saída de Sem Rematrícula roda em **fields e flags** (flags Sim→Não só em flags_stage/both).
- **Semântica operativa:** still in remat + SIAA Em Curso = **não rematriculou** → etapa Sem Rematrícula + Situação Sem Rematrícula (não Em Curso).
- **Arquivos:** `novoCrmFieldMapping.js`, `novoCrmFlagsStageSyncService.js`.

### 2026-07-31 — Campo Atualizado?=Sim + Sem Remat sem CPF/RGM → Perdido
- **Modelo usado:** Composer. Pedido do usuário.
- **Atualizado?:** custom field PROD `cms9c1gfk0sl0jq011ywjyxfo` (`NOVO_CRM_FIELD_ATUALIZADO`). **Supersedido 2026-08-04:** não mais em todo deal tocado — só com write de campo SIAA core (`hasSiaaFieldWrite`). Provision de leads novos continua grava Sim com preenchimento.
- **Sem Rematrícula + sem CPF + sem RGM → Perdido** (além da regra órfão fora do remat). Pega cards tipo Roseducadora (CSV Atendimento vazio). Quem tem CPF/RGM (ex. Carla) permanece e segue reclassificação se saiu do relatório remat.
- **Arquivos:** `novoCrmStageRules.js`, `novoCrmFlagsStageSyncService.js`, `novoCrmMatriculadosProvisionService.js`, `data/novo-crm-prod-ids.json`, `.env.example`.
- **Ops:** no Easypanel pode setar `NOVO_CRM_FIELD_ATUALIZADO=cms9c1gfk0sl0jq011ywjyxfo` (ou deixar o JSON PROD). Manter `NOVO_CRM_FIELD_INADIMPLENTE=cmrwtc7xp00fnpf015srkz771` (nunca `-`).

### 2026-07-31 — Sem Rematrícula: órfão (fora remat + sem matriculados) → Perdido
- **Modelo usado:** Composer. Escolha do usuário (opção 1).
- **Problema:** após Att entrada/saída, Sem Rematrícula ~5835 vs base remat ~5689 (~150–200 a mais). Muitos cards são captura WhatsApp / sem RGM — a saída só reclassificava quem tinha matRow.
- **Decisão:** no passo inverso, se está em Sem Rematrícula, **fora** do relatório remat de hoje e **sem** match em matriculados → move para **Perdido** (conversa no contato permanece). Com matRow continua reclassificando via SIAA. Contador `stages_exit_remat_orphan`. Sanity 70% da fila remat continua valendo.
- **Arquivo:** `novoCrmFlagsStageSyncService.js`.

### 2026-07-31 — Att: enriquecer satélite via matriculados (match completo)
- **Modelo usado:** Opus Strategist (diagnóstico) + Composer (implementação).
- **Problema:** bases satélite (ex. evasão) muitas vezes só trazem **RGM** — sem CPF/telefone/e-mail. O índice satélite indexava só colunas do arquivo → match fraco no CRM; docs/evasão/remat longe das bases Relatórios.
- **Decisão:** **matriculados = base "sim"**. Fluxo: satélite (RGM/o que tiver) → lookup em matriculados → completa CPF/e-mail/fone → indexa tudo no índice da fila → match no espelho. Ordem: carrega matriculados (`byRgm`/`byCpf`/`byEmail`/`byPhone`) **antes**; `loadIdentityIndexFromBase(cat, {byRgm,byCpf})` chama `enrichIdentityFromMatriculados`. Passo inverso usa a **mesma** cadeia (deal → matriculados → identity). CPF via `normalizeCpf` (padStart 11). Email/phone continuam só se únicos.
- **Preservado:** entrada+saída, sanity 70%, empty→Não em massa, intocáveis, concurrency.
- **Arquivo:** `novoCrmFlagsStageSyncService.js`.

### 2026-07-31 — Att de etapas: entrada + saída (passo inverso) por relatório do dia
- **Modelo usado:** Opus (principal, spec) + Executor (Sonnet, implementação). `novoCrmFlagsStageSyncService.js`.
- **Problema:** o sync só cobria **entrada** — preenchia/corrigia flag e etapa quando o aluno **está** na base do dia (docs/inad/bb/evasão/rematrícula), usando match por CPF/RGM (`digits()` puro, sem padStart). Quem **saiu** da base (documento entregue, quitou, voltou a ter acesso, saiu da evasão, fez rematrícula) só era corrigido se o deal **também** desse match com `matriculados` no mesmo ciclo — deals sem esse match nunca eram revisitados, então flag Sim e etapa Sem Rematricula ficavam presas para sempre mesmo com a pessoa fora da base.
- **Decisão:** relatório do dia = verdade, em dois passos:
  1. **Índice de identidade** por base satélite (`loadIdentityIndexFromBase`): cpf/rgm sempre (via `normalizeCpf`/`normalizeRgm`, recupera CPF com zero à esquerda perdido); email/phone só se **únicos** no relatório (repetido = ambíguo, não usa pra match). Guarda `nRows` do snapshot pro guard de sanity. `identityInIndex(index, {cpf,rgm,email,phone})` checa nessa ordem.
  2. **Passo inverso** roda depois do loop principal, sobre **todos** os deals do cache com flag=Sim / etapa Sem Rematricula (merge por `dealId` com a fila do loop principal — idempotente):
     - **Flags** (doc/inad/bb/evasão): deal com flag=Sim e identidade **fora** do índice da base → enqueue Não.
     - **Sem Rematricula**: deal na etapa e identidade fora do índice de rematrícula **e com matRow** no relatório de matriculados (sem matRow não reclassifica — sem dado pra saber o destino) → `classifyMatriculado(inRematricula:false, …)` decide a nova etapa (respeita intocáveis via o mesmo `decideMoveWork`) e atualiza o carousel Situação se mudou.
  3. **Sanity por fila:** se `nRows === 0` ou `nRows < NOVO_CRM_FLAGS_EXIT_SANITY_RATIO (default 0.7) × simCount` (simCount = **todos** os deals com Sim/na etapa no cache), a saída **daquela fila inteira** é pulada — upload incompleto/corrompido não pode zerar a base inteira. Contado em `exit_skipped_sanity` (obj por fila). `nRows` é contado no `forEach` do snapshot (não confia só em `row_count` metadata).
  4. **Merge por dealId** antes de escrever — mesmo deal pode acumular flags de saída + reclassificação de etapa num único PUT.
- **Matriculados (match, sem trocar a política existente):** além de `byCpf`/`byRgm`, indexa `byEmail`/`byPhone` do relatório (`_email`, `e_mail_ad`, `_phone`), também só se únicos. No loop principal, se cpf/rgm do deal não baterem, tenta `email_norm`/`phone_norm` do cache antes de desistir (`skipped_no_match`). Política de escrita do loop principal **não muda**: vazio→Sim preenche, diverge corrige, vazio→Não não grava em massa.
- **CAA:** fila local (`caaProtocolsRepository`) não mudou — Retenção continua vencendo por CAA open ≤72h independente do passo inverso.
- **Counters novos:** `flags_exit_cleared`, `stages_exit_remat`, `exit_skipped_sanity` (result + `saveFlagsStageLastRun`). Dry-run também passa pelo passo inverso e conta would-clear/samples (`exit:true` nas amostras).
- **Não fiz:** não liguei o cron (`NOVO_CRM_FLAGS_SYNC_ENABLED` continua a decidir), não mudei concurrency, não toquei no dedupe de duplicados/incompletos (WIP separado), sem testes automatizados (fora do escopo pedido).
- **Risco residual:** identidade do passo inverso usa os campos **do próprio deal** (CPF/RGM do custom field + email/phone do cache), não do matRow — em teoria pode divergir do que o loop principal usaria se o deal tivesse dado match ali (raro; CPF/RGM tendem a ser consistentes entre deal e SIAA). Base satélite com>0 linhas mas ainda assim incompleta (ex.: faltando metade dos alunos reais) pode passar no sanity ratio e gerar saída indevida — o ratio é uma heurística, não uma garantia.
- **Arquivos:** `server/services/novoCrmFlagsStageSyncService.js`, `.env.example`.

### 2026-07-31 — Att de etapas: mapear Financeira PROD + preencher flag vazia→Sim + log persistente
- **Modelo usado:** Composer/Auto (implementação). Diagnóstico na sessão anterior.
- **Problema:** contagens CRM pós-Att divergiam das bases Relatórios (docs ~5501 vs ~7983; financeira/inad sem write; evasão/BB próximos mas não iguais). Cron Att OFF em PROD (`NOVO_CRM_FLAGS_SYNC_ENABLED=0`); só botão manual. Última Att não sobrevivia a restart (jobs só em memória).
- **Causas:**
  1. `NOVO_CRM_FIELD_INADIMPLENTE` ausente em `data/novo-crm-prod-ids.json` (e `.env.example` documentava `-` = skip) → Att **não gravava** Situação Financeira. No CRM o campo real é `situacaofinanceira` (`cmrwtc7xp00fnpf015srkz771`), não um field `inadimplente`.
  2. Regra antiga `if (!cur || cur === next) continue` — **nunca preenchia flag vazia**, só corrigia valor já presente e divergente → milhares de docs/etc sem Sim.
- **Decisão:**
  1. Mapear `NOVO_CRM_FIELD_INADIMPLENTE` → id PROD de `situacaofinanceira`; aliases de leitura incluem `situacaofinanceira` / `situacao financeira`.
  2. Nova política de write: **vazio + próximo=Sim → preenche**; **vazio + Não → não grava** (evita flood de PUTs); valor existente que diverge → corrige.
  3. Persistir última Att apply em `novo_crm_cache_sync_state` key=`flags_stage_last` (JSON no `cursor_id`); expor em `GET /api/maintenance/novo-crm-cache-status` como `last_flags_sync` + linha no card "Att de etapas".
- **Ops:** se Easypanel tiver `NOVO_CRM_FIELD_INADIMPLENTE=-`, isso **continua desligando** o flag (env vence o JSON) — remover/zerar a var. Após deploy, clicar **Att de etapas** de novo para backfill empty→Sim. Cron noturno continua OFF até pedido explícito.
- **Ritmo (31/07 follow-up):** concurrency default da Att **8 → 5** (`NOVO_CRM_FLAGS_SYNC_CONCURRENCY`) — 8 workers gerava 429 em `/custom-fields`; 3 ficou lento demais. Em PROD preferir rate ≤3–4 (`NOVO_CRM_API_RATE_PER_SECOND`), não 8. Se 429 voltar → 3; se sobrar folga → testar 6 via env.
- **Arquivos:** `data/novo-crm-prod-ids.json`, `novoCrmFlagsStageSyncService.js`, `novoCrmPersonCacheRepository.js`, `routes/maintenance.js`, `maintenanceApi.ts`, `NovoCrmSyncPanel.tsx`, `.env.example`.

### 2026-07-30 — Dedupe de duplicados (`scope=duplicates`): mesma pessoa, dois cartões completos
- **Modelo usado:** Opus 5 (principal).
- **Problema:** auditoria da etapa **Sem Rematricula** (Kanban 7.493 × relatório 6.997) achou **55 pessoas com 2+ cartões = 73 cartões sobrando** só nessa etapa. Conferido ao vivo campo a campo: **23/23 dos pares no mesmo cadastro têm RGM e curso iguais** — não é multi-curso, é duplicata. Padrão: um card criado pela automação do CRM na conversa que entrou (título `Negócio <apelido>`, `contact.source=CSV Atendimento`, criado no mesmo instante da `conversation`) + um card criado pelo nosso provisionamento (título com o nome completo). O fields sync noturno preencheu CPF/RGM nos **dois**.
- **Por que o dedupe não pegava:** ele só varre dois baldes — contact **sem** deal (órfão) e contact com deal **sem CPF/RGM** (incompleto). Dois cards completos não caem em balde nenhum, e o dedupe nunca comparava dois deals do **mesmo** contact entre si.
- **Decisão:** novo `scope=duplicates` (incluído em `both`) em `novoCrmOrphanAlunoProvisionService.js`. Agrupa por **RGM do deal** entre etapas **mexíveis** (exclui Ganho/Cancelado via `isUntouchableStageId` + Perdido); grupo com 2+ cards → confere **cada card ao vivo** (`liveDealForDedupe`: stage, RGM, dono, campos preenchidos, notes/activities, e-mail/telefone/conversas do contato) e move os perdedores para **Perdido** com `updateDeal({ stageId })`. Falha de leitura = grupo inteiro pulado (`dup_live_unknown`). Multi-curso não é afetado: RGMs diferentes = grupos diferentes.
- **Regra de sobrevivência (score, maior vence):** dono atribuído `+1000` → campos SIAA preenchidos `×10` → e-mail válido `+30` → telefone BR plausível `+20` → **conversa `+15`** → notes/activities `+5`; empate resolve pelo **mais antigo**, depois menor `number`.
- **Trava de nome:** mesmo RGM+CPF não basta — CPF/telefone de assessoria gera pares tipo CHARLES×SARA. Só dedupe se `namesPlausiblyMatch` (ou mesmo `contact_id`). Grupo com nomes divergentes → `dup_name_mismatch` (não move).
- **Por que conversa não decide:** a `conversations` fica no **contato**, não no negócio, e **não se perde** quando o card vai para Perdido. Nos pares de cadastros diferentes o card com conversa costuma ser o cadastro **pior** — ex.: RGM 48876691, `Lead #21136153` **sem e-mail** e telefone truncado `+558881373821` (7 campos) contra o cadastro completo com 10 campos. O score mantém o cadastro bom nos três pares auditados (#62172, #68422, #71159) e ainda assim, no empate por idade, preserva o card nascido junto da conversa nos pares do mesmo cadastro.
- **Cadastro duplicado não é fundido nem apagado** — só o negócio dele vai para Perdido (decisão do operador, 30/07).
- **Contadores:** `dup_deal_groups`, `dup_deals_extra`, `dup_cross_contact`, `dup_resolved_live`, `dup_live_unknown`, `dup_stopped_at_max`, `dup_deals_would_move_perdido` / `dup_deals_moved_perdido` + amostras `type:'dup_deal'` com score dos dois lados. Cap `NOVO_CRM_DEDUPE_MAX_MOVES` (default 1000).
- **Achado paralelo (não é bug nosso):** dos 521 cards **sem CPF/RGM** na etapa, ~379 são **não-alunos** — conversas de entrada que a automação do CRM cria direto em Sem Rematricula. Isso é correção do lado do CRM, não do sync.
- **Arquivos:** `novoCrmOrphanAlunoProvisionService.js`, `server/routes/maintenance.js`, `src/services/maintenanceApi.ts`, `src/components/NovoCrmSyncPanel.tsx`.

### 2026-07-30 — Dedupe de incompletos: travas de identidade + conferência ao vivo antes de escrever
- **Modelo usado:** Opus 5 (principal).
- **Problema:** auditoria dos 1.666 "com negócio mas sem CPF/RGM" mostrou que a decisão saía **só do espelho + match por e-mail/telefone**, sem validar de quem é o dado. Três falhas concretas:
 1. **Chave compartilhada:** telefone `11993894205` aparece no SIAA para **LUIZ HENRIQUE** e **PEDRO SILVA BARBOSA**; o serviço pegava `items[0]` (ordem arbitrária do Map) e escreveria o RGM de um no deal do outro.
 2. **Pessoa errada:** contact **"Luiz Henrique de Lima Junior"** casou pelo e-mail `pedrosbarbosa05@gmail.com` → receberia o **RGM do Pedro**.
 3. **Espelho defasado:** 63 dos 245 enrich já tinham CPF/RGM **corretos no CRM** (write inútil); amostra live mostrou também CPF corrompido `"9"` no deal — esse sim precisa ser sobrescrito.
- **Decisão:**
 - **Ambiguidade:** se a chave casada (e-mail/telefone) aponta para **mais de um aluno distinto** no SIAA, não escreve nada (`incomplete_ambiguous`). Não há como saber de quem é o CPF/RGM.
 - **Nome plausível (`namesPlausiblyMatch`):** nome de contact no CRM é quase sempre apelido ("Bia", "Luh Oliveira", "rubensrock"), então **não** dá para exigir igualdade. Rejeita só o caso perigoso: contact com **2+ tokens** (nome completo plausível) que **não compartilha nenhum token** (igual ou prefixo, ≥3 letras) com o nome da fonte. Apelido de 1 token passa — a evidência ali é o telefone/e-mail. Vale para o nome SIAA (enrich) e para o nome do sibling (Perdido).
 - **Conferência ao vivo antes de escrever** (`liveDealIdentity`, sob o mesmo `liveCheck`, vale **também em dry-run**):
 - *Enrich:* lê o deal ao vivo; campo com valor **confiável** já preenchido não é reescrito (`incomplete_live_already_ok`); valor confiável **diferente** do SIAA vira `incomplete_live_conflict` e **não** sobrescreve; valor vazio ou lixo (CPF ≠ 11 dígitos, 6+ zeros à esquerda, todos iguais — pega o `"9"`→`00000000009`) é preenchido.
 - *Perdido:* confere etapa e campos ao vivo; deal em etapa intocável/já Perdido ou **com CPF/RGM ao vivo** não é movido (`perdido_skipped_live`). Falha de leitura = não escreve (`*_live_unknown`).
 - **Botão "Aplicar" no card 4** com confirmação inline (mesmo padrão do card de leads novos, pelo motivo do iframe já documentado). Prévia e apply usam o mesmo job assíncrono e o mesmo endpoint (`dry_run=0&async=1`).
- **Efeito medido (dry-run PROD, 30/07):** enrich **245 → 180** (63 já ok ao vivo, 1 ambíguo, 1 nome divergente); Perdido **12 → 9 negócios** (3 tinham identidade ao vivo); `incomplete_live_conflict=0`.
- **Contadores novos:** `incomplete_ambiguous`, `incomplete_name_mismatch`, `incomplete_live_already_ok`, `incomplete_live_conflict`, `incomplete_live_unknown`, `perdido_skipped_live`, `perdido_live_unknown` + `skip_samples` no result.
- **Arquivos:** `novoCrmOrphanAlunoProvisionService.js`, `src/services/maintenanceApi.ts`, `src/components/NovoCrmSyncPanel.tsx`, `scripts/novo-crm-orphan-aluno-dryrun.mjs`.
- **Lição:** match por e-mail/telefone identifica *o contato*, não *o aluno* — antes de escrever CPF/RGM confirmar que a chave é exclusiva e que o CRM não tem valor bom ali.

### 2026-07-30 — Falsos órfãos: full sync perdia deals; prévia do dedupe passa a conferir ao vivo
- **Modelo usado:** Opus 5 (principal).
- **Problema:** prévia do dedupe (`scope=both`) propunha **1.272 deals novos** para "órfãos". Auditoria ao vivo: **60/60** da amostra **já tinham deal no CRM**, com o **mesmo RGM** que seria criado (ex.: Daniela #65216 / RGM 39792331; Jacira #71102 / 47928417). Cruzando pelo espelho, só 180 pareciam ter RGM em uso — o espelho é que estava errado.
- **Causa raiz (espelho, não CRM):** `loadAllDealsByContactId` pagina **todos** os deals (`perPage=100`) antes de varrer contacts. Duas falhas somadas:
 1. **Parada precoce:** `if (res.items.length < 100) break` — página curta no meio (ordenação instável / deriva) encerrava o índice.
 2. **Deriva de paginação sem dedupe:** probe de 395 páginas devolveu 39.465 itens mas só **39.264 ids únicos** (201 duplicados = 201 perdidos em ~100 s). Numa run de ~3,5 h a perda escala.
 Contact sem deal no índice → `mapApiSnapshot` grava snapshot **sem deals** → `upsertSnapshot` sobrescreve (data-loss é logado mas não bloqueia) → contact vira **falso órfão**. Espelho tinha 37.793 deals contra **39.465** na API (~1.672 a menos ≈ os 1.453 falsos órfãos).
- **Não é** o `NOVO_CRM_DATABASE_URL`: aquele banco é de outra org/defasado (max deal 49.067, os contacts nem existem lá) e **não** é usado — `NOVO_CRM_CACHE_SOURCE=api`.
- **Decisão:**
 - **Paginação de deals:** só encerra em página vazia ou `page >= totalPages`; dedupe por `deal.id`; loga quando `seen < total`.
 - **Verificação por contact:** no full sync via API, contact que ficou **sem deal** no índice em lote é conferido com `listDealsForContactId` antes de gravar (`NOVO_CRM_CACHE_VERIFY_EMPTY_DEALS=1` default). Contadores `empty_deals_verified` / `deals_recovered`.
 - **Contacts também não param cedo:** `if (res.items.length < contactPerPage) break` virou `page >= totalPages`.
 - **Prévia do dedupe confere ao vivo:** o live-check do path órfão passa a valer **também em dry-run**; quem já tem deal é sincronizado no espelho via `warmContactFromLive` e sai da conta (`skipped_already_has_deal_live`, `warmed_cache`).
 - **Prévia vira job assíncrono** (`dry_run=1&async=1` → jobId + polling), porque a verificação ao vivo leva minutos. UI mostra progresso e resultado em texto claro.
 - **Warm compartilhado:** novo `server/services/novoCrmCacheWarmService.js#warmContactFromLive` (contact + deals + campos → `upsertSnapshot`), reusável por provision, dedupe e reparo.
- **Reparo do estoque atual:** `scripts/novo-crm-repair-missing-deals.mjs` (`--dry`, `--limit=`) varre quem está sem negócio no espelho, confere ao vivo e re-sincroniza. Run 30/07: dos 1.453, ~96% tinham deal — o reparo também recupera CPF/RGM dessas linhas.
- **Arquivos:** `novoCrmPersonApiSourceRepository.js`, `novoCrmPersonCacheSyncService.js`, `novoCrmOrphanAlunoProvisionService.js`, `novoCrmCacheWarmService.js`, `server/routes/maintenance.js`, `src/services/maintenanceApi.ts`, `src/components/NovoCrmSyncPanel.tsx`, `scripts/novo-crm-repair-missing-deals.mjs`.
- **Lição:** número de "órfão" saído só do espelho não é confiável para escrita em massa — confirmar ao vivo antes de criar (mesmo princípio já adotado em `mode=new`).

### 2026-07-30 — Leads novos (`mode=new`): dedup por RGM + anti-dupe por telefone/e-mail
- **Modelo usado:** Opus 5 (principal).
- **Problema:** prévia de `mode=new` listava 47 pessoas, mas **27 já existiam no CRM** (ex.: deals #103440/#103441, criados 28/07 pelo fluxo CSV Atendimento, com CPF/RGM já preenchidos). Duas causas somadas:
 1. **Seleção só por CPF:** `existingCpfs` vinha de `loadExistingCpfRgmSets()` mas o `rgms` era ignorado. Nessas 27 pessoas o `cpf_norm` do espelho está **corrompido** (`00000000009` — valor curto no campo CPF do deal + `padStart(11,'0')`), enquanto o `rgm_norm` está correto → passavam como novas. Espelho tem **119** linhas com RGM válido e CPF inválido/ausente (65 delas com `00000000009`).
 2. **Anti-dupe inútil:** o pré-create fazia só `searchContacts(cpf)`, que retorna **0** — o CPF vive no campo do *deal*, a busca de contact não indexa. Resultado: criaria contact + deal duplicados (mesmo padrão do incidente de 28/07).
- **Decisão:**
 - Dedup de seleção considera **CPF ou RGM** do espelho (`skipped_cache` / `skipped_cache_rgm`). RGM é obrigatório porque é o campo confiável quando o CPF do espelho está corrompido.
 - Anti-dupe pré-create passa a ser `findExistingContact({ cpf, phone, email })`: tenta **CPF → e-mail → telefone**. E-mail/telefone são os termos que a busca de contact realmente indexa (validado: telefone acha 1 hit exato; CPF acha 0). Telefone por último.
 - **Validação obrigatória do hit:** a busca é fuzzy — termo que não casa devolve a **primeira página inteira** (20 contatos aleatórios; reproduzido com e-mail AD). Só reusa o contact se o telefone/e-mail dele confere, ou se a busca devolveu **um único item** (retorno exato). Sem isso, o provision reusaria um contact aleatório.
 - Chave de telefone = DDD + 8 últimos dígitos (unifica `+55` e o 9 do celular; mesma canonização de `normalize_phone_br`).
 - **Verificação live antes de criar (decisão posterior no mesmo dia):** como outros cenários criam leads durante o dia e o full sync é noturno, a prévia roda como job assíncrono e consulta ao vivo cada candidato que passou pelo espelho. Hit live é sincronizado cirurgicamente em `novo_crm_person_cache` via `mapApiSnapshot` + `upsertSnapshot` e removido da criação. O card encontrado **não é alterado**; campos SIAA seguem no sync noturno. O apply repete a busca live imediatamente antes do create (race safety).
 - **Confirmação inline (não `window.confirm`):** a app roda em iframe cross-origin dentro do dcz-crm-sync; diálogo nativo disparado fora de gesto do usuário (callback do polling) é **suprimido pelo Chrome e `confirm()` retorna `false`** — dava "Criação cancelada" sem o operador ver nada. A prévia agora renderiza um bloco de confirmação no próprio card 3 com botões "Criar N leads" / "Descartar".
 - **Contadores novos:** `skipped_cache_rgm`, `matched_by_cpf`, `matched_by_phone`, `matched_by_email`, `search_fuzzy_rejected`.
- **Validado (dry-run PROD, 30/07):** 47 → **20 realmente novos** + `skipped_cache_rgm=27`. Busca por telefone: existente → 1 hit validado; inexistente → 0 itens (cria).
- **Pendente (não corrigido aqui):** os 119 `cpf_norm` corrompidos no espelho continuam corrompidos — `normalizeCpf` com `padStart(11,'0')` transforma lixo curto (ex. `9`) em CPF falso. Reavaliar piso mínimo de dígitos no padStart.
- **Arquivo:** `server/services/novoCrmMatriculadosProvisionService.js`.

### 2026-07-30 — Att de etapas: etapa Sem Rematricula sincroniza Situação em par
- **Modelo usado:** Executor (Sonnet 4.6).
- **Problema:** `mode=flags_stage` movia a etapa para **Sem Rematricula** mas deixava o carousel *Situação* intocado (ex.: "Em Curso") porque `fieldValues` só é construído com `doFields=true`. O campo permanecia divergente até o próximo `fields` noturno.
- **Decisão:** Quando `doFlags && classification.stageName === 'Sem Rematricula'` e `fieldIds.situacao` está mapeado, o serviço insere automaticamente `{ fieldId: fieldIds.situacao, value: 'Sem Rematrícula' }` na fila de escrita do deal, independente de `doFields`. Condições:
  - Só ocorre se o carousel no cache já **não** for `'Sem Rematrícula'` (comparação via `normalizeSituacaoCrm`), evitando write desnecessário.
  - Se `doFields=true` (mode=`both`) e `fieldValues` já inclui `fieldIds.situacao`, o entry NÃO é duplicado.
  - A escrita acontece mesmo se a etapa já estiver correta (situação pode estar errada independentemente).
- **Contadores novos:** `situacao_sem_remat_updated` (apply) / `situacao_sem_remat_would_update` (dry-run). Expostos no result e contabilizados na fila de trabalho (`needsSemRematSituacao`).
- **Arquivo:** `server/services/novoCrmFlagsStageSyncService.js`.
- **Imports adicionados:** `SITUACAO_CRM_SEM_REMATRICULA`, `normalizeSituacaoCrm` de `novoCrmFieldMapping.js`.

### 2026-07-29 — Dedupe órfãos/incompletos por telefone + e-mail (scope orphans|incomplete|both)
- **Modelo usado:** Executor (Sonnet 4.6).
- **Problema:** ~1.041 contacts órfãos (sem deal) e ~3.039 contacts incompletos (deal sem CPF/RGM no espelho) precisavam de tratamento estruturado. Match anterior era só por e-mail; telefone ficava fora.
- **Regras implementadas:**
  - Match: e-mail **ou** telefone (matriculados index `byEmail` + `byPhone`). CPF/RGM usados apenas para sibling lookup.
  - **Órfão (sem deal):**
    - Sibling cobre todos os RGMs → `dup_skip_no_deal` (NÃO cria deal Perdido fantasma, NÃO apaga contact).
    - Sibling falta algum RGM → cria deal(s) no sibling.
    - Sem sibling → cria deal(s) no próprio órfão.
  - **Incompleto (tem deal, sem CPF e/ou RGM):**
    - Sibling com score de completude maior → `dup_to_perdido`: move deal(s) do contact ruim para etapa **Perdido** (via `updateDeal({ stageId: perdidoStageId })`); respeita `isUntouchableStageId`; pula se já Perdido.
    - Sem sibling melhor → empty-only fill CPF/RGM no deal primário via `updateDealCustomFields`.
  - Nunca cria segundo contact. Nunca apaga contact.
- **Scope:** `orphans` (compat. com endpoint existente) | `incomplete` | `both`. Default endpoint: `orphans` (compat); novo dedupe UI usa `both`.
- **Contadores novos no result:** `scope`, `matched_email`, `matched_phone`, `dup_skip_no_deal`, `dup_to_perdido`, `deals_would_move_perdido` / `deals_moved_perdido`, `incomplete_total`, `incomplete_scanned`, `incomplete_no_match`, `incomplete_enriched`, `index.by_phone`.
- **Dry-run PROD (29/07):** orphans=1.041 · aluno=1.029 · dup_skip_no_deal=156 · dup_to_perdido=42 · deals_would_move_perdido=30 · deals_create_orphan=869 · deals_create_sibling=7 · incomplete=3.039 · sem_match=1.114 · enriched=1.780. Sem erros.
- **Rota:** `POST /api/maintenance/provision-orphan-alunos-novo-crm?scope=both&dry_run=1` (prévia) / `?scope=both&dry_run=0&async=1` (apply). Parâmetro `scope` em query ou body.
- **UI:** botão "Prévia dedupe (scope=both)" no `NovoCrmSyncPanel` (card 4), exibe contadores inline.
- **Script:** `scripts/novo-crm-orphan-aluno-dryrun.mjs [maxCreates] [--scope=both]`.
- **Arquivos:** `novoCrmOrphanAlunoProvisionService.js`, `server/routes/maintenance.js`, `src/services/maintenanceApi.ts`, `src/components/NovoCrmSyncPanel.tsx`, `scripts/novo-crm-orphan-aluno-dryrun.mjs`.
- **Nota:** a entrada «28/07 — Enrich por e-mail + provisionamento de órfãos aluno» é supersedida nesta parte pelo match telefone + regra incompleto→Perdido acima.

### 2026-07-29 — Att de etapas rápida + Retenção CAA só 72h
- **Modelo usado:** Composer/Grok.
- **Problema:** Att de etapas fazia `updateDealCustomFields` + `getDeal` em quase todo deal matched (~36k) → horas a 3 rps. CAA `open` sem janela inchava Retenção (estoque velho ~852 open).
- **Performance:** no apply `flags_stage`, só escreve flags se valor **já conhecido no cache** e divergir (não reescreve flag vazia); confia no `stageId` do espelho (sem `getDeal`, opt-in `NOVO_CRM_FLAGS_SYNC_LIVE_STAGE=1`); fila de escrita com concurrency default **8** (`NOVO_CRM_FLAGS_SYNC_CONCURRENCY`); deal alinhado → 0 calls. Em PROD Att: sugerir `NOVO_CRM_API_RATE_PER_SECOND=8`.
- **Regra Retenção:** CAA open com T0=`first_seen_at` e idade ≤ **72h** (`NOVO_CRM_CAA_RETENCAO_HOURS`) → Retenção. Após 72h: **não** força Retenção — segue SIAA (Cancel/Tranc → Perdido; Em curso → remat/acolhimento/Pós/Graduação). Untouchable global: **Ganho + Cancelado** apenas. Já em Retenção **sem** CAA open = manual/outra automação → não mexe. Já em Retenção **com** CAA open >72h → pode sair para SIAA/Perdido.
- **T0 Retenção (decisão 29/07):** `caaProtocolT0` usa exclusivamente `first_seen_at` — o momento do nosso primeiro upload do protocolo. `data_chegada` (campo Excel) foi removido do T0 porque não reflete o instante real de entrada no fluxo operacional. `data_chegada` inválida/vazia não causa fallback; se `first_seen_at` estiver ausente, retorna `null` (protocolo fica fora da janela de Retenção).
- **Arquivos:** `caaProtocolsRepository.js` (`caaProtocolT0`, `loadOpenCaaT0Map`), `novoCrmStageRules.js`, `novoCrmFlagsStageSyncService.js`, provision/orphan callers, `NovoCrmSyncPanel.tsx`.

### 2026-07-28 — classifyMatriculado: CAA pendente → etapa Retenção
- **Modelo usado:** Composer/Grok.
- **Status:** **Supersedida em 29/07** — ver «Att de etapas rápida + Retenção CAA só 72h». Retenção deixa de ser para qualquer CAA open e deixa de ser untouchable global.
- **Regra original:** Att de etapas / provision atribuía Retenção a qualquer `caa_protocols.status='open'`. Untouchable: Ganho/Retenção/Cancelado.

### 2026-07-28 — INCIDENTE: orphan-apply spam de deals no sibling + TRANCADO→Graduação
- **Modelo usado:** Composer/Grok.
- **Caso:** EVERTON FERNANDO TEIXEIRA MIRANDA (`evertonftm@hotmail.com`) — contact bom `cmrwwb42efm4ptb01rhys1ivb` já tinha Lead de Entrada **#86214** (23/07, RGM `45170339`). Orphan-apply (28/07) criou **6 deals extras** Graduação no mesmo contact (#101173, #103071, #103088, #103394, #103395, #103462). Situação SIAA = **Trancado**; carousel às vezes gravou `Trancado`, stage ficou **Graduação** (errado). Mesmo padrão em sibling `flordeluciana@hotmail.com` (5 deals hoje).
- **Causa raiz (combo):**
  1. Path `extra_deal_on_sibling` decidia “RGM faltando” só com **cache local stale** (`siblingRgms` / `rgmsOnCacheRow`) — não lia deals live no CRM. #86214 já tinha RGM no PROD; cache da run não via → criava de novo.
  2. Script `novo-crm-orphan-apply.mjs` rodava com `NOVO_CRM_ORPHAN_SKIP_FIELDS=1` + `LIVE_CHECK=0` + **várias runs sobrepostas** (offset 0/1150). Deals novos saíam **sem CPF/RGM** → mesmo após create, dedupe por RGM continuava falhando → spam.
  3. `classifyMatriculado` só mandava **CANCELADO→Perdido**; **TRANCADO** caía no default Graduação/Pós. `resolveSituacaoCrm` já mapeava carousel `Trancado` corretamente.
- **NÃO foi:** match de e-mail pra pessoa errada (1 linha matriculados, mesmo CPF/RGM); nem `mode=new` do provision diário.
- **Fix código:**
  - `classifyMatriculado`: TRANCADO → stage **Perdido** (carousel continua `Trancado`).
  - Orphan provision: identidade **live** no sibling (list deals + RGM/CPF); claim in-memory `${contactId}:rgm:…`; com `SKIP_FIELDS=1` ainda grava **CPF+RGM** (mínimo pro dedupe); script apply default `LIVE_CHECK=1`, `SKIP_FIELDS=0`.
- **Cleanup (NÃO auto-deletar):** listar candidatos → aprovação humana. Everton: manter #86214 (mover p/ Perdido + situacao Trancado); deletar #101173/#103071/#103088/#103394/#103395/#103462; contact órfão dup `cmrxr849t11tdo401lqqa8bi4` (+ deal #89146) é candidato a remoção/merge. Blast amostral: 2/2 siblings nos samples dos logs full tinham 2+ deals criados em 28/07.
- **Nota ops:** `NOVO_CRM_DATABASE_URL` local pode estar **atrás** do PROD API (max deal DB ~49k vs API ~103k) — auditoria de incidente deve preferir API `crm.eduit.com.br`.
- **Arquivos:** `novoCrmStageRules.js`, `novoCrmOrphanAlunoProvisionService.js`, `scripts/novo-crm-orphan-apply.mjs`.

### 2026-07-28 — Remodel Sync Novo CRM: noite (cache+campos) ≠ dia (3 botões)
- **Modelo usado:** Composer/Grok.
- **Supersede:** receita PROD de 23/07 que ligava **PROVISION noturno**. Provision automático de noite fica **OFF** — matriculados é D−1; matrículas do dia já chegam no CRM (CPF/telefone) por outro fluxo; criar em massa à noite a partir do snapshot é timing errado.
- **Noite (automático):**
  1. **Cache sync (espelho)** — puxa contacts/deals/fields pro Postgres local (`NOVO_CRM_CACHE_ENABLED=1`, full ~02:00 BRT).
  2. **Fields att** — snapshot matriculados D−1 atualiza campos SIAA em quem **já** está no funil (`NOVO_CRM_FIELDS_SYNC_ENABLED=1`, ~05:00 BRT).
  3. **Sem provision noturno** — `NOVO_CRM_PROVISION_ENABLED=0` (cron não cria gente).
  4. **FLAGS/etapas** — cron permanece OFF (`NOVO_CRM_FLAGS_SYNC_ENABLED=0`).
- **Dia (Disparador — 3 botões claros):**
  1. **Full Sync** → `POST /api/maintenance/sync-novo-crm-cache?mode=full&async=1` (só espelho local).
  2. **Att de etapas** → `POST /api/maintenance/sync-flags-stage-novo-crm?mode=flags_stage&dry_run=0&async=1` (flags + estágio a partir de financeiro/docs/BB/evasão/rematrícula). Escrita manual: gate de host (`ALLOW_PROD`); não exige `FLAGS_SYNC_ENABLED`.
  3. **Criação de leads novos** → `POST /api/maintenance/provision-matriculados-novo-crm?mode=new&dry_run=0&async=1` (+ status GET). Cap default **200**/run (`NOVO_CRM_PROVISION_NEW_MAX_PER_RUN`).
- **Regra de seleção `mode=new`:**
  1. CPF no snapshot **mais recente** de matriculados.
  2. CPF **ausente** de `novo_crm_person_cache` (espelho).
  3. Se existir snapshot anterior: restringe ao **delta** (CPF não estava no anterior).
  4. Contact já no CRM (busca API) → **atualiza card** (campos no deal; cria deal se faltar). Não cria 2º contact.
  5. `mode=all` = backlog/backfill (exige `PROVISION_ENABLED=1`; não é o fluxo diário).
- **UI:** `NovoCrmSyncPanel` — copy separa espelho ≠ att campos (noite) ≠ etapas ≠ leads novos; KPIs do cache são status (não “clique pra enriquecer”).
- **Campo Situação (carousel do deal):** se o aluno está no snapshot **rematrícula** (SIAA/Portal mais recente) → grava **`Sem Rematrícula`** (`SITUACAO_CRM_SEM_REMATRICULA` / `resolveSituacaoCrm`); senão mantém situação SIAA normalizada (ex. `Em Curso`). Mesma regra em fields sync noturno, enrich (empty-only), provision/leads novos e orphan provision — alinha o campo com a etapa `Sem Rematricula` do `classifyMatriculado`.
- **Arquivos:** `novoCrmMatriculadosProvisionService.js`, `maintenance.js`, `NovoCrmSyncPanel.tsx`, `maintenanceApi.ts`, `.env.example`, `server/index.js`.
- **Easypanel PROD:** garantir `NOVO_CRM_PROVISION_ENABLED=0`, `NOVO_CRM_FLAGS_SYNC_ENABLED=0`, manter CACHE + FIELDS_SYNC ligados.

### 2026-07-28 — Bugfix: `getNovoCrmStageIds`/`getNovoCrmDealFieldIds` caindo em IDs de DEV contra PROD
- **Contexto:** batch de provisionamento de órfãos rodou com `created_deals=0, errors=3244`, todos `"Referência inválida (estágio, contato ou responsável)"`. `NOVO_CRM_API_BASE_URL` apontava pra `crm.eduit.com.br` (PROD) mas o `.env` não tinha `NOVO_CRM_STAGE_*`/`NOVO_CRM_FIELD_*` — `novoCrmStageRules.js#envId` caía no fallback hard-coded de DEV (`cmrtilckh...`), que não existe no CRM PROD. `scripts/_applyNovoCrmProdIds.mjs` existia pra corrigir isso mas não era chamado por nenhum caller real (nem `apply-fast.mjs`, nem os scripts de orphan apply).
- **Fix:** `envId()` em `server/utils/novoCrmStageRules.js` ganhou detecção de host (`isProdCrmHost()`) — se `NOVO_CRM_API_BASE_URL` é `crm.eduit.com.br` (ou subdomínio) e não há env var explícita, lê o ID de `data/novo-crm-prod-ids.json` (stages+fields merged). Se o ID também não existir lá, retorna `''` — **nunca** cai no fallback DEV em PROD (IDs de DEV não existem em PROD; melhor falhar visível/vazio do que criar deal na etapa errada). Fallback DEV só se aplica quando o host não é PROD.
- **Validado:** rodando `novo-crm-orphan-apply.mjs` após o fix, os erros de "Referência inválida" desapareceram completamente (0 erros de stage; erros restantes eram só `429 Limite de requisições excedido`, esperado sob concorrência). ~991 deals criados nas runs de correção (685+304+2), restando só órfãos sem match real (não-aluno) ou já cobertos por sibling.
- **Nota operacional:** qualquer script novo que chame `createDeal`/`updateDealCustomFields` direto (sem passar por `novoCrmStageRules.js`) deve usar `getNovoCrmStageIds()`/`getNovoCrmDealFieldIds()` — não hardcodear IDs nem confiar em env vars que podem faltar.
- **Achado à parte (não é bug, confirmado benigno):** `dotenv@17.4.2` imprime `injected env (N) from .env // tip: <dica aleatória>` a cada load — array `TIPS` hard-coded no próprio `node_modules/dotenv/lib/main.js` (inclui até link promocional `vestauth.com`). Não é telemetria maliciosa nem dependência comprometida, é "feature" de marketing do dotenv upstream. Ignorável.

### 2026-07-28 — Enrich por e-mail + provisionamento de órfãos aluno (deals faltando)
- **Contexto:** dos ~3.390 contacts órfãos (sem `primary_deal_id`), ~3.229 batem por e-mail com o snapshot matriculados. Só ~12 são duplicata de contact (outro contact já tem deal da mesma pessoa via email/cpf/rgm) — nesses o órfão é ignorado. Os ~3.217 restantes precisam de deal(s) criado(s) no próprio órfão. Multi-curso é raro (~21 pessoas); regra: 1 contact, N deals (1 por RGM/curso).
- **Enrich (`novoCrmEnrichmentService.js`):** `buildMatriculadosIndex` ganhou `byEmail` (chave `normalizeEmail(mapped._email)` e `mapped.e_mail_ad`); `matchMatriculado` tenta e-mail (contact `email_norm` ou `raw_data.contact.email`) como último fallback, depois de cpf/rgm/phone. Preenchimento continua empty-only; `result.index.by_email` exposto.
- **Provisionamento de órfãos (`novoCrmOrphanAlunoProvisionService.js`, novo):** varre contacts sem deal, casa por e-mail (pessoal ou acadêmico) com matriculados. Para cada órfão-aluno:
  1. Busca **sibling** — outro contact que JÁ tem deal e compartilha email/cpf/rgm (rgm/cpf lidos de TODOS os deals do sibling, não só o primary).
  2. Sibling cobre todos os RGMs do aluno → `dup_contact_skip` (não cria nada; não apaga/mescla o órfão, só não grava).
  3. Sibling cobre parte → cria os deals que faltam **no sibling** (multi-curso: contact bom recebe o 2º curso).
  4. Sem sibling → cria 1 deal por RGM distinto **no próprio órfão** (fill de todos os campos mapeados + etapa via `classifyMatriculado`, igual ao provisionamento normal).
  - **Nunca cria um 2º contact.** Não-alunos (sem match de e-mail) são ignorados. Reaproveita `extractMatriculadosMappedValues`, `classifyMatriculado`, `getNovoCrmDealFieldIds`, `titleCasePolo`, `createDeal`/`updateDealCustomFields`; gate de escrita via `isNovoCrmWriteAllowedOnThisHost` (mesmo do provision).
  - Rota: `POST /api/maintenance/provision-orphan-alunos-novo-crm?dry_run=1|0&async=1&max=` (+ status GET), padrão igual ao `enrich-novo-crm` (dry síncrono, apply em job assíncrono).
  - Dry-run real (28/07): 3.390 órfãos, 3.237 aluno-por-email, 10 dup_contact_skip, 3.242 deals a criar no órfão, 2 no sibling — bate com a auditoria prévia (pequena variação por incluir e-mail acadêmico no match).
- **Script:** `scripts/novo-crm-orphan-aluno-dryrun.mjs` (dry-run isolado, só lê banco).

### 2026-07-28 — Diagnóstico Sync Novo CRM (full #21 + gaps CPF/RGM/Graduação)
- **Contexto:** Full sync #21 (28/07 02:00→05:40 BRT, ~220 min, status ok). UI Kanban Graduação 16.550 vs cache 13.675 (Δ≈2.875); demais etapas Acadêmico batem. Graduação ~95% sem owner; criação em massa 23/07 (~12k) via provision. FLAGS/etapas OFF.
- **Painel Sync (cache ativo 34.402):** Sem CPF 6.757 · Sem RGM 4.488 · “Campos incompletos” 6.909 · Alertas data-loss 28.779 abertos.
- **Por que tantos Sem CPF (quebra):**
  1. **~3.390 sem deal** — contact no CRM sem negócio; sync não inventa CPF/RGM.
  2. **~1.058 com deal mas campo CPF vazio** no CRM (Lead de Entrada/Atendimento/parcial).
  3. **~2.309 com CPF no custom field mas `cpf_norm` vazio** — bug: valores com **9–10 dígitos** (zero à esquerda perdido); `normalizeCpf` exigia 11. **Corrigido 28/07:** `padStart(11,'0')` + reprocess cache → **2.294 fixados**; Sem CPF **6.757 → 4.463**.
- **Sem deal ≠ duplicata:** dos 3.390, só **33** batem phone/email com contact que já tem deal; **24** duplicata só entre órfãos; **3.333** órfãos únicos.
- **Sem RGM no CRM (deal com campo vazio) = 1.098:** cruzado telefone × `mv_aluno_por_telefone` → **30 alunos**, **1.068 não alunos** (683 Lead de Entrada; 221 em etapas acadêmicas). Lista: `data/sem-rgm-nao-alunos.csv` + canvas `sync-gaps-cpf-rgm`.
- **“Campos incompletos” no KPI:** SQL rápido = falta CPF **ou** RGM **ou** phone **ou** email **ou** nome (não são os 10 campos do enrich).
- **Alertas:** `upsertSnapshot` **loga** regressão mas **ainda sobrescreve** o snapshot.
- **Pendente:** investigar Δ Graduação UI vs cache; opcional merge-preserve no upsert; decidir limpeza dos 1.068 não-alunos / 3.333 órfãos.
- **Modelo:** Composer/Grok.

### 2026-07-23 — Novo CRM PROD: sync noturna calm (cache + provision + fields; FLAGS off)
- **Status:** **Parcialmente supersedida em 28/07/2026** — PROVISION noturno sai da receita PROD; criação diária vira botão `mode=new`. Ver decisão «Remodel Sync Novo CRM» acima. CACHE + FIELDS_SYNC + FLAGS off permanecem.
- **Modelo usado:** Composer/Auto.
- **Pedido (histórico):** sync noturna PROD de contacts/deals + correção de campos SIAA; etapas manuais de dia.
- **Decisão original:**
  - Ligar **CACHE** + **PROVISION** + **FIELDS_SYNC**; **FLAGS_SYNC OFF**.
  - Gate PROD: `NOVO_CRM_PROVISION_ALLOW_PROD=1` + URL explícita.
  - Ritmo calm: `NOVO_CRM_API_RATE_PER_SECOND=2`, concurrency baixa.
  - Cron stagger antigo: cache **05** → provision **07** → fields **08** (UTC).
- **Arquivos:** defaults em `novoCrmPersonCacheSyncService`, `novoCrmMatriculadosProvisionService`, `novoCrmFlagsStageSyncService`; receita em `.env.example`.

### 2026-07-16 — Novo CRM: cache local Postgres→Postgres para ativação por tag
- **Modelo usado:** GPT-5.5.
- **Problema:** ativação por tag no Novo CRM fazia lookup `GET /api/contacts?search=...` pessoa a pessoa; lotes grandes ficavam lentos e dependentes da API HTTP.
- **Decisão:** criar espelho local `novo_crm_person_cache` com contact + deals + custom fields do Postgres CRM EduIT. A ativação resolve em lote no cache local; misses aquecem o cache com uma consulta em lote ao Postgres CRM; só a escrita da tag continua via API oficial.
- **Operação:** full sync é noturno e **pode demorar ~1h**. Prioridade = gentileza/completude: lotes ~300, `NOVO_CRM_CACHE_BATCH_DELAY_MS`, sem paralelismo agressivo. Incremental leve roda durante o dia.
- **Auditoria:** antes de sobrescrever snapshot, qualquer campo de negócio antes preenchido que fique vazio/ausente cria evento em `novo_crm_data_loss_events`; UI de alertas fica para etapa futura, API já existe.
- **Endpoints:** `POST /api/maintenance/sync-novo-crm-cache?mode=full|incremental&async=1`, `GET /api/maintenance/novo-crm-cache-status`, `GET /api/maintenance/novo-crm-cache-regressions`, `POST /api/maintenance/novo-crm-cache-regressions/:id/ack`.
- **Arquivos:** migration `043_novo_crm_person_cache.sql`, `novoCrmPersonSourceRepository.js`, `novoCrmPersonCacheRepository.js`, `novoCrmPersonCacheSyncService.js`, `novoCrmTagActivationService.js`.

### 2026-07-15 — Meu Painel Novo CRM: desfecho via tabulação `Retido?`
- **Modelo usado:** Composer (principal).
- **Decisão:** No modo `crm_fonte=novo_crm`, o Meu Painel **não marca desfecho manualmente**. Consultor tabula ao fechar a conversa no CRM EduIT; o app lê `conversation_close_tabulations`.
- **Regra v1 (só retenção):** `question` ≈ `Retido?` → `answer=Sim` = Retido; `answer=Não` = Não retido; sem linha = Pendente. Outras questions ignoradas (extensível depois via filtro).
- **Lista:** união de (1) ativações em `activation_novo_crm_tag_log`, (2) `campaign_recipients.repliedAt`, (3) contacts com tabulação de retenção no período + (4) snapshot legado `meu_painel_legacy_outcomes` (badge Histórico).
- **Env:** `NOVO_CRM_DATABASE_URL` + `NOVO_CRM_ENABLED=1`; opcional `NOVO_CRM_RETENCAO_QUESTION=Retido?`.
- **Migração:** `POST /api/maintenance/migrate-meu-painel-legacy` (requireApiKey) → tabela `042_meu_painel_legacy_outcomes`.
- **Arquivos:** `server/db/novoCrmClient.js`, `conversationCloseTabulationsRepository.js`, `meuPainelNovoCrmService.js`, `MeuPainelPage.tsx`.
- **Fora de escopo:** Painel Geral/Conversão full no Novo CRM; dual-write de outcome → CRM; outras tabulações além de retenção.

### 2026-07-14 — Ativação no Novo CRM por tag no deal/contact + limpeza stale
- **Modelo usado:** Composer (principal).
- **Contexto:** Disparo WhatsApp migrará pro CRM EduIT (campanhas). O app Disparador mantém painéis; no cutover a ação deixa de enviar template e passa a **taggear**.
- **Decisões:**
  - Tag visível na UI do CRM fica no **contact** (`POST/DELETE /api/contacts/:id/tags`). Quando houver `dealId`, aplica/remove também no deal.
  - Preferir body `{ tagName }` (API aceita `tagId` ou `tagName`).
  - Mapa fixo categoria → tag: `ativacao-caa`, `ativacao-financeiro`, `ativacao-docs`, …
  - **Horário da ativação:** log local `activation_novo_crm_tag_log` (`tag_value` = nome no SET, `''` no CLEAR) — espelho de `activation_origem_ativacao_log`.
  - **Limpeza:** mesma janela `origem_ativacao_stale_hours` (default 72h). Job `cleanStaleActivationTags` + `POST /api/maintenance/clean-stale-activation-tags` + cron 24h. Só remove tags registradas pelo log (não tags manuais soltas).
  - Automação CRM pós-tag: fora de escopo por enquanto.
  - UI cutover: botão vira **“Ativar (tag)”**; aba Disparador **não some ainda**.
  - **Enquanto cutover não ligado:** fluxo DataCrazy + WhatsApp permanece idêntico.
  - **Batch “Ativar (tag)”:** com `crm_fonte=novo_crm` (toggle do Painel), `POST /api/activation/:category/run-datacrazy-batch` deriva para `runNovoCrmTagActivationBatch` (lookup contact/deal por tel/CPF/email → tag; grava `activation_dispatch_events` com `channel=novo_crm_tag`). Body aceita `crm_fonte`. DataCrazy continua default se omitido/`datacrazy`.
- **Arquivos:** `novoCrmClient.js`, `novoCrmTagActivationService.js`, `novoCrmActivationTags.js`, `activationNovoCrmTagRepository.js`, `activationNovoCrmTagCleanupService.js`, migration `041_activation_novo_crm_tag_log.sql`, `ActivationListActions.tsx`, `activationApi.ts`.
- **Alternativas descartadas:** tag só no deal (UI lateral não mostra); setting separado de janela (duplicaria Regras); limpar qualquer `ativacao-*` sem log (apagaria tags manuais); endpoint novo separado do batch (mantém job/async/progresso iguais).

### 2026-07-13 — Toggle DataCrazy ↔ Novo CRM (fonte operacional na migração)
- **Modelo usado:** Composer (principal).
- **Problema:** disparador/painel hoje lê e marca 100% no fluxo DataCrazy; na migração de CRM precisamos (1) preservar histórico DataCrazy, (2) a partir de um gesto explícito passar a operar (KPIs + marcações + webhooks de resposta) no CRM novo.
- **Decisão (fase 1 — infraestrutura, sem credenciais ainda):**
  - Preferência global `crm_fonte` ∈ `{datacrazy, novo_crm}` em `localStorage` (`crm_fonte_v1`), compartilhada entre Painel e Meu Painel.
  - Toggle UI no header do **Painel** (`DataCrazy` | `Novo CRM`).
  - API `POST /api/painel/overview` aceita `crm_fonte`; backend normaliza via `server/utils/crmFonte.js`.
  - `datacrazy` → comportamento atual (zero regressão).
  - `novo_crm` sem config → overview stub (KPIs zerados + alertas) e POST outcomes retorna 503 até fase 2.
  - Env reservados: `NOVO_CRM_ENABLED=1` + `NOVO_CRM_DATABASE_URL` (e demais credenciais a definir com o usuário).
- **Fase 2 (quando houver acessos):** plugar leitura/escrita no banco/webhooks do novo CRM; migrar histórico DataCrazy para leitura unificada; marcações com `crm_fonte=novo_crm` gravam só no novo.
- **Alternativas descartadas:** feature flag só server-side sem UI (operador não controla o cutover); dual-write automático sem toggle (risco de misturar fontes no meio da migração).

### 2026-07-08 — Meu Painel CAA: coluna Wesley/Danubia prevalece sobre payload conflitante
- **Modelo usado:** Opus 4.7 (principal).
- **Problema:** Auditoria encontrou leads com `consultor_responsavel_nome` = Wesley/Danubia, mas `raw_payload.Consultor` = Joyce/Beatriz/etc. O efetivo priorizava o payload → coluna CONSULTOR ficava em branco e o consultor autenticado não via o lead.
- **Decisão:** Em `processos-caa`, `MEU_PAINEL_EFFECTIVE_CONSULTOR_SQL` passa a preferir a **coluna** quando ela já é Wesley/Danubia; só então cai no coalesce payload→coluna.
- **Alternativas descartadas:** limpar payload no sync (invasivo); exigir reatribuição manual dos 7 casos do dia.

### 2026-07-07 — Meu Painel Processos CAA: consultor inválido em branco (Wesley + Danubia)
- **Modelo usado:** Opus 4.7 (principal).
- **Problema:** Leads CAA apareciam com consultores errados (Joyce, Beatriz, etc.). Regra operacional: só **Wesley Guerreiro** e **Danubia** atendem CAA; demais devem ficar **sem consultor na UI** até correção automática.
- **Decisão:** (1) `sqlCaaMeuPainelDisplayConsultor()` — todos os leads CAA continuam no painel; coluna CONSULTOR mostra NULL se efetivo ≠ Wesley/Danubia. (2) Persistência/sync/backfill só gravam Wesley/Danubia em `processos-caa`; backfill limpa coluna inválida. (3) Sync CRM re-tenta leads CAA sem consultor válido.
- **Alternativas descartadas:** ocultar leads com consultor errado (usuário pediu ver todos); exibir nome errado até sync (confunde operação).

### 2026-07-07 — Meu Painel: consultor efetivo do payload + sync CRM periódico
- **Modelo usado:** Opus 4.7 (principal).
- **Problema:** Coluna `consultor_responsavel_nome` ficava null (41 leads/7d) ou desatualizada (90 divergências vs `raw_payload.Consultor`) — ex.: Renata com "Julia" no payload mas "—" na UI. Causa: gravação antiga não propagava payload; ON CONFLICT priorizava coluna antiga; 30 leads com chave `Consultor` vazia no webhook.
- **Decisão:** (1) `MEU_PAINEL_EFFECTIVE_CONSULTOR_SQL` — exibição/filtro usam `COALESCE(payload.Consultor, coluna)`. (2) Backfill corrige null **e** divergências. (3) `syncConsultorFromCrmForResponses` lê `DATACRAZY_CONSULTOR_RESPONSAVEL_FIELD_ID` quando payload vazio; cron 2h + `POST /api/maintenance/sync-response-consultores`. (4) ON CONFLICT prefere consultor do webhook.
- **Alternativas descartadas:** só backfill manual (não escala); confiar só no CRM (payload do n8n já traz consultor na maioria ATM/IA).

### 2026-07-06 — Painel CAA ATM/IA: sem métricas de disparo WhatsApp
- **Modelo usado:** Opus 4.7 (principal).
- **Problema:** Filtros `caa_atm`/`caa_ia` exibiam "Disparos enviados" (ex.: 36) porque `getActivationConversion` cruzava `activation_dispatch_events` com `activation_responses` da mesma origem via `EXISTS` — leads que receberam disparo CAA normal e depois entraram via movimentação DataCrazy (ou vice-versa) contaminavam o KPI.
- **Decisão:** `isOrigemMovimentacaoInterna()` em `origemAtivacaoFilter.js`; para ATM/IA zerar/ocultar KPIs de disparo e resposta (`whatsapp_metrics: false`), manter Atribuídos/Marcados/Revertidos/Meta; ocultar diário de ativações no front.
- **Alternativas descartadas:** manter EXISTS e tentar filtrar por ordem temporal dispatch vs ATM (frágil, 32 casos dispatch-after-ATM em 30d); contar só responses sem EXISTS (continuaria inflando "Responderam").

### 2026-07-06 — Meu Painel: backfill consultor/RGM do raw_payload + MV telefone
- **Modelo usado:** Opus 4.7 (principal).
- **Problema:** Leads com `—` em RGM e/ou consultor no painel tinham dados no banco não propagados: webhook n8n grava `Consultor` e `RGM` dentro de `raw_payload` (ex.: `"Consultor": "Beatriz"`) mas a rota POST `/responses` só lia chaves top-level → coluna `consultor_responsavel_nome` ficava null. RGM idem (`RGM` no payload + `mv_aluno_por_telefone` não eram usados na gravação).
- **Decisão:** (1) `recordResponse` extrai consultor/RGM de `rawPayload` e resolve RGM por telefone na MV; rota aceita `body.Consultor`. (2) `backfillResponsesMissingIdentity()` preenche retroativamente de payload, MV e dispatch (72h). Backfill rodado em prod/dev — ex.: tel `11994260396` passou a ter consultor Beatriz; RGM permanece null (não existe em nenhuma fonte → consultor preenche no modal).
- **Alternativas descartadas:** inferir consultor do operador do dispatch (migration 025 removeu — consultor ≠ quem disparou).

### 2026-06-25 — Meu Painel: join de outcome/CAA usa RGM efetivo (ar→mat→lk) + upsert por (category, rgm)
- **Modelo usado:** Opus 4.7 (principal).
- **Problema:** `listMeuPainel` exibia RGM via `coalesce(ar.rgm, mat.rgm, lk.rgm)` mas joins de `activation_manual_outcomes` e `caa_protocols` usavam só `ar.rgm`/`mat.rgm`. Leads com RGM resolvido por telefone (`mv_aluno_por_telefone`) gravavam outcome com RGM correto mas liam "não marcado" (ex.: Camila Rodrigues RGM 49340671). `meuPainelStats` tinha o mesmo gap. Múltiplos cliques geravam duplicatas em `activation_manual_outcomes` (16 linhas no caso Camila).
- **Decisão:** (1) Constante SQL `MEU_PAINEL_EFFECTIVE_RGM_SQL` — mesma ordem do SELECT — nos joins de `cp` e `amo`; stats enriquecem respostas com `lk`+`mat` antes de cruzar outcomes. (2) Migration `039`: dedupe por `(category, rgm)` + `UNIQUE INDEX` parcial; `upsertOutcome()` com `ON CONFLICT (category, rgm) WHERE rgm IS NOT NULL DO UPDATE`; rota POST meu-painel/outcomes e `createFromCrm` usam upsert.
- **Escopo local:** alterações no repo `tool_whatsapp_alunos` sem push/deploy até validação.
- **Alternativas descartadas:** só upsert sem corrigir join (KPI/listagem continuariam errados); vínculo por `response_id` (mais robusto, escopo maior).

### 2026-06-29 — Meu Painel Parte 2 (Opção A): nome/rgm/cpf por telefone via MV `mv_aluno_por_telefone`
- **Modelo usado:** Opus 4.8 (principal).
- **Problema:** Após a Parte 1 (ler `nome do lead` do `raw_payload`), restavam leads em **Meu Painel** com "—" porque o nome não estava em nenhuma fonte ligada por ID/RGM/CPF — só existia nas **bases acadêmicas, alcançável por telefone**. Ex.: `5513996483329` (DAYLLANA, em `processos_caa_rows`) e `5511915145574` (RICARDO, em `matriculados_rows`). Cruzar telefone inline é caro (telefone dentro de JSONB, exigiria regexp por linha em tabelas de 100k+).
- **Decisão (Opção A, definitiva):** Materialized view **`mv_aluno_por_telefone`** (migration `037`) consolidando `phone_norm → nome/rgm/cpf` das 4 bases acadêmicas, com **índice único** em `phone_norm` (habilita `REFRESH ... CONCURRENTLY` e dá lookup O(1)). `listMeuPainel` ganha `left join mv_aluno_por_telefone lk on lk.phone_norm = normalize_phone_br(ar.telefone)` e `lk.nome/lk.rgm/lk.cpf` entram **no fim** dos respectivos `COALESCE` (só preenche o que falta; não muda os joins de cp/amo, que continuam por `ar.rgm`/`mat.rgm`).
- **Normalização (`normalize_phone_br`, IMMUTABLE):** canônico BR = **DDD (2) + últimos 8 dígitos** do assinante. Unifica prefixo `55` e o `9` do celular: `5511958291608` = `11958291608` = `1158291608`. Mesma função usada na MV e no join → consistência garantida. Trade-off: dropar o `9` pode colidir celular×fixo de mesmo DDD+8 (raro; aceitável para exibir nome).
- **Fontes e custo de build (decisões por base):**
  - **matriculados** (710k linhas em 25 snapshots) → **só o último snapshot** (~33k, base completa autoritativa; varrer tudo seria desnecessário).
  - **processos_caa** (~900), **docs_pendentes** (~68k), **acessos_blackboard** (~103k, sem CPF) → **todos os snapshots** (são deltas; baratos). `DISTINCT ON (phone_norm) ORDER BY created_at DESC` → vence o registro mais recente. MV final: **31.890 telefones**.
- **Refresh:** `server/services/alunoPhoneLookupService.js` — `refreshAlunoPhoneLookupBackground()` chamado em `afterBaseUpload` (`baseUploads.js`) só para as 4 categorias-fonte (`PHONE_LOOKUP_SOURCE_CATEGORIES`), fire-and-forget, `CONCURRENTLY` com fallback para refresh normal se a MV ainda estiver vazia. Cron diário de rede de segurança (`startAlunoPhoneLookupCron`, default 04:00 UTC, env `ALUNO_PHONE_LOOKUP_REFRESH_HOUR_UTC`), guard contra execução concorrente.
- **Validado:** DAYLLANA, RICARDO e Camila resolvem por telefone; `node --check` + import OK; sem lint.
- **Alternativas descartadas:** **Opção B** (estender o lateral join de matriculados também por telefone) — barato mas parcial (resolveria RICARDO, não DAYLLANA, que está em processos_caa); cruzar telefone inline em todas as bases por query — caro e repetido a cada request. MV centraliza, indexa e roda o custo só no refresh periódico.

### 2026-06-29 — Meu Painel: nome do aluno lê também a chave `nome do lead` do raw_payload
- **Modelo usado:** Opus 4.8 (principal).
- **Problema:** Na aba **Meu Painel**, a coluna ALUNO mostrava "—" para leads que **tinham nome no banco**. Investigação do tel `5511958291608` (Camila Alves Silva, resposta `processos-caa` de 29/06 09:18) revelou que o nome chegou no próprio disparo, gravado em `activation_responses.raw_payload` sob a chave **`"nome do lead"`** (formato do webhook n8n/DataCrazy), mas a query `listMeuPainel` (`server/repositories/manualOutcomesRepository.js`) só lia `raw_payload->>'nome'` — chave usada **apenas** pelos leads criados manualmente. Amostra de 30 dias: `'nome do lead'`=52 payloads, `'nome'`=20 (manuais), ~4126 sem chave de nome (dependem de joins por RGM/CPF).
- **Decisão (Parte 1):** estender o `COALESCE` do campo `nome` em `listMeuPainel` para incluir `nullif(trim(raw_payload->>'nome do lead'),'')` e `nullif(trim(raw_payload->>'Nome do Lead'),'')` após o `'nome'` existente. Mantém a ordem de prioridade (CAA → datacrazy_lead_cache → matriculados → payload), só estende o último nível.
- **Sem backfill / sem regressão:** a query relê o JSON já armazenado, então os "—" antigos passam a exibir o nome imediatamente; nenhuma fonte anterior foi alterada. Validado: a resposta da Camila passou a resolver "Camila Alves Silva".
- **Não incluído (Parte 2, adiada a pedido):** fallback por telefone — (2a) join extra em `datacrazy_lead_cache.phone_norm`; (2b) cruzar telefone com bases acadêmicas (`docs_pendentes_rows`/`matriculados_rows`/`acessos_blackboard_rows`). 2b é caro inline (telefone dentro de JSON, exige regexp por linha); caminho correto seria enriquecer na escrita ou criar coluna/índice normalizado. Reabrir se os ~4126 sem nome no payload virarem dor recorrente.

### 2026-06-23 — Lookup: histórico de disparos + cache pós-envio
- **Modelo usado:** Opus 4.8 (principal).
- **Problema:** `activation_dispatch_events` já gravava `datacrazy_lead_id` no 1º envio, mas o lookup ignorava — sempre reconsultava API.
- **Decisão:** FASE 0.5 em `buildLeadsLookupIndex`: batch em `activation_dispatch_events` por `master_key` (RGM/CPF/tel/email). Após envio bem-sucedido, `upsert` em `datacrazy_lead_cache` com `source=activation`. Ordem: cache sync → histórico disparos → API (hybrid).

### 2026-06-23 — Hybrid v2: prefetch controlado antes do envio (fim do 429 em massa)
- **Modelo usado:** Opus 4.8 (principal).
- **Problema:** Modo hybrid v1 resolvia lead **durante** o envio com 10 workers WhatsApp paralelos → rajada de `?search=` + PUT origem no mesmo rate limiter (6–8/s) → 429, retries longos, 20 min até aparecer progresso; ~50% "não encontrado" por busca falha sob throttling.
- **Decisão:** Separar fases:
  1. Cache Postgres (segundos).
  2. **Prefetch** dos faltantes: 3 paralelos, ~6 req/s, barra de progresso (`prefetch_done/total`).
  3. Envio WhatsApp só com índice quente (`lazyResolve=false` após prefetch).
- **Defaults:** `DATACRAZY_CRM_RATE_PER_SECOND=6`, `DATACRAZY_PREFETCH_CONCURRENCY=3`, `ACTIVATION_BATCH_CONCURRENCY=6` em hybrid.
- **Easypanel:** remover envs agressivas (`CRM_RATE=15+`, `bulk_search`, `cache_first`).

### 2026-06-23 — Modo hybrid: fim do preflight 20min em 0%
- **Modelo usado:** Opus 4.8 (principal).
- **Problema:** `bulk_search` fazia centenas de `?search=` antes do 1º envio — 1000 leads ficavam 20+ min em 0% (429 + sem progresso). Insustentável.
- **Decisão:** Default `DATACRAZY_ACTIVATION_LOOKUP_MODE=hybrid`:
  1. **Preflight** = só cache Postgres (segundos).
  2. **Envio** = resolve API **6 paralelos** (`DATACRAZY_RESOLVE_CONCURRENCY`) por lead sem cache.
  3. Progresso visível (`status_message`, etapas avançam, contador sobe durante envio).
  4. **Cancelar** job: `POST /api/activation/jobs/:id/cancel` + botão no overlay.
  5. `bulk_search` permanece opt-in para lotes pequenos (<150).
- **Easypanel:** remover `DATACRAZY_ACTIVATION_LOOKUP_MODE=bulk_search` se setado.

### 2026-06-22 — Ativação em massa: blocos automáticos de 500
- **Modelo usado:** Opus 4.8 (principal).
- **Problema:** Operador precisava disparar 1000 a cada 10 min manualmente numa base de ~20k — inviável.
- **Decisão:** `runDatacrazyActivationBatch` divide automaticamente quando `toProcess.length > ACTIVATION_AUTO_CHUNK_SIZE` (default **500**). Cada bloco = preflight + envio próprio; pausa `ACTIVATION_CHUNK_PAUSE_MS` (default **30s**) entre blocos. Um único job async mostra progresso global (`chunk_index/chunk_total`). Opt-out: `autoChunk: false` no body.
- **UI:** confirmação avisa blocos automáticos; overlay mostra `bloco 3/40`.

### 2026-06-22 — Ativação: volta default bulk_search (preflight rápido) + filtro 55n
- **Modelo usado:** Opus 4.8 (principal).
- **Problema:** `cache_first` (default de 22/06) resolvia lead a lead na fila serial — correto contra 429, mas **muito lento** em lotes de 100–1000. Usuário pediu retomar a regra da época em que a ativação funcionava bem.
- **Decisão:** Default `DATACRAZY_ACTIVATION_LOOKUP_MODE=bulk_search` de novo:
  1. **Preflight** = cache Postgres (FASE 0) + busca direta paralela `?search=` (telefone → CPF → e-mail, 2 passadas) para lotes ≤ `DATACRAZY_DIRECT_SEARCH_THRESHOLD` (5000).
  2. **Envio** = só `lookupLeadInIndex` no índice já montado (sem API por lead).
  3. **Placeholders SIAA** (`55n encontrado`, `55 não encontrado`) continuam ignorados via `sanitizeContactPhone` / `isValidDatacrazySearchTerm` — import corrigido não deve mais gerar, mas filtro permanece.
  4. `cache_first` permanece opt-in via env para quem preferir serial + retry em 429.
  5. Defaults bulk: CRM **15/s**, direct search concurrency **10**.
- **Easypanel:** remover `DATACRAZY_ACTIVATION_LOOKUP_MODE=cache_first` se estiver setado manualmente.
- **Alternativas descartadas:** manter cache_first como default (lento); remover cache_first do código (útil como fallback anti-429).

### 2026-06-22 — Ativação DataCrazy: modo cache_first (fim dos 429 no preflight)
- **Modelo usado:** Opus 4.8 (principal).
- **Problema:** Lotes de 100–1000 leads no preflight disparavam centenas de `GET ?search=` em paralelo (até 12–20/s). A API DataCrazy retornava `Too many requests` (429); leads existentes eram marcados como **não encontrados** (falso negativo) e os logs ficavam cheios de erro.
- **Decisão:** Novo modo default `DATACRAZY_ACTIVATION_LOOKUP_MODE=cache_first`:
  1. **Preflight** = só cache Postgres (`datacrazy_lead_cache` por CPF + e-mail batch) + índice em memória — **zero** rajada de API.
  2. **Resolução por lead** na fila de envio: `resolveLeadForContact` enfileira buscas API **1 por vez** (`enqueueLeadResolve`), ordem CPF → e-mail → telefone.
  3. **429 ≠ not_found** — status `rate_limited` com até 8 retentativas (`DATACRAZY_RESOLVE_RATE_RETRY_*`); falha final grava `failed`/`rate_limited`, não `not_found`.
  4. Rate CRM default volta para **10/s**; cooldown 429 default **1200 ms**.
  5. Modo legado `bulk_search` preservado via env (comportamento anterior).
- **Alternativas descartadas:** Só baixar concurrency do bulk (ainda gera rajada no início); paginação CRM inteira (minutos em “Buscando…”); ignorar 429 e marcar not_found (causa raiz dos falsos negativos).

### 2026-06-19 — Rematrícula SIAA: RGM/CPF em notação científica + lookup matriculados quebrado
- **Modelo usado:** Opus 4.8 (principal). Bugfix operacional.
- **Problema:** Após upload SIAA (`excel__19062026-122501.zip`, 20.163 linhas), ~67% dos alunos apareciam sem RGM no Disparador (`-`). Export ERP grava RGM/CPF/celular como número Excel → XML devolve `"4.8982197E7"`, `"3.240816687E10"`. O parser descartava ( `normalizeRgmCanonical` extraía dígitos errados; `isPlausibleInstitutionalRgm` falhava) e gravava `RGM`/`RGM_ALUN` vazios. Coluna **Ciclo** mostrava `EM CURSO` porque `rowToRematriculaItem` lia `SIT_2026_1` (situação acadêmica, não ciclo). Fallback `rgmFromMatriculadosLookup` nunca funcionou: passava `PersonIndexEntry` para `institutionalRgmFromAnyRow` em vez de usar `matEntry.ids` (`RGM:…`) ou `matEntry.row`.
- **Decisão:**
  1. Novo helper `excelNumericCell.js` (`parseExcelNumericCell`, `cpfDigitsFromExcelCell`, `phoneDigitsFromExcelCell`) — usado em `brokenExportXlsx.js`, `spreadsheetToObjects.js`, `rgmDisplay.js`, `baseComparisonService.js`, `siaaRematriculaRepair.js`.
  2. `rgmFromMatriculadosLookup` lê `RGM:` de `matEntry.ids` primeiro.
  3. `cicloFromRematriculaRow` infere ciclo de colunas `SIT_YYYY_N` → `YYYY/N` (default `REMAT_CICLO_ORIGEM`).
  4. Script `repairRematriculaSnapshotRgms.mjs` — corrige snapshot já gravado + preenche RGM via matriculados. Rodado em prod no snapshot `984cbf52…`: **20.162/20.163** com RGM (1 órfão); re-run final **20.163/20.163**.
  5. **`importRgmCellValue`** em `brokenExportXlsx.js` / `spreadsheetToObjects.js` — na importação SIAA, coluna `RGM_ALUN` (fileira I) preserva prefixo 20–39 (ex. Adara `39462617`); antes `isPlausibleInstitutionalRgm` (40–49) zerava na hora do parse.
- **Correção adicional (mesmo dia):** RGMs prefixo 20–39 (alunos antigos) estavam gravados no DB mas **ocultos na UI** — filtro `isPlausibleInstitutionalRgm` limitava exibição a 40–49 (~1.836 linhas com `-`). Ampliado default para **20–52**; criado `displayRgmFromRematriculaRow` + `matriculadosRgmLookup.js` (dupla verificação CPF → e-mail → nome). Fila rematrícula: **0 sem RGM** após reparo.

### 2026-06-19 — Cleanup origem_ativacao: fallback por dispatch + verify no CLEAR

- **Modelo usado:** Opus 4.7 (principal). Bugfix operacional.
- **Problema:** job `clean-stale-origem-ativacao` lia só `activation_origem_ativacao_log` (SET ok sem CLEAR). Leads com campo preenchido no CRM mas **sem linha no log** (insert falhou silenciosamente no disparo) ou com CLEAR `ok` no log mas CRM ainda preenchido (PUT 200 sem efeito) ficavam eternamente com `origem_ativacao` e a simulação mostrava 0.
- **Decisão:**
  1. `listStaleSetEntries` — último SET por lead (subquery), stale se `created_at` > janela e sem CLEAR ok posterior.
  2. `listStaleDispatchEntriesWithoutClear` — `activation_dispatch_events` `sent` > janela sem CLEAR ok no log após o disparo (cobre log ausente).
  3. Cleanup une as duas listas (dedupe por `datacrazy_lead_id`).
  4. `clearOrigemAtivacaoForLead` — após PUT vazio, GET best-effort; se campo ainda preenchido → `ok: false` (não registra CLEAR ok no log).
  5. Disparo — `recordOrigemAtivacaoLog` usa fallback `origemAtivacaoForCategory(category)` se `value` vazio (evita NOT NULL / insert falho).
- **Alternativas descartadas:** varrer todo o CRM por leads com campo set (caro, sem índice); confiar só no log (bug original).

### 15/06/2026 — Rematrícula: **PAUSADO** — sem denominador comum com Excel; recalcular rota

- **Modelo usado:** Opus 4.7 (principal).
- **Status:** **Congelado em 15/06/2026.** Não iterar mais na lógica atual (instituição + matriculados × vencidos) até nova definição de produto/dados. Código entregue (bases `inadimplentes-vencidos`, categoria `rematricula`, migrations 032–033) **permanece no repo** mas **não é fonte de verdade operacional** até reabrir.
- **Motivo da pausa:** após cruzamento RGM/CPF com `remat1506.xlsx` (`SIT_2026_1 + SIT_ATUAL = EM CURSO`), overlap ficou alto mas **não fechou 100%** — divergências persistentes em financeiro (`SIT_FINAN` ERP vs base vencidos ~300 pessoas “trocadas de lado”) e situação acadêmica (duplo EM CURSO no Excel vs `Situação Matrícula` única no snapshot matriculados ~170 só no painel). Time não chegou a denominador comum aceito.
- **Números no congelamento** (painel vs Excel, após incluir Braz Cubas Grad EAD):
  - Adimplente: **17.902** painel vs **17.520** Excel — **17.460 em comum** (99,7%)
  - Inadimplente: **3.468** painel vs **3.680** Excel — **3.401 em comum** (92,4%)
  - Total painel **21.370** vs Excel **21.200**
- **O que NÃO fazer até reabrir:** ajustar mais filtros de instituição, trocar para `SIT_FINAN`, ou “forçar” números ao Excel sem decisão explícita nova.
- **Rotas a reavaliar quando retomar** (sem implementar agora):
  1. ~~**Upload do relatório remat unificado**~~ → **15/06 tarde:** base **Rematrícula** em Bases com **dois uploads** (`SIAA`, `Portal de Polos`); snapshot **mais recente** (por `created_at`) define inadimplentes na fila (migration `034`). Ver entrada abaixo.
  2. **Híbrido:** universo do relatório remat + inadimplente só da base vencidos (ou só `SIT_FINAN`) — escolher UMA regra financeira e documentar.
  3. **Manter derivação atual** mas aceitar delta ~1–8% vs Excel como custo de não depender do relatório lento do ERP.
  4. **Desativar aba Rematrícula** na UI até rota definida (flag/env) — só se operação pedir.
- **Implementação congelada** (referência): ver entrada abaixo; instituições no filtro = UNICID + Cruzeiro 16 Grad EAD + Braz Cubas Grad EAD.

### 15/06/2026 — Base Rematrícula: uploads SIAA + Portal de Polos (mais recente vence)

- **Modelo usado:** Opus 4.7 (principal).
- **Decisão:** Nova seção **Rematrícula** em Bases com **dois uploads independentes** (`siaa`, `portal-de-polos`). Para classificar **inadimplente** no Disparador, usar sempre o snapshot com maior `created_at` entre as duas fontes (não merge — substituição pelo mais recente). Migration `034_rematricula_base.sql`. Base legada `inadimplentes-vencidos` permanece na UI mas deixa de alimentar a fila.
- **API:** `GET /api/base-uploads/rematricula/status`; upload com header `X-Remat-Source: siaa|portal-de-polos`.
- **UI:** card full-width no topo da grade de Bases; badge “Em uso” na fonte ativa.

### 15/06/2026 — Rematrícula: fila 2026/1 EM CURSO + inadimplente *(implementação; inadimplente migrado para base Rematrícula SIAA/Portal)*

- **Modelo usado:** Opus 4.7 (principal).
- **Problema:** campanha de rematrícula precisa atingir matriculados **2026/1** ainda **EM CURSO**, excluindo quem já aparece em **2026/2** (concluída), com segmentação **adimplente vs inadimplente vencido**. A base **Financeiro** (~7,4k) mistura quem está no prazo com quem está vencido; o relatório operacional correto é **"Alunos com mensalidade em aberto (3).xlsx"** (~3,7k RGMs).
- **Decisão:**
  - Nova base em Bases: **Inadimplentes Vencidos** (`inadimplentes-vencidos`, migration `032`).
  - Nova categoria de ativação **`rematricula`** (migration `033`): universo = matriculados snapshot **2026/1** + situação **EM CURSO** + **instituição UNICID, Cruzeiro Grad EAD (16) ou Braz Cubas Grad EAD** + não concluinte + **sem** linha no mesmo canon em **2026/2**.
  - **Inadimplente** = canon no snapshot mais recente da base **Rematrícula** (SIAA ou Portal de Polos — o upload mais novo). **Adimplente** = resto do universo.
  - Ciclos configuráveis: `REMAT_CICLO_ORIGEM` (default `2026/1`), `REMAT_CICLO_DESTINO` (default `2026/2`).
  - UI Disparador: aba Rematrícula, filtros Adimplente/Inadimplente, coluna Financeiro, bulk select respeita filtro.
  - `origem_ativacao` DataCrazy: `Remat`. Cooldown 24h.
- **Invalidação de cache:** upload de `matriculados` ou `rematricula` invalida fila `rematricula`.
- **Alternativas descartadas:**
  - **Usar base Financeiro** para inadimplente — infla ~2× (inclui mensalidade em aberto ainda no prazo).
  - **Coluna `SIT_FINAN=Inadimplente` só no export matriculados** — ~93% de overlap com o relatório vencido, mas menos auditável que cruzar com snapshot dedicado.
  - **Categoria sem subgrupos** — operação precisa disparar mensagens distintas por segmento.

### 12/06/2026 — Disparador: criar anotação no card do DataCrazy a cada envio (rastreabilidade no CRM)

- **Modelo usado:** Opus 4.7 (principal) decidiu; Executor (Sonnet 4.6) implementará.
- **Problema:** quando o disparador manda uma mensagem WhatsApp pra um aluno, o consultor que depois abrir o card no DataCrazy não tem como saber o que foi enviado, quando, por quem e com qual template. A única evidência fica no `activation_dispatch_events` do tool — invisível a quem usa o CRM.
- **Decisão:** após cada envio bem-sucedido em `runDatacrazyActivationBatch`, postar uma anotação no card do lead via `POST /api/v1/leads/{leadId}/notes` (já existe na API DataCrazy — Bearer Auth com a mesma `DATACRAZY_API_KEY`). Conteúdo da nota inclui timestamp BRT + categoria + template + **identidade do operador que disparou** + texto da mensagem renderizado (com variáveis já substituídas).
- **Formato da anotação:**
  ```
  [Disparador WhatsApp] 12/06/2026 14:32 (BRT)
  Categoria: Processos CAA
  Template: caa_msg1
  Disparado por: raphael.castro
  ---
  Olá João, identificamos um processo CAA aberto no seu nome...
  ```
- **Falha na criação da nota = NÃO bloqueia o disparo.** A mensagem WhatsApp já foi enviada (o lead recebeu). Logamos `logger.warn` e marcamos `datacrazy_note_failed=true` no `recordDispatchEvent` (coluna nova) pra permitir auditoria/retry futuro.
- **Toggle:** env var `DATACRAZY_DISPATCH_NOTE_ENABLED` (default `true`). Permite desligar sem deploy se a API do DataCrazy ficar instável.
- **Propagação do operador:** o `dcz-crm-sync` já injeta `consultor_nome` no iframe URL (`readConsultorIdentity().nome` no frontend). Propagar via novo campo `operator_nome` no body de `POST /:category/run-datacrazy-batch` → `runDatacrazyActivationBatch(category, { operatorNome }, ...)`. Quando ausente (chamadas internas, scheduler), fallback `'Disparador automático'`.
- **Texto renderizado da mensagem:** templateComponents do WhatsApp Business têm o `body.text` original com placeholders `{{1}}`, `{{2}}`; o tool já carrega isso em `templateComponentsByName`. Expor helper `renderTemplateText(components, variables)` em `whatsappClient.js` (mesmo regex que `extractTemplateVariableOrder` usa).
- **Schema delta** (migration `031_dispatch_datacrazy_note.sql`):
  ```sql
  ALTER TABLE activation_dispatch_events
    ADD COLUMN IF NOT EXISTS datacrazy_note_failed BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS datacrazy_note_id TEXT;
  ```
- **API client novo** (`server/services/datacrazyClient.js`):
  - `async function addLeadNote(leadId, note)` → POST `/api/v1/leads/{leadId}/notes` body `{ note }`. Bearer Auth via `getConfig().apiKey`. Retorna `{ id?: string|null }` derivado do response. Throw em status != 2xx.
  - Exportada no `datacrazyClient` ao final do arquivo.
- **Alternativas descartadas:**
  - **Webhook reverso DataCrazy chama o tool** — burocrático e exige config do CRM; ativo simples (POST direto) é mais robusto.
  - **Anotação compacta (sem texto da mensagem)** — descartada pelo usuário; queria ver o que foi enviado direto no card sem precisar ir ao tool.
  - **Anotação como atividade/tarefa** — DataCrazy tem `/api/v1/leads/{leadId}/activities`, mas "atividades" carregam semântica de pendência (criar pendência fantasma pra cada disparo poluiria a agenda do consultor). Notes são puramente informativos.
  - **Bloquear o disparo quando a nota falha** — a mensagem JÁ foi entregue ao aluno; bloquear força reenvio que dispararia mensagem duplicada. Falha de nota é problema de auditoria, não de entrega.
  - **Sempre ligado sem toggle** — risco operacional: se a API do DataCrazy ficar fora no meio de uma campanha grande, queremos poder desligar via env var sem deploy.

### 11/06/2026 — Disparador: coluna "Última ativação" + sort por mais antigo/recente

- **Modelo usado:** Opus 4.7 (principal) decidiu UX; Executor (Sonnet 4.6) implementou.
- **Problema:** operador não tinha como priorizar reativação por "leads que não recebem mensagem há mais tempo". Tinha que olhar manualmente os contadores.
- **Decisão:** nova coluna "Última ativação" entre "Vezes ativado" e "Próxima msg", clicável no header para cyclar `null → mais antigo → mais recente → null`. Quando o sort está ativo, leads nunca-ativados (prior_activation_count = 0) somem da fila — ordenar por data que não existe não faz sentido, e o intent do sort é foco em reativação.
- **Banner de feedback:** quando sort ativo, banner verde acima da tabela mostra ordenação atual + número de leads escondidos + botão "Limpar ordenação".
- **Bulk select consistente:** `handleBulkSelect` passa o `sort` para `/roster/keys` para que "selecionar todos" bata com o que está na tela.
- **Backend:**
  - `activationDispatchRepo.getLastSentAtByMasterKey(category)` (já existia) → cacheado em `lastSentCaches` (mesma TTL do roster).
  - `buildRosterRowsCached` injeta `last_dispatch_at` em cada item.
  - `parseRosterSort` + `applyRosterSort` no service; rota aceita `?sort=last_dispatch_oldest|last_dispatch_newest`.
- **Alternativas descartadas:**
  - **Sort em coluna separada "Tempo desde última"** (mostrar sempre, sort opcional sem esconder zerados): mais coluna sem ganho — leads nunca-ativados não tem o que ordenar e ficariam no topo/fundo de qualquer jeito poluindo a lista.
  - **Sort padrão por mais antigo no load inicial:** mudaria o comportamento padrão atual; usuário pediu opt-in via clique no header.

### 10/06/2026 — Activation Conversion: respostas pelo dia do disparo + esconder "Revertidos" para bases != CAA

- **Modelo usado:** Opus 4.7 (principal) decidiu; Executor (Sonnet 4.6) implementou.
- **Problema 1 (atribuição temporal):** o gráfico/tabela diário da Conversão atribuía respostas ao dia em que o webhook chegou. Isso distorcia leitura — "10 disparos no dia 09 + 7 respostas no dia 11" não dizia qual taxa de conversão tinha o disparo do dia 09. Time queria ler "X% das ativações do dia Y geraram resposta".
- **Decisão 1:** refactor de `buildValidResponseExists` em `activationConversionService.js` para correlacionar resposta ao `dispatch_event` mais recente dentro da janela `staleHours`, e usar o `dispatch_event.created_at` como data de atribuição. Mantém staleHours como single source of truth da janela de validade. Respostas revertidas (`manual_outcomes.outcome = 'revertido'`) continuam atribuídas ao dia da marcação manual — esse é o evento operacional do CAA, não a resposta crua.
- **Problema 2 (KPI Revertidos confunde fora do CAA):** "Revertidos" é fluxo manual exclusivo da base Processos CAA. Em bases sem esse fluxo, KPI e coluna mostravam sempre 0, atrapalhando leitura.
- **Decisão 2:** card "Revertidos" e coluna da tabela só aparecem quando `category === 'processos-caa'` OU `category === 'all'` (já que "Todas as bases" agrega CAA). Para outras bases, KPI some e coluna mostra "—" em cinza claro.
- **Alternativas descartadas:**
  - **Atribuir resposta ao dia do recebimento + adicionar 2ª linha "respostas por dia do disparo":** dobra carga visual, time não entendia qual linha era a métrica real.
  - **Filtrar Revertidos por flag opcional toggle:** o KPI nem deveria existir fora do CAA; toggle só adiciona ruído.

### 10/06/2026 — Meu Painel: Supervisor Acadêmico tem acesso pleno (ver tudo + reatribuir)

- **Modelo usado:** Opus 4.7 (principal) decidiu; Executor (Sonnet 4.6) implementou.
- **Problema:** Supervisor Acadêmico precisava ver todos os leads no Meu Painel (não só os atribuídos ao próprio nome) e reatribuir consultor — mesma capacidade do admin. Antes só `role=admin` ou `consultor=*` davam essa visão; categoria Supervisor não dava nada.
- **Decisão:** introduzir `categoria` (passada pelo iframe do dcz-crm-sync via query) como segundo eixo de permissão no Meu Painel. Quando `categoria == 'Supervisor Acadêmico'` (case/accent-insensitive), trata como admin para fins de:
  - listar leads (Meu Painel/list e Meu Painel/stats sem filtro de consultor)
  - reatribuir consultor (`PATCH /responses/:id/assign-consultor`)
- **Implementação:**
  - Backend (`server/routes/activation.js`): helpers `_normCat`, `_isSupervisorAcademicoCat`, `_hasFullAccess` (true se role=admin OU categoria=Supervisor Acadêmico). `resolveConsultor` e `assign-consultor` usam o helper.
  - Frontend: `meuPainelApi.ts` lê `categoria` da URL e envia em toda request. `MeuPainelPage.tsx` propaga em todos os fetches. `AssignConsultorModal.tsx` envia `categoria` no body do PATCH.
  - dcz-crm-sync `_disparador_whatsapp.html` adicionou `&categoria=...` no `_iframe_url` (commit no outro repo).
- **Default ao abrir Meu Painel:** período = "Hoje" e categoria = "Processos CAA". Ajuste de UX puxado pelo uso predominante do time.
- **Alternativas descartadas:**
  - **Criar role intermediário "supervisor" no dcz-crm-sync:** mexer no sistema de roles do dcz é escopo maior; categoria já existia e bate 1:1 com o caso.
  - **Adicionar `consultor=*` para todo supervisor:** funcionaria pra ver tudo mas não dá poder de reatribuir, e mascara a identidade do supervisor.

### 09/06/2026 — Congelar ciclos: arquivar 2026/1 das operações

- **Modelo usado:** Opus 4.7 (principal) decidiu; Executor (Sonnet 4.6) implementou.
- **Decisão:** Adicionar capacidade de arquivar um ciclo inteiro ("2026/1") em vez de congelar snapshot por snapshot. Tabela nova `frozen_cycles(ciclo PK, frozen_at, frozen_by, reason)`. Quando frozen, ciclo some do disparador (roster filtra), relatórios (Conversão, CAA Daily, CAA Funil — `kpis_by_ciclo` e `counts_by_ciclo`), dropdowns de ciclo no UI. Histórico em `activation_dispatch_events`/`activation_responses` NÃO é tocado.
- **Sem escape hatch:** decisão explícita do usuário — ciclo frozen some 100%, sem `?include_frozen=1`. Histórico só via SQL direto.
- **Reativação:** `DELETE /api/cycles/:ciclo/freeze` deleta linha de `frozen_cycles` e tudo volta. Sem soft-delete (overkill pro caso).
- **Granularidade por ciclo, não por base+ciclo:** ciclo é unidade real ("2026/1 acabou pra todas as bases ao mesmo tempo"). Se algum dia precisar congelar 1 base específica de um ciclo, reabrir.
- **Componentes:**
  - Migration `030_frozen_cycles.sql`.
  - `server/repositories/frozenCyclesRepository.js` (novo) com cache 5min em `getFrozenSet()`.
  - `server/services/cicloResolverService.js` ganha `getActiveCiclos()`.
  - `server/services/activationService.js` (roster + rosterKeys), `activationConversionService.js`, `caaFunnelService.js`: filtragem out de ciclos frozen.
  - `server/routes/reports.js` (`/caa/summary`): `available_ciclos` filtrado de frozen.
  - `server/routes/cycles.js` (novo): `GET /api/cycles`, `POST/DELETE /api/cycles/:ciclo/freeze`.
  - `src/services/cyclesApi.ts` (novo).
  - `src/pages/BasesPage.tsx`: card "Ciclos" no topo.
- **Cache invalidation:** `freezeCycle`/`unfreezeCycle` chamam `bustFrozenSetCache()`. Painéis no frontend refazem load após operação.
- **Alternativas descartadas:**
  - **Flag por snapshot (nível A):** só protege contra apagar, não cobre o caso real (arquivar ciclo das operações).
  - **Refactor ciclo-aware no nível snapshot (nível C, ~2 dias):** matar mosca com canhão; infra existente do `cicloResolverService` resolve com flag simples.
  - **Flag por base+ciclo:** complexidade extra sem caso de uso. Reabrir quando surgir.

### 09/06/2026 — Seleção multi-página no Disparador (combo dropdown)

- **Modelo usado:** Opus 4.7 (principal) decidiu UX; Executor (Sonnet 4.6) implementou.
- **Problema:** Disparos manuais grandes (ex: 2.392 leads sem resposta) exigiam avançar 24 páginas marcando 100 por vez. Inviável operacionalmente.
- **Decisão:** Dropdown "Mais ▾" ao lado do checkbox do header em `ActivationRosterTable`, com 4 opções: "Página atual", "Próximas 5 páginas", "Próximas 10 páginas", "Todos filtrados (N)".
  - **Página atual** e **próximas N páginas**: ADICIONA à seleção (acumula com o que já estava).
  - **Todos filtrados**: SUBSTITUI a seleção (consistente com "selecione TUDO").
- **Backend novo:** `GET /api/activation/:category/roster/keys` que aceita os mesmos query params do `roster` (stage, ciclo, bb_subgrupo, responseFilter) e retorna apenas `master_keys[]` — payload mínimo, 1 request resolve a base inteira.
- **Linha de status acima da tabela:** mostra `<N> selecionado(s)` + botão "Desmarcar todos" sempre que há seleção. Mostra `⏳ Carregando seleção em massa…` durante operações.
- **Alternativas descartadas:**
  - **Opção A (só "Todos filtrados")**: simples mas tudo-ou-nada; usuário disse que às vezes quer "só 500".
  - **Opção B (só "Próximas N páginas")**: cobre o caso parcial mas pra "tudo" exigiria 40 requests sequenciais (ineficiente).
  - **Aumentar PAGE_SIZE temporariamente** (ex: "mostrar 500/página"): table fica gigante, UX ruim.
- **Onde:** `server/services/activationService.js` (função `getActivationRosterKeys`), `server/routes/activation.js` (rota nova ANTES de `/roster`), `src/services/activationApi.ts` (método `rosterKeys` + tipo `ActivationRosterKeysResponse`), `src/components/ActivationPanel.tsx` (callbacks `addSelectionMany`/`replaceSelection`), `src/components/ActivationRosterTable.tsx` (dropdown + linha de status + handler `handleBulkSelect`).

### 08/06/2026 — Onda 2: cache persistente Postgres `cpf → datacrazy_lead_id` (resolve escala 4k–10k leads)

- **Modelo usado:** Opus 4.7 (principal) decidiu/escreveu a spec; Executor (Sonnet 4.6) implementou. Opus revisou diff antes do commit.
- **Problema:** Onda 1 (commit anterior `f66f15a`) corrigiu o preflight pra disparos de até ~250 pessoas (~10s), mas pra 4k–10k leads (volume que a base recebe periodicamente) ainda paga ~1 chamada à API DataCrazy por pessoa → 6–17 minutos por disparo. Inaceitável quando vira rotina.
- **Decisão:** Cache local Postgres `cpf → datacrazy_lead_id`, populado por cron noturno + hits oportunistas. Disparos consultam o cache em milissegundos antes de cair na API.
- **Schema:**
  - **Migration `029_datacrazy_lead_cache.sql`** — `datacrazy_lead_cache(cpf PK, datacrazy_lead_id, email_norm, phone_norm, nome, raw_lead jsonb, source, last_synced_at, last_seen_at)` + índices em email_norm/phone_norm/last_synced_at. Tabela auxiliar `datacrazy_lead_cache_sync_log` com auditoria de cada execução do cron.
  - **CPF como PK** (não `datacrazy_lead_id`): nossa base local indexa por CPF; CPF é o ponto de entrada estável. `datacrazy_lead_id` também é único, mas a chamada típica é "tenho um CPF, quero o lead_id".
- **Componentes novos:**
  - `server/repositories/datacrazyLeadCacheRepository.js` — `getByCpf`/`getByCpfBatch` (lookup), `upsertLeadFromCrm`/`upsertLeadFromCrmBatch` (write via `unnest` em chunks de 500), `touchLastSeen` (atualiza only `last_seen_at`), `recordSyncStart`/`recordSyncFinish` (log). Cópias locais de `normalizeEmailForMatch`/`leadPhoneDigits` pra evitar dependência circular com `datacrazyClient.js`.
  - `server/services/datacrazyLeadCacheSyncService.js` — `runFullSync({ dryRun })` varre todas as páginas via `datacrazyClient.searchLeads`, upsert em batch. `startDatacrazyCacheSyncCron()` agenda execução diária na hora UTC configurada (default 03:00 UTC = 00:00 BRT). `setTimeout` + `setInterval(...).unref()` pra não bloquear shutdown.
  - `server/routes/maintenance.js` — endpoints `POST /api/maintenance/sync-datacrazy-cache?dryRun=1` e `POST /api/maintenance/invalidate-datacrazy-cache?all=1|?cpf=...`, protegidos por `requireApiKey`.
- **Integração com `buildLeadsLookupIndex`** (em `datacrazyClient.js`):
  - **FASE 0 (nova):** consulta `getByCpfBatch(cpfs)` antes do atalho/paginação. Pessoas com cache hit (e dentro do TTL `DATACRAZY_CACHE_TTL_DAYS` default 7d) são removidas de `personList` e do `remainingEmails/Phones`. `touchLastSeen` é fire-and-forget.
  - **FASE 2 (nova):** leads resolvidos via API (atalho ou paginação) são upsertados no cache automaticamente — `upsertLeadFromCrmBatch(..., 'preflight')` fire-and-forget. Cache auto-aquece com uso.
  - Retorno ganhou `cache_hits` e `cache_stale_skipped` em ambos os caminhos.
- **Mudança nos callers (`activationService.js`):** `contacts` passa a incluir `cpf: item.cpf` (já existia no roster desde sempre, linha 314). Sem CPF, FASE 0 simplesmente não acha — cai no caminho da Onda 1.
- **Env vars novas:**
  - `DATACRAZY_CACHE_ENABLED=1` — flag de kill switch (`0` desativa cache + cron).
  - `DATACRAZY_CACHE_SYNC_HOUR_UTC=3` — hora do cron diário (0–23).
  - `DATACRAZY_CACHE_SYNC_MAX_PAGES=2000` — safety limit (cobre ~200k leads).
  - `DATACRAZY_CACHE_TTL_DAYS=7` — quantos dias um lead pode ficar sem re-sync antes de ser considerado stale.
- **Impacto esperado:**
  - 100 leads: ~10s (Onda 1) → <100ms (cache cheio).
  - 1k leads: ~100s (Onda 1) → <500ms.
  - 10k leads: ~17min (Onda 1) → ~3–5s.
  - Cold start (cache vazio ou pessoas novas no CRM): cai no caminho da Onda 1, sem regressão.
- **Trade-offs aceitos:**
  - **Tabela cresce ~100MB** pra base de 50k leads (raw_lead jsonb). Aceitável; se virar problema, dropar `raw_lead` e manter só campos chave.
  - **Sync noturno custa ~3min** de chamadas à API CRM, fora de horário comercial. Sem usuário ativo, sem rate-limit conflict.
  - **Dados podem ter até 7 dias** de defasagem para pessoas que mudaram telefone/email — mesma janela do problema atual (sem cache, telefone errado da nossa base já entrega mensagem no número errado). Aceitável.
  - **Pessoas sem CPF** (raras em Inadimplentes/CAA) caem no caminho sem cache.
  - **Multi-instância não suportada** se o tool rodar em N réplicas: cada réplica tem seu próprio cron, mas o DB é compartilhado → upserts idempotentes não conflitam. OK.
- **Alternativas descartadas:**
  - **Redis** em vez de Postgres: introduz dependência nova; tool já usa Postgres pra tudo; volume não justifica.
  - **Cache em memória estendido (sem persistir)**: perde tudo no restart do Easypanel (que acontece a cada deploy).
  - **Sync sob demanda só (sem cron)**: primeiro disparo do dia paga ~3min. Cron noturno tira isso do caminho crítico.
  - **Webhook do DataCrazy notificando mudanças**: DataCrazy não publica esse webhook.
  - **Endpoint "lookup by tax_id"** no DataCrazy: provavelmente não existe (a API só expõe `search` genérico).
- **Aplicação:** migration aplicada manualmente pelo usuário via `npm run migrate` apontando pra produção; Easypanel rebuilda o app no push pro `main`.
- **Onde (resumo):**
  - Novos: `server/db/migrations/029_datacrazy_lead_cache.sql`, `server/repositories/datacrazyLeadCacheRepository.js`, `server/services/datacrazyLeadCacheSyncService.js`.
  - Modificados: `server/routes/maintenance.js` (2 endpoints), `server/index.js` (cron no boot), `server/services/datacrazyClient.js` (FASE 0 + FASE 2 + 2 exports novos: `normalizeEmailForMatch` e `leadPhoneDigits`), `server/services/activationService.js` (2 callers passam `cpf`), `.env.example` (bloco novo).

### 08/06/2026 — Preflight DataCrazy escalável (dedupe por pessoa + métrica corrigida)

- **Modelo usado:** Opus 4.7 (principal) decidiu + implementou diretamente.
- **Problema:** Disparos de 100+ pessoas travavam em "Buscando alunos no DataCrazy" por minutos a fio (usuário reportou >10min em 100 leads). Em escala (4k–10k leads, base que entra periodicamente) o gargalo ficaria intolerável.
- **Causa raiz** em `server/services/datacrazyClient.js#buildLeadsLookupIndex`:
  1. **Métrica errada do threshold**: a condição que escolhia entre atalho rápido (busca direta `?search=<termo>`) e caminho lento (paginação completa) usava `totalRemaining = emails.size + phones.size`. Como cada pessoa contribui com 2 termos (email + telefone), 100 pessoas viravam "200" e caíam fora do default `DATACRAZY_DIRECT_SEARCH_THRESHOLD=100`. Disparavam pro loop de paginação (`take=100` × `maxPages=500` × `pageDelay=400ms` = potencialmente minutos).
  2. **Sem dedupe por pessoa**: o atalho consultava email E telefone separadamente da mesma pessoa, dobrando chamadas à API DataCrazy (200 chamadas pra 100 leads).
- **Decisão (Onda 1, commit único):**
  1. **API nova `{contacts: [{email, phone}]}`** em `buildLeadsLookupIndex`, retrocompat com formato antigo `{emails, phones}`. Permite vincular email↔telefone por pessoa.
  2. **Threshold passa a contar pessoas** (`Math.max(emails, phones)` ou `personList.length` quando há `contacts`), não termos. Default subiu de `100` pra `250`.
  3. **Concorrência default subiu** de `5` pra `10` (env `DATACRAZY_DIRECT_SEARCH_CONCURRENCY`).
  4. **Estratégia 2-passadas no atalho** quando há `contacts`:
     - 1ª passada: 1 termo por pessoa (telefone preferido, email fallback se sem telefone).
     - 2ª passada: pessoas ainda não encontradas tentam o email. Cobre casos onde telefone diverge entre nossa base e o CRM, sem custo no caso comum.
  5. **Callers atualizados**: `runDatacrazyActivationBatch` e `previewDatacrazyMatches` (no `activationService.js`) passam `contacts` em vez de `emails`+`phones`.
- **Quick fix sem rebuild** (env vars no Easypanel, válidas imediatamente): `DATACRAZY_DIRECT_SEARCH_THRESHOLD=300` e `DATACRAZY_DIRECT_SEARCH_CONCURRENCY=15`. Útil enquanto o commit não foi rebuildado.
- **Impacto esperado:**
  - 100 leads: passa de minutos (paginação) pra ~5–10s (1 passada de ~10 batches × 1s).
  - 250 leads: ~15–25s ainda via atalho.
  - >250 leads: cai no caminho de paginação completa (que pra base de ~50k leads do CRM dá ~100 páginas com early_stop — ~40s).
- **Onda 2 — pendente (decisão estrutural, não implementada):** cache persistente `cpf → datacrazy_lead_id` em tabela própria, populado por job noturno varrendo a base do DataCrazy 1x/dia. Disparos consultariam o cache em ms; só iriam à API em cache miss. Pra 10k leads cairia de ~11min pra ~100ms total quando todos estiverem em cache. Spec a escrever quando houver demanda concreta de >300 leads recorrentes.
- **Alternativas descartadas (Onda 1):**
  - **Só env vars (sem commit):** resolveria pro disparo atual mas continuaria gastando 2× chamadas à API por pessoa (sem dedupe). Não escala pra 4k+.
  - **Cache persistente agora (Onda 2 antecipada):** escopo maior (migration + repo + cron + invalidação). Onda 1 + env vars destrava o caso atual com 1 commit.
  - **Manter formato antigo `{emails, phones}` e dedupe no caller:** quebraria o ponto de extensibilidade — qualquer caller futuro reescreveria a lógica de dedupe.
- **Onde:**
  - `server/services/datacrazyClient.js#buildLeadsLookupIndex` — nova API + lógica de 2 passadas + métrica corrigida.
  - `server/services/activationService.js` (2 chamadores: `runDatacrazyActivationBatch` e `previewDatacrazyMatches`) — passam `contacts`.
- **Retrocompat:** formato antigo `{emails, phones}` continua funcionando (sem dedupe, sem 2 passadas) — qualquer chamador externo não quebra.

### 02/06/2026 — Breakdown por ciclo em Conversão, CAA Daily, CAA Funil e Disparador

- **Modelo usado:** Opus 4.7 (principal) decidiu + implementou diretamente (Executor foi interrompido pelo usuário no meio da tarefa; trabalho parcial estava em commits intermediários que o Opus auditou e completou).
- **Problema:** A separação por ciclo existia apenas em `MatriculadosComparisonPanel` (`/reports` card matriculados). Demais relatórios (Conversão, CAA Daily, CAA Funil) e o Disparador não diferenciavam 2026/1 de 2026/2 — relevante porque Graduação e Pós viram ciclo em datas distintas (ex.: Pós ainda em 2026/1 enquanto Graduação já em 2026/2). Contagens agregadas escondiam essa diferença.
- **Decisão:**
  1. **Helper compartilhado** `server/services/cicloResolverService.js` com cache TTL 5min:
     - `getRgmToCicloMap(): Promise<Map<rgm, ciclo>>` — indexa o snapshot mais recente de matriculados.
     - `getAvailableCiclos(): Promise<string[]>` — lista ordenada desc lexicográfico.
     - `rgmFromMasterKey(masterKey)` e `masterKeysForCiclo(map, ciclo)` — helpers de transformação.
     - `bustCicloCache()` chamado em `routes/baseUploads.js` ao subir snapshot de matriculados.
  2. **Endpoints aceitam `?ciclo=<valor>` e sempre retornam `available_ciclos` + dados por ciclo:**
     - `/api/reports/activation-conversion` → `kpis_by_ciclo: Record<ciclo, kpis>` (sempre presente quando há >1 ciclo). Filtro específico: aplica `master_key = ANY(...)` derivado do `cicloMap`.
     - `/api/reports/caa/summary` → `summary_by_ciclo: Record<ciclo, { transitions }>`. Filtra in-memory cruzando `caa_protocols.rgm` com map.
     - `/api/reports/caa/funnel` → `counts_by_ciclo: Record<ciclo, counts>`. Mesma estratégia in-memory.
     - `/api/activation/list/:category` → `counts_by_ciclo: Record<ciclo, number>` — calculado sobre `rows` cacheado, **antes** dos filtros de stage/subgrupo/ciclo. Garante que contagens visíveis no header não se alteram com filtros locais.
  3. **UI segue padrão `MatriculadosComparisonPanel`:**
     - Dropdown `<select>` "Ciclo: Todos / 2026/2 / 2026/1" no header de cada painel — só aparece quando `available_ciclos.length > 1`.
     - Modo "Todos": número principal + mini-badges abaixo com breakdown por ciclo.
     - Modo "ciclo específico": números/listas recalculados pra esse ciclo, badges escondidos.
     - **Disparador (roster):** linha de texto "Por ciclo: 2026/2: X · 2026/1: Y" **sempre visível** acima dos chips de filtro (mostra total real independente do filtro ativo).
- **Onde (arquivos modificados):**
  - Backend: `cicloResolverService.js` (NOVO), `activationConversionService.js`, `caaProtocolsService.js`, `caaFunnelService.js`, `activationService.js`, `routes/reports.js`, `routes/baseUploads.js`.
  - Frontend: `reportApi.ts`, `activationApi.ts` (types), `ActivationConversionPage.tsx` (KpiCard com `cicloBreakdown`), `CaaDailyPanel.tsx` (helpers `pickTransition`/`buildBreakdown` reativos ao filtro), `CaaFunnelPanel.tsx` (dropdown + badges nos 6 estado cards), `ActivationRosterTable.tsx` (estado `countsByCiclo` + linha "Por ciclo:").
- **Default seguro:** Sem snapshot matriculados → cache vazio, `available_ciclos = []`, dropdown não aparece, comportamento idêntico ao anterior. Sem ciclo válido para um RGM → não conta em nenhum breakdown (mas continua na agregada).
- **Escopo conhecido (não implementado nesta iteração):** No CAA Daily, o filtro de ciclo afeta apenas os 4 KPIs do topo. A tabela de transições e os chips "Estado atual da base CAA" continuam agregados (backend não recebe filtro de ciclo nesses fluxos). Iterar quando houver demanda real.

#### Estratégia in-memory vs JOIN no banco

Optou-se por **filtragem in-memory** (cruzando `master_key/rgm` com o `cicloMap` carregado uma vez por query) em vez de JOIN com tabela temporária:
- ✅ Cache compartilhado entre as 3 queries de um mesmo painel (TTL 5min cobre a janela típica de navegação).
- ✅ Não precisa criar nem manter tabela `rgm_ciclo` no banco — fonte continua sendo o JSON do snapshot.
- ✅ Filtragem por ciclo via `master_key = ANY($N)` é eficiente em PostgreSQL com índice em `master_key`.
- ❌ Carrega map completo em memória (28k RGMs × ~10 bytes = ~280KB — negligível).

#### Alternativas descartadas

- **Layout side-by-side com 2 colunas de cards** (proposta original do usuário): 4 KPIs × 2 ciclos = 8 cards no Conversão, 6 cards × 2 = 12 no Funil — visualmente poluído. O padrão do MatriculadosComparison (número principal + badges abaixo) entrega a mesma informação com menos ruído e o usuário já validou esse padrão na decisão de 29/05.
- **Persistir ciclo em coluna nova de `activation_dispatch_events`:** acoplaria registros históricos ao snapshot atual de matriculados — se o ciclo de um aluno mudasse, o histórico ficaria errado. Lookup on-the-fly via snapshot vigente é mais consistente conceitualmente.
- **JOIN com tabela temporária `rgm_ciclo`:** mais "puro" SQL mas exige sincronização extra e cleanup. Filtragem in-memory é mais simples pro volume atual (~28k RGMs).
- **Cache de ciclo por TTL maior (ex.: 30min):** matriculados pode ser reimportado várias vezes ao dia em operação ativa; 5min equilibra performance × frescor.
- **Cache pré-aquecido no boot:** não vale a complexidade — primeira request paga ~1s, depois fica em cache.

### 02/06/2026 — Sync de desfechos CAA via CRM (remove input manual)

- **Modelo usado:** Opus 4.7 (principal) decidiu; Executor (Sonnet 4.6) implementou.
- **Problema:** O painel de desfecho manual (decisão 28/05) exigia que o consultor abrisse a app, preenchesse um modal e subisse print. Na prática, o consultor já registrava o desfecho no CRM DataCrazy diretamente — dois registros paralelos, divergentes e com fricção.
- **Decisão:** Substituir o fluxo de input manual por **polling automático de um campo CRM**. O consultor preenche o campo `DATACRAZY_DESFECHO_CAA_FIELD_ID` no lead com `"Sim"` (matrícula revertida) ou `"Não"` (cancelamento confirmado). A app lê esse campo, cria a entrada em `activation_manual_outcomes` e limpa o campo (handshake).
- **Escopo da remoção:** Página `/desfechos-manuais`, modal `ManualOutcomeModal`, hook `useConsultor`, `manualOutcomesApi.ts`, rota `/api/manual-outcomes`, serviço `manualOutcomesService.js`, link "Desfechos" no header, rota em `App.tsx`, botão "Desfecho" no roster CAA e no funil CAA.
- **O que continua:** Repositório `manualOutcomesRepository.js` (agora escrito pelo sync, lido pelo `caaFunnelService`). Tabela `activation_manual_outcomes` inalterada. A coluna "Desfecho manual" no funil CAA continua mostrando o valor — agora preenchido pelo sync.
- **Mapeamento de valores:**
  - `"Sim"` → `outcome = 'revertido'`
  - `"Não"` / `"Nao"` (case-insensitive) → `outcome = 'confirmado'`
  - Qualquer outro valor → ignorado (auditoria em `crm_desfecho_sync_log`)
- **Envs:**
  - `DATACRAZY_DESFECHO_CAA_FIELD_ID` — UUID do campo no CRM (sem esse env o sync é no-op com aviso).
  - `CRM_DESFECHO_SYNC_LOOKBACK_DAYS` — janela de lookback (default 14 dias).
  - `CRM_DESFECHO_SYNC_INTERVAL_HOURS` — intervalo do cron interno (default 2h).
- **Rate-limit:** reutiliza `datacrazyCrmLimiter` (10/s) extraído para `server/utils/datacrazyCrmLimiter.js` (compartilhado com cleanup de `origem_ativacao`).
- **Onde:**
  - Migration `023_crm_desfecho_sync_log.sql` — tabela de auditoria do sync.
  - `server/utils/datacrazyCrmLimiter.js` (NOVO) — singleton extraído do cleanup service.
  - `server/services/activationOrigemCleanupService.js` — refatorado para importar do módulo compartilhado.
  - `server/services/datacrazyClient.js` — nova função `getLeadAdditionalFieldValue(leadId, fieldId)`.
  - `server/repositories/activationDispatchRepository.js` — nova função `listRecentDispatchedLeadsForCategory(category, days)`.
  - `server/repositories/manualOutcomesRepository.js` — novas funções `deleteByRgmAndCategory` e `createFromCrm`.
  - `server/services/crmDesfechoSyncService.js` (NOVO) — orquestra o sync, retorna resultado.
  - `server/routes/maintenance.js` — endpoint `POST /api/maintenance/sync-crm-desfechos`.
  - `server/index.js` — remove rota manual-outcomes, adiciona cron do sync.
  - `src/services/maintenanceApi.ts` — novo método `syncCrmDesfechos` e tipo `SyncCrmDesfechosResponse`.
  - `src/pages/JourneyRulesPage.tsx` — card "Sync de desfechos CAA do CRM" no scope GLOBAL.
  - `src/components/Header.tsx`, `src/App.tsx` — remoção de rota/link.
  - `src/components/ActivationRosterTable.tsx`, `src/components/CaaFunnelPanel.tsx` — remoção de botão e modal.

#### Alternativas descartadas

- **n8n webhook disparando quando o campo é preenchido:** exigiria configuração de automação no DataCrazy para cada campo, mais frágil que polling periódico.
- **Preservar input manual junto com o sync:** dois caminhos paralelos gerando entradas divergentes; dados de fonte dupla confundem o funil. O CRM é a fonte de verdade.
- **Polling de todos os leads do CRM (sem filtrar por dispatched):** caro e sem contexto — só faz sentido verificar leads que realmente foram ativados. `listRecentDispatchedLeadsForCategory` filtra por `status='sent'` na janela de lookback.
- **Limitar lookback ao cooldown CAA (6h):** muito curto; consultor pode demorar dias para registrar. 14 dias cobre bem sem custo excessivo de GETs no CRM.
- **Rate-limit separado para o sync:** descartado em favor do singleton compartilhado — ambos chamam o mesmo CRM, o teto de 10/s é global.

### 02/06/2026 — Limpeza proativa de `origem_ativacao` stale + filtro defensivo de respostas

- **Modelo usado:** Opus 4.7 (principal) decidiu; Executor (Sonnet 4.6) implementou.
- **Problema:** O handshake n8n (decisão 01/06) só limpa `origem_ativacao` no CRM se a pessoa **responder**. Quem nunca responde fica com o campo preenchido pra sempre — e qualquer mensagem futura (3 meses, 6 meses depois) dispara o webhook e vira falso-positivo em `activation_responses`.
- **Decisão (tripé):**
  1. **Cleanup ativo** — job que limpa leads com `origem_ativacao` SET há mais de N horas (default 72h, configurável em `/journey-rules`). Lê de `activation_origem_ativacao_log` os SETs sem CLEAR posterior + `created_at < now() - interval Nh`. Pra cada, PUT `value=""` no CRM e registra um CLEAR no log (auditoria + idempotência).
  2. **2 caminhos de execução do cleanup:**
     - **Endpoint `POST /api/maintenance/clean-stale-origem-ativacao`** (protegido por `requireApiKey`) — agendável via n8n Schedule Trigger.
     - **Cron interno** — `setInterval` no boot do server (a cada 24h). Backup defensivo caso o n8n caia.
  3. **Filtro defensivo na leitura de respostas** — toda query que conta/exibe respostas faz `INNER JOIN activation_dispatch_events` exigindo um `sent` para a mesma `master_key`/`category` nas últimas N horas antes do `received_at`. Mesma N do cleanup (vem de `journey_settings.origem_ativacao_stale_hours`). Respostas "órfãs" continuam no DB (auditoria) mas não contam em painel de Conversão nem no `ResponseBadge` do roster.
- **Config:** novo campo `origem_ativacao_stale_hours integer default 72 check (between 1 and 8760)` em `journey_settings` (scope GLOBAL), editável em `/journey-rules` em um card novo.
- **Onde:**
  - Migration `022_origem_ativacao_settings.sql` (campo novo).
  - `server/repositories/journeySettingsRepository.js` (FIELDS + ALLOWED).
  - `server/repositories/activationOrigemRepository.js` — nova função `listStaleSetEntries(hours)`.
  - `server/services/activationOrigemCleanupService.js` (NOVO) — orquestra cleanup, retorna `{ scanned, cleaned, failed, errors }`.
  - `server/services/datacrazyClient.js` — função `clearOrigemAtivacaoForLead(leadId)` (PUT value=""), se ainda não existir.
  - `server/routes/maintenance.js` (NOVO) — endpoint + `requireApiKey`.
  - `server/index.js` — registra rota + `setInterval(cleanupService.run, 24h)` no boot.
  - `server/repositories/activationResponseRepository.js` — modifica `findLastByMasterKeys` com JOIN/filtro de dispatch recente.
  - `server/services/activationConversionService.js` — aplica filtro em todas as métricas (KPIs, by_category, top_buttons, recent_responses).
  - `src/services/journeySettingsApi.ts` — campo novo.
  - `src/pages/JourneyRulesPage.tsx` — card "Limpeza de origem_ativacao (CRM)" com input numérico.
- **Default seguro:** 72h cobre janela CAA (48h) + folga; categorias não-CAA têm sobra confortável. Cron 24h evita explosão de PUTs no CRM.

#### Alternativas descartadas

- **Limpar a tabela `activation_responses` (deletar registros stale):** descartado. Os registros são auditoria. Filtro em query é reversível e não destrói dado.
- **Webhook na app pra interceptar e validar antes de gravar:** quebra a decisão arquitetural de 22/05 (n8n grava direto, app só lê). Cleanup ativo + filtro defensivo resolve sem essa migração.
- **Cleanup só via endpoint (sem cron interno):** se n8n cair, fica acumulando. Cron interno é backup barato.
- **Janela diferente pra cleanup e pra filtro:** confunde — se limpamos em 72h, responder após 72h é stale por definição. Usar mesma config.
- **Janela hard-coded no env (sem UI):** decisão 29/05 abriu precedente — config de operação vai pra `journey_settings` + `/journey-rules` (escala melhor que env).
- **Categoria nova `aguardando-inicio` no CHECK do log de origem:** fora de escopo desta iteração; bug latente conhecido (CHECK na tabela `activation_origem_ativacao_log` não inclui `aguardando-inicio`). Anotar pra próxima migration.

#### Extensão (02/06/2026) — Botão manual + rate-limit do CRM

- **Botão na UI:** card "Limpeza de origem_ativacao" em `/journey-rules` ganhou 2 botões:
  - **Simular (dry-run)** → `POST /api/maintenance/clean-stale-origem-ativacao?dry_run=true` (não chama CRM, só conta o que seria limpo).
  - **Limpar agora** → mesmo endpoint sem `dry_run`. Confirm dialog antes de disparar.
  - Painel de resultado mostra: encontrados, limpos, falhas, janela, taxa CRM, ran_at + lista expansível dos erros.
- **Rate-limit CRM:** `activationOrigemCleanupService.js` ganhou um `createRateLimiter` singleton (default 10/s, configurável via `DATACRAZY_CRM_RATE_PER_SECOND`). `await datacrazyCrmLimiter.acquire()` antes de cada PUT pro CRM DataCrazy. Default conservador — DataCrazy não publica limite oficial; 10/s evita rajada e mantém cleanup tolerável (1.000 leads stale → ~100s).
- **Onde:**
  - `server/services/activationOrigemCleanupService.js` — `datacrazyCrmLimiter` + `acquire()` antes do PUT + `crm_rate_per_second` no retorno.
  - `src/services/maintenanceApi.ts` (NOVO) — client TS com `apiAuthHeaders()`.
  - `src/pages/JourneyRulesPage.tsx` — botões + painel de resultado.

##### Alternativas descartadas (extensão)

- **Sem confirm dialog:** botão escarlate sem confirmação é arriscado — Limpeza apaga centenas de campos no CRM real.
- **Rate-limit no `datacrazyClient` (global):** afetaria também `searchLeads` / `paginateAll` que já têm seus próprios pacings (`pageDelay`). Limitar só na cleanup mantém o resto inalterado.
- **Botão na página `/manutenção` separada:** página dedicada de manutenção não existe ainda; pra 1 botão, criar uma página é overhead. Colocar no card já existente é coeso.

### 02/06/2026 — Rate-limit Meta WhatsApp (cap rígido por segundo)

- **Modelo usado:** Opus 4.7 (principal)
- **Problema:** O dispatcher de ativação (`runDatacrazyActivationBatch`) não tinha nenhuma garantia estrutural de respeitar limites da Meta. Único pacing era o `ACTIVATION_SEND_DELAY_MS` (default 400ms = ~2,5/s) — útil mas frágil: se alguém zerar o env, paralelizar o dispatcher, ou se a Meta apertar o limite, o código não avisa. Risco real de derrubar qualidade do número WABA ou ser banido em lotes grandes (ex.: 4.600 inadimplentes).
- **Decisão:** Adicionar um **rate limiter de janela deslizante** singleton no módulo, com cap rígido por segundo (default 60/s, configurável via `WHATSAPP_MAX_SENDS_PER_SECOND`). `await whatsappSendLimiter.acquire()` antes de cada `messagingProvider.sendTemplateMessage`. Default 60/s é abaixo do limite Cloud API da Meta (80/s) com margem de segurança.
- **Onde:**
  - `server/utils/rateLimiter.js`: novo helper `createRateLimiter(maxPerWindow, windowMs)` — janela deslizante in-memory.
  - `server/services/activationService.js`: singleton `whatsappSendLimiter` no top-level; `await whatsappSendLimiter.acquire()` antes do envio dentro do loop.
- **Comportamento mantido:** `ACTIVATION_SEND_DELAY_MS=400` (default) continua valendo — o limiter é puramente defensivo. Para acelerar (ex.: lotes grandes em WABA tier 4/5), setar `ACTIVATION_SEND_DELAY_MS=0` e o limiter garante teto de 60/s. Em tier 4 (100k/24h), 60/s permite drenar 100k em ~28min sem risco.
- **Limitação conhecida:** estado in-memory, válido para 1 processo Node. Se houver múltiplos workers no futuro, migrar para Redis/Postgres.

#### Alternativas descartadas

- **Reduzir `ACTIVATION_SEND_DELAY_MS` para 17ms (= 60/s evenly distributed):** mais simples, mas não tem garantia de teto se algum envio for instantâneo (cache local). Sliding-window é mais robusto.
- **Token bucket clássico:** funcionalmente equivalente para esse caso (não precisamos de "burst"); sliding-window é mais fácil de raciocinar e suficiente.
- **Cap diário por categoria/global:** considerado, mas tier 4 (100k/24h) deixa folga suficiente para o volume atual; cap por segundo basta. Adicionar cap diário em fase futura se for útil.
- **Quality monitoring via API Meta Business (Green/Yellow/Red):** valor agregado, mas exige integração nova; pode entrar em iteração posterior se a operação crescer.

### 02/06/2026 — Coluna "Janela" no roster CAA (tempo restante 48h)

- **Modelo usado:** Opus 4.7 (principal)
- **Problema:** O roster CAA não mostrava ao consultor quanto tempo ainda restava da janela de 48h por candidato. A informação existia no `caaFunnelService` (estoque/funil) mas ficava escondida lá. Sem isso, o consultor não conseguia priorizar quem atender primeiro.
- **Decisão:** Adicionar coluna nova "Janela" no `ActivationRosterTable` (somente categoria `processos-caa`), mostrando o tempo restante até a janela vencer, com badge colorido por urgência. Cálculo do `hours_remaining` é feito no frontend a partir do `expires_at` (timestamp absoluto vindo do backend), garantindo que o número sempre reflita o "agora", mesmo com o cache do backend ativo.
- **Onde:**
  - `server/services/activationService.js`: `import { calcJanela }` adicionado; após o loop de items, novo bloco específico para CAA carrega `listOpenProtocolsByRgm` + `journey_settings`, calcula `{ t0, expires_at }` via `calcJanela`, anexa `caa_janela: { t0, expires_at, t0_source, dias_tipo }` (ISO strings) em cada item. Sort atualizado: CAA ordena por `expires_at` ascendente (mais urgente no topo).
  - `src/services/activationApi.ts`: novo tipo `CaaJanelaInfo` + campo opcional em `ActivationRosterItem`.
  - `src/components/ActivationRosterTable.tsx`: novo componente `CaaJanelaCell` + coluna "Janela" no `<thead>` (CAA only) entre os filtros condicionais e "Vezes ativado".
- **Faixas de cor:** Verde ≥12h (formato `14h` ou `2d` se ≥48h) · Âmbar 6–12h · Vermelho <6h (mostra minutos se <1h: `42min`) · Cinza "Vencida" ou "sem janela" (sem T0).
- **Tooltip:** mostra fonte do T0 (Data Chegada / 1º export / 1º envio), tipo de contagem (corridos/úteis), T0 e data de vencimento formatados.

#### Alternativas descartadas

- **Computar `hours_remaining` no backend e cachear o número:** ficaria preso ao TTL do cache (10min), badge ficaria "frozen" em valor antigo. Solução adotada (cachear `expires_at` absoluto, computar horas no frontend) é mais simples e sempre fresca.
- **Badge inline no nome em vez de coluna:** o usuário pediu coluna explicitamente. Coluna deixa o dado tabular e ordenável.
- **Chips de contagem no header ("X vencendo em 6h · Y em <1h"):** considerado, mas escopo MVP é coluna; adicionar depois se houver demanda.
- **Querry separada para listar TODOS protocolos abertos (sem dedup por RGM):** descartado em favor de reusar `listOpenProtocolsByRgm` (mesma usada pra montar a fila). Pessoas com >1 protocolo aberto verão a janela do "mais recentemente mudado" — caso raro, custo de erro baixo, evolui depois.

### 02/06/2026 — Remoção do dedup por template (`template_ja_enviado`)

- **Modelo usado:** Opus 4.7 (principal)
- **Problema:** Mesmo com o cooldown novo (decisão abaixo), a pessoa continuava sendo bloqueada permanentemente por uma segunda barreira no `runDatacrazyActivationBatch`: `wasTemplateSentInCategory(category, master_key, template_name)`. Essa função consultava `activation_dispatch_events` sem janela temporal e marcava `skipped: template_ja_enviado` se aquele **nome de template específico** já tivesse sido enviado uma vez. Na prática — como quase nenhuma categoria tem 3 templates distintos por tier (1ª/Reativação/5ª) — o sistema resolvia o mesmo nome (`caa_cancelamento`) pra todos os tiers e o segundo filtro virava bloqueio permanente disfarçado de "dedup". Caso real validado: RGM 47277581 entrou na fila como Reativação após o cooldown de 6h, mas o dispatch acusava `1 ignorada(s) (template já enviado)`.
- **Decisão:** Remover o check + a função `wasTemplateSentInCategory`. O cooldown (6h CAA / 24h outras) é o único gate antispam; o cap por tier continua dado pela presença/ausência de template (sem template `fifth` → `template_nao_configurado` segura naturalmente).
- **Onde:** `server/services/activationService.js` — `runDatacrazyActivationBatch` (5 linhas removidas) + definição da função (9 linhas removidas).
- **Efeito:** Pessoa pode receber o mesmo template múltiplas vezes desde que respeite o cooldown e o tier. A operação assume a responsabilidade de configurar templates distintos por tier em `/regras` se quiser conteúdo variado (não é obrigatório).

#### Alternativas descartadas

- **Janela temporal no dedup (ex.: "mesmo template só após 7 dias"):** mais um eixo de configuração que sobrepõe o cooldown sem benefício claro. Cooldown único é mais simples.
- **Manter o dedup mas relaxar pra "diferente status que não `sent`":** não muda nada — o status pra evento bem-sucedido sempre é `sent`.
- **Manter o dedup como warning não-bloqueante:** poluiria o resultado do batch sem agregar; quem precisar de variedade de conteúdo cadastra mais templates.

### 02/06/2026 — Cooldown entre disparos (substitui filtro absoluto de dispatched)

- **Modelo usado:** Opus 4.7 (principal)
- **Problema:** Pessoa que já foi disparada 1 vez em uma categoria nunca mais voltava à fila — o filtro `dispatched.has(master_key)` era absoluto. Conflito com a regra de múltiplas ativações por tier (1ª / Reativação / 5ª) que já existia no resto da app (`resolveMessageTier`, `resolveTemplateForActivation`).
- **Decisão:** Trocar por **cooldown configurável por categoria**:
  - **`processos-caa`**: **6h** (encaixa 2 disparos/dia dentro da janela CAA de 48h; consultor não trabalha 24h, então 12h não daria 2 envios no mesmo expediente)
  - **Outras categorias** (`docs-pendentes`, `financeiro`, `acessos-blackboard`, `provavel-evasao`, `aguardando-inicio`): **24h** (1x/dia)
  - Limite total continua dado pelos templates configurados — pessoa some quando esgota o tier (ex.: sem template `5ª ativação`, sai após a 4ª).
- **Onde:**
  - `activationDispatchRepository.js#getLastSentAtByMasterKey` — nova query `max(created_at)` por master_key + status `sent`.
  - `activationService.js#COOLDOWN_HOURS_BY_CATEGORY`, `getCooldownHoursForCategory`, `isOnCooldown` — helpers.
  - 3 locais que usavam `dispatched.has(master_key)` foram substituídos por `isOnCooldown(...)`: intersection list, aguardando-início, batch.
  - Erro claro quando usuário seleciona alguém em cooldown via batch: HTTP 400 `no_eligible_selected` com mensagem indicando horas restantes.
- **Default seguro:** cooldownHours hardcoded por categoria. Quando for preciso tuning fino per-categoria via UI, mover pra `journey_settings`.

#### Alternativas descartadas

- **Sempre permitir disparos consecutivos sem cooldown:** spam; sem proteção contra clique duplo.
- **Cooldown via `journey_settings`:** mais flexível, mas exige migration + form em `/regras` + carregar settings em cada chamada de fila. Defaults hardcoded resolvem o problema imediato.
- **Limite máximo absoluto por pessoa (ex.: 5 disparos/categoria):** confiamos nos templates configurados (sem 5ª = sai naturalmente).

### 01/06/2026 — Verify de `origem_ativacao` agora é best-effort + n8n limpa após resposta

- **Modelo usado:** Opus 4.7 (principal)
- **Problema:** `verifyOrigemAtivacaoForCategory` bloqueava o disparo quando o **PUT no CRM web** retornava 200 OK mas o **GET na API pública** (`/api/v1/leads`) não retornava o campo `origem_ativacao` nos `additionalFields` (config "campo não exposto via API"). O campo estava sendo gravado corretamente no CRM — só não saía na resposta da API pública.
- **Decisão:**
  - `verify` agora confia no **PUT 200 OK** (a automação do CRM lê o campo internamente, não via API pública).
  - GET via API pública continua sendo feito como double-check, mas se falhar/não retornar o campo, loga warning e segue (`ok: true, verified: false`).
  - PUT que falhar de verdade (status != 200) continua bloqueando o disparo (comportamento correto).
- **Onde:** `server/services/datacrazyClient.js#verifyOrigemAtivacaoForCategory`.

#### Webhook de resposta (n8n) — handshake obrigatório

A automação do CRM (DataCrazy) dispara o webhook de resposta enquanto `origem_ativacao` estiver preenchido no lead. Se o n8n só grava em `activation_responses` e **não limpa** o campo, **toda mensagem subsequente do aluno** continuará sendo logada como resposta de ativação (falso-positivo).

**Fluxo correto no n8n:**

```
[Trigger: resposta WhatsApp]
  ↓
[Grava em activation_responses (Postgres)]
  ↓
[HTTP PUT — limpa origem_ativacao no CRM]
```

**PUT pra limpar o campo:**

```
PUT https://crm.g1.datacrazy.io/api/crm/additional-fields/lead/{LEAD_ID}/3a22bd69-4578-4740-87c1-29e72fbbac22
Authorization: Bearer <DATACRAZY_API_KEY>
Content-Type: application/json
Body: {"value": ""}
```

(Field ID `3a22bd69-4578-4740-87c1-29e72fbbac22` = `origem_ativacao` no CRM. Validado 01/06/2026.)

#### Alternativas descartadas

- **Endpoint da app `POST /api/activation/responses` fazer o PUT de limpeza:** acopla a app ao fluxo de respostas e duplica responsabilidade — o n8n já é o ponto natural pra isso.
- **Marcar o campo `origem_ativacao` como "exposto via API" no CRM:** seria mais limpo, mas requer config no DataCrazy que pode não estar disponível na conta. A solução com PUT-trust funciona sem depender disso.

### 03/06/2026 — Falso start: consultor no dispatch (revertido na mesma sessão)

- **Modelo usado:** Opus 4.7 (principal)
- **Contexto:** Numa primeira leitura, interpretei "consultor" como quem clica em "Ativar". Construí `activation_dispatch_events.consultor_id` (migration 024) + hook `useConsultor` + painel agrupado por disparador. **Errado.** O usuário corrigiu: o disparador é um operador (pessoa diferente do consultor); o consultor é quem ASSUME a conversa no DataCrazy depois que o aluno responde.
- **Revertido em:** migration 025 dropa colunas; arquivos novos deletados; código modificado restaurado.
- **Aprendizado documentado:** sempre clarear "quem clica" vs "quem atende" antes de modelar tabelas de autoria.

### 03/06/2026 — Painel "Por consultor" (modelo correto)

- **Modelo usado:** Opus 4.7 (principal)
- **Decisão:** Identidade do consultor vem do **DataCrazy** (não do nosso app). Snapshot textual gravado em duas fontes:
  - `activation_responses.consultor_responsavel_nome` — populado pelo webhook do n8n que entrega a resposta (n8n lê o campo customizado do DataCrazy ao processar a resposta).
  - `caa_protocols.consultor_responsavel_nome` + `consultor_responsavel_updated_at` — populado pelo `crmDesfechoSyncService` que faz polling. Quando detecta desfecho (Sim/Não), também lê o campo "consultor responsável" do mesmo lead e atualiza TODOS os protocolos daquele RGM.

#### Migration 026

```sql
alter table activation_responses
  add column consultor_responsavel_nome text;
alter table caa_protocols
  add column consultor_responsavel_nome text,
  add column consultor_responsavel_updated_at timestamptz;
```

Snapshot por texto (não FK) — preserva histórico se o consultor for renomeado/deletado no futuro `app_users`. Depois do merge com `dcz-crm-sync`, resolve nome → user por similarity em `username` / `email_cruzeiro`.

#### Config necessária

- `DATACRAZY_DESFECHO_CAA_FIELD_ID` — campo "Sim/Não" do desfecho (já existia).
- `DATACRAZY_CONSULTOR_RESPONSAVEL_FIELD_ID` (NOVO) — UUID do campo customizado no DataCrazy onde fica o nome do consultor responsável. Sem ele, sync de desfecho continua funcionando mas atribuição fica vazia.

#### Contrato do webhook do n8n

O n8n já posta em `POST /api/activation/responses`. Agora também pode enviar:

```json
{
  "lead": "<datacrazy_lead_id>",
  "evt": "<external_id>",
  "rgm": "...",
  "consultor_responsavel_nome": "Felipe Nolasco"
}
```

Aceita várias chaves: `consultor_responsavel_nome` | `consultorResponsavelNome` | `consultor` | `responsavel` | `responsible_user_name`. Sem o campo, gravação continua funcional (consultor fica nulo).

#### Atribuição CAA

Quando `crmDesfechoSyncService` detecta `Sim`/`Não` num lead:
1. Cria entrada em `activation_manual_outcomes` (como já fazia).
2. **Novo**: Lê `DATACRAZY_CONSULTOR_RESPONSAVEL_FIELD_ID` no mesmo lead via `getLeadAdditionalFieldValue`.
3. Se preenchido, `UPDATE caa_protocols SET consultor_responsavel_nome=$1, consultor_responsavel_updated_at=now() WHERE rgm=$2` (atualiza todos os protocolos do RGM — realista, o consultor cuida do lead inteiro, não de protocolos individuais).
4. Best-effort: se falhar leitura/update, loga warning e segue (não bloqueia o sync de desfecho).

#### Endpoint

`GET /api/reports/consultores?period_days=` (com `requireApiKey`). Resposta:
- `consultores[]`: `{ consultor_nome, caa_revertidos, caa_perdidos, caa_taxa_reversao, total_respostas, ultima_atribuicao }`.
- `totals`: agregado.
- Período padrão 30d, máx 365.
- Ordenado por `caa_revertidos desc`, tiebreaker `total_respostas desc`.

#### UI

`ConsultoresPanel` em `/reports` (renderizado quando categoria ativa = CAA). Filtros: período 7/30/90d. Tabela compacta com Consultor / Revertidos / Perdidos / Taxa / Respostas / Última atividade. Mensagem informativa quando vazio (explica que dados aparecem quando webhook/sync começarem a popular).

#### Alternativas descartadas

- **FK pra `app_users.id`:** acoplaria ao banco do dcz-crm-sync antes do merge. Snapshot textual desacopla.
- **Atribuir respostas com mesma lógica:** decisão do usuário foi "só reversão" — mais simples e foco no que importa pra comissionamento.
- **Tabela `consultor_attribution` separada:** redundante, snapshot dentro de `caa_protocols` resolve.
- **Buscar consultor em todo lead disparado (não só nos com desfecho):** mais custo de API e dado fica obsoleto rápido. Snapshot no momento do desfecho captura quem efetivamente fechou.
- **Múltiplas tentativas de chave no webhook:** preferido invés de exigir uma chave única — torna o n8n mais resiliente a refactor do nome do campo.

### 02/06/2026 — Direct search threshold 25→100 + paralelização

- **Modelo usado:** Opus 4.7 (principal)
- **Problema:** Selecionar **29 pessoas** na fila CAA caía no scan paginado completo do CRM (29 > 25). Resultado: minutos pra varrer 30k leads em 300+ páginas com 400ms entre páginas.
- **Decisão:**
 - Threshold default sobe de **25 → 100** (`DATACRAZY_DIRECT_SEARCH_THRESHOLD`). Cobre seleções típicas do roster sem trade-off (até 100 GETs diretos ainda é mais rápido que paginar o CRM inteiro).
 - Buscas diretas agora rodam em **batches paralelos de 5** (configurável via `DATACRAZY_DIRECT_SEARCH_CONCURRENCY`, default 5, max 20). Antes era 1 por vez (sequencial).
 - 29 leads sai de minutos → ~6s.
- **Onde:** `server/services/datacrazyClient.js#buildLeadsLookupIndex` (bloco do fast path).

#### Alternativas descartadas

- **Threshold ainda maior (ex.: 500):** acima de ~100 alvos, paginar o CRM inteiro (com cache `sharedLeadsIndex` TTL 20min) já compensa, porque a 1ª chamada paga o custo único e as subsequentes reusam.
- **Concorrência mais alta (ex.: 20):** sem dados sobre rate limit oficial do DataCrazy, 5 é conservador. Bumpável via env se precisar.
- **Cache de leads por master_key:** já existe via `sharedLeadsIndex` (índice global de phone/email com TTL 20min).

### 01/06/2026 — Busca direta no DataCrazy para lotes pequenos

- **Modelo usado:** Opus 4.7 (principal)
- **Problema:** Disparar 1 pessoa demorava ~4min porque `buildLeadsLookupIndex` varria todas as páginas de leads (`take=100&skip=N`) com `pageDelay=400ms`, mesmo que o alvo fosse só 1 telefone.
- **Decisão:** Quando o lote tem **<= 25 alvos novos** (configurável via `DATACRAZY_DIRECT_SEARCH_THRESHOLD`), pular a paginação e fazer `GET /api/v1/leads?search=<telefone_ou_email>&take=5` por alvo, alimentando o mesmo `byPhone/byEmail` que o caminho paginado popula. Lotes maiores continuam no scan paginado (mais eficiente em volume). **Atualização 02/06/2026:** threshold elevado para 100 + paralelização de 5 — ver entrada acima.
- **Onde:** `server/services/datacrazyClient.js` → `buildLeadsLookupIndex`. Retorno ganhou flags `direct_search` e `direct_queries` para diagnóstico.
- **Efeito:** Disparo individual (seleção de 1 aluno) deve cair de ~4min para alguns segundos (1 request à API + latência).
- **Default seguro:** Se a busca direta falhar (`searchLeads` lançar), loga warning e continua com o que tiver. Cache compartilhado (`sharedLeadsIndex`, TTL 20min) é alimentado igual.

#### Alternativas descartadas

- **Sempre usar scan paginado:** mantém o problema atual (tempo proporcional ao tamanho do CRM, não ao lote).
- **Buscar lead por id quando já temos `datacrazy_lead_id`:** só vale após a primeira ativação. No 1º disparo, ainda precisamos descobrir o lead por telefone/email.

### 22/05/2026 — Regra D+1 para CAA (cancelamento de matrícula)

- **Modelo usado:** Opus 4.7 (principal)
- **Decisão:** Status normalizado por protocolo + histórico de transições + fila restrita aos pendentes.

#### Modelo de status

A partir das colunas `Situação Atendimento` e `Situação Deferimento` do export `data.xlsx`:

| Atendimento | Deferimento | Status normalizado | Significado                                       |
|-------------|-------------|--------------------|---------------------------------------------------|
| PENDENTE    | Em aberto   | `open`             | Em fila para ativação                             |
| CANCELADO   | (qualquer)  | `lost_canceled`    | Aluno desistiu antes do CAA decidir (perdemos)    |
| CONCLUIDO   | Deferido    | `lost_confirmed`   | CAA aprovou cancelamento (perdemos)               |
| CONCLUIDO   | Indeferido  | `won_reverted`     | CAA negou cancelamento — matrícula segue (vitória) |
| (outros)    | —           | `unknown`          |                                                   |

#### Tabelas

- `caa_protocols` — estado vivo por **Protocolo** (chave primária).
- `caa_protocol_transitions` — histórico de mudanças de status (`from_status` → `to_status`).

Snapshots brutos continuam em `processos_caa_snapshots/_rows` para auditoria.

#### Pipeline

1. Upload CAA grava em `processos_caa_rows` (snapshot bruto).
2. `caaProtocolsService.processSnapshot(snapshotId)` é chamado em sequência:
   - UPSERT em `caa_protocols`.
   - Para cada protocolo, se o status mudou em relação ao estado vivo, registra uma linha em `caa_protocol_transitions`.
3. Idempotente: reimportar o mesmo snapshot não gera novas transições.

#### Fila de ativação

- Categoria `processos-caa` em `getIntersectionActivationList`:
  - Filtra `processos_caa_rows` por `Subprocesso = cancelamento` **E** `Situação Atendimento = PENDENTE`.
  - Dedup por RGM (não falar 2x com a mesma pessoa).
  - Cruzamento com matriculados mantém a régua de 1ª/reativação/5ª via `activation_dispatch_events`.

#### Painel D+1

- Endpoints:
  - `GET /api/reports/caa/summary?hours=24` — KPIs + contagens atuais.
  - `GET /api/reports/caa/transitions?hours=24&to_status=lost_canceled,lost_confirmed` — lista detalhada.
- UI: componente `CaaDailyPanel` aparece em **Relatórios** (quando card CAA selecionado) e em **Ativação CAA**.

#### Alternativas descartadas

- **Calcular tudo on-the-fly comparando snapshots brutos:** caro e sem chave estável (mesmo Protocolo é a única chave confiável; comparar XLSX a XLSX é frágil).
- **Identidade por Protocolo na fila:** descartado por pedido do usuário — 1 aluno com 2 protocolos pendentes deve aparecer 1× só.
- **Mudar `rowFilterForCategory` para incluir o filtro de pendência em todos os contextos:** quebraria o relatório de overview ("12.425 cancelamentos no arquivo") que conta tudo. O filtro de pendência é aplicado **só na fila**, via flag `caaOnlyPending` passada de `activationService`.

#### Scripts utilitários

- `server/scripts/backfillCaaProtocols.mjs` — reconstrói `caa_protocols` a partir dos snapshots existentes (usar `--reset` para zerar antes).
- `server/scripts/inspectCaaProtocols.mjs` — fotografia rápida do estado.
- `server/scripts/diagCaaQueue.mjs` — verifica a fila CAA atual.
- `server/scripts/diagCaaSummary.mjs` — verifica stats D+1.

#### Extensão (25/05/2026) — Painel D+1 baseado no último export

- Antes: filtro por janela móvel `?hours=24` (mostrava "0" se passassem 24h sem upload novo).
- Agora: `scope=last_snapshot` é o padrão. Os endpoints `/api/reports/caa/summary` e `/api/reports/caa/transitions` resolvem o snapshot mais recente em `processos_caa_snapshots` e filtram `caa_protocol_transitions` por `snapshot_id`.
- Compatibilidade: `?scope=hours&hours=24` continua funcionando (debug).
- Resposta agora inclui o objeto `snapshot` (`id`, `file_name`, `row_count`, `created_at`) para o header do painel mostrar contexto.

### 22/05/2026 — Respostas de ativação (webhook externo)

- **Modelo usado:** Opus 4.7 (principal)
- **Decisão:** A app **não recebe webhook** de respostas. A integração externa (DataCrazy ou similar) grava direto na tabela `activation_responses`. A app apenas **lê** e exibe.

#### Schema `activation_responses` (migration 015)

| Coluna | Tipo | O que preencher |
|---|---|---|
| `category` | text | `processos-caa` / `docs-pendentes` / `financeiro` / `acessos-blackboard` / `provavel-evasao` (pode ficar null — será resolvido pelo dispatch) |
| `master_key` | text | Idealmente `RGM:<rgm>` (mesma chave de `activation_dispatch_events`) |
| `datacrazy_lead_id` | text | ID do lead na DataCrazy |
| `telefone` | text | Número (qualquer formato; é normalizado) |
| `rgm` | text | Para fallback de identificação |
| `response_kind` | text | `click` (default) / `message` / `opt_out` / `other` |
| `button_payload` | text | Texto/payload do botão clicado (ex.: "Quero ativar", "Não quero") |
| `message_text` | text | Texto livre, se houver |
| `external_id` | text | ID único do evento no provedor — usado para idempotência (UPSERT) |
| `raw_payload` | jsonb | Payload original (auditoria) |
| `received_at` | timestamptz | Quando o evento aconteceu no provedor |

**Correlação fila ↔ resposta** (ordem de prioridade):
1. `master_key` direto (preferido).
2. `datacrazy_lead_id` → busca último `activation_dispatch_events.datacrazy_lead_id`.
3. `telefone` normalizado → busca último envio dessa pessoa (janela 168h).

**Comportamento na fila:**
- Resposta **não tira** ninguém da fila. Só vira badge "Clicou · 2h" no roster.
- Para CAA: o aluno só sai da fila quando o **status do protocolo** mudar (pendente → won/lost). Cruzar resposta + transição permite identificar "respondeu mas perdemos" (alvo de análise).

**Exemplo de INSERT** (para a integração externa):
```sql
insert into activation_responses (
  category, master_key, datacrazy_lead_id, telefone, rgm,
  response_kind, button_payload, external_id, raw_payload
) values (
  'processos-caa', 'RGM:47485892', 'lead_abc123', '5511947648432', '47485892',
  'click', 'Quero ativar minha matrícula', 'evt_xyz',
  '{"source":"datacrazy","template":"caa_reativacao_v2"}'::jsonb
)
on conflict (external_id) where external_id is not null do nothing;
```

#### Alternativas descartadas

- **Endpoint webhook na própria app:** o usuário prefere centralizar gravação fora; menos pontos de falha do lado nosso.
- **Tirar quem respondeu da fila:** descartado — clique não significa desfecho, só engajamento.

### 22/05/2026 — Filtro de "limbo" na fila Blackboard (turma ainda não começou)

- **Modelo usado:** Opus 4.7 (principal)
- **Decisão:** Alunos cuja `Data Matrícula` cai em uma turma cadastrada em `academic_terms` cujo `inicio_conteudo` ainda não chegou são **retirados da fila `acessos-blackboard`**. Outras filas (financeiro, docs, CAA, evasão) NÃO são afetadas.

#### Por quê

A planilha de Blackboard lista todos os matriculados que não acessaram a plataforma. Mas se a turma de alguém ainda não começou (ex.: matriculado em junho na turma "Agosto", aulas só em 15/08), ele não tem conteúdo para acessar — pressioná-lo a entrar no BB é ativação inútil/ruidosa.

#### Como funciona

1. **Cadastro:** turmas vivem em `academic_terms` (já existente, página `/academic-terms`). Campos relevantes: `inicio_matricula`, `fim_matricula`, `inicio_conteudo`, `tem_ambientacao`, `dias_ambientacao`.
2. **Resolução da turma do aluno:** `findTermByMatriculaDate(terms, dataMatricula)` em `server/services/termResolverService.js`.
   - Lê `data->>'Data Matrícula'` do snapshot matriculados.
   - Converte serial Excel via `excelSerialToDate` (`server/utils/dateParser.js`).
   - Acha a turma `t` onde `t.inicio_matricula ≤ dataMat ≤ t.fim_matricula`.
3. **Verificação de limbo:** `isInLimbo(term, today)` retorna `true` se `today < (inicio_conteudo - dias_ambientacao)`.
4. **Aplicação:** em `getIntersectionActivationList` (categoria `acessos-blackboard`), antes de adicionar o item à fila, executa `resolveLimbo`; se `limbo === true`, incrementa `skipped_bb_limbo` e pula.
5. **Cache:** turmas são carregadas com TTL 5min (`loadTerms()`); rotas POST/PUT/DELETE em `academicTerms.js` invalidam via `bustTermCaches()` (limpa também o cache da fila BB).

#### Default seguro

- Sem turma cadastrada → ninguém é filtrado (comportamento idêntico ao anterior).
- Aluno cuja data de matrícula não bate com nenhuma turma → entra na fila normalmente.

#### Indicação na UI

- Banner amarelo na `AcademicTermsPage` explicando a regra.
- Banner na `ActivationRosterTable` quando `category === 'acessos-blackboard'` e `skipped_bb_limbo > 0`, com link pro Calendário.

#### Alternativas descartadas

- **Identificar turma pelo `Ciclo`** (ex.: "2026/1"): o ciclo é grosseiro (1 ciclo = 1 semestre), não tem granularidade pra "abril/maio/junho". Usar data_matricula dá a granularidade necessária e usa o cadastro já existente.
- **Filtrar em todas as filas:** o usuário decidiu aplicar apenas em BB por ora (financeiro/docs/CAA podem ter ações úteis mesmo no limbo).
- **Mover cadastro de turmas pra dentro de Regras:** o cadastro já existe em Calendário e é referenciado por outros sistemas (decisionEngine, students.term_id); duplicar ou mover quebraria links existentes.

#### Próximos passos sugeridos

- Categoria nova de ativação `aguardando-inicio` para os alunos em limbo, com mensagens semanais ("sua turma começa em X dias") — esqueleto fica reservado para quando os tipos de mensagem forem decididos.

#### Extensão (22/05/2026) — Priorização BB + filtros nível/ciclo

- Migration 016: `nivel` e `ciclo` em `academic_terms` (text, nullable, indexados). Aplicar manualmente: `node server/db/migrate.js` (ou `npm run migrate` se houver script).
- Form de turma e listagem de Regras ganham os campos. Filtros na listagem por nível e ciclo.
- Fila BB ordena por urgência: `alta` (≥30d sem início), `media` (≥14d), `normal` (<14d), `sem_turma`. Defaults hard-coded em `URGENCY_HIGH_DAYS` / `URGENCY_MEDIUM_DAYS` em `activationService.js`.
- Badge `UrgencyBadge` no roster + chips com contagens no header da fila BB.
- Default seguro: sem turma cadastrada para um aluno → `sem_turma`, mantém na fila sem priorização.

### 25/05/2026 — Campo `origem_ativacao` no disparo DataCrazy

- **Modelo usado:** Opus 4.7 (principal)
- **Decisão:** Após envio bem-sucedido do template em `runDatacrazyActivationBatch`, a app faz `PUT` no endpoint do **CRM web** (não o OpenAPI público): `{crm}/api/crm/additional-fields/lead/{leadId}/{fieldId}` com body `{ value: "Doc" | "Inad" | "caa" | ... }`. Mesma URL que o navegador usa ao editar o campo manualmente.
- **Extensão (26/05/2026):** `verifyOrigemAtivacaoForCategory` confirma leitura no lead (GET com `additionalFields`). **Pré-voo** no 1º lead encontrado antes de qualquer envio; falha → HTTP 503 `origem_ativacao_unavailable` e banner na UI. No loop, grava `origem_ativacao` **antes** do WhatsApp; se falhar, não envia e interrompe o lote.
- **Extensão (26/05/2026) — Hardening:** `APP_API_KEY` opcional protege rotas de escrita; upload matriculados invalida cache de todas as filas; CPF→RGM usa matrícula mais recente; reparo de colunas CAA deslocadas (`caaExportRepair.js`); falha em `processSnapshot` retorna `warning` no upload.
- **Correção (25/05):** `PATCH /api/v1/leads/{id}` com `additionalFields` retorna 200 mas **não persiste** o valor de forma confiável; só o PUT no CRM funciona.

### 28/05/2026 — Painel de Desfecho Manual (CAA + 4 categorias)

- **Modelo usado:** Opus 4.7 (principal) decidiu, Executor (Sonnet 4.6) implementou.
- **Decisão:** Os consultores registram manualmente o resultado de cada ativação CAA (revertido/confirmado/sem contato/outro), com possibilidade de anexar print da conversa. Esta tabela vira a **fonte da verdade do desfecho** porque o export CAA novo só lista protocolos com `Data Chegada = D-1` — a maioria dos desfechos cai fora dessa janela e não aparece em snapshots subsequentes (3 exports consecutivos analisados em 25/26/27 de maio: zero protocolos repetidos).

#### Modelo de dados

Migration `018_activation_manual_outcomes.sql`:

| Coluna | Tipo | O que guarda |
|---|---|---|
| `id` | uuid pk | |
| `category` | text (check 5 categorias) | Genérico para reuso futuro; UI inicial só CAA |
| `master_key` | text | Padrão `RGM:<rgm>` (mesmo das outras tabelas) |
| `rgm`, `cpf`, `nome` | text | Identificação do aluno |
| `protocolo` | text | Opcional. Auto-vinculado se aluno tem 1 protocolo aberto |
| `outcome` | enum | `revertido` / `confirmado` / `sem_contato` / `outro` |
| `motivo` | text | Texto livre detalhando |
| `notes` | text | Observações |
| `proof_path` | text | Caminho absoluto no disco (`server/uploads/manual_outcomes/{id}.{ext}`) |
| `proof_mime`, `proof_size_bytes` | | |
| `consultor_nome` | text not null | Texto livre — **sem auth de usuário no app** |
| `occurred_at` | timestamptz | Quando o desfecho aconteceu na vida real |

#### Endpoints (todos com `requireApiKey`)

| Método | Rota | O que faz |
|---|---|---|
| `POST` | `/api/manual-outcomes` | Cria registro JSON (sem anexo) |
| `POST` | `/api/manual-outcomes/:id/proof` | Upload binário (`X-File-Name`, MIME validado, ≤10MB) |
| `GET` | `/api/manual-outcomes` | Lista com filtros (category, outcome, consultor, period, search por RGM/nome) |
| `GET` | `/api/manual-outcomes/:id` | Detalhe |
| `GET` | `/api/manual-outcomes/:id/proof` | Serve o anexo inline |
| `DELETE` | `/api/manual-outcomes/:id` | Hard delete + remove anexo |
| `DELETE` | `/api/manual-outcomes/:id/proof` | Remove só o anexo |
| `GET` | `/api/manual-outcomes/protocols-by-rgm/:rgm` | Lista protocolos abertos do RGM (auxiliar do modal) |

#### Fluxo de uso

1. Consultor abre `/desfechos-manuais` (item "Desfechos" no header) ou clica no botão "Desfecho" na linha do roster CAA em `/`.
2. Modal abre. Se vier do roster, pré-preenche `category`, `rgm`, `nome` e busca protocolos abertos do aluno.
 - 1 protocolo aberto → preenche e mostra "Trocar".
 - >1 → dropdown.
 - 0 → campo livre.
3. Hook `useConsultor` lê `localStorage['consultor_nome']`. Primeira vez, usa `window.prompt`. Reusa nas próximas vezes.
4. Submeter cria o registro. Se houver anexo, faz POST sequencial para `/api/manual-outcomes/:id/proof`.
5. Página de listagem permite filtrar, ver anexo (link direto pra rota `/proof`), excluir.

#### Decisões de design

- **Tipo do anexo:** upload local em `server/uploads/manual_outcomes/`, replicando padrão `express.raw` de `baseUploads.js`. Pasta criada no boot do server (`fs.mkdirSync` em `server/index.js`). MIMEs aceitos: PNG/JPG/WebP/GIF/PDF.
- **Sem multer:** mantida a regra do projeto de não adicionar dependências.
- **Trade-off:** se o app for pra ambiente sem disco persistente (container ephemeral), os anexos somem. Hoje o app roda local/servidor próprio — OK como MVP. Migrar pra Supabase Storage se virar problema (dependência `@supabase/supabase-js` já existe; só falta config de bucket).
- **Identidade do consultor:** texto livre via localStorage. Sem auth de usuário (decisão consciente de não criar tabela `users`/login agora).
- **Tabela genérica:** modelada com `category` aceitando todas as 5 (CAA, docs, financeiro, BB, evasão) mesmo a UI sendo CAA-only no MVP — evita migration nova depois.
- **`proof_path` absoluto:** simplifica `res.sendFile()`. O endpoint `GET /:id` retorna esse path no JSON; futuro: sanitizar no DTO se preocupar com vazamento (rota é protegida por API key).

#### Alternativas descartadas

- **Inferir desfecho automaticamente do export CAA:** não funciona — o export novo só lista D-1. Confirmado com 3 amostras consecutivas (25/26/27 de maio): zero protocolos repetidos.
- **Multipart com multer:** descartado — sem novas dependências. POST JSON + POST binário separado é equivalente.
- **Enum granular (6 valores) com `revertido_caa`/`revertido_aluno`/`confirmado_caa`/etc.:** descartado em favor de `outcome` simples + campo `motivo` (texto). Granularidade vai pro `motivo`, classificação principal fica usável.
- **Login/auth de usuário:** descartado — consumo único de tempo sem benefício imediato. localStorage com prompt resolve para ≤20 consultores.
- **Painel manual genérico desde a UI:** descartado — UI focada em CAA (caso de uso real); modelo de dados genérico.

#### Pendências (não-bloqueantes)

- **Janela de 48h (cap de envios + saída automática da fila):** configuração persistida (ver decisão 29/05/2026 abaixo). Falta implementar a aplicação efetiva: `expiration_at` em `caa_protocols` + filtro de cap (2/dia, 4/total por RGM) + job de expiração + KPI "perdas silenciosas".
- **Painel de conversão (envios × respostas):** Fase 2 prevista, independente do painel manual. Cruza `activation_dispatch_events` × `activation_responses`.
- **Sanitização do `proof_path` no DTO `GET /:id`:** ajuste menor de segurança.

### 29/05/2026 — Configuração da janela CAA na aba Regras

- **Modelo usado:** Opus 4.7 (principal) decidiu; Executor (Sonnet 4.6) implementou.
- **Decisão:** Adicionar 2 campos configuráveis em `journey_settings` (scope GLOBAL apenas) para o usuário definir como funciona a janela de 48h do CAA, sem ainda aplicar a lógica.

#### Campos

Migration `019_caa_window_settings.sql` (`ALTER TABLE journey_settings`):

| Coluna | Tipo / valores | Default | O que significa |
|---|---|---|---|
| `caa_janela_t0` | text — `data_chegada` \| `primeiro_export` \| `primeiro_envio` | `data_chegada` | Quando começa a contar os 48h: Data Chegada no CAA, 1ª vez que apareceu no nosso export, ou 1º envio que fizemos |
| `caa_janela_dias_tipo` | text — `corridos` \| `uteis` | `corridos` | Se os 2 dias da janela são corridos (com sábado/domingo) ou úteis (só seg–sex) |

Reaproveita endpoints existentes (`GET/PUT /api/journey-settings/global`) — só ampliou `FIELDS` e `ALLOWED` em `journeySettingsRepository.js`.

#### UI

Novo Card "Janela CAA (48h)" em `/journey-rules`, **só aparece no scope GLOBAL** (essas regras não fazem sentido por turma).

Banner amarelo no topo do card sinaliza: *"Estas configurações são armazenadas, mas ainda não impactam a fila CAA. A aplicação efetiva acontecerá em fase posterior."* — evita expectativa errada de que ao salvar já vale.

#### Alternativas descartadas

- **Nova tabela `system_settings` chave/valor:** custo desnecessário; a tabela `journey_settings` já é a "fonte de regras operacionais" e tem toda a infra de GET/PUT/scope GLOBAL pronta.
- **Aplicar como prefixo em raw_config (jsonb):** mais frouxo, sem CHECK nem tipagem. Colunas dedicadas dão validação no banco e DTOs limpos.
- **Permitir por turma (scope TERM):** descartado — regras de janela CAA são da operação, não do calendário acadêmico.
- **Implementar a lógica de expiração junto com a UI:** descartado pra evitar ativar a regra sem o usuário ter confirmado a configuração com o time interno. UI primeiro, lógica depois (em fase separada).

### 29/05/2026 — Subgrupos da fila "Sem acesso BB" + categoria nova `aguardando-inicio`

- **Modelo usado:** Opus 4.7 (principal) decidiu; Executor (Sonnet 4.6) implementou.
- **Decisão:** Dividir a fila `acessos-blackboard` em 3 subgrupos baseados em telemetria do export, e mover alunos em limbo (turma ainda não começou) para uma 6ª categoria de ativação com mensagem própria.

#### Modelo da fila BB

Antes: binário — "está no export = excluído". Agora: cada matriculado é classificado em `bbSubgroupService.classifyBbSubgroup()`:

| Ordem | Subgrupo | Critério | Cor no roster |
|---|---|---|---|
| 1 | `podia_e_nao_acessou` | Sem linha no export OU sem `Ultimo Acesso` | rose ("Nunca acessou") |
| 2 | `nao_acessa_faz_tempo` | Último acesso ≥ `bb_nao_acessa_dias` atrás | amber ("Há tempo") |
| 3 | `acessou_pouco` | Acesso recente, mas `Minutos < bb_acessou_pouco_minutos` OU `Interações < bb_acessou_pouco_interacoes` | sky ("Pouco uso") |
| — | `ok` | Acessando regularmente | (não entra na fila) |

Limbo continua excluído da fila BB e agora alimenta a categoria nova `aguardando-inicio`.

#### Thresholds em `journey_settings` (migration 020)

| Coluna | Default | Range |
|---|---|---|
| `bb_nao_acessa_dias` | 14 | 1–365 |
| `bb_acessou_pouco_minutos` | 60 | ≥ 0 |
| `bb_acessou_pouco_interacoes` | 10 | ≥ 0 |

Editáveis em `/journey-rules` (scope GLOBAL) — card **"Subgrupos da fila Sem acesso BB"**, sem banner de "não impacta" (esses thresholds afetam a fila em produção imediatamente).

Período de análise = **mensal** (assumido — `Minutos`/`Interações` no export representam atividade do mês corrente).

#### Categoria nova `aguardando-inicio` (migration 021)

- Aluno cuja turma ainda não liberou conteúdo (limbo). Não cruza com nenhum export.
- Cada item da fila tem `dias_ate_inicio` (positivo) + `bb_term_codigo`.
- Aba dedicada em `ActivationPanel.tsx`.
- Template configurável via `raw_config.activation_templates['aguardando-inicio']`.
- `origem_ativacao` mapping: `'aguardando-inicio' → 'AguardInicio'` em `datacrazyClient.js`.
- Cap de envios (`excludeDispatched`) continua valendo — mesma régua das outras categorias.

Migration 021 atualiza CHECK constraints de `activation_dispatch_events` e `activation_manual_outcomes` (a tabela `activation_responses.category` é nullable e sem check — não foi tocada).

#### Filtro de subgrupo no roster

- Endpoint roster aceita `?bb_subgrupo=podia_e_nao_acessou|nao_acessa_faz_tempo|acessou_pouco`.
- Frontend adiciona chips em `ActivationRosterTable` (só categoria BB) com contagens calculadas **antes** do filtro de stage, pra exibir o total real por subgrupo independente da combinação de filtros.

#### Implicações operacionais conhecidas

- **Distribuição inicial enviesada:** snapshots BB que cobrem só uma fração dos matriculados (ex.: 131 linhas vs 27.790 alunos) jogam quase todo mundo em `podia_e_nao_acessou`. Não é bug — é estado do dado. Importar export BB completo redistribui.
- **`bb_urgency` ainda existe** como sinal secundário (alta/media/normal/sem_turma); ordenação primária agora é por subgrupo.
- **Banner amarelo "X alunos retirados por limbo"** foi substituído por mini-link apontando que esses alunos agora vivem na aba "Aguardando início".

#### Alternativas descartadas

- **Sub-abas dentro do BB ao invés de chips:** chips replicam o padrão dos filtros de stage já existentes e ocupam menos espaço.
- **Manter "Sem conteúdo" como subgrupo do BB:** preferimos categoria separada porque a mensagem (apoio "sua turma começa em X dias") é fundamentalmente diferente das mensagens de "sem acesso".
- **Thresholds em `raw_config` (jsonb):** colunas dedicadas com CHECK dão validação e tipagem; segue padrão da janela CAA.
- **Reaproveitar `bb_urgency` como base de subgrupo:** `bb_urgency` mede tempo desde início da turma; subgrupo mede engajamento real com o BB. Conceitos diferentes; mantemos ambos.

#### Mapeamento categoria → valor

| Categoria (`activationService`) | Valor em `origem_ativacao` |
|---------------------------------|----------------------------|
| `docs-pendentes` | `Doc` |
| `financeiro` | `Inad` |
| `processos-caa` | `caa` |
| `provavel-evasao` | `Evasao` |
| `acessos-blackboard` | `BB` |

Campo custom no **Lead** (não negócio). Config: `DATACRAZY_ORIGEM_ATIVACAO_FIELD` (nome), `DATACRAZY_ORIGEM_ATIVACAO_FIELD_ID` (UUID do campo), `DATACRAZY_CRM_BASE_URL` (default deriva `api.g1` → `crm.g1`).

#### Implementação

- `server/services/datacrazyClient.js` — `verifyOrigemAtivacaoForCategory`, `ORIGEM_ATIVACAO_BY_CATEGORY`, `ORIGEM_ATIVACAO_BLOCK_MESSAGE`.
- `activation_origem_ativacao_log` (migration 017) — auditoria local de cada PUT (lead, categoria, valor, ok/falha).
- Automações DataCrazy podem filtrar `origem_ativacao = caa` (etc.) para gravar em `activation_responses`.
- **Webhook resposta (opcional):** `POST /api/activation/responses` com `{ lead, evt, rgm?, cpf? }`. Com `cpf`, o RGM vem do **último snapshot matriculados**, linha com **Data Matrícula** mais recente para aquele CPF (prioridade sobre `rgm` do webhook). Monta `master_key` (RGM → CPF → dispatch recente).

#### Alternativas descartadas

- **Preencher só na automação DataCrazy:** o disparo já parte da nossa app; preencher no PATCH garante o valor antes de qualquer clique/resposta.
- **Usar tag em vez de campo adicional:** tags são mais visíveis no funil, mas misturam com segmentação manual; o campo foi criado pelo usuário para esse fim.

### 29/05/2026 — Painel de Conversão de Ativação

- **Modelo usado:** Opus 4.7 (principal)
- **Decisão:** Nova página `/conversao` que cruza `activation_dispatch_events` × `activation_responses` e mostra KPIs de engajamento (taxa de resposta, opt-out, top botões) com filtro retrátil por base e janela 7/30/90 dias.

#### Diferença vs Funil CAA

- **Funil CAA** = lifecycle de protocolos (ainda ativável / perdido / revertido). Exclusivo CAA.
- **Conversão** = quantos disparos viraram interação. Atravessa todas as 6 categorias (ou filtra uma específica).

#### Endpoint

`GET /api/reports/activation-conversion?category=<cat|all>&period_days=<7|30|90>` (com `requireApiKey`).

Resposta (estável):
- `filters`: o que foi aplicado (`category`, `period_days`, `since`, `now`).
- `kpis`: agregados globais (`total_dispatches`, `unique_dispatched`, `unique_responders`, `unique_clickers`, `unique_messages`, `unique_opt_outs`, `response_rate`, `opt_out_rate`).
- `by_category`: array com mesmas métricas por categoria (**sempre devolvido**, mesmo quando filtrado por uma — UI só exibe quando `all`).
- `top_buttons`: top-5 `button_payload` mais clicados no período.
- `recent_responses`: últimas N respostas com nome resolvido via LEFT JOIN no último dispatch da mesma `master_key`+categoria com `status='sent'`.

#### Métricas

- `unique_*` = `COUNT(DISTINCT master_key)` (NULLs excluídos). Importante porque uma pessoa pode receber múltiplos disparos.
- `response_rate` = `unique_responders / unique_dispatched` (0 se denominador 0).
- "Respondeu" = qualquer `response_kind ≠ null`. "Clicou" = só `click`. "Mensagem" = só `message`. "Opt-out" = só `opt_out`.
- Janela: `created_at >= now() - interval '<N> days'` para dispatches; `coalesce(received_at, created_at)` para responses.
- Apenas dispatches com `status='sent'` contam como envio efetivo.

#### UI

- **Botão retrátil "Base"** (pedido explícito): popover single-select com 7 opções (Todas + 6 categorias), fecha ao clicar fora. Implementado com `useState` + ref/click-outside, sem libs novas.
- **Chips de período** sempre visíveis (7d/30d/90d), default 30d.
- **4 KPI cards** no topo (Enviados, Responderam c/ taxa, Clicaram, Opt-out).
- **Quebra por base** (tabela): visível só quando "Todas as bases". Linhas clicáveis → selecionam a categoria. Taxa de resposta colorida (verde >10% / âmbar 5-10% / cinza <5%).
- **Top botões** (lista compacta) quando há dados de `button_payload`.
- **Tabela "Últimas respostas"** paginada (Carregar mais, +50 por vez).
- Link "Conversão" no `Header` entre "Relatórios" e "Regras", ícone `TrendingUp`.

#### Alternativas descartadas

- **Dropdown nativo `<select>` em vez de popover:** o usuário pediu explicitamente "botão retrátil". Popover dá visual mais limpo, integra melhor com chips e abre espaço para futuro multi-select.
- **Endpoint separado para `by_category`:** vem junto no mesmo endpoint para evitar 2 round-trips por load.
- **`recent_responses` com paginação por cursor:** offset simples é suficiente para os volumes atuais; cursor pode entrar quando a tabela passar de 10k linhas.
- **Métrica de conversão a partir de respostas web (PerfectPay etc.):** fora de escopo desta iteração; este painel é só sobre engajamento na conversa do WhatsApp.

### 29/05/2026 — Funil CAA (base estoque com lifecycle)

- **Modelo usado:** Opus 4.7 (principal)
- **Decisão:** Painel novo `CaaFunnelPanel` + mini-resumo no `CaaDailyPanel`. Lifecycle calculado **on-the-fly** sobre `caa_protocols` (sem schema novo). Manual outcome **prevalece** sobre status do export.

#### Escopo

Apenas CAA por enquanto. Outras 5 categorias (docs, financeiro, BB, evasão, aguard-início) não têm tabela "estoque" equivalente — generalização fica para quando o conceito estiver validado.

#### Estados do funil (6 estados + 1 fora)

Calculados em `server/services/caaFunnelService.js#classifyEstado`:

| Estado | Condição | Cor UI |
|---|---|---|
| `ativavel` | sem manual + status='open' + dentro da janela | azul |
| `perdido_silencioso` | sem manual + status='open' + janela vencida + sem clique/msg | laranja |
| `revertido_manual` | manual_outcome.outcome = 'revertido' | verde médio |
| `perdido_manual` | manual_outcome.outcome ∈ ('confirmado','sem_contato','outro') | vermelho médio |
| `revertido_export` | sem manual + status='won_reverted' | verde escuro |
| `perdido_export` | sem manual + status ∈ ('lost_canceled','lost_confirmed') | vermelho escuro |
| (fora) `unknown` | status='unknown' (não conta no `total_no_funil`) | cinza |

Prioridade: **manual outcome > export.** Flag `conflict_manual_vs_export` quando manual diverge do status final (ex.: manual `revertido` + export `lost_confirmed`).

#### Janela 48h

`expires_at = T0 + 48h conforme `journey_settings`:

- `caa_janela_t0`: `data_chegada` | `primeiro_export` (default) | `primeiro_envio` — com fallback para `first_seen_at` se T0 escolhido é inválido.
- `caa_janela_dias_tipo`: `uteis` (default) → `addBusinessDays(T0, 2)` em `server/utils/businessDays.js` (pula sáb/dom; **TODO feriados** comentado) | `corridos` → `T0 + 48h`.

#### Flags transversais

- `engajado` = tem `activation_response` com `response_kind ∈ ('click','message')` no master_key `RGM:<rgm>`.
- `conflito` = manual outcome diverge do status final do export.

#### Cap de envios

**Não bloqueia.** Apenas exibe `dispatches_today` / `dispatches_total` na tabela. Cap visual virá em iteração futura.

#### Endpoint

`GET /api/reports/caa/funnel?estado=&engajado=&conflito=&limit=&offset=` (com `requireApiKey`).

Resposta:
```json
{
  "config": { "janela_t0", "janela_dias_tipo", "cap_diario", "cap_total", "now" },
  "counts": { "ativavel", "perdido_silencioso", "revertido_manual", "perdido_manual",
              "revertido_export", "perdido_export", "unknown",
              "total_no_funil", "engajados", "com_conflito" },
  "items": [ /* lifecycle por protocolo */ ],
  "total_items", "limit", "offset", "generated_at"
}
```

#### Filtro de "base estoque ativa"

Query no service: `caa_protocols.last_snapshot_id = ÚLTIMO_SNAPSHOT_ID` OR existe `activation_manual_outcomes` ligado por protocolo OU rgm. Garante:
- Snapshot atual: tudo aparece.
- Históricos com desfecho registrado: continuam visíveis para rastreabilidade.
- Snapshots antigos sem desfecho: somem da base estoque (não poluem).

#### Hardening de `protocolFromRow` (caaProtocolsRepository)

Adicionado guard: rejeita linhas com `protocolo` que não seja numérico de 9-12 dígitos. Antes do guard, snapshots processados ANTES do repair V2 inseriam entradas "fantasma" em `caa_protocols` usando texto bagunçado ("Motivo: X...\nSubmotivo: Y...") como chave primária. Após o repair, novas entradas eram criadas com o protocolo limpo — mas as antigas ficavam. O script `server/scripts/cleanupCaaPhantoms.mjs` (one-shot) remove esses fantasmas (22 entradas + transições no momento da decisão).

#### UI

- Em `/reports` (card CAA): `CaaFunnelPanel` renderizado abaixo do `CaaDailyPanel` (D+1).
- `CaaDailyPanel` ganha seção rodapé "Estoque acumulado" com 6 chips compactos.
- Cards do funil são clicáveis (filtro toggle por estado).
- Tabela com botão "Registrar desfecho" → abre `ManualOutcomeModal` pré-preenchido (não criar modal novo).
- Toggles "Só engajados" / "Só conflito" como filtros adicionais.

#### Alternativas descartadas

- **Persistir estado em coluna nova:** o estado depende de `now()` e `journey_settings`, mudaria toda vez. Cálculo on-the-fly é mais simples e sempre consistente.
- **Funil em todas as 6 categorias agora:** sem chave estável análoga ao Protocolo nas outras categorias (RGM seria a chave, mas múltiplas matrículas/situações por aluno complicam). Validar no CAA primeiro.
- **Cap de envios bloqueante já:** decisão de "perdemos vs ainda dá" precisa de mais dados de operação para calibrar os limites. Por ora só observamos.

### 29/05/2026 — Repair V2 para export CAA (colunas embaralhadas, padrão novo)

- **Modelo usado:** Opus 4.7 (principal)
- **Decisão:** `caaExportRepair.js` ganhou um segundo detector + repair (V2) para um novo padrão de deslocamento do export `data.xlsx`. V1 mantido intacto para snapshots antigos.

#### Sintomas

Snapshot CAA de 29/05/2026 mostrava 25 cancelamentos de matrícula no arquivo mas só 2 pendentes na fila (BI externo confirmava 24 pendentes). O validador `validateCaaUploadRows` não bloqueava porque o `isCaaRowMisaligned` antigo só detectava 1 padrão (status em `Observação` / protocolo em `Data Conclusão`).

#### Padrão V2 (novo)

Em ~88% das linhas de cancelamento o XLSX vinha assim:

| Coluna XLSX | Conteúdo real esperado |
|---|---|
| `Protocolo` | texto "Motivo: X - Y\r\nSubmotivo: Z - W\r\nCelular: ..." (= Observação) |
| `Email` | "UNICID - GRADUAÇÃO EAD" (= Instituição) |
| `Celular` | "PEDAGOGIA (LICENCIATURA)" (= Curso) |
| `Curso` | "1" (lixo) |
| `Instituição` | "" (vazio) |
| `Situação Atendimento` | "11958849181" (= Celular) |
| `Situação Deferimento` | email |
| `Aging Dias` | **status real** ("PENDENTE") |
| `Observação` | **deferimento real** ("Em aberto") |
| `Data Previsão` | **protocolo real** (10 dígitos) |
| `Data Conclusão` | "0" (lixo) |

#### Detector `looksLikeMisalignedV2`

Sinais combinados: `Aging Dias` contém PEND/CONCLU/CANCEL/ABERTO + `Data Previsão` parece protocolo (9-12 dígitos após `\D+` strip) + `Protocolo` é texto longo OU não-numérico.

#### Repair `repairMisalignedV2`

- `Protocolo` ← dígitos de `Data Previsão`
- `Observação` ← texto original de `Protocolo`
- `Situação Atendimento` ← normalizado de `Aging Dias` (PENDENTE/CONCLUIDO/CANCELADO)
- `Situação Deferimento` ← texto original de `Observação`
- `Celular` ← dígitos de `Situação Atendimento` original
- `Email` ← `Situação Deferimento` original (já era email)
- `Instituição` ← `Email` original se contém ` - `
- `Curso` ← `Celular` original se não for telefone
- `Aging Dias`, `Data Previsão`, `Data Conclusão` ← `""` (limpar)
- Escreve variantes com e sem acento em sincronia

#### Prioridade

`repairCaaExportRow` testa V2 antes de V1; se V2 detectado, aplica e retorna sem cair no V1. Padrões são mutuamente exclusivos pelos dados observados.

#### Endurecimento do validador

- `validateCaaUploadRows` threshold de misaligned: 40% → 25%.
- Mensagem atualizada para sinalizar tentativa de repair automático e sugerir reexportar se persistir.

#### Reprocessamento

- `node server/scripts/repairLatestCaaSnapshot.mjs` reaplica repair em todas as linhas do snapshot mais recente e re-roda `processSnapshot`.
- Snapshots antigos NÃO foram reprocessados (formato diferente, V1 já tinha rodado).

#### Resultado validado

- Snapshot `e2811ece` (data (1).xlsx, 29/05/2026 17:28):
  - Antes: open=2, lost_confirmed=1, **unknown=22**
  - Depois: open=24, lost_confirmed=1, **unknown=0**
- `GET /api/reports/caa/summary?scope=last_snapshot` retorna `current.open=24` ✓

#### Alternativas descartadas

- **Refatorar parsing de XLSX para tolerar headers misturados:** muito complexo (`xlsx` lib chama `sheet_to_json` com header automático); repair pós-parse é cirúrgico.
- **Bloquear upload e mandar refazer:** o arquivo é tudo que temos do dia; bloquear sem repair seria perda de visibilidade.
- **Reprocessar todos snapshots antigos:** usuário pediu só o atual; antigos têm formato diferente e já foram reduzidos.
- **Adicionar coluna `data_repaired`:** repair grava in-place em `processos_caa_rows.data` (snapshot original do XLSX bruto fica no `file_path` se necessário auditar).

### 29/05/2026 — Filtro por Ciclo em comparison e filas de ativação

- **Modelo usado:** Opus 4.7 (principal)
- **Decisão:** Resposta do `/api/reports/matriculados-comparison` passa a expor `available_ciclos` + `by_ciclo` (mesma shape do agregado, filtrada por ciclo). Roster de ativação aceita `?ciclo=2026/1` e devolve `available_ciclos`. Frontend exibe dropdown (relatórios) e chips (filas) **só quando há >1 ciclo distinto** no snapshot.

#### Motivação

Graduação e Pós viram ciclo em datas diferentes (Graduação já em 2026/2, Pós ainda em 2026/1). Somar os dois ciclos na contagem dá número enganoso. Hoje a confusão era visível no painel "Matriculados x Outras Bases" e nas filas.

#### Backend

- `server/services/baseComparisonService.js`:
  - Helper `extractAvailableCiclos(matByCanon)` extrai os ciclos distintos do snapshot matriculados, ordenados desc lexicográfico (`'2026/2' > '2026/1'`).
  - Helper `buildBlocksForMat(matByCanon, matIndex, otherSnaps, matSnap)` extraído do fluxo principal — recebe um `matByCanon` arbitrário (completo ou filtrado por ciclo).
  - Resposta nova: `{ ..., comparisons, by_ciclo: { '<ciclo>': { blocks } }, available_ciclos }`.
  - Nome do campo agregado **`comparisons`** preservado (não renomeado para `blocks`) por compatibilidade com o consumer já existente.
- `server/services/activationService.js`:
  - `getActivationRoster(category, opts)` aceita `opts.ciclo`. `available_ciclos` é calculado **antes** de qualquer filtro (sobre `rows` cacheado), então o seletor nunca some quando algum filtro está ativo.
  - Filtro de ciclo aplicado em pós-processamento in-memory (após stage filter e bb subgrupo filter), não dentro de `getIntersectionActivationList` — respeita o cache `buildRosterRowsCached` que não conhece ciclo.
- `server/routes/activation.js`: aceita `?ciclo=<valor>` e repassa.

#### Frontend

- `src/components/MatriculadosComparisonPanel.tsx`:
  - Dropdown `<select>` "Ciclo: [Todos] [2026/2] [2026/1] …" no cabeçalho, visível só com `available_ciclos.length > 1`.
  - Quando `'all'`: blocos renderizam o agregado **+** badges compactos `2026/2: X · 2026/1: Y` abaixo do número primário de cada bloco.
  - Quando ciclo específico: blocos renderizam `by_ciclo[ciclo].blocks` (sem os badges de quebra).
- `src/components/ActivationRosterTable.tsx`:
  - Estados `cicloFilter` / `availableCiclos` em todas as 6 categorias.
  - Chips "Ciclo: Todos / 2026/2 / 2026/1 …" abaixo dos chips de stage (e abaixo dos chips de subgrupo BB quando categoria === `acessos-blackboard`).
  - Reseta `page = 0` na troca; passa `ciclo` no `roster()`.

#### Alternativas descartadas

- **Cache segmentado por ciclo (chave nova):** desnecessário — o pós-filtro in-memory é trivialmente rápido sobre o `rows` já cacheado, e mantém o cache base único.
- **Filtro de ciclo dentro de `getIntersectionActivationList`:** quebraria o cache `buildRosterRowsCached` (chave teria que mudar). Pós-filtro é funcionalmente equivalente e mais simples.
- **Renomear `comparisons` → `blocks` no payload comparison:** quebraria o consumer existente sem ganho. Mantive `comparisons` no agregado e usei `blocks` dentro de `by_ciclo[ciclo]`.
- **Quebra por ciclo em todos os números do bloco (primary + secondary):** poluído visualmente. Apenas o número primário ganha os badges.
