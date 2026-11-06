// Puxa os leads da RD Station Marketing (app OAuth "App RD Corvo - Integração Exponencial")
// e gera os dados da jornada do lead para o painel.
//
// Saídas:
//   rd.json                       público, SEM dados pessoais (sem nome, e-mail, telefone ou empresa)
//   $RD_DIR/leads.enc             nome, e-mail e empresa, criptografados com a senha do painel (PAINEL_SENHA)
//   $RD_DIR/state.enc             estado da sincronização, criptografado com RD_STATE_KEY
// Os dois .enc vão para o ramo "rd-dados" (um commit só, sobrescrito a cada rodada), não para o main.
//
// Variáveis: RD_CLIENT_ID, RD_CLIENT_SECRET, RD_REFRESH_TOKEN, RD_STATE_KEY (base64, 32 bytes),
//            PAINEL_SENHA, RD_DIR (pasta dos .enc), RD_START (padrão 2026-09-01), RD_BUDGET (padrão 300)
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { createCipheriv, createDecipheriv, randomBytes, pbkdf2Sync, createHmac, createHash } from "node:crypto";
import { join } from "node:path";

const env = k => { const v = process.env[k]; if (!v) { console.error(`Falta a variável ${k}`); process.exit(1); } return v.trim(); };
const CLIENT_ID = env("RD_CLIENT_ID"), CLIENT_SECRET = env("RD_CLIENT_SECRET"), REFRESH = env("RD_REFRESH_TOKEN");
const STATE_KEY = Buffer.from(env("RD_STATE_KEY"), "base64"), SENHA = env("PAINEL_SENHA");
const DIR = process.env.RD_DIR || ".rd-dados";
const START = process.env.RD_START || "2026-09-01";
const BUDGET = +(process.env.RD_BUDGET || 300);
const SEGMENT = 17065511; // segmentação padrão "Todos os contatos da base de Leads"
const API = "https://api.rd.services";
if (STATE_KEY.length !== 32) { console.error("RD_STATE_KEY precisa ter 32 bytes em base64"); process.exit(1); }
mkdirSync(DIR, { recursive: true });
const STATE_PATH = join(DIR, "state.enc"), PII_PATH = join(DIR, "leads.enc");
const OUT = new URL("../rd.json", import.meta.url);

// ---------- criptografia ----------
function encState(obj) {
  const iv = randomBytes(12), c = createCipheriv("aes-256-gcm", STATE_KEY, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj)), c.final(), c.getAuthTag()]);
  return Buffer.concat([iv, ct]);
}
function decState(buf) {
  const iv = buf.subarray(0, 12), tag = buf.subarray(buf.length - 16), ct = buf.subarray(12, buf.length - 16);
  const d = createDecipheriv("aes-256-gcm", STATE_KEY, iv); d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString("utf8"));
}
// formato lido pelo navegador (WebCrypto): PBKDF2-SHA256 -> AES-256-GCM, ct = cifra || tag
const PBKDF2_IT = 310000;
function encForBrowser(obj) {
  const salt = randomBytes(16), iv = randomBytes(12), key = pbkdf2Sync(SENHA, salt, PBKDF2_IT, 32, "sha256");
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj)), c.final(), c.getAuthTag()]);
  return JSON.stringify({ v: 1, it: PBKDF2_IT, s: salt.toString("base64"), iv: iv.toString("base64"), ct: ct.toString("base64") });
}
const leadId = uuid => createHmac("sha256", STATE_KEY).update(uuid).digest("base64url").slice(0, 10);

// ---------- estado ----------
let S = { contacts: {}, listedUntil: null };
if (existsSync(STATE_PATH)) {
  try { S = decState(readFileSync(STATE_PATH)); } catch (e) { console.error("Estado ilegível, recomeçando do zero:", e.message); }
}
const saveState = () => { const tmp = STATE_PATH + ".tmp"; writeFileSync(tmp, encState(S)); renameSync(tmp, STATE_PATH); };

// ---------- API ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));
let TOKEN = null, calls = 0;
async function auth() {
  const r = await fetch(`${API}/auth/token`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: REFRESH }) });
  const j = await r.json();
  if (!j.access_token) throw new Error(`Falha ao renovar o token da RD (${r.status}): ${JSON.stringify(j).slice(0, 200)}`);
  TOKEN = j.access_token;
}
async function get(path) {
  for (let i = 0; i < 8; i++) {
    try {
      calls++;
      const r = await fetch(API + path, { headers: { Authorization: "Bearer " + TOKEN } });
      if (r.status === 401 && i < 2) { await auth(); continue; }
      if (r.status === 429 || r.status >= 500) { await sleep(Math.min(60000, 4000 * (i + 1))); continue; }
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`${r.status} ${path}: ${(await r.text()).slice(0, 200)}`);
      return await r.json();
    } catch (e) {
      if (i === 7) throw e;
      await sleep(3000 * (i + 1));
    }
  }
}
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const it = items[i++]; await fn(it); } }));
}

