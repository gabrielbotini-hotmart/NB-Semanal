const fs = require('fs');
const path = require('path');
const DIR = path.join(__dirname, '..', 'Dados') + path.sep;
const outDir = __dirname + path.sep;

// ---------- checagem de arquivos obrigatórios ----------
const REQUIRED = {
  '01_receita_semana_nivel_estrategia.csv': '01_receita_semana_nivel_estrategia.sql',
  '06_operacional_raw.csv': '06_operacional_raw.sql',
  'budget_oficial.csv': null,
  'reforecast_oficial.csv': null,
  'f_budget_daily.csv': null,
  // f_reforecast_daily.csv NÃO é mais lido (12/08/2026) — a meta semanal de reforecast é
  // reconstruída a partir de reforecast_oficial.csv, ver buildSemanalDeMensal() mais abaixo.
};
const missing = Object.keys(REQUIRED).filter(f => !fs.existsSync(DIR + f));
if (missing.length) {
  console.error('Faltam arquivos obrigatórios em Dados/:');
  missing.forEach(f => console.error('  - ' + f + (REQUIRED[f] ? '  (rode Querys/' + REQUIRED[f] + ' no Redshift e exporte com esse nome, separador ";")' : '  (planilha de budget/reforecast mantida à mão)')));
  console.error('\nVeja Dados/README.md para o contrato de cada arquivo.');
  process.exit(1);
}

