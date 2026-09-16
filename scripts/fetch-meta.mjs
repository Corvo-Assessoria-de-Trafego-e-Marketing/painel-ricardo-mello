// fetch-meta.mjs — puxa a Meta Marketing API e reescreve ../data.json (dados diários por anúncio).
// Rodado pelo GitHub Actions de hora em hora. Node 20+ (fetch global).
// Env: META_TOKEN (obrigatória), AD_ACCOUNT_ID (opcional), SINCE (opcional).

import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const TOKEN   = process.env.META_TOKEN;
const ACCOUNT = process.env.AD_ACCOUNT_ID || "2895948854126435";
const SINCE   = process.env.SINCE || "2026-04-01";
const API     = "https://graph.facebook.com/v21.0";
const ROOT    = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT     = join(ROOT, "data.json");
const THUMBDIR = join(ROOT, "thumbs");

if (!TOKEN) { console.error("ERRO: defina o secret META_TOKEN."); process.exit(1); }

async function getAll(path, params) {
  const url = new URL(`${API}/${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  url.searchParams.set("access_token", TOKEN);
  if (!params.limit) url.searchParams.set("limit", "500");
  let out = [], next = url.toString(), guard = 0;
  while (next && guard++ < 200) {
    const r = await fetch(next);
    const j = await r.json();
    if (j.error) throw new Error(`${path}: ${j.error.message}`);
    out = out.concat(j.data || []);
    next = j.paging?.next || null;
  }
  return out;
}

const num = v => (v == null ? 0 : Math.round(parseFloat(v) || 0));
const sumArr = a => Array.isArray(a) ? a.reduce((s, x) => s + num(x.value), 0) : num(a);

function pick(actions, types) {
  if (!Array.isArray(actions)) return 0;
  for (const t of types) {
    const hit = actions.find(a => a.action_type === t);
    if (hit) return num(hit.value);
  }
  return 0;
}

const IF = [
  "ad_id", "adset_id", "campaign_id",
  "spend", "impressions", "reach",
  "actions",
  "video_thruplay_watched_actions",
  "video_p25_watched_actions", "video_p50_watched_actions",
  "video_p75_watched_actions", "video_p95_watched_actions",
  "video_play_actions",
].join(",");

function toRow(r) {
  const all = r.actions || [];
  const o = {
    d: r.date_start,
    a: r.ad_id,
    c: r.campaign_id,
  };
  if (r.adset_id) o.as = r.adset_id;

  o.s  = +(+r.spend).toFixed(2);
  o.i  = num(r.impressions);
  o.rc = num(r.reach);

  const le = pick(all, ["lead", "offsite_conversion.fb_pixel_lead", "onsite_conversion.lead_grouped"]);
  const ql = pick(all, ["offsite_conversion.fb_pixel_custom.lead_quali", "offsite_conversion.custom.lead_quali", "lead_quali"]);
  const pu = pick(all, ["omni_purchase", "purchase", "offsite_conversion.fb_pixel_purchase"]);
  const co = pick(all, ["omni_initiated_checkout", "initiate_checkout"]);
  const lc = pick(all, ["link_click"]);
  o.ck = lc;
  const pv = pick(all, ["omni_landing_page_view", "landing_page_view"]);
  const ig = pick(all, ["onsite_conversion.ig_profile_visit", "onsite_conversion.ig_profile_engagement"]);
  const fo = pick(all, ["onsite_conversion.follow", "onsite_conversion.page_follow", "follow", "like"]);

  const tp = sumArr(r.video_thruplay_watched_actions);
  const vh = pick(a, ["video_view"]);

  if (le) o.le = le;
  if (ql) o.ql = ql;
  if (pu) o.pu = pu;
  if (co) o.co = co;
  if (lc) o.lc = lc;
  if (pv) o.pv = pv;
  if (ig) o.ig = ig;
  if (fo) o.fo = fo;
  if (tp) o.tp = tp;

  const q25 = sumArr(r.video_p25_watched_actions);
  const q50 = sumArr(r.video_p50_watched_actions);
  const q75 = sumArr(r.video_p75_watched_actions);
  const q95 = sumArr(r.video_p95_watched_actions);
  if (tp || vh) {
    const v = {};
    if (vh) v.h = vh;
    if (tp) v.tp = tp;
    if (q25) v.q25 = q25;
    if (q50) v.q50 = q50;
    if (q75) v.q75 = q75;
    if (q95) v.q95 = q95;
    o.vid = v;
  }

  return o;
}

function dateChunks(since, until, days = 30) {
  const chunks = [];
  let s = new Date(since + "T00:00:00Z");
  const end = new Date(until + "T00:00:00Z");
  while (s <= end) {
    const e = new Date(s); e.setUTCDate(e.getUTCDate() + days - 1);
    if (e > end) e.setTime(end.getTime());
    chunks.push([s.toISOString().slice(0, 10), e.toISOString().slice(0, 10)]);
    s = new Date(e); s.setUTCDate(s.getUTCDate() + 1);
  }
  return chunks;
}

async function main() {
  const until = new Date().toISOString().slice(0, 10);

  console.log(`Buscando metadados (campanhas, anúncios, conjuntos)...`);
  const campMeta = await getAll(`act_${ACCOUNT}/campaigns`, {
    fields: "id,name,objective,status,effective_status",
  });
  const adMeta = await getAll(`act_${ACCOUNT}/ads`, {
    fields: "id,name,campaign_id,adset_id,effective_status,creative{id}",
  });
  const adsetMeta = await getAll(`act_${ACCOUNT}/adsets`, {
    fields: "id,name",
  });
  console.log(`  ${campMeta.length} campanhas, ${adMeta.length} anúncios, ${adsetMeta.length} conjuntos`);

  const campById = Object.fromEntries(campMeta.map(c => [c.id, c]));
  const adById   = Object.fromEntries(adMeta.map(a => [a.id, a]));
  const adsetName = Object.fromEntries(adsetMeta.map(s => [s.id, s.name]));

  const chunks = dateChunks(SINCE, until, 30);
  console.log(`Buscando insights em ${chunks.length} blocos de 30 dias (${SINCE} → ${until})...`);
  let rows = [];
  for (const [cs, ce] of chunks) {
    console.log(`  bloco ${cs} → ${ce}...`);
    const chunk = await getAll(`act_${ACCOUNT}/insights`, {
      level: "ad",
      time_range: JSON.stringify({ since: cs, until: ce }),
      time_increment: "1",
      fields: IF,
    });
    rows = rows.concat(chunk);
    console.log(`    ${chunk.length} linhas (total acumulado: ${rows.length})`);
  }

  const qlTypes = new Set();
  for (const r of rows) {
    if (!r.actions) continue;
    for (const act of r.actions) {
      if (act.action_type && act.action_type.includes("lead_quali")) qlTypes.add(act.action_type);
      if (act.action_type && act.action_type.includes("custom")) qlTypes.add(act.action_type);
    }
  }
  if (qlTypes.size) console.log(`  action_types com lead_quali/custom: ${[...qlTypes].join(", ")}`);
  else console.log(`  NENHUM action_type com lead_quali ou custom encontrado nas actions`);

  const daily = rows
    .filter(r => parseFloat(r.spend) > 0 || parseInt(r.impressions) > 0)
    .map(toRow)
    .sort((x, y) => x.d < y.d ? -1 : x.d > y.d ? 1 : 0);

  if (!daily.length) throw new Error("nenhuma linha com gasto — confira o token e o AD_ACCOUNT_ID");

  const usedAds    = [...new Set(daily.map(r => r.a))];
  const usedCamps  = [...new Set(daily.map(r => r.c))];
  const usedAdsets = [...new Set(daily.filter(r => r.as).map(r => r.as))];

  mkdirSync(THUMBDIR, { recursive: true });
  const imgMap = {};
  let baixadas = 0;
  for (const adId of usedAds) {
    const file = join(THUMBDIR, adId + ".jpg"), rel = "thumbs/" + adId + ".jpg";
    if (existsSync(file)) { imgMap[adId] = rel; continue; }
    const cid = adById[adId]?.creative?.id;
    if (!cid) continue;
    try {
      const j = await (await fetch(`${API}/${cid}?fields=thumbnail_url&thumbnail_width=400&thumbnail_height=400&access_token=${TOKEN}`)).json();
      if (!j.thumbnail_url) continue;
      const ir = await fetch(j.thumbnail_url);
      if (!ir.ok) continue;
      writeFileSync(file, Buffer.from(await ir.arrayBuffer()));
      imgMap[adId] = rel; baixadas++;
    } catch { /* segue sem capa */ }
  }

  const campaigns = usedCamps.filter(id => campById[id]).map(id => ({
    id, name: campById[id].name, objective: campById[id].objective || "",
  }));
  const adsets = usedAdsets.map(id => ({ id, name: adsetName[id] || id }));
  const ads = usedAds.map(id => {
    const a = adById[id] || {};
    const o = { id, name: a.name || id, campaign_id: a.campaign_id || daily.find(r => r.a === id).c, status: a.effective_status || "PAUSED" };
    if (a.adset_id) o.adset_id = a.adset_id;
    if (imgMap[id]) o.img = imgMap[id];
    return o;
  });

  const dates = daily.map(r => r.d);
  const data = {
    meta: {
      account_id: ACCOUNT,
      account_name: "EXPONENTIAL NOVO 2025",
      client: "Ricardo Mello",
      currency: "BRL",
      tz: "America/Sao_Paulo",
      updated_at: new Date().toISOString(),
      seed: false,
      first_date: dates[0],
      last_date: dates[dates.length - 1],
      default_period: "last_30d",
    },
    campaigns, adsets, ads, daily,
  };

  writeFileSync(OUT, JSON.stringify(data) + "\n");

  const tot = daily.reduce((s, r) => s + r.s, 0);
  const ql  = daily.reduce((s, r) => s + (r.ql || 0), 0);
  const le  = daily.reduce((s, r) => s + (r.le || 0), 0);
  console.log(`OK  linhas=${daily.length}  anúncios=${ads.length}  campanhas=${campaigns.length}  capas novas=${baixadas}`);
  console.log(`    período ${data.meta.first_date} → ${data.meta.last_date}  investido R$${tot.toFixed(2)}`);
  console.log(`    leads=${le}  lead_quali=${ql}`);
}

main().catch(e => { console.error("FALHA:", e.message); process.exit(1); });