// ---------- normalização ----------
const trim = s => (s == null ? "" : String(s)).trim().replace(/\s+/g, " ");
const utm = s => { const v = trim(s); return v.startsWith("{{") ? "{{}}" : v; };
function slimEvent(e) {
  const p = e.payload || {};
  return { i: e.event_identifier || "", t: e.event_timestamp || "", s: utm(p.traffic_source), c: utm(p.traffic_campaign),
    tv: utm(p.traffic_value), m: utm(p.traffic_medium), co: trim(p.company_name || p.cf_nome_da_empresa) };
}
function slimDetail(d) {
  return { n: trim(d.name), e: trim(d.email).toLowerCase(), q: trim(d.cf_lead_qualificado).toUpperCase(),
    fat: trim(d.cf_faixa_de_faturamento_mensal || d.cf_faixa_de_faturamento), seg: trim(d.cf_segmento),
    func: trim(d.cf_numero_de_funcionarios || d.cf_funcionarios), co: trim(d.cf_nome_da_empresa),
    st: trim(d.cf_plug_funnel_stage), ow: trim(d.cf_plug_contact_owner), pl: trim(d.cf_plug_deal_pipeline),
    lr: trim(d.cf_plug_lost_reason), v: +d.cf_plug_opportunity_value || 0, tags: d.tags || [] };
}

// ---------- 1. contatos com conversão nova ----------
await auth();
const now = new Date();
const listFrom = S.listedUntil ? new Date(new Date(S.listedUntil).getTime() - 3 * 3600e3).toISOString() : START;
const listed = [];
for (let p = 1; p <= 400; p++) {
  const j = await get(`/platform/segmentations/${SEGMENT}/contacts?page=${p}&page_size=125&order=last_conversion_date:desc`);
  const cs = (j && j.contacts) || [];
  for (const c of cs) if (c.last_conversion_date && new Date(c.last_conversion_date) >= new Date(listFrom)) listed.push(c);
  if (!cs.length || new Date(cs.at(-1).last_conversion_date || 0) < new Date(listFrom)) break;
}
const full = listed.filter(c => { const k = S.contacts[c.uuid]; return !k || k.lc !== c.last_conversion_date; });
console.log(`RD: ${listed.length} contatos com conversão desde ${listFrom.slice(0, 16)} · ${full.length} novos ou com conversão nova`);

// ---------- 2. releitura da etapa no CRM (orçamento por rodada) ----------
const CLOSED = /VENDIDO|PERDIDO|Perdidos/i;
const fullSet = new Set(full.map(c => c.uuid));
const nowMs = now.getTime();
const prio = k => { // menor = mais urgente
  const rf = k.rf ? new Date(k.rf).getTime() : 0, last = new Date(k.lc || 0).getTime();
  const recent = nowMs - last < 14 * 864e5, closed = CLOSED.test(k.st || "");
  return rf + (closed ? 24 * 3600e3 : 0) - (recent ? 4 * 3600e3 : 0);
};
const refresh = Object.entries(S.contacts).filter(([u, k]) => !fullSet.has(u) && k.inWindow)
  .sort((a, b) => prio(a[1]) - prio(b[1])).slice(0, Math.max(0, BUDGET - full.length)).map(([u]) => u);

let done = 0;
await pool(full, 4, async c => {
  const [d, ev] = await Promise.all([get(`/platform/contacts/${c.uuid}`), get(`/platform/contacts/${c.uuid}/events?event_type=CONVERSION`)]);
  if (!d) { delete S.contacts[c.uuid]; return; }
  const evs = (Array.isArray(ev) ? ev : []).map(slimEvent).sort((a, b) => a.t.localeCompare(b.t));
  S.contacts[c.uuid] = { ...slimDetail(d), ev: evs, lc: c.last_conversion_date, rf: now.toISOString(),
    inWindow: evs.some(e => e.t.slice(0, 10) >= START) };
  if (++done % 200 === 0) { console.log(`  ${done}/${full.length}`); saveState(); }
});
await pool(refresh, 4, async u => {
  const d = await get(`/platform/contacts/${u}`);
  if (!d) { delete S.contacts[u]; return; }
  const k = S.contacts[u]; Object.assign(k, slimDetail(d), { rf: now.toISOString() });
});
if (listed.length) S.listedUntil = listed.map(c => c.last_conversion_date).sort().at(-1);
S.updatedAt = now.toISOString();
saveState();
console.log(`RD: ${full.length} lidos por completo · ${refresh.length} etapas relidas · ${calls} chamadas`);

