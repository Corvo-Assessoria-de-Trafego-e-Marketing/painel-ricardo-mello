// Importa a exportação de cadastros do CRM (CSV) e gera crm.json para a aba "CRM / Comercial".
// Uso: node scripts/import-crm.mjs <caminho-do-csv>
// Telefone não é levado para o painel (só nome e e-mail).
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { basename } from "node:path";

const src = process.argv[2];
if (!src) { console.error("Uso: node scripts/import-crm.mjs <arquivo.csv>"); process.exit(1); }

// ---- CSV (RFC 4180: aspas, vírgulas e quebras de linha dentro de campo) ----
function parseCSV(text) {
  const rows = []; let row = [], f = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
      else f += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n") { row.push(f); rows.push(row); row = []; f = ""; }
    else if (c !== "\r") f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}

const raw = readFileSync(src, "utf8").replace(/^﻿/, "");
const [head, ...body] = parseCSV(raw).filter(r => r.some(v => v.trim()));
const col = name => { const i = head.indexOf(name); if (i < 0) throw new Error(`Coluna não encontrada: ${name}`); return i; };
const C = {
  nome: col("Nome"), email: col("E-mail"), seg: col("Segmento"), fat: col("Faturamento"),
  quali: col("Qualificado"), etiq: col("Etiqueta"), etapa: col("Etapa no CRM"), status: col("Status no CRM"),
  resp: col("Responsável no CRM"), src: col("utm_source"), med: col("utm_medium"), camp: col("utm_campaign"),
  term: col("utm_term"), cont: col("utm_content"), data: col("Data do cadastro"),
  func: head.findIndex(h => /funcionários/i.test(h)),
};

// "02/10/2026, 10:35" -> "2026-10-02T10:35"
const isoDate = s => { const m = /(\d{2})\/(\d{2})\/(\d{4}),?\s*(\d{2}):(\d{2})/.exec(s || ""); return m ? `${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}` : ""; };
// utm não preenchida pelo gerenciador ({{campaign.name}}) vale como vazia
const utm = s => (s || "").trim().startsWith("{{") ? "" : (s || "").trim();

// Cadastros de teste da equipe (Corvo / Exponential / consultoria) — ficam fora do painel.
const TEST = [
  /\bteste?s?\b/i, /test[e@.]/i, /exemplo|example/i, /verificacao/i, /exponentialclub|purplestrawberry|pstrawberry/i,
  /caliope/i, /^pipoca@/i, /^ghh@/i, /^captura\./i, /^joca@gol/i, /maxtanie\.com$/i, /eunaocaio/i, /relay\.firefox/i,
];
const isTest = r => TEST.some(re => re.test(r.nome) || re.test(r.email));

const all = body.map(v => ({
  nome: (v[C.nome] || "").trim(), email: (v[C.email] || "").trim().toLowerCase(),
  etapa: (v[C.etapa] || "").trim(), status: (v[C.status] || "").trim(), resp: (v[C.resp] || "").trim(),
  quali: (v[C.quali] || "").trim(), etiq: (v[C.etiq] || "").trim(),
  seg: (v[C.seg] || "").trim(), fat: (v[C.fat] || "").trim(), func: C.func >= 0 ? (v[C.func] || "").trim() : "",
  src: utm(v[C.src]), med: utm(v[C.med]), camp: utm(v[C.camp]), term: utm(v[C.term]), cont: utm(v[C.cont]),
  d: isoDate(v[C.data]),
}));

const tests = all.filter(isTest);
const discarded = all.filter(r => !isTest(r) && r.etiq === "descartado");
const valid = all.filter(r => !isTest(r) && r.etiq !== "descartado");

// Um lead por e-mail. Vale o cadastro mais recente que já está no CRM (tem etapa);
// se nenhum estiver, o mais recente. "cad" = quantas vezes a pessoa preencheu.
const byEmail = new Map();
for (const r of valid) { const k = r.email || r.nome; (byEmail.get(k) || byEmail.set(k, []).get(k)).push(r); }
const leads = [...byEmail.values()].map(rs => {
  rs.sort((a, b) => b.d.localeCompare(a.d));
  const pick = rs.find(r => r.etapa) || rs[0];
  const { etiq, ...lead } = pick;
  // a etiqueta "qualificado/desqualificado" só existe a partir da regra nova; antes dela fica vazio
  return { ...lead, cad: rs.length, first: rs[rs.length - 1].d };
}).sort((a, b) => b.d.localeCompare(a.d));

const dates = leads.map(l => l.d).filter(Boolean).sort();
const out = {
  meta: {
    source: basename(src),
    exported_at: statSync(src).mtime.toISOString(),
    first_date: dates[0], last_date: dates[dates.length - 1],
    rows: all.length, tests: tests.length, discarded: discarded.length, duplicates: valid.length - leads.length,
  },
  leads,
};
writeFileSync(new URL("../crm.json", import.meta.url), JSON.stringify(out));

console.log(`${all.length} linhas · ${tests.length} testes · ${discarded.length} descartados · ${valid.length - leads.length} repetidos → ${leads.length} leads`);
console.log("Testes removidos:", [...new Set(tests.map(r => `${r.nome} <${r.email}>`))].join(" | "));
const cnt = {}; leads.forEach(l => cnt[l.etapa || "(sem etapa)"] = (cnt[l.etapa || "(sem etapa)"] || 0) + 1);
console.table(cnt);