// Parser de CSV de verdade (RFC4180: campo entre aspas pode conter delimitador/quebra de
// linha literal; "" dentro de aspas = aspas escapada). Os exports gerados pelo
// scripts/atualizar_dados.py (Astrobox -> NDJSON -> CSV via csv.writer do Python) já saem
// assim, então texto livre com quebra de linha/`;` embutido (motivo de perda, nome de
// produtor etc.) vem corretamente entre aspas e este parser lê direto, sem corromper nada.
function parseCsvRows(raw, delim) {
  const rows = [];
  let field = '', row = [], inQuotes = false, atFieldStart = true;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (inQuotes) {
      if (c === '"') {
        if (raw[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else field += c;
      continue;
    }
    // Só entra em modo "aspas" se a aspa é o PRIMEIRO caractere do campo (RFC4180: campo
    // é inteiramente cotado ou não é). Isso evita que uma aspa solta no meio de texto livre
    // (comum em export antigo, sem escape de verdade) seja confundida com abertura de aspas.
    if (c === '"' && atFieldStart) { inQuotes = true; atFieldStart = false; continue; }
    if (c === delim) { row.push(field); field = ''; atFieldStart = true; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; atFieldStart = true; continue; }
    field += c; atFieldStart = false;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => !(r.length === 1 && r[0] === ''));
}
// Fallback pra exports antigos, exportados à mão do Redshift SEM aspas ao redor de campo com
// quebra de linha embutida (não é CSV válido nesse caso) — junta linhas consecutivas até
// bater a contagem de colunas do cabeçalho. Em um CSV bem formado (gerado pelo
// scripts/atualizar_dados.py) toda linha já sai com a contagem certa, então isso não faz nada.
function reassembleByFieldCount(rows, H) {
  const out = [];
  let buf = null;
  let descartadas = 0;
  for (const fields of rows) {
    if (buf === null) buf = fields;
    else { buf[buf.length - 1] += '\n' + fields[0]; buf = buf.concat(fields.slice(1)); }
    if (buf.length >= H) { out.push(buf.slice(0, H)); buf = null; }
  }
  if (buf !== null) descartadas++;
  return { rows: out, descartadas };
}
function readCsv(name, delim) {
  delim = delim || ';';
  const raw = fs.readFileSync(DIR + name, 'utf8').replace(/^﻿/, '');
  const rawRows = parseCsvRows(raw, delim);
  if (!rawRows.length) return [];
  const head = rawRows[0].map(h => h.trim());
  const { rows, descartadas } = reassembleByFieldCount(rawRows.slice(1), head.length);
  if (descartadas) console.warn('[aviso] ' + name + ': ' + descartadas + ' linha(s) final(is) incompleta(s) descartada(s).');
  return rows.map(cols => {
    const o = {};
    head.forEach((h, i) => o[h] = cols[i]);
    return o;
  });
}
// Arquivos opcionais (enriquecimento) — se faltar, o resto do build segue normal.
function readCsvOptional(name, delim) {
  try { return readCsv(name, delim); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}

const mesKey = d => d ? d.slice(0, 7) : null;            // '2025-01-01' -> '2025-01'
const mesBr  = d => { const [dd, mm, yy] = d.split('/'); return yy + '-' + mm; }; // '01/02/2026'->'2026-02'
const bucket = n => { n = (n || '').replace('N', ''); const x = +n;
  if (x === 2 || x === 3) return 'N2-N3'; if (x === 4 || x === 5) return 'N4-N5'; if (x >= 6) return 'N6+'; return 'Sem nivel'; };
// operacional_raw.csv vem cru (SELECT *) — nível é derivado direto do amount_12_months
// numérico. Borda inclusiva no nível DE CIMA (confirmado com o Gabriel em 28/07/2026):
// <1M N2-N3 · 1M a <5M N4-N5 · >=5M N6+. Quem está exatamente em 1M ou 5M conta pro nível
// seguinte (antes era <= e ficava no nível de baixo — ver Pendencias/README.md).
const bucketFromAmount = s => { const amt = parseFloat(s);
  if (!isFinite(amt)) return 'Sem nivel'; if (amt < 1000000) return 'N2-N3'; if (amt < 5000000) return 'N4-N5'; return 'N6+'; };
// operacional_raw.csv tem campos de texto livre sem nenhum escape/aspa ao redor (motivo de
// perda, nome de produtor com "&" etc.) — uma minoria de linhas fica desalinhada de um jeito
// que a reconstrução por contagem de coluna (readCsv) não recupera 100%. Em vez de tentar
// reconstruir cada caso exótico, validamos o FORMATO de cada campo antes de confiar nele:
// se não parece data/e-mail de verdade, vira null em vez de contaminar semana/mês/pessoa.
const estr = s => ({ OUTBOUND: 'Outbound', INBOUND: 'Inbound', HUNTING: 'Hunting' }[(s || '').toUpperCase()] || null);
const money = s => parseInt(String(s).replace(/[^\d]/g, ''), 10) || 0;  // 'R$ 1.234.567' -> 1234567
const num = s => { const v = parseFloat(s); return isFinite(v) ? v : 0; };
// f_budget_daily/f_reforecast_daily usam vírgula como separador DECIMAL (sem separador de
// milhar) — diferente do money() acima, que é pra planilha mensal (ponto de milhar, sem decimal).
const numBr = s => { const v = parseFloat(String(s).replace(',', '.')); return isFinite(v) ? v : 0; };
// datas do Redshift vêm como '', 'null' (texto) ou 'AAAA-MM-DD'; só aceita se bater o formato.
const cleanDate = s => { if (!s) return null; const t = String(s).trim(); return /^\d{4}-\d{2}-\d{2}/.test(t) ? t.slice(0, 10) : null; };
const cleanEmail = s => { if (!s) return null; const t = String(s).trim(); return t.includes('@') ? t : null; };

// Mesma regra de semana usada nas queries SQL (Querys/01 e Querys/05): semana 1 = 01/jan até
// o dia anterior à 1ª segunda-feira do ano (parcial); da 2ª semana em diante começa na segunda.
function firstMondayUTC(year) {
  const jan1 = new Date(Date.UTC(year, 0, 1));
  const add = (8 - jan1.getUTCDay()) % 7;
  const d = new Date(jan1); d.setUTCDate(d.getUTCDate() + add);
  return d;
}
function anoSemana(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const year = d.getUTCFullYear();
  const fm = firstMondayUTC(year);
  if (d < fm) return year + '-W01';
  const weekNum = Math.floor((d - fm) / 86400000 / 7) + 2;
  return year + '-W' + String(weekNum).padStart(2, '0');
}

const NIVEIS = ['N2-N3', 'N4-N5', 'N6+'];
const ESTRS = ['Outbound', 'Inbound', 'Hunting'];
// CO_KEYS (31/07/2026): chaves de filtro pras estruturas de Closer/Onboarding — "all" +
// estratégia + nível, como entradas IRMÃS no mesmo dicionário (não um produto cartesiano
// estr×nível). O filtro de Nível na Semanal Área é INDEPENDENTE do de Estratégia (a pedido do
// Gabriel — um substitui o outro, nunca os dois ativos ao mesmo tempo), então basta cada
// estrutura ter mais 3 chaves (N2-N3/N4-N5/N6+) além das 4 que já tinha. Só Closer/Onboarding
// ganham isso — SDR continua só com ESTOQUE_KEYS (all+estratégia), sem filtro de Nível.
const CO_KEYS = ['all', ...ESTRS, ...NIVEIS];
function blankKeys(keys) { const o = {}; keys.forEach(k => o[k] = {}); return o; }
const METRICS = ['contacted', 'connected', 'opps', 'sql', 'cw', 'activation', 'sap', 'gmv', 'receita'];
function blankM() { const o = {}; METRICS.forEach(m => o[m] = 0); return o; }
function addM(a, b) { METRICS.forEach(m => a[m] += b[m] || 0); return a; }
function getP(map, email) { if (!map[email]) map[email] = { email }; return map[email]; }
function wk(p, w) { return (p.porSemana || (p.porSemana = {}))[w] || (p.porSemana[w] = {}); }
function last4Weekly(semanalObj, allWeeks) {
  const ws = allWeeks.filter(w => semanalObj && semanalObj[w] != null).sort().slice(-4);
  return ws.map(w => ({ semana: w, valor: Math.round(semanalObj[w]) }));
}

// ---------- ACTUAL: 01 (receita/gmv/sap) ----------
// Ainda pré-agregada por semana no SQL — a versão granular (financeira_raw.csv, via
// Parquet + DuckDB-Wasm) entra numa etapa seguinte; por ora este arquivo não muda.
const f01 = readCsv('01_receita_semana_nivel_estrategia.csv');
const finCell = {};   // key mes|nivelbucket|estr
const finCellSemanal = {}; // key ano_semana|nivelbucket|estr (mesma coisa, grão semana)
for (const r of f01) {
  const b = bucket(r.nivel), e = estr(r.estrategia);
  const mk = mesKey(r.mes);
  const k = mk + '|' + b + '|' + e;
  if (!finCell[k]) finCell[k] = { receita: 0, gmv: 0, sap: 0 };
  finCell[k].receita += num(r.receita_net_brl_sales);
  finCell[k].gmv += num(r.gmv_brl_sales);
  finCell[k].sap = Math.max(finCell[k].sap, +r.sap_mensal || 0); // max MTD = sap do mês por celula
  const w = r.ano_semana;
  const kw = w + '|' + b + '|' + e;
  if (!finCellSemanal[kw]) finCellSemanal[kw] = { receita: 0, gmv: 0, sap: 0 };
  finCellSemanal[kw].receita += num(r.receita_net_brl_sales);
  finCellSemanal[kw].gmv += num(r.gmv_brl_sales);
}

// ---------- ACTUAL: operacional_raw (1 linha por lead — substitui 02/03/04/05) ----------
// Cada estágio é contado na semana da SUA PRÓPRIA data (throughput, não coorte) — isso é
// o "unpivot" que antes era feito em SQL (05_produtividade.sql), agora em JS, para poder
// trocar o grão de tempo sem reescrever query nenhuma.
//
// ⚠️ operacional_raw.csv é um SELECT * (Querys/06_operacional_raw.sql) — pode conter PII
// (telefone etc.) que não tem nada a ver com o dashboard. A partir daqui só lemos os campos
// abaixo, POR NOME — nunca fazemos spread da linha inteira. Se for adicionar um campo novo
// ao app_data.js (o arquivo que vai pro navegador), confirme antes que não é PII.
const fop = readCsv('06_operacional_raw.csv');
// 3º elemento = objeto Salesforce de origem do campo — 'lead' (Contact/Lead, filtra por
// is_lead_br_funnel) ou 'opp' (Opportunity, filtra por is_opp_br_funnel). Necessário desde
// 30/07/2026: o WHERE do 06_operacional_raw.sql passou a trazer a linha se QUALQUER UM dos
// dois objetos for BR (antes só olhava is_lead_br_funnel e descartava opps sem lead ou com
// lead de outro office) — então agora é o build_data.js que decide, campo a campo, se aquele
// dado específico é elegível. Ver leadBrOk/oppBrOk logo abaixo e o uso em `dates`.
const STAGES = [
  ['contacted_date', 'contacted', 'lead'],
  ['connected_date', 'connected', 'lead'],
  ['opportunity_create_date', 'opps', 'opp'],
  ['sql_date', 'sql', 'opp'],
  ['closed_won_date', 'cw', 'opp'],
  ['activation_date_10k', 'activation', 'opp'],
];
const CUTOFF = '2025-01-01';

const funCell = {};   // mes|nivelbucket|estr -> {contacted,...}
const funCellSemanal = {}; // ano_semana|nivelbucket|estr -> {contacted,...} (mesma coisa, grão semana)
const semContactedNivel = {}, semOppNivel = {}, semCwNivel = {}, semActNivel = {};
const porPessoaSdr = {}, porPessoaCloser = {}, porPessoaOnb = {};
const rankCw = {}, rankOwner = {};
const fteBy = {};
const fteByWeek = {}; // semana -> estrategia -> {sdrs:Set, contacted, opps} (mesma coisa que fteBy, por semana)
const cicloAcc = { dias_contato_conectado: [], dias_conectado_opp: [], dias_opp_sql: [], dias_sql_won: [], dias_won_ativacao: [] };
// coorte de contato→conexão POR SEMANA: dos leads contatados na semana W, quantos conectaram
// na PRÓPRIA semana W (não é o throughput de connected, que conta conexões de coortes antigas).
const sdrCohort = { all: {}, Outbound: {}, Inbound: {}, Hunting: {} }; // estr -> W -> { contacted, conn }
// coorte C2 por DONO do lead (owner_email) — atribuição real de "quem contatou": sdr_email_sf
// só é preenchido depois que o SDR assume/conecta, então não serve pra atribuir o "contacted".
const sdrOwnerCohort = {}; // owner_email -> W -> { contacted, conn }
const sdrUnq = { all: {}, Outbound: {}, Inbound: {}, Hunting: {} };    // estr -> W -> nº de unqualifieds
const sdrOppFteSet = { all: {}, Outbound: {}, Inbound: {}, Hunting: {} }; // estr -> W -> Set(sdr que gerou opp)
// coorte por semana de CONTATO × status ATUAL (hoje) do lead — situação mais recente entre
// contacted/connected/nurturing/qualified/unqualified (data mais recente vence).
const sdrCohortStatus = { all: {}, Outbound: {}, Inbound: {}, Hunting: {} }; // estr -> W(contato) -> {status: n}
// mesma coisa acima, por PESSOA (owner do lead) — alimenta o gráfico de Status no 1:1 Gestor
// (05/08/2026, a pedido do Gabriel). Preenchido lazy (owner -> W -> {status:n}) dentro do loop
// principal, junto com sdrCohortStatus.
const sdrCohortStatusPessoa = {};
// registro por LEAD (23/08/2026, a pedido do Gabriel): alimenta o botão "Exportar CSV" do card
// "Status atual por safra" no 1:1 Gestor — mesma população/status de sdrCohortStatusPessoa
// (ownerReal), só que 1 linha por lead em vez de agregado, pra dar pra filtrar "quem está em
// Connected na semana X" de uma pessoa específica. Só lead_id como identificador (nunca
// nome/e-mail/telefone do lead cru — mesma barreira de privacidade da tela de validação de
// Onboarding, ver Dados/README.md). Escrito num arquivo À PARTE (sdr_leads_data.js), mesmo
// motivo do onbLeadsValidacao: não inflar o app_data.js principal.
const sdrLeadsValidacao = [];
const sdrContactFteSet = { all: {}, Outbound: {}, Inbound: {}, Hunting: {} }; // estr -> W -> Set(owner SDR real que contatou)
const sdrOppsNivelAcc = { all: {}, Outbound: {}, Inbound: {}, Hunting: {} }; // opps por nível×semana, só SDR real
// coorte de negociação POR SEMANA (funil Closer): dos leads que viraram opp na semana W,
// quantos chegaram a SQL na PRÓPRIA semana W (C1); e, do sub-coorte que chegou a SQL na
// mesma semana, quantos chegaram a Offer também na mesma semana (C2, encadeado — mesmo
// padrão do C2 de SDR: sempre a partir do sub-coorte do estágio anterior, não do total).
const closerCohort = blankKeys(CO_KEYS); // estr/nível -> W -> { opp, sql, offer }
// C4: coorte SQL→CW, ancorada na semana do SQL (não do opp) — dos que chegaram a SQL em W,
// quantos fecharam (CW) na MESMA semana. Métrica isolada, não encadeada com C1/C2.
const closerCohortSqlCw = blankKeys(CO_KEYS); // estr/nível -> W(sql) -> { sql, cw }
// saídas do funil de Closer por perda (Lost Deal) — mesmo papel do sdrUnq pro SDR.
const closerLost = blankKeys(CO_KEYS);   // estr/nível -> W -> nº de lost deals
// throughput semanal de CW (fechado ganho), só de leads com closer atribuído — denominador
// junto com closerLost pra "Saídas do funil" da página de Closer (mesmo grão de sdrOppsNivelAcc).
const closerCwAcc = blankKeys(CO_KEYS);  // estr/nível -> W -> nº de CW
// closers distintos que RECEBERAM opp / que FECHARAM (CW) na semana — denominador do
// "Opp/FTE" e "CW/FTE" do Closer (mesmo papel do sdrContactFteSet/sdrOppFteSet).
const closerOppFteSet = blankKeys(CO_KEYS);
const closerCwFteSet = blankKeys(CO_KEYS);
// coorte por semana de ENTRADA NO CLOSER (opp) × status ATUAL (hoje) do lead — situação mais
// recente entre opp/sql/offer/contract/closed_won/lost_deal (data mais recente vence).
const closerCohortStatus = blankKeys(CO_KEYS); // estr/nível -> W(opp) -> {status: n}
// mesma coisa acima, por PESSOA (closer) — alimenta o gráfico de Status no 1:1 Gestor
// (05/08/2026, a pedido do Gabriel). Preenchido lazy (closer -> W -> {status:n}).
const closerCohortStatusPessoa = {};
// coorte de ativação POR SEMANA (funil Onboarding): dos leads que fecharam (CW) na semana W,
// quantos chegaram a 1k na PRÓPRIA semana W (C1); e, do sub-coorte que chegou a 1k na mesma
// semana, quantos chegaram a 5k também na mesma semana (C2, encadeado — mesmo padrão do
// C2 de SDR/Closer). Sem "saída por perda" conhecida aqui (só existe a saída por ativação 10k).
const onbCohort = blankKeys(CO_KEYS); // estr/nível -> W -> { cw, a1k, a5k }
// throughput semanal de Ativação 10k, só de leads com onboarder atribuído — mesmo papel do
// closerCwAcc (saída do funil de Onboarding).
const onbActAcc = blankKeys(CO_KEYS); // estr/nível -> W -> nº de ativações 10k
// onboarders distintos que RECEBERAM CW / que ATIVARAM 10k na semana — denominador do
// "CW/FTE" e "Ativado/FTE" do Onboarding.
const onbCwFteSet = blankKeys(CO_KEYS);
const onbActFteSet = blankKeys(CO_KEYS);
// coorte por semana de ENTRADA NO ONBOARDING (CW) × status ATUAL (hoje) do lead — situação
// mais recente entre cw/a1k/a5k/ativado_10k (data mais recente vence).
const onbCohortStatus = blankKeys(CO_KEYS); // estr/nível -> W(cw) -> {status: n}
// mesma coisa acima, por PESSOA (onboarder) — alimenta o gráfico de Status no 1:1 Gestor
// (05/08/2026, a pedido do Gabriel). Preenchido lazy (onb -> W -> {status:n}).
const onbCohortStatusPessoa = {};

function pushCiclo(key, dateA, dateB) {
  if (!dateA || !dateB) return null;
  const d = (new Date(dateB + 'T00:00:00Z') - new Date(dateA + 'T00:00:00Z')) / 86400000;
  if (!isFinite(d) || d < 0) return null;
  cicloAcc[key].push(d);
  return d;
}

// Cargo/Ativo/Nome/Foto por pessoa (12/08/2026, a pedido do Gabriel) — DUAS fontes com escopos
// DIFERENTES, de propósito:
// 1) rosterSdr/rosterCloser/rosterOnboarding (isRealSdr/isRealCloser/isRealOnboarder logo
//    abaixo) — quem é "real" pros KPIs/Estoque/coortes (números já validados contra o Power BI,
//    ver comentários originais mantidos abaixo) — CONTINUAM em Dados/Imagens Sales.csv, sem
//    mudança. Testado trocar pra Sales_goals+Sales_Infos (12/08/2026) e o Gabriel pediu pra
//    reverter só essa parte: a fonte nova é mais atual, mas mexia em números já fechados
//    (Estoque de SDR caiu ~10% por gente que a planilha antiga ainda marcava ativa).
// 2) cargoPorEmail/infoPorEmail (Sales_goals + Sales_Infos, novo) — só pra Cargo/Ativo/Nome/Foto
//    exibidos por pessoa (diretorio/enrichPessoa mais abaixo), que alimenta a tabela "por
//    pessoa" da Semanal Área E a lista de pessoas do 1:1 Gestor (mesmo dado, os dois
//    consumidores) — aqui sim vale a pena ser mais atual, e não mexe em nenhum KPI/Estoque/
//    coorte porque enrichPessoa só seta nome/foto/ativo/cargo em cima de pessoas que já existem
//    (D.porPessoa.*, calculado à parte, sem depender de rosterSdr/Closer/Onboarding).
function cargoAtualPorEmail() {
  const best = {};
  readSalesGoalsCsv().forEach(r => {
    if (!r.email || !r.funcao) return;
    const [dd, mm, yy] = r.data.split('/'); if (!dd || !mm || !yy) return;
    const iso = `${yy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
    const atual = best[r.email];
    // Desempate mesma-data: a coluna "concat" (nº|Função|email) NÃO garante 1 linha por pessoa —
    // quem foi promovido no meio do mês aparece com 2 linhas na MESMA Data (função antiga, que
    // ainda conta meta pro gestor anterior, e a nova). A ordem do arquivo é por BLOCO de Função
    // (todo SDR primeiro, depois CSR, depois ONB), não cronológica — não dá pra usar "linha de
    // baixo vence". O sinal certo é "Fase do analista" (fase): a função que está saindo vem
    // marcada "Offboarding"; a nova vem "Ramping up"/"Onboarded"/"Guardrail" — em empate de
    // data, "Offboarding" perde pra qualquer outra.
    if (!atual || iso > atual.iso || (iso === atual.iso && atual.fase === 'Offboarding' && r.fase !== 'Offboarding')) {
      best[r.email] = { iso, funcao: r.funcao, fase: r.fase };
    }
  });
  const CARGO_MAP = { SDR: 'SDR', CSR: 'Closer', ONB: 'Onboarding' }; // Função (Sales_goals) -> Cargo (nome usado no resto do código)
  const out = {}; for (const e in best) out[e] = CARGO_MAP[best[e].funcao] || null;
  return out;
}
const cargoPorEmail = cargoAtualPorEmail();
const fSalesInfos = readCsvOptional('sales_infos.csv', ';'); // datasource Astrobox "Sales_Infos", f_pi:05233c55-735c-4829-b9c8-10a70108154d
const infoPorEmail = {};
for (const r of fSalesInfos) {
  const email = cleanEmail(r.Email); if (!email) continue;
  infoPorEmail[email.toLowerCase()] = {
    nome: (r['Nome completo'] || '').trim() || null,
    foto: (r.Imagem || '').trim() || null,
    ativo: (r.Ativo || '').trim().toLowerCase() === 'sim',
  };
}

// "SDR real" = quem a planilha de diretório (Dados/Imagens Sales.csv — mesmo datasource
// Astrobox "Imagens Sales" usado pra nome/foto, ver seção DIRETÓRIO abaixo) marca com
// Cargo=SDR e Ativo=Sim. Reconciliado com o roster oficial do Power BI (`6.1d_SDR`) em
// 28/07-29/07/2026: bate 29/29 (as 2 diferenças são gente promovida a Closer que este
// datasource já reflete e o Power BI ainda não). Antes usávamos um heurístico (qualquer
// email que já apareceu em sdr_email_sf, menos 4 exclusões manuais) que incluía ~2x mais
// gente (ex-SDRs, contas de time) e inflava Estoque/coortes da página de SDR. Se a planilha
// faltar ou não tiver ninguém com Cargo=SDR, cai de volta pro heurístico antigo (com aviso)
// — a PÁGINA de SDR conta só quem é "real"; a tabela mantém todos (auditoria).
const fDiretorio = readCsvOptional('Imagens Sales.csv', ',');
let rosterSdr = new Set(fDiretorio.filter(r => (r.Cargo || '').trim() === 'SDR' && (r.Ativo || '').trim() === 'Sim').map(r => (r.Email || '').trim().toLowerCase()).filter(Boolean));
// Inclusão manual: promovidos a Closer que já não aparecem com Cargo=SDR no diretório, mas
// atuaram como SDR antes da promoção — a pedido do Gabriel (30/07/2026), mantidos no funil de
// SDR pra não perder os contatados/coortes do período em que trabalharam como SDR.
const SDR_MANUAL_INCLUI = new Set(['olivio.blach@hotmart.com', 'lucas.guerrero@hotmart.com']);
if (rosterSdr.size) SDR_MANUAL_INCLUI.forEach(e => rosterSdr.add(e));
let NAO_SDR = new Set();
if (!rosterSdr.size) {
  console.warn('[aviso] Dados/Imagens Sales.csv sem ninguém com Cargo=SDR — usando heurístico antigo de "SDR real" (menos preciso, ver Pendencias/README.md).');
  NAO_SDR = new Set(['camila.harumi@hotmart.com', 'gustavo.duarte@hotmart.com', 'bubr_bizops@hotmart.com', 'bkf-team@hotmart.com']);
  rosterSdr = new Set();
  for (const r of fop) { const s = cleanEmail(r.sdr_email_sf); if (s) rosterSdr.add(s.toLowerCase()); }
}
const isRealSdr = o => { o = (o || '').toLowerCase(); return !!o && rosterSdr.has(o) && !NAO_SDR.has(o); };
// Filtro de página do New Biz (Power BI): exclui leads PQL/PPQL (já pré-qualificados, não
// são trabalho de prospecção do SDR) e segmentação Seed 1/Seed 2 (fora do funil padrão).
// Confirmado batendo com o Estoque do Power BI (semana 31: 1090 = 1090) combinado com o
// roster oficial acima.
const leadFlowOk = r => { const lf = (r.lead_flow || '').trim(), seg = (r.lead_flow_segmentation || '').trim();
  return lf !== 'PQL' && lf !== 'PPQL' && seg !== 'Seed 1' && seg !== 'Seed 2'; };
// Variante só pra Carteira/Estoque de Onboarding (10/08/2026, a pedido do Gabriel): mantém
// PQL/PPQL/Seed 1 fora (mesmo critério de SDR/Closer), mas NÃO exclui Seed 2 — validado contra
// a planilha de referência (551 clientes reais): sem essa exclusão de Seed 2 especificamente,
// os 2 clientes que faltavam pra bater 100% (Yasmin Araújo) aparecem, e nenhum extra indevido
// entra (551/551 exato, 0 extra, 0 faltando). Usada SÓ no onbLeadsMap abaixo — em todo o resto
// (SDR, Closer, coorte semanal de Onboarding) o leadFlowOk original continua igual.
const leadFlowOkOnb = r => { const lf = (r.lead_flow || '').trim(), seg = (r.lead_flow_segmentation || '').trim();
  return lf !== 'PQL' && lf !== 'PPQL' && seg !== 'Seed 1'; };
// "Closer real" = mesmo padrão do isRealSdr acima, via Dados/Imagens Sales.csv (Cargo=Closer,
// Ativo=Sim). Reconciliado com o "Tamanho Carteira de Opps" do Power BI em 29/07/2026: o
// total (Opp+SQL+Offer+Contract) bate de perto nas semanas recentes (~292 vs ~290 na última),
// com folga maior em semanas mais antigas — esperado, já que o roster "Ativo" é um snapshot de
// HOJE aplicado retroativamente (quem entrou/saiu do time nas semanas mais antigas puxa o
// número pra outro lado; não dá pra reconstruir o roster histórico exato sem uma fonte
// versionada). Página de Closer conta só quem é "real"; sem filtro, a tabela audita todos.
const rosterCloser = new Set(fDiretorio.filter(r => (r.Cargo || '').trim() === 'Closer' && (r.Ativo || '').trim() === 'Sim').map(r => (r.Email || '').trim().toLowerCase()));
const isRealCloser = o => { o = (o || '').toLowerCase(); return !!o && rosterCloser.has(o); };
// "Onboarder real" = mesmo padrão de isRealSdr/isRealCloser acima, via Imagens Sales.csv
// (Cargo=Onboarding, Ativo=Sim). Testado em 30/07/2026 (comentário antigo acima) e descartado
// na época porque a fonte de status estava dessincronizada e restringir ao roster piorava o
// número contra o Power BI — retestado em 10/08/2026, DEPOIS do fix da fonte (ver
// Querys/06_operacional_raw.sql, join com dhaf_salesforce.onboarding), e agora bate quase
// exato com a planilha de referência do time (550 vs 551 reais, 549 match/1 extra/2
// faltando) — usado só no onbLeadsMap abaixo (Estoque/Carteira), não na tabela por pessoa
// (D.porPessoa.onboarding), que segue auditando todo mundo que já atuou como onboarder.
const rosterOnboarding = new Set(fDiretorio.filter(r => (r.Cargo || '').trim() === 'Onboarding' && (r.Ativo || '').trim() === 'Sim').map(r => (r.Email || '').trim().toLowerCase()));
const isRealOnboarder = o => { o = (o || '').toLowerCase(); return !!o && rosterOnboarding.has(o); };
// Dados/sales_goals.csv (Astrobox, datasource "Sales_goals", separador ";") — planilha de metas
// mensal por pessoa. A partir de 07/2026 o time de Closer (CSR) e Onboarding (ONB) passou a ser
// segmentado por NÍVEL de cliente (N2-N3/N4-N5/N6+) em vez de estratégia (Outbound/Inbound) —
// SDR continua só em Outbound/Inbound/Hunting, sem nível (11/08/2026, a pedido do Gabriel:
// tabela "por pessoa" de Closer/Onboarding passa a agrupar por esse nível em vez de estratégia).
// Guardamos só o mês mais recente (snapshot atual) — é tudo que a tabela "por pessoa" precisa;
// histórico mensal completo não é usado em nenhuma outra feature ainda.
function readSalesGoalsCsv() {
  const filePath = DIR + 'sales_goals.csv';
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf8').replace(/^﻿/, '');
  return parseCsvRows(raw, ';').slice(1).map(cols => ({
    data: (cols[2] || '').trim(),   // dd/mm/yyyy
    funcao: (cols[3] || '').trim(), // SDR / CSR / ONB
    email: (cols[6] || '').trim().toLowerCase(),
    nivel: (cols[8] || '').trim(),  // "Estratégia completa": N2-N3/N4-N5/N6+ (CSR/ONB) ou Outbound/Inbound/... (SDR, legado)
    fase: (cols[11] || '').trim(),  // "Fase do analista": Onboarded/Ramping up/Guardrail/Offboarding — ver cargoAtualPorEmail acima
  }));
}
const NIVEIS_SET = new Set(NIVEIS);
function nivelAtualPorFuncao(funcaoAlvo) {
  const best = {};
  readSalesGoalsCsv().forEach(r => {
    if (r.funcao !== funcaoAlvo || !r.email || !NIVEIS_SET.has(r.nivel)) return;
    const [dd, mm, yy] = r.data.split('/'); if (!dd || !mm || !yy) return;
    const iso = `${yy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
    if (!best[r.email] || iso > best[r.email].iso) best[r.email] = { iso, nivel: r.nivel };
  });
  const out = {}; for (const e in best) out[e] = best[e].nivel;
  return out;
}
const nivelPorCloser = nivelAtualPorFuncao('CSR');
const nivelPorOnboarder = nivelAtualPorFuncao('ONB');
// Filtro do Power BI (visual "Tamanho Carteira de Opps"): só opps válidas e dentro do funil
// BR — mesmos campos de dhmv_sales_touched (is_opp_valid/is_opp_br_funnel), sem precisar de
// join novo. Efeito pequeno sozinho (~99,7% das opps já passam), mas replicado por completude.
// Mesmos campos usados também pelo Power BI como 'f_salesfunnel_dates'[is_opp_valid/is_opp_br_funnel]
// — não achamos essa tabela separada no Redshift (só produtos de automação sem relação; ver
// Pendencias/README.md), o mais provável é ser o mesmo dado importado 2x no modelo do Power BI.
// leadBrOk/oppBrOk (30/07/2026): filtro Brasil por OBJETO, não por linha inteira — desde que o
// WHERE do 06_operacional_raw.sql passou a trazer a linha se QUALQUER UM dos dois for BR (pra
// não perder opps sem lead/com lead de outro office), é aqui que cada campo é filtrado pelo seu
// objeto de origem: is_lead_br_funnel pros campos do objeto Lead, is_opp_br_funnel pros campos
// do objeto Opportunity. Usado no loop principal (ver STAGES) e no sdrLeads/oppValidOk abaixo.
const leadBrOk = r => (r.is_lead_br_funnel || '').trim() === 'True';
const oppBrOk = r => (r.is_opp_br_funnel || '').trim() === 'True';
const oppValidOk = r => (r.is_opp_valid || '').trim() === 'True' && oppBrOk(r);
// ⚠️ Testado em 30/07/2026: adicionar leadFlowOk (PQL/PPQL + Seed 1/2) ao Estoque de Closer
// afasta o número do Power BI em vez de aproximar (o visual "Tamanho Carteira de Opps" não
// parece aplicar esse filtro) — por isso o closerLeads abaixo usa só isRealCloser+oppValidOk,
// sem leadFlowOk (diferente do Estoque de SDR, onde leadFlowOk é confirmado necessário).
// Testado em 30/07/2026: ao contrário de SDR/Closer, um roster curado (Cargo=Onboarding+Ativo=Sim,
// 19 pessoas) deixa o Estoque de Onboarding MUITO abaixo do Power BI (~296 vs ~603 na última
// semana) — a maioria das 55 pessoas que já apareceram como onboarding_email_sf histórico NÃO
// está nesse roster (saíram do time, mudaram de cargo etc.), mas ainda assim contam no Power BI.
// O filtro real de "Nome onboarders não é em branco" é bem mais simples: só exige ter alguém
// atribuído (quase sempre true — 4755/4756 dos CW já tem onboarding_email_sf preenchido), sem
// exigir que essa pessoa esteja num roster "ativo hoje".
let dataMaxRaw = ''; // data mais recente com resultado na base (max das datas de estágio)
// hojeStr/addDaysStr movidos pra antes do loop principal (10/08/2026) — precisam estar
// disponíveis aqui dentro pra alimentar onbCloseInfo (ver abaixo), usada tanto no loop
// principal (coorte semanal de Onboarding) quanto no onbLeadsMap (Estoque/Carteira).
const hojeStr = new Date().toISOString().slice(0, 10);
// soma N dias a uma data 'AAAA-MM-DD', devolve string no mesmo formato.
function addDaysStr(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
// accomplished/unaccomplished (+ fallback) de um registro de onboarding — usado tanto no loop
// principal (coorte semanal) quanto no onbLeadsMap (estoque), pra manter os dois consistentes.
// Fallback: o status já diz Accomplished/Unaccomplished na fonte, mas a data em si veio vazia
// -> usa CW+90d (a pedido do Gabriel, 03/08/2026 — resolve leads com status certo e data vazia).
// ⚠️ 10/08/2026: testamos também um 2º fallback — tratar como Unaccomplished por timeout
// (CW+90d) mesmo SEM nenhum status de fechamento, replicando a automação real do Salesforce
// ("Out of Onboarding time (>90 days)", confirmada na fonte viva pro caso 006SG00000RbRMfYAN).
// Validado contra a planilha de referência (551 clientes reais) e DESCARTADO: não é um corte
// cego de 90 dias pra todo mundo — aplicado em geral, tirou 120 clientes que a base real ainda
// mostra como ativos (de 551, ficou 431 match/120 faltando — pior que sem essa regra, que já
// tinha só 7 faltando). A automação real do Salesforce deve depender de alguma condição a mais
// que não identificamos (segmento, nível, etc.) — não replicar sem entender essa condição.
// ⚠️ 10/08/2026: as datas de accomplished/unaccomplished agora vêm da fonte viva
// (dhaf_salesforce.onboarding_history, MIN(createddate) de quando o registro passou por aquele
// estágio pela 1ª vez — ver Querys/06_operacional_raw.sql). Isso expôs casos REABERTOS: o
// registro já passou por "Unaccomplished"/"Accomplished" em algum momento (data existe), mas o
// status ATUAL voltou a ser algo ativo (ex. "Activation & Monitoring") — cliente que "voltou".
// Validado contra a planilha de referência (551 clientes reais, 10/08/2026): sem esse gate, 12
// clientes reabertos ficavam saindo do estoque por engano. Por isso só confia na data quando o
// STATUS ATUAL também bate — não é só "a data existe", é "a data existe E ainda é o status de
// agora".
function onbCloseInfo(r, cw) {
  const status = (r.onboarding_status || '').trim();
  let accomp = status === 'Accomplished' ? cleanDate(r.onboarding_accomplished_date) : null;
  let unaccomp = status === 'Unaccomplished' ? cleanDate(r.onboarding_unaccomplished_date) : null;
  let accompFallback = false, unaccompFallback = false;
  if (status === 'Accomplished' && !accomp) { accomp = addDaysStr(cw, 90); accompFallback = true; }
  if (status === 'Unaccomplished' && !unaccomp) { unaccomp = addDaysStr(cw, 90); unaccompFallback = true; }
  return { accomp, unaccomp, accompFallback, unaccompFallback, close: accomp || unaccomp || null, status };
}

for (const r of fop) {
  const b = bucketFromAmount(r.amount_12_months), e = estr(r.sales_strategy);
  const sdr = cleanEmail(r.sdr_email_sf), closer = cleanEmail(r.closer_email_sf), onb = cleanEmail(r.onboarding_email_sf), owner = cleanEmail(r.owner_email);
  // leadOk/oppOk: já que o WHERE do SQL agora deixa passar a linha se qualquer um dos dois
  // objetos for BR (ver STAGES), aqui é onde cada objeto é filtrado pelo seu próprio campo.
  const leadOk = leadBrOk(r), oppOk = oppBrOk(r);
  // lfOk (31/07/2026): lead_flow/lead_flow_segmentation (PQL/PPQL/Seed 1/2) é o filtro global
  // "em todas as páginas" do painel principal do Power BI — confirmado batendo EXATO (349 Opp /
  // 141 CW / 102 Ativação, jul/2026 MTD) quando aplicado em TODAS as contagens (não só
  // contacted/connected como antes). Diferente de leadOk/oppOk acima, não depende do objeto —
  // vale igual pra Lead e Opportunity (é atributo de origem/segmentação que persiste após a
  // conversão). ⚠️ current_office=BRAZIL foi testado no mesmo painel e afasta bem do Power BI
  // (48/62/102) — mesma armadilha já documentada no Estoque de Onboarding, não usar aqui.
  const lfOk = leadFlowOk(r);
  // stOk/oppValidForCw (20/08/2026): filtros que a query oficial "Resultados Daily" do Power BI
  // aplica no Actual (sales_type<>'PQL' pra Opp/CW/Ativação; is_opp_valid=TRUE só pro CW) e que
  // faltavam aqui — achado investigando uma opp PQL (006SG00000hKQyWYAW, is_opp_valid=False)
  // que inflava o Actual de agosto em +1 Opp/+1 CW vs o relatório oficial. Aplicado só na
  // contagem do funil Actual (funCell/funCellSemanal, abaixo) — não mexe em ranking/FTE/coortes
  // por pessoa de Closer/Onboarding, que usam outro critério de validade (oppValidOk, ver
  // comentário de 30/07 acima) já validado à parte contra o Power BI.
  const stOk = (r.sales_type || '').trim() !== 'PQL';
  const oppValidForCw = (r.is_opp_valid || '').trim() === 'True';
  const ownerReal = isRealSdr(owner) && lfOk && leadOk; // este lead conta nas métricas SDR da página?
  // datas cruas normalizadas uma vez por lead (SELECT * pode trazer '', 'null' ou data real).
  // Campo vira null se !lfOk (qualquer objeto) OU se o objeto específico não for BR (leadOk/
  // oppOk) — dali pra baixo, todo código que já checa `if (dates.xxx_date)` fica
  // automaticamente protegido (a maioria dos usos de opportunity_create_date/sql_date/
  // closed_won_date/activation_date_10k/contacted_date/connected_date no resto do loop está
  // aninhada dentro de um desses checks).
  const dates = {};
  for (const [col, , obj] of STAGES) {
    let v = cleanDate(r[col]);
    if (v && (!lfOk || (obj === 'lead' && !leadOk) || (obj === 'opp' && !oppOk))) v = null;
    dates[col] = v;
    if (v && v > dataMaxRaw) dataMaxRaw = v;
  }

  // coorte semanal contato→conexão (por estratégia): denom = contatado em W; num = conectou em W.
  const _estrLead = estr(r.sales_strategy);
  if (dates.contacted_date) {
    const wc = anoSemana(dates.contacted_date);
    const connSame = dates.connected_date && anoSemana(dates.connected_date) === wc;
    // C2 encadeado: do coorte de contato (contatou+conectou em W), qualificou em W? (mesma semana)
    const q1 = cleanDate(r.qualified_date), qualSame = connSame && q1 && anoSemana(q1) === wc;
    // C3: contatado em W e qualificado em W, direto — NÃO exige conexão na mesma semana (mede
    // o funil ponta a ponta contato→qualificação, independente de quando a conexão aconteceu).
    const qualDirect = q1 && anoSemana(q1) === wc;
    const bumpCoh = o => { const cc = o[wc] || (o[wc] = { contacted: 0, conn: 0, qual: 0, qualDirect: 0 }); cc.contacted++; if (connSame) cc.conn++; if (qualSame) cc.qual++; if (qualDirect) cc.qualDirect++; };
    if (ownerReal) { bumpCoh(sdrCohort.all); if (_estrLead) bumpCoh(sdrCohort[_estrLead]); }
    // mesma coorte, por SDR (mantido) — mas o C2 da tabela usa a versão por DONO abaixo.
    if (sdr) {
      const pw = wk(getP(porPessoaSdr, sdr), wc);
      pw.cohContacted = (pw.cohContacted || 0) + 1;
      if (connSame) pw.cohConn = (pw.cohConn || 0) + 1;
    }
    // C2 por dono do lead (owner_email) — cobre 100% dos contatados, reconcilia com o card do topo.
    if (owner) {
      const oc = sdrOwnerCohort[owner] || (sdrOwnerCohort[owner] = {});
      const cc = oc[wc] || (oc[wc] = { contacted: 0, conn: 0 });
      cc.contacted++; if (connSame) cc.conn++;
    }
  }
  const _unq = cleanDate(r.unqualified_date);
  if (_unq && ownerReal) { const wq = anoSemana(_unq); sdrUnq.all[wq] = (sdrUnq.all[wq] || 0) + 1; if (_estrLead) sdrUnq[_estrLead][wq] = (sdrUnq[_estrLead][wq] || 0) + 1; }
  if (dates.contacted_date) {
    const wc = anoSemana(dates.contacted_date);
    const sd = { contacted: dates.contacted_date, connected: dates.connected_date,
      nurturing: cleanDate(r.nurturing_date), qualified: cleanDate(r.qualified_date), unqualified: _unq };
    let status = 'contacted', bestD = sd.contacted;
    for (const k of ['connected', 'nurturing', 'qualified', 'unqualified']) if (sd[k] && sd[k] >= bestD) { bestD = sd[k]; status = k; }
    const bumpSt = o => { const cc = o[wc] || (o[wc] = { contacted: 0, connected: 0, nurturing: 0, qualified: 0, unqualified: 0 }); cc[status]++; };
    if (ownerReal) { bumpSt(sdrCohortStatus.all); if (_estrLead) bumpSt(sdrCohortStatus[_estrLead]); }
    if (ownerReal && owner) {
      bumpSt(sdrCohortStatusPessoa[owner] || (sdrCohortStatusPessoa[owner] = {}));
      sdrLeadsValidacao.push({
        leadId: r.lead_id || null, owner, semana: wc, status,
        contacted: sd.contacted, connected: sd.connected, nurturing: sd.nurturing, qualified: sd.qualified, unqualified: sd.unqualified,
        estr: _estrLead || null,
      });
    }
  }

  // coorte semanal de negociação (Closer): denom = virou opp em W; C1 = chegou a SQL em W;
  // C2 (encadeado) = do sub-coorte que chegou a SQL em W, chegou a Offer também em W.
  // status atual (hoje) do lead, por semana de ENTRADA no closer (opp) — mesma lógica do
  // status de SDR, com os estágios da negociação.
  const _offerD = cleanDate(r.offer_presented_date), _contractD = cleanDate(r.contract_sent_date), _lostD = cleanDate(r.lost_deal_date);
  // nivOk: nível de cliente válido pro filtro independente de Nível (Closer/Onboarding, Semanal
  // Área) — mesmo bucket já calculado (b) pra tudo mais, só checando se é um dos 3 buckets reais.
  const nivOk = b && NIVEIS.includes(b);
  if (dates.opportunity_create_date && closer) {
    const wo = anoSemana(dates.opportunity_create_date);
    const sqlSame = dates.sql_date && anoSemana(dates.sql_date) === wo;
    const offerSame = sqlSame && _offerD && anoSemana(_offerD) === wo;
    const bumpCloCoh = o => { const cc = o[wo] || (o[wo] = { opp: 0, sql: 0, offer: 0 }); cc.opp++; if (sqlSame) cc.sql++; if (offerSame) cc.offer++; };
    bumpCloCoh(closerCohort.all); if (e) bumpCloCoh(closerCohort[e]); if (nivOk) bumpCloCoh(closerCohort[b]);
    const pw = wk(getP(porPessoaCloser, closer), wo);
    pw.cohOpp = (pw.cohOpp || 0) + 1;
    if (sqlSame) pw.cohSql = (pw.cohSql || 0) + 1;

    const sd2 = { opp: dates.opportunity_create_date, sql: dates.sql_date, offer: _offerD, contract: _contractD, closed_won: dates.closed_won_date, lost_deal: _lostD };
    let status2 = 'opp', bestD2 = sd2.opp;
    for (const k of ['sql', 'offer', 'contract', 'closed_won', 'lost_deal']) if (sd2[k] && sd2[k] >= bestD2) { bestD2 = sd2[k]; status2 = k; }
    const bumpCloSt = o => { const cc = o[wo] || (o[wo] = { opp: 0, sql: 0, offer: 0, contract: 0, closed_won: 0, lost_deal: 0 }); cc[status2]++; };
    bumpCloSt(closerCohortStatus.all); if (e) bumpCloSt(closerCohortStatus[e]); if (nivOk) bumpCloSt(closerCohortStatus[b]);
    bumpCloSt(closerCohortStatusPessoa[closer] || (closerCohortStatusPessoa[closer] = {}));

    (closerOppFteSet.all[wo] = closerOppFteSet.all[wo] || new Set()).add(closer);
    if (e) (closerOppFteSet[e][wo] = closerOppFteSet[e][wo] || new Set()).add(closer);
    if (nivOk) (closerOppFteSet[b][wo] = closerOppFteSet[b][wo] || new Set()).add(closer);
  }
  if (_lostD && closer && oppOk && lfOk) { // lost_deal_date é campo do objeto Opportunity, não do Lead
    const wl = anoSemana(_lostD);
    closerLost.all[wl] = (closerLost.all[wl] || 0) + 1; if (e) closerLost[e][wl] = (closerLost[e][wl] || 0) + 1; if (nivOk) closerLost[b][wl] = (closerLost[b][wl] || 0) + 1;
  }
  // C4: coorte SQL→CW — dos leads que chegaram a SQL na semana W, quantos fecharam (CW) na
  // MESMA semana. Âncora é a semana do SQL (diferente do C1/C2 acima, ancorados na semana do opp).
  if (dates.sql_date && closer) {
    const wsql = anoSemana(dates.sql_date);
    const cwSame = dates.closed_won_date && anoSemana(dates.closed_won_date) === wsql;
    const bumpC4 = o => { const cc = o[wsql] || (o[wsql] = { sql: 0, cw: 0 }); cc.sql++; if (cwSame) cc.cw++; };
    bumpC4(closerCohortSqlCw.all); if (e) bumpC4(closerCohortSqlCw[e]); if (nivOk) bumpC4(closerCohortSqlCw[b]);
  }

  // coorte semanal de ativação (Onboarding): denom = fechou (CW) em W; C1 = chegou a 1k em W;
  // C2 (encadeado) = do sub-coorte que chegou a 1k em W, chegou a 5k também em W. Status atual
  // (hoje) do lead, por semana de ENTRADA no onboarding (CW) — mesma lógica do status de
  // SDR/Closer, com os estágios de ativação. Não há "saída por perda" conhecida aqui.
  const _a1kD = cleanDate(r.activation_date_1k), _a5kD = cleanDate(r.activation_date_5k);
  if (dates.closed_won_date && onb) {
    const wo2 = anoSemana(dates.closed_won_date);
    const a1kSame = _a1kD && anoSemana(_a1kD) === wo2;
    const a5kSame = a1kSame && _a5kD && anoSemana(_a5kD) === wo2;
    // a10kSame é DIRETO (não encadeado por a1k/a5k) — mede CW→10k ponta a ponta na mesma
    // semana, igual ao C3 do SDR (contato→qualificação pulando a exigência de conexão).
    const a10kSame = dates.activation_date_10k && anoSemana(dates.activation_date_10k) === wo2;
    // status ATUAL (hoje) do onboarding — não é coorte de mesma semana, é snapshot de agora,
    // pra quem fechou (CW) naquela semana. Usa onbCloseInfo (10/08/2026) em vez do status cru —
    // já cobre o fallback de timeout de 90 dias (ver comentário na função, perto do topo).
    const onbClose = onbCloseInfo(r, dates.closed_won_date);
    const bumpOnbCoh = o => { const cc = o[wo2] || (o[wo2] = { cw: 0, a1k: 0, a5k: 0, a10k: 0, accomplished: 0, unaccomplished: 0 }); cc.cw++; if (a1kSame) cc.a1k++; if (a5kSame) cc.a5k++; if (a10kSame) cc.a10k++; if (onbClose.accomp) cc.accomplished++; if (onbClose.unaccomp) cc.unaccomplished++; };
    bumpOnbCoh(onbCohort.all); if (e) bumpOnbCoh(onbCohort[e]); if (nivOk) bumpOnbCoh(onbCohort[b]);
    const pwo = wk(getP(porPessoaOnb, onb), wo2);
    pwo.cohCw = (pwo.cohCw || 0) + 1;
    if (a1kSame) pwo.coh1k = (pwo.coh1k || 0) + 1;

    const sd3 = { cw: dates.closed_won_date, a1k: _a1kD, a5k: _a5kD, ativado_10k: dates.activation_date_10k };
    let status3 = 'cw', bestD3 = sd3.cw;
    for (const k of ['a1k', 'a5k', 'ativado_10k']) if (sd3[k] && sd3[k] >= bestD3) { bestD3 = sd3[k]; status3 = k; }
    const bumpOnbSt = o => { const cc = o[wo2] || (o[wo2] = { cw: 0, a1k: 0, a5k: 0, ativado_10k: 0 }); cc[status3]++; };
    bumpOnbSt(onbCohortStatus.all); if (e) bumpOnbSt(onbCohortStatus[e]); if (nivOk) bumpOnbSt(onbCohortStatus[b]);
    bumpOnbSt(onbCohortStatusPessoa[onb] || (onbCohortStatusPessoa[onb] = {}));

    (onbCwFteSet.all[wo2] = onbCwFteSet.all[wo2] || new Set()).add(onb);
    if (e) (onbCwFteSet[e][wo2] = onbCwFteSet[e][wo2] || new Set()).add(onb);
    if (nivOk) (onbCwFteSet[b][wo2] = onbCwFteSet[b][wo2] || new Set()).add(onb);
  }

  if (e) {
    const f = fteBy[e] || (fteBy[e] = { sdrs: new Set(), contacted: 0, opps: 0 });
    if (sdr) f.sdrs.add(sdr);
  }

  // tempos de ciclo — por lead, independente do corte >=2025 usado nas contagens de estágio
  const dCC = pushCiclo('dias_contato_conectado', dates.contacted_date, dates.connected_date);
  pushCiclo('dias_conectado_opp', dates.connected_date, dates.opportunity_create_date);
  const dOS = pushCiclo('dias_opp_sql', dates.opportunity_create_date, dates.sql_date);
  const dSW = pushCiclo('dias_sql_won', dates.sql_date, dates.closed_won_date);
  const dWA = pushCiclo('dias_won_ativacao', dates.closed_won_date, dates.activation_date_10k);
  // ciclo por semana: bucketiza pela semana da data "de chegada" de cada transição (mesma
  // data que já bucketiza o estágio correspondente mais abaixo), pra poder mostrar o ciclo
  // médio da semana selecionada nas tabelas de Semanal Área.
  if (dCC != null && sdr) {
    const p = getP(porPessoaSdr, sdr); p._dCCsum = (p._dCCsum || 0) + dCC; p._dCCn = (p._dCCn || 0) + 1;
    if (dates.connected_date) { const pw = wk(p, anoSemana(dates.connected_date)); pw.dCCsum = (pw.dCCsum || 0) + dCC; pw.dCCn = (pw.dCCn || 0) + 1; }
  }
  if (dOS != null && closer) {
    const p = getP(porPessoaCloser, closer); p._dOSsum = (p._dOSsum || 0) + dOS; p._dOSn = (p._dOSn || 0) + 1;
    if (dates.sql_date) { const pw = wk(p, anoSemana(dates.sql_date)); pw.dOSsum = (pw.dOSsum || 0) + dOS; pw.dOSn = (pw.dOSn || 0) + 1; }
  }
  if (dSW != null && closer) {
    const p = getP(porPessoaCloser, closer); p._dSWsum = (p._dSWsum || 0) + dSW; p._dSWn = (p._dSWn || 0) + 1;
    if (dates.closed_won_date) { const pw = wk(p, anoSemana(dates.closed_won_date)); pw.dSWsum = (pw.dSWsum || 0) + dSW; pw.dSWn = (pw.dSWn || 0) + 1; }
  }
  if (dWA != null && onb) {
    const p = getP(porPessoaOnb, onb); p._dWAsum = (p._dWAsum || 0) + dWA; p._dWAn = (p._dWAn || 0) + 1;
    if (dates.activation_date_10k) { const pw = wk(p, anoSemana(dates.activation_date_10k)); pw.dWAsum = (pw.dWAsum || 0) + dWA; pw.dWAn = (pw.dWAn || 0) + 1; }
  }

  for (const [col, key] of STAGES) {
    const dateStr = dates[col];
    if (!dateStr || dateStr < CUTOFF) continue;
    const mk = dateStr.slice(0, 7), w = anoSemana(dateStr);

    // sales_type<>PQL (todas as etapas) + is_opp_valid=TRUE (só CW) — ver comentário de stOk/
    // oppValidForCw acima. Só afeta o funil Actual (Mensal/Semanal Sales); o resto do loop
    // abaixo (ranking/FTE/coortes por pessoa) continua sem esse filtro, sem mudança.
    if (stOk && (key !== 'cw' || oppValidForCw)) {
      const ck = mk + '|' + b + '|' + e;
      if (!funCell[ck]) funCell[ck] = { contacted: 0, connected: 0, opps: 0, sql: 0, cw: 0, activation: 0 };
      funCell[ck][key] += 1;
      const ckw = w + '|' + b + '|' + e;
      if (!funCellSemanal[ckw]) funCellSemanal[ckw] = { contacted: 0, connected: 0, opps: 0, sql: 0, cw: 0, activation: 0 };
      funCellSemanal[ckw][key] += 1;
    }

    if (key === 'contacted') {
      (semContactedNivel[w] = semContactedNivel[w] || {})[b] = (semContactedNivel[w][b] || 0) + 1;
      if (ownerReal) { // FTE de contato = donos SDR reais distintos (owner cobre o "contacted", sdr não)
        (sdrContactFteSet.all[w] = sdrContactFteSet.all[w] || new Set()).add(owner);
        if (e) (sdrContactFteSet[e][w] = sdrContactFteSet[e][w] || new Set()).add(owner);
      }
      if (sdr) {
        const p = getP(porPessoaSdr, sdr); p.contacted = (p.contacted || 0) + 1; p.estrategia = e || p.estrategia;
        wk(p, w).contacted = (wk(p, w).contacted || 0) + 1;
      }
      if (e) {
        fteBy[e].contacted += 1;
        const fwe = (fteByWeek[w] = fteByWeek[w] || {})[e] = (fteByWeek[w] || {})[e] || { sdrs: new Set(), contacted: 0, opps: 0 };
        if (sdr) fwe.sdrs.add(sdr);
        fwe.contacted += 1;
      }
    }
    if (key === 'connected' && sdr) {
      const p = getP(porPessoaSdr, sdr); p.connected = (p.connected || 0) + 1;
      wk(p, w).connected = (wk(p, w).connected || 0) + 1;
    }
    if (key === 'opps') {
      (semOppNivel[w] = semOppNivel[w] || {})[b] = (semOppNivel[w][b] || 0) + 1;
      if (ownerReal && NIVEIS.includes(b)) { // opps por nível só de SDR real (alimenta a página)
        (sdrOppsNivelAcc.all[w] = sdrOppsNivelAcc.all[w] || {})[b] = (sdrOppsNivelAcc.all[w][b] || 0) + 1;
        if (e) (sdrOppsNivelAcc[e][w] = sdrOppsNivelAcc[e][w] || {})[b] = (sdrOppsNivelAcc[e][w][b] || 0) + 1;
      }
      if (sdr) {
        const p = getP(porPessoaSdr, sdr);
        p.opps = (p.opps || 0) + 1;
        p.oppNivel = p.oppNivel || {}; p.oppNivel[b] = (p.oppNivel[b] || 0) + 1;
        p.semanal = p.semanal || {}; p.semanal[w] = (p.semanal[w] || 0) + 1;
        const pw = wk(p, w); pw.opps = (pw.opps || 0) + 1; pw.oppNivel = pw.oppNivel || {}; pw.oppNivel[b] = (pw.oppNivel[b] || 0) + 1;
        // esta MESMA opp (independente de semana) chegou a SQL? — acumulado, não coorte de
        // mesma semana (alimenta a coluna "Opp→SQL · 5s" da tabela por pessoa).
        if (dates.sql_date) pw.oppSql = (pw.oppSql || 0) + 1;
        if (ownerReal) { (sdrOppFteSet.all[w] = sdrOppFteSet.all[w] || new Set()).add(owner);
          if (e) (sdrOppFteSet[e][w] = sdrOppFteSet[e][w] || new Set()).add(owner); }
      }
      if (closer) {
        const p = getP(porPessoaCloser, closer); p.opps = (p.opps || 0) + 1; p.estrategia = e || p.estrategia;
        const pw = wk(p, w); pw.opps = (pw.opps || 0) + 1;
        // esta MESMA opp (independente de semana) chegou a CW? — acumulado, não coorte de
        // mesma semana (alimenta a coluna "Opp→CW · 5s" da tabela por pessoa, mesmo padrão
        // do "Opp→SQL · 5s" do SDR).
        if (dates.closed_won_date) pw.oppCw = (pw.oppCw || 0) + 1;
      }
      if (e) {
        fteBy[e].opps += 1;
        const fwe = (fteByWeek[w] = fteByWeek[w] || {})[e] = (fteByWeek[w] || {})[e] || { sdrs: new Set(), contacted: 0, opps: 0 };
        fwe.opps += 1;
      }
    }
    if (key === 'sql' && closer) {
      const p = getP(porPessoaCloser, closer); p.sql = (p.sql || 0) + 1;
      wk(p, w).sql = (wk(p, w).sql || 0) + 1;
    }
    if (key === 'cw') {
      (semCwNivel[w] = semCwNivel[w] || {})[b] = (semCwNivel[w][b] || 0) + 1;
      if (closer) {
        const p = getP(porPessoaCloser, closer);
        p.cw = (p.cw || 0) + 1;
        p.cwNivel = p.cwNivel || {}; p.cwNivel[b] = (p.cwNivel[b] || 0) + 1;
        p.semanal = p.semanal || {}; p.semanal[w] = (p.semanal[w] || 0) + 1;
        const pw = wk(p, w); pw.cw = (pw.cw || 0) + 1; pw.cwNivel = pw.cwNivel || {}; pw.cwNivel[b] = (pw.cwNivel[b] || 0) + 1;
        rankCw[closer] = rankCw[closer] || { email: closer, cw: 0, ativados: 0 }; rankCw[closer].cw += 1;
        (closerCwFteSet.all[w] = closerCwFteSet.all[w] || new Set()).add(closer);
        if (e) (closerCwFteSet[e][w] = closerCwFteSet[e][w] || new Set()).add(closer);
        if (nivOk) (closerCwFteSet[b][w] = closerCwFteSet[b][w] || new Set()).add(closer);
        closerCwAcc.all[w] = (closerCwAcc.all[w] || 0) + 1; if (e) closerCwAcc[e][w] = (closerCwAcc[e][w] || 0) + 1; if (nivOk) closerCwAcc[b][w] = (closerCwAcc[b][w] || 0) + 1;
      }
      if (onb) {
        const p = getP(porPessoaOnb, onb); p.cwIn = (p.cwIn || 0) + 1; p.estrategia = e || p.estrategia;
        const pw = wk(p, w); pw.cwIn = (pw.cwIn || 0) + 1;
        // este MESMO CW (independente de semana) já ativou 10k? — acumulado, alimenta a
        // coluna "CW→10K · 5s" da tabela por pessoa (mesmo padrão do "Opp→SQL · 5s" do SDR).
        if (dates.activation_date_10k) pw.cwAct10k = (pw.cwAct10k || 0) + 1;
      }
      if (owner) { rankOwner[owner] = rankOwner[owner] || { email: owner, cw: 0, ativados: 0 }; rankOwner[owner].cw += 1; }
    }
    if (key === 'activation') {
      (semActNivel[w] = semActNivel[w] || {})[b] = (semActNivel[w][b] || 0) + 1;
      if (onb) {
        const p = getP(porPessoaOnb, onb);
        p.activated = (p.activated || 0) + 1;
        p.actNivel = p.actNivel || {}; p.actNivel[b] = (p.actNivel[b] || 0) + 1;
        p.semanal = p.semanal || {}; p.semanal[w] = (p.semanal[w] || 0) + 1;
        const pw = wk(p, w); pw.activated = (pw.activated || 0) + 1; pw.actNivel = pw.actNivel || {}; pw.actNivel[b] = (pw.actNivel[b] || 0) + 1;
        (onbActFteSet.all[w] = onbActFteSet.all[w] || new Set()).add(onb);
        if (e) (onbActFteSet[e][w] = onbActFteSet[e][w] || new Set()).add(onb);
        if (nivOk) (onbActFteSet[b][w] = onbActFteSet[b][w] || new Set()).add(onb);
        onbActAcc.all[w] = (onbActAcc.all[w] || 0) + 1; if (e) onbActAcc[e][w] = (onbActAcc[e][w] || 0) + 1; if (nivOk) onbActAcc[b][w] = (onbActAcc[b][w] || 0) + 1;
      }
      if (closer) { rankCw[closer] = rankCw[closer] || { email: closer, cw: 0, ativados: 0 }; rankCw[closer].ativados += 1; }
      if (owner) { rankOwner[owner] = rankOwner[owner] || { email: owner, cw: 0, ativados: 0 }; rankOwner[owner].ativados += 1; }
    }
  }
}

// montar actual.mensal
function buildMensal(cells) {
  // cells: key mes|nivel|estr -> partial metrics; retorna {mes:{total,porNivel,porEstrategia,porNivelEstrategia}}
  // porNivelEstrategia é o cruzamento nível x estratégia (aditivo, não muda o shape de
  // porNivel/porEstrategia já existentes) — alimenta o filtro de Estratégia na Mensal Sales
  // sem quebrar quem já lê porNivel/porEstrategia direto (Semanal Sales, Semanal Área).
  const out = {};
  for (const k in cells) {
    const [mk, b, e] = k.split('|');
    if (!out[mk]) out[mk] = { total: blankM(), porNivel: {}, porEstrategia: {}, porNivelEstrategia: {} };
    const cell = cells[k];
    addM(out[mk].total, cell);
    if (!out[mk].porNivel[b]) out[mk].porNivel[b] = blankM();
    addM(out[mk].porNivel[b], cell);
    if (!out[mk].porEstrategia[e]) out[mk].porEstrategia[e] = blankM();
    addM(out[mk].porEstrategia[e], cell);
    if (!out[mk].porNivelEstrategia[b]) out[mk].porNivelEstrategia[b] = {};
    if (!out[mk].porNivelEstrategia[b][e]) out[mk].porNivelEstrategia[b][e] = blankM();
    addM(out[mk].porNivelEstrategia[b][e], cell);
  }
  return out;
}
const actualCells = {};
function mergeInto(dst, src) { for (const k in src) { if (!dst[k]) dst[k] = blankM(); addM(dst[k], src[k]); } }
mergeInto(actualCells, finCell);
mergeInto(actualCells, funCell);
const actualMensal = buildMensal(actualCells);

function roundM(o) { METRICS.forEach(m => o[m] = Math.round(o[m])); return o; }
for (const mk in actualMensal) {
  roundM(actualMensal[mk].total);
  for (const b in actualMensal[mk].porNivel) roundM(actualMensal[mk].porNivel[b]);
  for (const e in actualMensal[mk].porEstrategia) roundM(actualMensal[mk].porEstrategia[e]);
  for (const b in actualMensal[mk].porNivelEstrategia)
    for (const e in actualMensal[mk].porNivelEstrategia[b]) roundM(actualMensal[mk].porNivelEstrategia[b][e]);
}

// ---------- BUDGET / REFORECAST ----------
function buildRef(name, estCol, nivCol) {
  const rows = readCsv(name);
  const cells = {};
  for (const r of rows) {
    const mk = mesBr(r.Data); const e = estr(r[estCol] || r.Estrategia || r['Estratégia']);
    const b = (r[nivCol] || r.Nivel || r['Nível'] || '').trim(); if (!b) continue; // pula linhas sem nivel
    const k = mk + '|' + b + '|' + e;
    cells[k] = {
      contacted: money(r.Contacted), connected: money(r.Connected), opps: money(r.Opps),
      sql: money(r.SQL), cw: money(r.CW), activation: money(r.Activation), sap: money(r.SAP),
      gmv: money(r.GMV), receita: money(r['Net Revenue'])
    };
  }
  return buildMensal(cells);
}
const budgetMensal = buildRef('budget_oficial.csv', 'Estrategia', 'Nivel');
const reforecastMensal = buildRef('reforecast_oficial.csv', 'Estratégia', 'Nível');

// ---------- BUDGET / REFORECAST DIÁRIO (meta real por semana) ----------
// f_budget_daily/f_reforecast_daily: 1 linha por dia × nível × estratégia × pessoa (SDR/
// Closer/Onboarding), já rateada — somar as colunas "_Dia" de TODAS as linhas de uma mesma
// semana reconstrói a meta da semana (validado: soma do mês bate com f_goals.* dentro de
// ~0,02%). Ano+Semana_Ano já seguem a MESMA regra de ano_semana usada no resto do projeto
// (semana 1 parcial + segunda-feira em diante), então não precisa parsear a data por extenso.
function buildDailySemanal(name) {
  const rows = readCsv(name);
  const cells = {};
  for (const r of rows) {
    const niv = (r['f_goals.Nivel'] || '').trim(); if (!niv) continue;
    const est = estr(r['f_goals.Estrategia']); if (!est) continue;
    const wk = r.Ano + '-W' + String(+r.Semana_Ano).padStart(2, '0');
    const k = wk + '|' + niv + '|' + est;
    if (!cells[k]) cells[k] = blankM();
    cells[k].contacted += numBr(r.Contacted_Dia);
    cells[k].connected += numBr(r.Connected_Dia);
    cells[k].opps += numBr(r.Opps_Dia);
    cells[k].sql += numBr(r.SQL_Dia);
    cells[k].cw += numBr(r.CW_Dia);
    cells[k].activation += numBr(r.Activation_Dia);
    cells[k].sap += numBr(r.SAP_Dia);
    cells[k].gmv += numBr(r.GMV_Dia);
    cells[k].receita += numBr(r.Net_Revenue_Dia);
  }
  return buildMensal(cells); // genérico o bastante pra reaproveitar (chave semana em vez de mês)
}
const budgetSemanal = buildDailySemanal('f_budget_daily.csv');
// reforecastSemanal NÃO vem mais de Dados/f_reforecast_daily.csv — ver reconstrução logo após
// weekEndUTC() mais abaixo (precisa dessas duas funções, por isso fica depois).

// actual.semanal — mesma estrutura {total,porNivel,porEstrategia} do actual.mensal, só que
// por semana (reaproveita buildMensal, que não sabe/não liga se a chave é mês ou semana).
const actualCellsSemanal = {};
mergeInto(actualCellsSemanal, finCellSemanal);
mergeInto(actualCellsSemanal, funCellSemanal);
const actualSemanal = buildMensal(actualCellsSemanal);
for (const w in actualSemanal) {
  roundM(actualSemanal[w].total);
  for (const b in actualSemanal[w].porNivel) roundM(actualSemanal[w].porNivel[b]);
  for (const e in actualSemanal[w].porEstrategia) roundM(actualSemanal[w].porEstrategia[e]);
}
// semanas: budgetSemanal (f_budget_daily.csv) já cobre o ano inteiro (mesma cobertura que
// f_reforecast_daily.csv tinha), então não precisa mais do reforecastSemanal aqui pra não
// perder semana nenhuma — reforecastSemanal é construído logo abaixo, DEPOIS desta lista.
const semanas = [...new Set([...Object.keys(actualSemanal), ...Object.keys(budgetSemanal)])].sort();

// semana -> mês (chave 'YYYY-MM'), usado pelo filtro em cascata Mês → Semana no dashboard.
// Mês de uma semana = mês da SEGUNDA-FEIRA que abre a semana (ou 01/jan pra semana 1 parcial).
function weekStartUTC(weekKey) {
  const [ys, ws] = weekKey.split('-W');
  const year = +ys, w = +ws;
  if (w === 1) return new Date(Date.UTC(year, 0, 1));
  const fm = firstMondayUTC(year);
  const d = new Date(fm); d.setUTCDate(d.getUTCDate() + (w - 2) * 7);
  return d;
}
const semanaMes = {};
for (const w of semanas) semanaMes[w] = weekStartUTC(w).toISOString().slice(0, 7);

// fte por semana (mesma coisa que "fte" acima, só que por semana, pro filtro de Semanal Área)
const fteSemanal = {};
for (const w in fteByWeek) {
  fteSemanal[w] = ESTRS.filter(e => fteByWeek[w][e]).map(e => ({
    estrategia: e, fte: fteByWeek[w][e].sdrs.size,
    contacted: Math.round(fteByWeek[w][e].contacted), opps: Math.round(fteByWeek[w][e].opps)
  }));
}

// ---------- ESTOQUE DO FUNIL SDR (snapshot no FIM de cada semana) ----------
// Diferente das contagens de throughput acima (que contam cada estágio na semana da SUA
// data): aqui é ESTOQUE — quantos leads estavam PARADOS em cada estágio no último dia de
// cada semana. Um lead está "em contacted" no fim da semana W se foi contatado até o fim de
// W e ainda NÃO avançou (connected/nurturing) nem saiu do funil de SDR (virou opp/qualificado
// ou foi desqualificado) até o fim de W. Mesma lógica, mais fundo, para connected e nurturing.
// Só datas são lidas por nome (contacted/connected/nurturing/qualified/unqualified/opp) —
// nenhuma PII entra no app_data.js, só contagens semanais agregadas.
function weekEndUTC(weekKey) {
  const [ys, ws] = weekKey.split('-W'); const year = +ys, w = +ws;
  if (w === 1) { const d = firstMondayUTC(year); d.setUTCDate(d.getUTCDate() - 1); return d; } // véspera da 1ª segunda
  const d = weekStartUTC(weekKey); d.setUTCDate(d.getUTCDate() + 6); return d;                  // domingo
}
// reforecastSemanal (12/08/2026, a pedido do Gabriel): reconstruído a partir do reforecastMensal
// (planilha reforecast_oficial.csv) em vez de lido de Dados/f_reforecast_daily.csv — esse arquivo
// era um export manual separado, feito no mesmo lote que o de budget, e ficou desatualizado sem
// ninguém perceber (reforecast é revisado bem mais vezes que budget ao longo do trimestre). O
// Gabriel mandou o editor avançado do Power BI (Power Query/M) que gera aquele arquivo lá — a
// fórmula é: meta do MÊS (f_goals) rateada por PESSOA (tabela f_rateio_budget, a MESMA usada
// tanto pro budget quanto pro reforecast) e depois por DIA. Rateio por pessoa soma 100% dentro
// de cada nível×estratégia — como D.budget/D.reforecast só expõem total/porNivel/porEstrategia
// (nunca por pessoa), o rateio por pessoa CANCELA na soma e não precisa ser reproduzido; só a
// divisão por dia importa:
//   • Contacted/Connected/Opps/SQL/CW → meta do mês ÷ dias ÚTEIS do mês, só conta em dia útil
//     (mesma regra do Dia_Util do Power Query: seg-sex, sem feriado).
//   • Activation/SAP/GMV/Net Revenue → meta do mês ÷ dias CORRIDOS do mês, todo dia (inclui
//     fim de semana) — confirmado batendo com o rateio real (Net_Revenue_Dia idêntico
//     sábado/domingo/dia útil no f_budget_daily.csv).
// Validado contra f_budget_daily.csv real (esse sim ainda lido normalmente, ver budgetSemanal
// acima — sabemos que bate com o Power BI): reconstruir a mesma semana com esta fórmula bateu
// exato (Opps: 65 reconstruído = 65 real) ou dentro de ~0,01% (Net Revenue: R$466.952
// reconstruído vs R$466.993 real) — mesma margem de arredondamento que já existia no rateio.
// Ganho: reforecastSemanal agora segue automaticamente qualquer atualização de
// reforecast_oficial.csv, sem precisar reexportar um 2º arquivo diário à parte.
function diasUteisNoMesUTC(ano, mes0) { // mes0 = 0-indexado (0=jan)
  const n = new Date(Date.UTC(ano, mes0 + 1, 0)).getUTCDate();
  let c = 0;
  for (let d = 1; d <= n; d++) { const dow = new Date(Date.UTC(ano, mes0, d)).getUTCDay(); if (dow >= 1 && dow <= 5) c++; }
  return c;
}
const RATEIO_DIA_UTIL = ['contacted', 'connected', 'opps', 'sql', 'cw'];
const RATEIO_DIA_CORRIDO = ['activation', 'sap', 'gmv', 'receita'];
function buildSemanalDeMensal(mensalObj, semanasAlvo) {
  const out = {};
  for (const w of semanasAlvo) {
    const start = weekStartUTC(w), end = weekEndUTC(w);
    const acc = { total: blankM(), porNivel: {}, porEstrategia: {}, porNivelEstrategia: {} };
    const addDia = (dst, src, diaUtil, diasUteisMes, diasCorridosMes) => {
      if (!src) return;
      if (diaUtil && diasUteisMes) RATEIO_DIA_UTIL.forEach(m => dst[m] = (dst[m] || 0) + (src[m] || 0) / diasUteisMes);
      if (diasCorridosMes) RATEIO_DIA_CORRIDO.forEach(m => dst[m] = (dst[m] || 0) + (src[m] || 0) / diasCorridosMes);
    };
    for (const d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      const ano = d.getUTCFullYear(), mes0 = d.getUTCMonth();
      const mk = ano + '-' + String(mes0 + 1).padStart(2, '0');
      const mCell = mensalObj[mk]; if (!mCell) continue;
      const dow = d.getUTCDay(), diaUtil = dow >= 1 && dow <= 5;
      const diasUteisMes = diasUteisNoMesUTC(ano, mes0), diasCorridosMes = new Date(Date.UTC(ano, mes0 + 1, 0)).getUTCDate();
      addDia(acc.total, mCell.total, diaUtil, diasUteisMes, diasCorridosMes);
      for (const niv in mCell.porNivel) { acc.porNivel[niv] = acc.porNivel[niv] || blankM(); addDia(acc.porNivel[niv], mCell.porNivel[niv], diaUtil, diasUteisMes, diasCorridosMes); }
      for (const es in mCell.porEstrategia) { acc.porEstrategia[es] = acc.porEstrategia[es] || blankM(); addDia(acc.porEstrategia[es], mCell.porEstrategia[es], diaUtil, diasUteisMes, diasCorridosMes); }
      for (const niv in mCell.porNivelEstrategia) {
        acc.porNivelEstrategia[niv] = acc.porNivelEstrategia[niv] || {};
        for (const es in mCell.porNivelEstrategia[niv]) {
          acc.porNivelEstrategia[niv][es] = acc.porNivelEstrategia[niv][es] || blankM();
          addDia(acc.porNivelEstrategia[niv][es], mCell.porNivelEstrategia[niv][es], diaUtil, diasUteisMes, diasCorridosMes);
        }
      }
    }
    roundM(acc.total);
    for (const b in acc.porNivel) roundM(acc.porNivel[b]);
    for (const e in acc.porEstrategia) roundM(acc.porEstrategia[e]);
    for (const b in acc.porNivelEstrategia) for (const e in acc.porNivelEstrategia[b]) roundM(acc.porNivelEstrategia[b][e]);
    out[w] = acc;
  }
  return out;
}
const reforecastSemanal = buildSemanalDeMensal(reforecastMensal, Object.keys(budgetSemanal));

// ---------- REFORECAST SEMANAL OFICIAL (calendário útil real) — só Semanal Sales ----------
// 13/08/2026, a pedido do Gabriel: a reconstrução acima (buildSemanalDeMensal/reforecastSemanal)
// trata todo dia de semana (seg-sex) como dia útil, sem excluir feriado nenhum — o time de Ops
// já tem uma base oficial que reparte a meta mensal pelo calendário útil real (datasource
// Astrobox "NB Calendário_Semanal" + 3 recortes por nível: N2-N3/N4-N5/N6+). Usada SÓ na aba
// Semanal Sales (decisão explícita do Gabriel, 13/08/2026) — a Semanal Área continua com
// `reforecastSemanal` acima, sem mudança. Export manual, mesmo padrão de sales_goals.csv/
// sales_infos.csv (sem integração com scripts/atualizar_dados.py) — reexportar os 4 arquivos
// só quando o reforecast oficial for revisado (raro, ~1x/ano segundo o Gabriel); enquanto isso
// não muda, os arquivos continuam valendo. Só tem quebra por NÍVEL, não por Estratégia — por
// isso o index.html trava o filtro de Estratégia em "Todas" enquanto Referência=Reforecast
// estiver selecionado na Semanal Sales.
function parseSemanaCalendario(s) { // '26W01 (01/01)' -> '2026-W01' (mesma regra de semana do resto do projeto)
  const m = /^(\d{2})W(\d{2})/.exec((s || '').trim());
  return m ? ('20' + m[1] + '-W' + m[2]) : null;
}
function readCalendarioSemanal(name) {
  const out = {};
  for (const r of readCsvOptional(name)) {
    const w = parseSemanaCalendario(r.Semana); if (!w) continue;
    // Contacted..SAP vêm em decimal com vírgula (numBr, mesmo formato de f_budget_daily.csv);
    // só GMV/Net Revenue vêm em "R$ X.XXX.XXX" (money, mesmo formato de budget_oficial.csv) —
    // formato misto específico deste export, confirmado linha a linha na amostra que o Gabriel mandou.
    out[w] = {
      contacted: numBr(r.Contacted), connected: numBr(r.Connected), opps: numBr(r.Opps),
      sql: numBr(r.SQL), cw: numBr(r.CW), activation: numBr(r.Activation),
      sap: numBr(r.SAP), gmv: money(r.GMV), receita: money(r['Net Revenue']),
    };
  }
  return out;
}
// porEstrategia/porNivelEstrategia por PROPORÇÃO (14/08/2026, a pedido do Gabriel) — a base
// oficial da Astrobox só tem Total/Nível, não Estratégia. Em vez de tentar adivinhar a fórmula
// exata de calendário útil da Ops (pode ter alguma regra de feriado não documentada), uso a
// proporção REAL já validada entre semana e mês — que já temos dos dois lados (semanal vem da
// Astrobox, mensal vem de reforecast_oficial.csv/budget_oficial.csv, ambos já carregados) — e
// aplico essa mesma proporção em cima do valor mensal por Estratégia/Nível×Estratégia (o
// mensal já tem essa quebra, só nunca tinha sido usada na visão semanal). Garantia
// matemática: como porEstrategia soma pro total dentro do mês (por construção de
// buildMensal), a soma das estratégias×proporção também soma pro total semanal oficial — não
// é uma estimativa solta, é uma repartição proporcional de um número que já bate. Assume que
// a distribuição de dias úteis no mês é igual pra todas as estratégias/níveis (razoável —
// feriado é da empresa inteira, não varia por segmento de cliente ou motor de aquisição).
//
// Função genérica (14/08/2026) — reaproveitada pra reforecast E budget, mesmo tratamento nos
// dois: lê os 4 CSVs de calendário semanal (total + 3 níveis), monta {total,porNivel} por
// semana e deriva porEstrategia/porNivelEstrategia por proporção em cima do mensal oficial
// correspondente (reforecastMensal ou budgetMensal).
const safeDiv = (a, b) => b ? a / b : 0;
function buildSemanalOficialComEstrategia(prefixo, mensalObj) {
  const calTotal = readCalendarioSemanal(prefixo + '_total.csv');
  const calPorNivel = {
    'N2-N3': readCalendarioSemanal(prefixo + '_n2n3.csv'),
    'N4-N5': readCalendarioSemanal(prefixo + '_n4n5.csv'),
    'N6+': readCalendarioSemanal(prefixo + '_n6mais.csv'),
  };
  const out = {}; // week -> {total, porNivel, porEstrategia, porNivelEstrategia}
  for (const w in calTotal) {
    const cell = { total: calTotal[w], porNivel: {} };
    for (const niv of NIVEIS) if (calPorNivel[niv][w]) cell.porNivel[niv] = calPorNivel[niv][w];
    out[w] = cell;
  }
  for (const w in out) {
    const mk = semanaMes[w], mCell = mensalObj[mk], wCell = out[w];
    if (!mCell) continue;
    const ratioTot = {}; METRICS.forEach(m => ratioTot[m] = safeDiv(wCell.total[m], mCell.total[m]));
    wCell.porEstrategia = {};
    for (const es of ESTRS) {
      const mEst = mCell.porEstrategia[es]; if (!mEst) continue;
      const cellOut = {}; METRICS.forEach(m => cellOut[m] = mEst[m] * ratioTot[m]);
      wCell.porEstrategia[es] = cellOut;
    }
    wCell.porNivelEstrategia = {};
    for (const niv of NIVEIS) {
      const mNiv = mCell.porNivel[niv], wNiv = wCell.porNivel[niv];
      if (!mNiv || !wNiv) continue;
      const ratioNiv = {}; METRICS.forEach(m => ratioNiv[m] = safeDiv(wNiv[m], mNiv[m]));
      const mCellNivEst = mCell.porNivelEstrategia[niv] || {};
      wCell.porNivelEstrategia[niv] = {};
      for (const es of ESTRS) {
        const mNE = mCellNivEst[es]; if (!mNE) continue;
        const cellOut = {}; METRICS.forEach(m => cellOut[m] = mNE[m] * ratioNiv[m]);
        wCell.porNivelEstrategia[niv][es] = cellOut;
      }
    }
  }
  return out;
}
const reforecastSemanalOficial = buildSemanalOficialComEstrategia('reforecast_semanal', reforecastMensal);
// 14/08/2026, a pedido do Gabriel: mesmo tratamento pro Budget — base oficial de calendário
// útil real (Astrobox "NB BU Brasil | Calendário_Semanal [budget]" + 3 recortes por nível),
// substituindo a comparação seg-sex só na Semanal Sales. Diferente do reforecast, o Budget
// semanal JÁ tinha uma fonte real por dia (f_budget_daily.csv/budgetSemanal) — essa nova base
// não substitui `budgetSemanal` (que continua alimentando a Semanal Área, sem mudança), é uma
// fonte PARALELA usada só pela Semanal Sales. Investigação (ver Pendencias/README.md
// 14/08/2026): a comparação mês a mês entre as duas fontes semanais de budget mostrava
// divergência de até 24%, mas era um artefato de fronteira mês×semana na hora de AGRUPAR
// semanas num mês pra validação — não um problema no dado (a soma do ano inteiro bate). Esse
// mesmo artefato existia no reforecast e foi corrigido de vez trocando a fonte da meta do MTD
// pra vir direto do mensal (ver renderSemanal() em index.html) — não depende de nenhuma
// convenção de fronteira específica da Astrobox.
const budgetSemanalOficial = buildSemanalOficialComEstrategia('budget_semanal', budgetMensal);

const sdrLeads = fop.filter(r => isRealSdr(cleanEmail(r.owner_email)) && leadFlowOk(r) && leadBrOk(r)).map(r => ({
  estr: estr(r.sales_strategy), owner: cleanEmail(r.owner_email),
  contacted: cleanDate(r.contacted_date), connected: cleanDate(r.connected_date),
  nurturing: cleanDate(r.nurturing_date), qualified: cleanDate(r.qualified_date),
  unqualified: cleanDate(r.unqualified_date), opp: cleanDate(r.opportunity_create_date),
})).filter(l => l.contacted); // estoque da página = só leads de SDR real, sem PQL/PPQL/Seed1-2
const dataMax = dataMaxRaw && dataMaxRaw <= hojeStr ? dataMaxRaw : hojeStr; // capa no dia de hoje
const ESTOQUE_KEYS = ['all', ...ESTRS];
const sdrEstoque = {}; ESTOQUE_KEYS.forEach(k => sdrEstoque[k] = []); // estr -> [{semana,contacted,connected,nurturing}]
for (const w of semanas) {
  const startStr = weekStartUTC(w).toISOString().slice(0, 10);
  if (startStr > hojeStr) continue;              // semana totalmente no futuro (só budget as tem)
  let T = weekEndUTC(w).toISOString().slice(0, 10);
  if (T > hojeStr) T = hojeStr;                  // semana EM CURSO: snapshot até hoje
  const acc = {}; ESTOQUE_KEYS.forEach(k => acc[k] = { contacted: 0, connected: 0, nurturing: 0 });
  for (const l of sdrLeads) {
    if (l.contacted > T) continue;                                  // ainda não contatado até T
    if ((l.opp && l.opp <= T) || (l.qualified && l.qualified <= T) || (l.unqualified && l.unqualified <= T)) continue; // saiu do funil SDR
    let best = l.contacted, stage = 'contacted';                    // etapa SDR mais recente até T
    if (l.connected && l.connected <= T && l.connected >= best) { best = l.connected; stage = 'connected'; }
    if (l.nurturing && l.nurturing <= T && l.nurturing >= best) { best = l.nurturing; stage = 'nurturing'; }
    acc.all[stage]++;
    if (l.estr) acc[l.estr][stage]++;
  }
  ESTOQUE_KEYS.forEach(k => sdrEstoque[k].push({ semana: w, ...acc[k] }));
}
// mesmo estoque acima, por PESSOA (owner do lead) — alimenta o gráfico de Estoque no 1:1
// Gestor (05/08/2026, a pedido do Gabriel). Mesma regra de entrada/saída do estoque de SDR,
// só que a chave é o dono do lead em vez de estratégia/nível.
const sdrOwnersReais = [...new Set(sdrLeads.map(l => l.owner).filter(Boolean))];
const sdrEstoquePessoa = {}; sdrOwnersReais.forEach(o => sdrEstoquePessoa[o] = []); // owner -> [{semana,contacted,connected,nurturing}]
for (const w of semanas) {
  const startStr = weekStartUTC(w).toISOString().slice(0, 10);
  if (startStr > hojeStr) continue;
  let T = weekEndUTC(w).toISOString().slice(0, 10);
  if (T > hojeStr) T = hojeStr;
  const acc = {}; sdrOwnersReais.forEach(o => acc[o] = { contacted: 0, connected: 0, nurturing: 0 });
  for (const l of sdrLeads) {
    if (!l.owner) continue;
    if (l.contacted > T) continue;
    if ((l.opp && l.opp <= T) || (l.qualified && l.qualified <= T) || (l.unqualified && l.unqualified <= T)) continue;
    let best = l.contacted, stage = 'contacted';
    if (l.connected && l.connected <= T && l.connected >= best) { best = l.connected; stage = 'connected'; }
    if (l.nurturing && l.nurturing <= T && l.nurturing >= best) { best = l.nurturing; stage = 'nurturing'; }
    acc[l.owner][stage]++;
  }
  sdrOwnersReais.forEach(o => sdrEstoquePessoa[o].push({ semana: w, ...acc[o] }));
}
// SDRs distintos que geraram opp por semana (por estratégia) — denominador do "Opps / FTE"
const sdrOppFte = { all: {}, Outbound: {}, Inbound: {}, Hunting: {} };
for (const k of ESTOQUE_KEYS) for (const w in sdrOppFteSet[k]) sdrOppFte[k][w] = sdrOppFteSet[k][w].size;
const sdrContactFte = { all: {}, Outbound: {}, Inbound: {}, Hunting: {} };
for (const k of ESTOQUE_KEYS) for (const w in sdrContactFteSet[k]) sdrContactFte[k][w] = sdrContactFteSet[k][w].size;
// opps por nível × semana (por estratégia), já acumulado no loop SÓ com SDR real (página).
const sdrOppsNivel = sdrOppsNivelAcc;
// closers distintos que receberam opp / que fecharam (CW) por semana — denominador do
// "Opp/FTE" e "CW/FTE" do Closer.
const closerOppFte = blankKeys(CO_KEYS);
for (const k of CO_KEYS) for (const w in closerOppFteSet[k]) closerOppFte[k][w] = closerOppFteSet[k][w].size;
const closerCwFte = blankKeys(CO_KEYS);
for (const k of CO_KEYS) for (const w in closerCwFteSet[k]) closerCwFte[k][w] = closerCwFteSet[k][w].size;
// onboarders distintos que receberam CW / que ativaram 10k por semana — denominador do
// "CW/FTE" e "Ativado/FTE" do Onboarding.
const onbCwFte = blankKeys(CO_KEYS);
for (const k of CO_KEYS) for (const w in onbCwFteSet[k]) onbCwFte[k][w] = onbCwFteSet[k][w].size;
const onbActFte = blankKeys(CO_KEYS);
for (const k of CO_KEYS) for (const w in onbActFteSet[k]) onbActFte[k][w] = onbActFteSet[k][w].size;

// ---------- ESTOQUE DO FUNIL CLOSER (snapshot no FIM de cada semana) ----------
// Mesmo conceito do estoque de SDR, aplicado ao funil de negociação: quantos leads (que já
// viraram opp) estão parados em cada etapa — Opp / SQL / Offer / Contract — no fim de cada
// semana. Sai do estoque ao fechar (Closed Won) ou perder (Lost Deal).
const closerLeads = fop.filter(r => isRealCloser(cleanEmail(r.closer_email_sf)) && oppValidOk(r)).map(r => ({
  estr: estr(r.sales_strategy), nivel: bucketFromAmount(r.amount_12_months), closer: cleanEmail(r.closer_email_sf),
  opp: cleanDate(r.opportunity_create_date), issues: cleanDate(r.issues_identified_date), sql: cleanDate(r.sql_date),
  offer: cleanDate(r.offer_presented_date), contract: cleanDate(r.contract_sent_date),
  cw: cleanDate(r.closed_won_date), lost: cleanDate(r.lost_deal_date),
})).filter(l => l.opp); // só quem virou opp entra no estoque de closer, só Closer real e opp válida/BR
const closerEstoque = {}; CO_KEYS.forEach(k => closerEstoque[k] = []); // estr/nível -> [{semana,opp,issues,sql,offer,contract}]
for (const w of semanas) {
  const startStr = weekStartUTC(w).toISOString().slice(0, 10);
  if (startStr > hojeStr) continue;
  let T = weekEndUTC(w).toISOString().slice(0, 10);
  if (T > hojeStr) T = hojeStr;
  const acc = {}; CO_KEYS.forEach(k => acc[k] = { opp: 0, issues: 0, sql: 0, offer: 0, contract: 0 });
  for (const l of closerLeads) {
    if (l.opp > T) continue;                                          // ainda não virou opp até T
    if ((l.cw && l.cw <= T) || (l.lost && l.lost <= T)) continue;      // fechou (ganhou ou perdeu) — saiu do estoque
    let best = l.opp, stage = 'opp';                                  // etapa mais recente até T
    if (l.issues && l.issues <= T && l.issues >= best) { best = l.issues; stage = 'issues'; }
    if (l.sql && l.sql <= T && l.sql >= best) { best = l.sql; stage = 'sql'; }
    if (l.offer && l.offer <= T && l.offer >= best) { best = l.offer; stage = 'offer'; }
    if (l.contract && l.contract <= T && l.contract >= best) { best = l.contract; stage = 'contract'; }
    acc.all[stage]++;
    if (l.estr) acc[l.estr][stage]++;
    if (l.nivel && NIVEIS.includes(l.nivel)) acc[l.nivel][stage]++;
  }
  CO_KEYS.forEach(k => closerEstoque[k].push({ semana: w, ...acc[k] }));
}
// mesmo estoque acima, por PESSOA (closer) — alimenta o gráfico de Estoque no 1:1 Gestor
// (05/08/2026, a pedido do Gabriel). Mesma regra de entrada/saída, chave = closer_email_sf.
const closersReais = [...new Set(closerLeads.map(l => l.closer).filter(Boolean))];
const closerEstoquePessoa = {}; closersReais.forEach(o => closerEstoquePessoa[o] = []); // closer -> [{semana,opp,issues,sql,offer,contract}]
for (const w of semanas) {
  const startStr = weekStartUTC(w).toISOString().slice(0, 10);
  if (startStr > hojeStr) continue;
  let T = weekEndUTC(w).toISOString().slice(0, 10);
  if (T > hojeStr) T = hojeStr;
  const acc = {}; closersReais.forEach(o => acc[o] = { opp: 0, issues: 0, sql: 0, offer: 0, contract: 0 });
  for (const l of closerLeads) {
    if (!l.closer) continue;
    if (l.opp > T) continue;
    if ((l.cw && l.cw <= T) || (l.lost && l.lost <= T)) continue;
    let best = l.opp, stage = 'opp';
    if (l.issues && l.issues <= T && l.issues >= best) { best = l.issues; stage = 'issues'; }
    if (l.sql && l.sql <= T && l.sql >= best) { best = l.sql; stage = 'sql'; }
    if (l.offer && l.offer <= T && l.offer >= best) { best = l.offer; stage = 'offer'; }
    if (l.contract && l.contract <= T && l.contract >= best) { best = l.contract; stage = 'contract'; }
    acc[l.closer][stage]++;
  }
  closersReais.forEach(o => closerEstoquePessoa[o].push({ semana: w, ...acc[o] }));
}

// ---------- ESTOQUE DE ATIVAÇÃO (Onboarding) — snapshot no FIM de cada semana ----------
// 01/08→03/08/2026, a pedido do Gabriel: reclassificado em 3 faixas — nuncaVendeu (CW sem
// nenhum GMV, nunca chegou nem em 1k) / vendendo (já tem GMV — 1k ou 5k — mas ainda não é
// "ativo") / ativo (activation_date_10k preenchida). Sai do estoque SÓ por
// accomplished/unaccomplished (mesmo papel do "Onboarding_close_date" do Power BI —
// COALESCE(accomplished_date, unaccomplished_date)) — ativar 10k NÃO tira mais do estoque
// (antes tirava; agora "ativo" é uma faixa que fica ali até fechar accomplished/unaccomplished).
// Contagem por opp_id (não lead_id), igual à métrica de referência.
const onbLeadsMap = new Map();
for (const r of fop) {
  const cw = cleanDate(r.closed_won_date); if (!cw) continue;
  // onboarding_owner_email_atual (10/08/2026): dono ATUAL do registro de onboarding no
  // Salesforce — pode ser diferente de onboarding_email_sf (dono da OPORTUNIDADE, congelado
  // desde a criação) quando o caso foi reatribuído depois. Usado SÓ aqui (Carteira/Estoque
  // atual) — o resto do build_data.js (coorte semanal, ranking, produtividade) continua com
  // onboarding_email_sf puro, porque ali o que importa é quem fez o trabalho NA ÉPOCA, não
  // quem é o dono hoje. Validado contra a planilha de referência: sem isso, 11 dos 551 clientes
  // apareciam com o onboarder errado na Carteira atual.
  const onbEmailRaw = cleanEmail(r.onboarding_owner_email_atual) || cleanEmail(r.onboarding_email_sf);
  // isRealOnboarder (10/08/2026): exclui leads presos com um onboarder que já saiu do time (o
  // e-mail continua no campo onboarding_email_sf mas ninguém mais trabalha aquele lead) — ver
  // comentário perto de rosterOnboarding, acima.
  if (!onbEmailRaw || !oppValidOk(r) || !leadFlowOkOnb(r) || !isRealOnboarder(onbEmailRaw)) continue; // filtros do Power BI
  const oppId = (r.opp_id || '').trim(); if (!oppId || onbLeadsMap.has(oppId)) continue;
  // Onboarding_close_date (DAX do Power BI): accomplished_date se preenchido, senão
  // unaccomplished_date, senão "nunca" — accomplished tem prioridade (não é o menor dos dois).
  // onbCloseInfo (10/08/2026) cobre os dois fallbacks (status certo sem data + timeout de 90
  // dias sem status nenhum) — ver comentário na função, perto do topo do arquivo.
  const ci = onbCloseInfo(r, cw);
  onbLeadsMap.set(oppId, {
    oppId, onb: onbEmailRaw, estr: estr(r.sales_strategy), nivel: bucketFromAmount(r.amount_12_months), cw, close: ci.close,
    accomp: ci.accomp, unaccomp: ci.unaccomp, accompFallback: ci.accompFallback, unaccompFallback: ci.unaccompFallback,
    a1k: cleanDate(r.activation_date_1k), a5k: cleanDate(r.activation_date_5k), a10k: cleanDate(r.activation_date_10k),
    // status GRANULAR real da fonte (Pre Onboarding/Contacted/.../Ready for Activation/Activation
    // & Monitoring/Accomplished/Unaccomplished) — diferente da classificação simplificada em 3
    // faixas (nuncaVendeu/vendendo/ativo) usada no gráfico de Estoque. Guardado aqui pra
    // homologação (10/08/2026, a pedido do Gabriel): tabela por onboarder × status real.
    status: ci.status || null,
    lastOnboardingDate: cleanDate(r.last_onboarding_date),
  });
}
const onbLeads = [...onbLeadsMap.values()];
const onbEstoque = {}; CO_KEYS.forEach(k => onbEstoque[k] = []); // estr/nível -> [{semana,nuncaVendeu,vendendo,ativo}]
for (const w of semanas) {
  const startStr = weekStartUTC(w).toISOString().slice(0, 10);
  if (startStr > hojeStr) continue;
  let T = weekEndUTC(w).toISOString().slice(0, 10);
  if (T > hojeStr) T = hojeStr;
  const acc = {}; CO_KEYS.forEach(k => acc[k] = { nuncaVendeu: 0, vendendo: 0, ativo: 0 });
  for (const l of onbLeads) {
    if (l.cw > T) continue;                                 // ainda não fechou até T
    if (l.close && l.close <= T) continue;                   // accomplished/unaccomplished até T — ÚNICA saída do estoque
    let stage;
    if (l.a10k && l.a10k <= T) stage = 'ativo';                                       // já ativou 10k
    else if ((l.a1k && l.a1k <= T) || (l.a5k && l.a5k <= T)) stage = 'vendendo';      // já tem GMV (1k ou 5k), ainda não é ativo
    else stage = 'nuncaVendeu';                                                       // CW sem nenhum GMV ainda
    acc.all[stage]++;
    if (l.estr) acc[l.estr][stage]++;
    if (l.nivel && NIVEIS.includes(l.nivel)) acc[l.nivel][stage]++;
  }
  CO_KEYS.forEach(k => onbEstoque[k].push({ semana: w, ...acc[k] }));
}
// mesmo estoque acima, por PESSOA (onboarder) — alimenta o gráfico de Estoque no 1:1 Gestor
// (05/08/2026, a pedido do Gabriel). Mesma regra de entrada/saída, chave = onboarding_email_sf.
// Nome diferente de onbEstoquePorPessoa (que é o TOTAL atual, sem série por semana — ver seção
// de validação mais abaixo) pra não colidir.
const onboardersReais = [...new Set(onbLeads.map(l => l.onb).filter(Boolean))];
const onbEstoqueSemanalPorPessoa = {}; onboardersReais.forEach(o => onbEstoqueSemanalPorPessoa[o] = []); // onb -> [{semana,nuncaVendeu,vendendo,ativo}]
for (const w of semanas) {
  const startStr = weekStartUTC(w).toISOString().slice(0, 10);
  if (startStr > hojeStr) continue;
  let T = weekEndUTC(w).toISOString().slice(0, 10);
  if (T > hojeStr) T = hojeStr;
  const acc = {}; onboardersReais.forEach(o => acc[o] = { nuncaVendeu: 0, vendendo: 0, ativo: 0 });
  for (const l of onbLeads) {
    if (!l.onb) continue;
    if (l.cw > T) continue;
    if (l.close && l.close <= T) continue;
    let stage;
    if (l.a10k && l.a10k <= T) stage = 'ativo';
    else if ((l.a1k && l.a1k <= T) || (l.a5k && l.a5k <= T)) stage = 'vendendo';
    else stage = 'nuncaVendeu';
    acc[l.onb][stage]++;
  }
  onboardersReais.forEach(o => onbEstoqueSemanalPorPessoa[o].push({ semana: w, ...acc[o] }));
}

// dias úteis (seg-sex) já DECORRIDOS em cada semana até hoje — pra "produtividade por dia
// útil" (Contacted/FTE e Opps/FTE por dia). Semana fechada = 5 (ou menos, se for a semana 1
// parcial); semana em curso = só os dias úteis que já passaram; semana futura = não entra.
function businessDaysBetweenUTC(start, end) {
  let n = 0; const d = new Date(start);
  while (d <= end) { const dow = d.getUTCDay(); if (dow !== 0 && dow !== 6) n++; d.setUTCDate(d.getUTCDate() + 1); }
  return n;
}
const hojeDate = new Date(hojeStr + 'T00:00:00Z');
const diasUteisSemana = {};
for (const w of semanas) {
  const start = weekStartUTC(w);
  if (start > hojeDate) continue; // semana totalmente futura — sem dia útil decorrido ainda
  const end = weekEndUTC(w) > hojeDate ? hojeDate : weekEndUTC(w);
  diasUteisSemana[w] = businessDaysBetweenUTC(start, end);
}

// ---------- CICLO (médias simples por lead, direto do unpivot acima) ----------
const avg = arr => arr.length ? +(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1) : null;
const ciclo = {
  dias_contato_conectado: avg(cicloAcc.dias_contato_conectado),
  dias_conectado_opp: avg(cicloAcc.dias_conectado_opp),
  dias_opp_sql: avg(cicloAcc.dias_opp_sql),
  dias_sql_won: avg(cicloAcc.dias_sql_won),
  dias_won_ativacao: avg(cicloAcc.dias_won_ativacao),
};

// ---------- RANKING (closer/owner, direto do unpivot acima) ----------
const ranking = {
  closers: Object.values(rankCw).sort((a, b) => b.cw - a.cw).slice(0, 12),
  owners: Object.values(rankOwner).sort((a, b) => b.cw - a.cw).slice(0, 12),
  sdrs: null,
};

// ---------- DIRETÓRIO DE PESSOAS (nome + foto, opcional) ----------
// Fontes já lidas acima (infoPorEmail/cargoPorEmail), pra alimentar o roster de "SDR/Closer/
// Onboarding real" — reaproveitadas aqui pra montar nome/foto/cargo por pessoa. Se
// sales_infos.csv faltar, nome/foto ficam null e a interface cai de volta pro prefixo do e-mail
// (sem foto); cargo continua vindo de sales_goals.csv independente disso.
const diretorio = {};
const todosEmailsDiretorio = new Set([...Object.keys(cargoPorEmail), ...Object.keys(infoPorEmail)]);
todosEmailsDiretorio.forEach(email => {
  const info = infoPorEmail[email] || {};
  diretorio[email] = { nome: info.nome || null, foto: info.foto || null, ativo: info.ativo === true, cargo: cargoPorEmail[email] || '' };
});
// cargoEsperado (opcional): além de Ativo=Sim, exige que o Cargo atual no diretório bata com o
// papel da lista (SDR/Closer/Onboarding) — usado pelo 1:1 Gestor (30/07/2026) pra não mostrar,
// por ex., o Olivio/Lucas Guerrero (incluídos manualmente no funil histórico de SDR via
// SDR_MANUAL_INCLUI) como se ainda fossem SDR hoje: o Cargo deles no diretório já é "Closer".
function enrichPessoa(p, cargoEsperado) {
  const d = diretorio[p.email.toLowerCase()];
  p.nome = d?.nome || null;
  p.foto = d?.foto || null;
  p.ativo = d?.ativo === true && (!cargoEsperado || d?.cargo === cargoEsperado); // "Sim" + Cargo atual bate com o papel (sem match = inativo)
  return p;
}

// porSemana por pessoa: mesmas métricas do total, só que uma célula por semana — alimenta
// a Semanal Área quando o usuário filtra por uma semana específica em vez do acumulado.
function buildPessoaSemanaSdr(p) {
  const out = {};
  for (const w in (p.porSemana || {})) {
    const pw = p.porSemana[w];
    out[w] = {
      contacted: Math.round(pw.contacted || 0), connected: Math.round(pw.connected || 0), opps: Math.round(pw.opps || 0),
      contactRate: pw.contacted ? +(pw.connected / pw.contacted).toFixed(3) : null,
      // coorte: dos contatados NESSA semana, quantos conectaram na MESMA semana (não throughput).
      cohortRate: pw.cohContacted ? +(pw.cohConn / pw.cohContacted).toFixed(3) : null,
      oppNivel: NIVEIS.map(n => Math.round((pw.oppNivel || {})[n] || 0)),
      diasContatoConectado: pw.dCCn ? +(pw.dCCsum / pw.dCCn).toFixed(1) : null,
      // das opps geradas NESSA semana, quantas (essa mesma opp) já chegaram a SQL — acumulado
      // até hoje, não coorte de mesma semana (alimenta "Opp→SQL · 5s" na tabela por pessoa).
      oppSql: Math.round(pw.oppSql || 0),
    };
  }
  return out;
}
function buildPessoaSemanaCloser(p) {
  const out = {};
  for (const w in (p.porSemana || {})) {
    const pw = p.porSemana[w];
    out[w] = {
      opps: Math.round(pw.opps || 0), sql: Math.round(pw.sql || 0), cw: Math.round(pw.cw || 0),
      sqlRate: pw.opps ? +(pw.sql / pw.opps).toFixed(3) : null,
      winRate: pw.sql ? +(pw.cw / pw.sql).toFixed(3) : null,
      cwNivel: NIVEIS.map(n => Math.round((pw.cwNivel || {})[n] || 0)),
      diasOppSql: pw.dOSn ? +(pw.dOSsum / pw.dOSn).toFixed(1) : null,
      diasSqlWon: pw.dSWn ? +(pw.dSWsum / pw.dSWn).toFixed(1) : null,
      // coorte: dos que viraram opp NESSA semana, quantos chegaram a SQL na MESMA semana.
      cohOpp: Math.round(pw.cohOpp || 0), cohSql: Math.round(pw.cohSql || 0),
      // das opps recebidas NESSA semana, quantas (essa mesma opp) já chegaram a CW — acumulado
      // até hoje, não coorte de mesma semana (alimenta "Opp→CW · 5s" na tabela por pessoa).
      oppCw: Math.round(pw.oppCw || 0),
    };
  }
  return out;
}
function buildPessoaSemanaOnb(p) {
  const out = {};
  for (const w in (p.porSemana || {})) {
    const pw = p.porSemana[w];
    out[w] = {
      cwIn: Math.round(pw.cwIn || 0), activated: Math.round(pw.activated || 0),
      actRate: pw.cwIn ? +(pw.activated / pw.cwIn).toFixed(3) : null,
      actNivel: NIVEIS.map(n => Math.round((pw.actNivel || {})[n] || 0)),
      diasWonAtivacao: pw.dWAn ? +(pw.dWAsum / pw.dWAn).toFixed(1) : null,
      // coorte: dos que fecharam (CW) NESSA semana, quantos chegaram a 1k na MESMA semana.
      cohCw: Math.round(pw.cohCw || 0), coh1k: Math.round(pw.coh1k || 0),
      // dos CWs recebidos NESSA semana, quantos (esse mesmo CW) já ativaram 10k — acumulado até
      // hoje, não coorte de mesma semana (alimenta "CW→10K · 5s" na tabela por pessoa).
      cwAct10k: Math.round(pw.cwAct10k || 0),
    };
  }
  return out;
}

// ---------- PESSOAS (SDR / Closer / Onboarding) ----------
const sdrList = Object.values(porPessoaSdr).map(p => enrichPessoa({
  email: p.email, estrategia: p.estrategia || null,
  contacted: Math.round(p.contacted || 0), connected: Math.round(p.connected || 0), opps: Math.round(p.opps || 0),
  contactRate: p.contacted ? +(p.connected / p.contacted).toFixed(3) : null,
  diasContatoConectado: p._dCCn ? +(p._dCCsum / p._dCCn).toFixed(1) : null,
  oppNivel: NIVEIS.map(n => Math.round((p.oppNivel || {})[n] || 0)),
  metricaSemanal: 'opps', semanal: last4Weekly(p.semanal, semanas),
  porSemana: buildPessoaSemanaSdr(p),
}, 'SDR')).sort((a, b) => b.opps - a.opps);

const closerList = Object.values(porPessoaCloser).map(p => enrichPessoa({
  email: p.email, estrategia: p.estrategia || null, nivel: nivelPorCloser[p.email.toLowerCase()] || null,
  opps: Math.round(p.opps || 0), sql: Math.round(p.sql || 0), cw: Math.round(p.cw || 0),
  sqlRate: p.opps ? +(p.sql / p.opps).toFixed(3) : null,
  winRate: p.sql ? +(p.cw / p.sql).toFixed(3) : null,
  diasOppSql: p._dOSn ? +(p._dOSsum / p._dOSn).toFixed(1) : null,
  diasSqlWon: p._dSWn ? +(p._dSWsum / p._dSWn).toFixed(1) : null,
  cwNivel: NIVEIS.map(n => Math.round((p.cwNivel || {})[n] || 0)),
  metricaSemanal: 'cw', semanal: last4Weekly(p.semanal, semanas),
  porSemana: buildPessoaSemanaCloser(p),
}, 'Closer')).sort((a, b) => b.cw - a.cw);

const onbList = Object.values(porPessoaOnb).map(p => enrichPessoa({
  email: p.email, estrategia: p.estrategia || null, nivel: nivelPorOnboarder[p.email.toLowerCase()] || null,
  cwIn: Math.round(p.cwIn || 0), activated: Math.round(p.activated || 0),
  actRate: p.cwIn ? +(p.activated / p.cwIn).toFixed(3) : null,
  diasWonAtivacao: p._dWAn ? +(p._dWAsum / p._dWAn).toFixed(1) : null,
  actNivel: NIVEIS.map(n => Math.round((p.actNivel || {})[n] || 0)),
  metricaSemanal: 'activated', semanal: last4Weekly(p.semanal, semanas),
  porSemana: buildPessoaSemanaOnb(p),
}, 'Onboarding')).sort((a, b) => b.activated - a.activated);

// ---------- TELA TEMPORÁRIA DE HOMOLOGAÇÃO (03/08/2026) ----------
// Snapshot do Estoque de ativação POR ONBOARDER, na data de HOJE (não por semana) — só pra
// validar manualmente a reclassificação nunca vendeu/vendendo/ativo (ver onbEstoque acima),
// contra o que o time já sabe da operação. Mesma lógica de classificação, T fixo = hoje.
// ⚠️ Tirar do app_data.js depois que a homologação terminar (não faz parte do dashboard).
// Campo é "ativos" (plural), não "ativo" — enrichPessoa já usa "ativo" (singular) pro status
// de Ativo=Sim no roster; um sobrescrevia o outro (bug pego no teste, contagem virava true/false).
const onbEstoquePorPessoaMap = {};
// tabela por onboarder × status REAL do funil (10/08/2026, a pedido do Gabriel) — mesma
// população do estoque (CW até hoje, ainda sem accomplished/unaccomplished), mas contada pelo
// `onboarding_status` granular da fonte em vez da faixa simplificada nuncaVendeu/vendendo/ativo.
// Serve pra homologar se a simplificação do gráfico "Estoque de ativação" bate com a realidade
// operacional (ver Pendencias/README.md item 19 — investigação da carteira inflada).
const ONB_STATUS_ORDEM = ['Pre Onboarding', 'Contacted', 'Connected', 'Welcome', 'Product Migration', 'Ready for Activation', 'Activation & Monitoring', 'Accomplished', 'Unaccomplished'];
const onbEstoquePorPessoaStatusMap = {};
for (const l of onbLeads) {
  if (!l.onb) continue;
  if (l.cw > hojeStr) continue;                                 // ainda não fechou até hoje
  if (l.close && l.close <= hojeStr) continue;                  // já saiu do estoque (accomplished/unaccomplished)
  let stage;
  if (l.a10k && l.a10k <= hojeStr) stage = 'ativos';
  else if ((l.a1k && l.a1k <= hojeStr) || (l.a5k && l.a5k <= hojeStr)) stage = 'vendendo';
  else stage = 'nuncaVendeu';
  const p = onbEstoquePorPessoaMap[l.onb] || (onbEstoquePorPessoaMap[l.onb] = { email: l.onb, nuncaVendeu: 0, vendendo: 0, ativos: 0 });
  p[stage]++;
  const statusKey = l.status && ONB_STATUS_ORDEM.includes(l.status) ? l.status : 'Outros/vazio';
  const ps = onbEstoquePorPessoaStatusMap[l.onb] || (onbEstoquePorPessoaStatusMap[l.onb] = { email: l.onb });
  ps[statusKey] = (ps[statusKey] || 0) + 1;
}
const onbEstoquePorPessoa = Object.values(onbEstoquePorPessoaMap)
  .map(p => enrichPessoa({ ...p, total: p.nuncaVendeu + p.vendendo + p.ativos }))
  .sort((a, b) => b.total - a.total);
const onbEstoquePorPessoaStatus = Object.values(onbEstoquePorPessoaStatusMap)
  .map(p => enrichPessoa({ ...p, total: [...ONB_STATUS_ORDEM, 'Outros/vazio'].reduce((s, k) => s + (p[k] || 0), 0) }))
  .sort((a, b) => b.total - a.total);
// registro por registro (opp_id) — pro dropdown de validação individual da tela temporária:
// mesma classificação de hoje, mas com as datas cruas visíveis, pra rastrear um caso específico.
// Escrito num arquivo À PARTE (validacao_onboarding_data.js, não app_data.js) — são ~4-5 mil
// registros, não faz sentido inflar o app_data.js principal (que o dashboard inteiro carrega)
// com dado que só a tela de homologação usa.
const onbLeadsValidacao = onbLeads.filter(l => l.onb).map(l => {
  const saiu = l.close && l.close <= hojeStr;
  let situacao;
  if (saiu) situacao = 'saiu (accomplished/unaccomplished)';
  else if (l.a10k && l.a10k <= hojeStr) situacao = 'ativos';
  else if ((l.a1k && l.a1k <= hojeStr) || (l.a5k && l.a5k <= hojeStr)) situacao = 'vendendo';
  else situacao = 'nuncaVendeu';
  return {
    oppId: l.oppId, onbEmail: l.onb, onbNome: diretorio[l.onb.toLowerCase()]?.nome || null,
    estr: l.estr, nivel: l.nivel, cw: l.cw,
    a1k: l.a1k, a5k: l.a5k, a10k: l.a10k, accomp: l.accomp, unaccomp: l.unaccomp, accompFallback: l.accompFallback, unaccompFallback: l.unaccompFallback,
    situacao,
    // status real do funil (10/08/2026) — pro dropdown de filtro por status na tela de validação.
    status: l.status || '(vazio)', lastOnboardingDate: l.lastOnboardingDate,
  };
}).sort((a, b) => (b.cw || '').localeCompare(a.cw || ''));

// ---------- SÉRIES SEMANAIS POR NÍVEL (direto do unpivot acima) ----------
function roundNivelWeek(obj) {
  const out = {};
  for (const w in obj) { out[w] = {}; NIVEIS.forEach(n => out[w][n] = Math.round(obj[w][n] || 0)); }
  return out;
}
const semanalPorNivel = {
  contacted: roundNivelWeek(semContactedNivel),
  opps: roundNivelWeek(semOppNivel),
  cw: roundNivelWeek(semCwNivel),
  activation: roundNivelWeek(semActNivel),
};

// ---------- FTEs por estratégia (produtividade) ----------
const fte = ESTRS.filter(e => fteBy[e]).map(e => ({
  estrategia: e, fte: fteBy[e].sdrs.size,
  contacted: Math.round(fteBy[e].contacted), opps: Math.round(fteBy[e].opps)
}));

// ---------- MÊS FECHADO (para a aba Mensal Sales) ----------
const mesesComActual = Object.keys(actualMensal).sort();
const curMonthKey = new Date().toISOString().slice(0, 7);
let closedIdx = mesesComActual.length - 1;
if (mesesComActual[closedIdx] === curMonthKey) closedIdx--;
const mesFechado = {
  mes: mesesComActual[closedIdx] || null,
  mesAnterior: mesesComActual[closedIdx - 1] || null,
};

// ---------- SEMANA FECHADA (para a aba Semanal Sales) ----------
// Mesma lógica do mesFechado, em semanas: a reunião semanal é toda segunda-feira e revisa a
// semana anterior (a que acabou de fechar) — "semana fechada" = a semana mais recente ANTERIOR
// à semana de HOJE (por data corrida, não "a última semana com dado"), pra ficar estável a
// semana inteira até a virada da próxima segunda.
const semanaAtualKey = anoSemana(hojeStr);
const semanasAsc = [...semanas].sort();
let idxSemFechada = -1;
for (let i = semanasAsc.length - 1; i >= 0; i--) { if (semanasAsc[i] < semanaAtualKey) { idxSemFechada = i; break; } }
const semanaFechada = {
  semana: idxSemFechada >= 0 ? semanasAsc[idxSemFechada] : null,
  semanaAnterior: idxSemFechada >= 1 ? semanasAsc[idxSemFechada - 1] : null,
};

// ---------- OUTPUT ----------
const meses = [...new Set([...Object.keys(actualMensal), ...Object.keys(budgetMensal), ...Object.keys(reforecastMensal)])].sort();
// hora local (não UTC) do build — toISOString() joga pra UTC e erra a hora exibida no banner
// (17/08/2026, a pedido do Gabriel: "Dados atualizados até DD/MM (HH:MM)").
const _agora = new Date();
const _pad2 = n => String(n).padStart(2, '0');
// geradoEmHora é o mtime de 06_operacional_raw.csv, não a hora deste script — o Gabriel corrigiu:
// quer a hora em que scripts/atualizar_dados.py (que baixa os CSVs do Astrobox) rodou por último,
// não a hora em que build_data.js foi disparado (podem ser bem diferentes: build_data.js às vezes
// roda de novo manualmente sem buscar dado novo).
const _fetchDt = fs.statSync(DIR + '06_operacional_raw.csv').mtime;
const DATA = {
  geradoEm: `${_agora.getFullYear()}-${_pad2(_agora.getMonth() + 1)}-${_pad2(_agora.getDate())}`,
  geradoEmHora: `${_pad2(_fetchDt.getHours())}:${_pad2(_fetchDt.getMinutes())}`,
  dataMax,
  meses, semanas, semanaMes, niveis: NIVEIS, estrategias: ESTRS,
  actual: { mensal: actualMensal, semanal: actualSemanal },
  budget: { mensal: budgetMensal, semanal: budgetSemanal, semanalOficial: budgetSemanalOficial },
  reforecast: { mensal: reforecastMensal, semanal: reforecastSemanal, semanalOficial: reforecastSemanalOficial },
  ciclo, ranking,
  porPessoa: { sdr: sdrList, closer: closerList, onboarding: onbList },
  semanalPorNivel,
  fte, fteSemanal,
  sdrEstoque, sdrCohort, sdrOwnerCohort, sdrUnq, sdrOppsNivel, sdrOppFte, sdrCohortStatus, sdrContactFte,
  diasUteisSemana, closerEstoque, onbEstoque,
  closerCohort, closerCohortSqlCw, closerLost, closerCw: closerCwAcc, closerCohortStatus, closerOppFte, closerCwFte,
  onbCohort, onbAct: onbActAcc, onbCohortStatus, onbCwFte, onbActFte,
  mesFechado, semanaFechada,
  onbEstoquePorPessoa, // ⚠️ temporário — homologação do Estoque de ativação (03/08/2026), tirar depois
  onbEstoquePorPessoaStatus, onbStatusOrdem: ONB_STATUS_ORDEM, // ⚠️ temporário — homologação por status real (10/08/2026), tirar depois
  // Estoque/Status por PESSOA (05/08/2026) — alimentam os gráficos por pessoa no 1:1 Gestor,
  // mesmo padrão dos equivalentes por estratégia/nível acima, só que chaveados por e-mail.
  sdrEstoquePessoa, closerEstoquePessoa, onbEstoqueSemanalPorPessoa,
  sdrCohortStatusPessoa, closerCohortStatusPessoa, onbCohortStatusPessoa,
};
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outDir + 'app_data.js', 'window.DATA = ' + JSON.stringify(DATA) + ';');
// ⚠️ arquivo À PARTE, só pra tela de validação (validacao_onboarding_pessoa.html) — não é lido
// pelo app principal (index.html), tirar os dois quando a homologação terminar.
fs.writeFileSync(outDir + 'validacao_onboarding_data.js', 'window.VALIDACAO_ONB = ' + JSON.stringify(onbLeadsValidacao) + ';');
// ⚠️ arquivo À PARTE (23/08/2026, botão "Exportar CSV" do card "Status atual por safra" no
// 1:1 Gestor de SDR) — não é lido pelo app principal fora desse botão, mesmo motivo do
// validacao_onboarding_data.js (não inflar o app_data.js que o dashboard inteiro carrega).
fs.writeFileSync(outDir + 'sdr_leads_data.js', 'window.SDR_LEADS = ' + JSON.stringify(sdrLeadsValidacao) + ';');
console.log('OK app_data.js — meses:', meses.length, '| semanas:', semanas.length, '| leads (operacional_raw):', fop.length);
console.log('OK validacao_onboarding_data.js —', onbLeadsValidacao.length, 'registros (opp_id)');
console.log('OK sdr_leads_data.js —', sdrLeadsValidacao.length, 'registros (lead_id)');
console.log('ultimo mes actual:', Object.keys(actualMensal).sort().pop());
console.log('mes fechado:', mesFechado.mes, '(anterior:', mesFechado.mesAnterior + ')');
console.log('semana fechada:', semanaFechada.semana, '(anterior:', semanaFechada.semanaAnterior + ')');
console.log('pessoas — sdr:', sdrList.length, '| closer:', closerList.length, '| onboarding:', onbList.length);
const comFoto = [...sdrList, ...closerList, ...onbList].filter(p => p.foto).length;
console.log('diretório (sales_infos.csv):', fSalesInfos.length, 'linhas | pessoas com foto casada:', comFoto);
console.log('exemplo 2026-06 total:', JSON.stringify(actualMensal['2026-06']?.total));
console.log('budget 2026-06 total:', JSON.stringify(budgetMensal['2026-06']?.total));
console.log('ciclo:', JSON.stringify(ciclo));
console.log('top closer:', JSON.stringify(ranking.closers[0]));
console.log('estoque SDR all (últ. semana):', JSON.stringify(sdrEstoque.all[sdrEstoque.all.length - 1]), '| pontos:', sdrEstoque.all.length);