// ---------- 3. saídas ----------
const FUNIL = id => {
  if (/^diagnostico-dre$/.test(id)) return "planilha";
  if (/^dre-inteligente/.test(id)) return "dre_int";
  if (/imersao|IMR|lote-zero/i.test(id)) return "imersao";
  if (/^diag/i.test(id)) return "diagnostico";
  if (/whatsapp/i.test(id)) return "whatsapp";
  return "outros";
};
// cadastros de teste da equipe (mesma régua do antigo import-crm.mjs + UTMs de teste)
const TEST = [/\bteste?s?\b/i, /test[e@.]/i, /exemplo|example/i, /verificacao/i, /exponentialclub|purplestrawberry|pstrawberry/i,
  /caliope/i, /^pipoca@/i, /^ghh@/i, /^captura\./i, /^joca@gol/i, /maxtanie\.com$/i, /eunaocaio/i, /relay\.firefox/i, /corvoassessoria/i, /lekoplast/i];
const isTest = k => TEST.some(re => re.test(k.n) || re.test(k.e)) || k.ev.some(e => /teste|claude/i.test(e.s + " " + e.c));

const dict = {}, D = (f, v) => { const a = dict[f] ||= [""]; let i = a.indexOf(v); if (i < 0) { i = a.length; a.push(v); } return i; };
const leads = [], entries = [], pii = {};
let tests = 0, discarded = 0;
for (const [uuid, k] of Object.entries(S.contacts)) {
  const win = k.ev.filter(e => e.t.slice(0, 10) >= START);
  if (!win.length) continue;
  if (isTest(k)) { tests++; continue; }
  if ((k.tags || []).includes("descartado")) { discarded++; continue; }
  const id = leadId(uuid), li = leads.length;
  const seg = /^outro/i.test(k.seg) ? "Outro" : k.seg;
  const firstT = win[0].t, lastT = win.at(-1).t;
  leads.push([id, k.q === "SIM" ? 1 : k.q === "NÃO" || k.q === "NAO" ? 0 : -1, D("fat", k.fat), D("seg", seg), D("func", k.func),
    D("st", k.st), D("ow", k.ow), D("lr", k.lr), k.v, k.ev.length > win.length ? 1 : 0, win.length, lastT.slice(0, 10), (k.rf || "").slice(0, 13)]);
  const co = k.co || win.map(e => e.co).find(Boolean) || "";
  pii[id] = [k.n, k.e, co];
  const byF = {};
  for (const e of win) (byF[FUNIL(e.i)] ||= []).push(e);
  for (const [f, evs] of Object.entries(byF)) {
    const withUtm = evs.find(e => e.s && e.s !== "{{}}") || evs[0];
    const ph = evs.some(e => [e.s, e.c, e.tv, e.m].includes("{{}}")) ? 1 : 0, nu = withUtm.s ? 0 : 1;
    const res = f === "dre_int" && evs.some(e => e.i === "dre-inteligente-resultado") ? 1 : 0;
    entries.push([li, D("f", f), evs[0].t.slice(0, 10), D("src", withUtm.s === "{{}}" ? "" : withUtm.s), D("cmp", withUtm.c === "{{}}" ? "" : withUtm.c),
      D("term", withUtm.tv === "{{}}" ? "" : withUtm.tv), D("med", withUtm.m === "{{}}" ? "" : withUtm.m), res, ph, nu, evs.length]);
  }
  void firstT;
}
const out = {
  meta: { updated_at: now.toISOString(), start: START, leads: leads.length, entries: entries.length, tests, discarded,
    fields: { lead: ["id", "q", "fat", "seg", "func", "st", "ow", "lr", "v", "prev", "nc", "last", "rf"],
      entry: ["lead", "f", "d", "src", "cmp", "term", "med", "res", "ph", "nu", "n"] } },
  dict, leads, entries,
};
writeFileSync(OUT, JSON.stringify(out));
writeFileSync(PII_PATH, encForBrowser({ updated_at: now.toISOString(), leads: pii }));
const h = createHash("sha256").update(JSON.stringify(out.leads)).digest("hex").slice(0, 8);
console.log(`rd.json: ${leads.length} leads · ${entries.length} entradas · ${tests} testes · ${discarded} descartados · hash ${h}`);
