import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { mountAppCore, inkressApi, isPaidStatus } from "@inkress/apps-core";
import { openPg } from "@inkress/apps-core/pgdb";
import { putObject, storageConfigured, decodeDataUrl, isAllowedImage } from "@inkress/apps-core/storage";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";
for (const k of ["OAUTH_CLIENT_ID", "OAUTH_CLIENT_SECRET", "INKRESS_API_BASE"]) {
  if (!process.env[k]) { console.error(`[expense-logger] Missing env: ${k}`); process.exit(1); }
}

const db = await openPg("expense_logger", `
  CREATE TABLE IF NOT EXISTS expenses (
    id BIGSERIAL PRIMARY KEY, merchant_id BIGINT NOT NULL, spent_on DATE NOT NULL,
    amount NUMERIC NOT NULL, tax_amount NUMERIC NOT NULL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'JMD',
    category TEXT NOT NULL DEFAULT 'Other', vendor TEXT, note TEXT, receipt_url TEXT,
    created_by_id BIGINT, created_by_name TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  ALTER TABLE expenses ADD COLUMN IF NOT EXISTS tax_amount NUMERIC NOT NULL DEFAULT 0;
  ALTER TABLE expenses ADD COLUMN IF NOT EXISTS receipt_url TEXT;
  CREATE INDEX IF NOT EXISTS idx_expenses_merchant ON expenses (merchant_id, spent_on DESC);
  CREATE TABLE IF NOT EXISTS categories (id BIGSERIAL PRIMARY KEY, merchant_id BIGINT NOT NULL, name TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
  CREATE UNIQUE INDEX IF NOT EXISTS idx_el_cat_uniq ON categories (merchant_id, lower(name));
  CREATE TABLE IF NOT EXISTS recurring (
    id BIGSERIAL PRIMARY KEY, merchant_id BIGINT NOT NULL, category TEXT NOT NULL DEFAULT 'Other',
    amount NUMERIC NOT NULL, vendor TEXT, note TEXT, currency TEXT NOT NULL DEFAULT 'JMD',
    day_of_month INTEGER NOT NULL DEFAULT 1, active BOOLEAN NOT NULL DEFAULT true, last_created DATE, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS budgets (merchant_id BIGINT NOT NULL, category TEXT NOT NULL, monthly_limit NUMERIC NOT NULL, PRIMARY KEY (merchant_id, category));
`);

const app = express();
const core = mountAppCore(app, {
  clientId: process.env.OAUTH_CLIENT_ID, clientSecret: process.env.OAUTH_CLIENT_SECRET,
  apiBaseUrl: process.env.INKRESS_API_BASE, frameAncestors: process.env.FRAME_ANCESTORS,
  staticDir: path.join(__dirname, "dist"),
});

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const RANGES = { "30d": 30, "90d": 90, "365d": 365 };
const DEFAULT_CATEGORIES = ["Supplies", "Rent", "Salaries", "Utilities", "Marketing", "Equipment", "Inventory", "Transport", "Fees", "Other"];

async function effectiveCategories(merchantId) {
  const custom = await db.q(`SELECT id, name FROM categories WHERE merchant_id=$1 ORDER BY name`, [merchantId]);
  const seen = new Set(DEFAULT_CATEGORIES.map((c) => c.toLowerCase()));
  const customClean = custom.filter((c) => !seen.has(c.name.toLowerCase()));
  return { names: [...DEFAULT_CATEGORIES, ...customClean.map((c) => c.name)], defaults: DEFAULT_CATEGORIES, custom: customClean.map((c) => ({ id: c.id, name: c.name })) };
}
function rangeStart(range) { return new Date(Date.now() - (RANGES[range] || 30) * 86400 * 1000); }
const serialize = (r) => ({ id: r.id, spent_on: r.spent_on, amount: Number(r.amount), tax_amount: Number(r.tax_amount || 0), currency: r.currency, category: r.category, vendor: r.vendor, note: r.note, receipt_url: r.receipt_url, created_by: r.created_by_name ? { id: r.created_by_id, name: r.created_by_name } : null, created_at: r.created_at });

// Windowed/paginated revenue (page param) — complete 12-month P&L.
async function inkressRevenue(session, since, currency) {
  let revenue = 0;
  for (let page = 1; page <= 8; page++) {
    const r = await inkressApi(core.cfg, session.accessToken, `orders?limit=200&page=${page}&order=id desc`);
    const entries = r?.result?.entries || [];
    for (const o of entries) { if (isPaidStatus(o) && new Date(o.inserted_at || o.created_at || 0) >= since && (!currency || (o.currency?.code || o.currency_code) === currency)) revenue += Number(o.total || 0); }
    if (!entries.length) break;
    if (new Date(entries[entries.length - 1].inserted_at || 0) < since) break;
  }
  return round2(revenue);
}

// ---- Overview (revenue vs expenses → profit, trend, budgets) ---------------
app.get("/api/overview", core.requireSession, async (req, res) => {
  const range = RANGES[req.query.range] ? req.query.range : "30d";
  const since = rangeStart(range);
  const currency = req.session.data?.merchant?.currency_code || "JMD";
  try {
    const sinceStr = since.toISOString().slice(0, 10);
    const rows = await db.q(`SELECT * FROM expenses WHERE merchant_id=$1 AND spent_on >= $2 ORDER BY spent_on DESC, id DESC`, [req.session.merchantId, sinceStr]);
    let revenue = 0, revenueOk = true;
    try { revenue = await inkressRevenue(req.session, since, currency); } catch { revenueOk = false; }
    const total = round2(rows.reduce((s, e) => s + Number(e.amount), 0));
    const byCat = new Map(), byVendor = new Map(), byMonth = new Map();
    for (const e of rows) {
      byCat.set(e.category, round2((byCat.get(e.category) || 0) + Number(e.amount)));
      if (e.vendor) byVendor.set(e.vendor, round2((byVendor.get(e.vendor) || 0) + Number(e.amount)));
      const mo = String(e.spent_on).slice(0, 7); byMonth.set(mo, round2((byMonth.get(mo) || 0) + Number(e.amount)));
    }
    const budgets = await db.q(`SELECT category, monthly_limit FROM budgets WHERE merchant_id=$1`, [req.session.merchantId]);
    const thisMonth = new Date().toISOString().slice(0, 7);
    const budgetStatus = budgets.map((b) => { const spent = rows.filter((e) => e.category === b.category && String(e.spent_on).slice(0, 7) === thisMonth).reduce((s, e) => s + Number(e.amount), 0); return { category: b.category, limit: Number(b.monthly_limit), spent: round2(spent), over: spent > Number(b.monthly_limit) }; });

    res.json({
      range, currency, revenue, revenue_ok: revenueOk, expenses_total: total, profit: round2(revenue - total),
      margin: revenue ? Math.round(((revenue - total) / revenue) * 100) : null, expense_count: rows.length,
      by_category: [...byCat.entries()].map(([category, amount]) => ({ category, amount })).sort((a, b) => b.amount - a.amount),
      by_vendor: [...byVendor.entries()].map(([vendor, amount]) => ({ vendor, amount })).sort((a, b) => b.amount - a.amount).slice(0, 6),
      by_month: [...byMonth.entries()].sort().map(([month, amount]) => ({ month, amount })),
      budgets: budgetStatus, recent: rows.slice(0, 6).map(serialize),
    });
  } catch (err) { res.status(502).json({ error: "overview_failed", message: err?.message }); }
});

// ---- Expenses CRUD ---------------------------------------------------------
app.get("/api/expenses", core.requireSession, async (req, res) => {
  const range = RANGES[req.query.range] ? req.query.range : "90d";
  const cat = req.query.category ? String(req.query.category) : null;
  const conds = [`merchant_id=$1`, `spent_on >= $2`]; const params = [req.session.merchantId, rangeStart(range).toISOString().slice(0, 10)];
  if (cat) { params.push(cat); conds.push(`category=$${params.length}`); }
  const rows = await db.q(`SELECT * FROM expenses WHERE ${conds.join(" AND ")} ORDER BY spent_on DESC, id DESC LIMIT 400`, params);
  res.json({ expenses: rows.map(serialize), categories: (await effectiveCategories(req.session.merchantId)).names });
});
app.post("/api/expenses", core.requireSession, async (req, res) => {
  const b = req.body || {};
  const amount = round2(b.amount);
  if (!(amount > 0)) return res.status(400).json({ error: "bad_amount", message: "Enter an amount greater than zero." });
  const spent = /^\d{4}-\d{2}-\d{2}$/.test(b.spent_on) ? b.spent_on : new Date().toISOString().slice(0, 10);
  const row = await db.one(`INSERT INTO expenses (merchant_id, spent_on, amount, tax_amount, currency, category, vendor, note, receipt_url, created_by_id, created_by_name)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [req.session.merchantId, spent, amount, round2(b.tax_amount), (b.currency || req.session.data?.merchant?.currency_code || "JMD"),
     String(b.category || "Other").slice(0, 40), b.vendor || null, b.note || null, b.receipt_url || null, req.actor?.id || null, req.actor?.name || null]);
  res.status(201).json({ expense: serialize(row) });
});
app.patch("/api/expenses/:id", core.requireSession, async (req, res) => {
  const b = req.body || {};
  const row = await db.one(`SELECT * FROM expenses WHERE id=$1 AND merchant_id=$2`, [req.params.id, req.session.merchantId]);
  if (!row) return res.status(404).json({ error: "not_found" });
  const u = await db.one(`UPDATE expenses SET spent_on=$1, amount=$2, tax_amount=$3, category=$4, vendor=$5, note=$6, receipt_url=$7 WHERE id=$8 RETURNING *`,
    [/^\d{4}-\d{2}-\d{2}$/.test(b.spent_on) ? b.spent_on : row.spent_on, b.amount != null ? round2(b.amount) : row.amount, b.tax_amount != null ? round2(b.tax_amount) : row.tax_amount,
     b.category || row.category, b.vendor !== undefined ? (b.vendor || null) : row.vendor, b.note !== undefined ? (b.note || null) : row.note, b.receipt_url !== undefined ? (b.receipt_url || null) : row.receipt_url, row.id]);
  res.json({ expense: serialize(u) });
});
app.delete("/api/expenses/:id", core.requireSession, async (req, res) => { await db.run(`DELETE FROM expenses WHERE id=$1 AND merchant_id=$2`, [req.params.id, req.session.merchantId]); res.json({ ok: true }); });

// ---- Receipt image upload (S3) ---------------------------------------------
app.post("/api/upload", core.requireSession, async (req, res) => {
  if (!storageConfigured()) return res.status(503).json({ error: "storage_off", message: "Receipt hosting isn't configured." });
  const decoded = decodeDataUrl(req.body?.data);
  if (!decoded || !isAllowedImage(decoded.contentType)) return res.status(400).json({ error: "bad_image", message: "Upload a JPG, PNG, WEBP or GIF." });
  if (decoded.body.length > 5 * 1024 * 1024) return res.status(400).json({ error: "too_big", message: "Image must be under 5MB." });
  try { const { url } = await putObject({ prefix: `expenses/${req.session.merchantId}`, body: decoded.body, contentType: decoded.contentType }); res.json({ url }); }
  catch (err) { res.status(502).json({ error: "upload_failed", message: err?.message }); }
});

// ---- Categories (incl. rename = R1 edit) -----------------------------------
app.get("/api/categories", core.requireSession, async (req, res) => res.json({ ...(await effectiveCategories(req.session.merchantId)), storage: storageConfigured() }));
app.post("/api/categories", core.requireSession, async (req, res) => {
  const name = String(req.body?.name || "").trim().slice(0, 40);
  if (!name) return res.status(400).json({ error: "no_name", message: "Enter a category name." });
  if (DEFAULT_CATEGORIES.some((c) => c.toLowerCase() === name.toLowerCase())) return res.status(400).json({ error: "exists", message: "That category already exists." });
  await db.run(`INSERT INTO categories (merchant_id, name) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [req.session.merchantId, name]);
  res.status(201).json(await effectiveCategories(req.session.merchantId));
});
app.patch("/api/categories/:id", core.requireSession, async (req, res) => {
  const name = String(req.body?.name || "").trim().slice(0, 40);
  const c = await db.one(`SELECT * FROM categories WHERE id=$1 AND merchant_id=$2`, [req.params.id, req.session.merchantId]);
  if (!c) return res.status(404).json({ error: "not_found" });
  if (!name) return res.status(400).json({ error: "no_name" });
  await db.run(`UPDATE categories SET name=$1 WHERE id=$2`, [name, c.id]);
  await db.run(`UPDATE expenses SET category=$1 WHERE merchant_id=$2 AND category=$3`, [name, req.session.merchantId, c.name]);
  res.json(await effectiveCategories(req.session.merchantId));
});
app.delete("/api/categories/:id", core.requireSession, async (req, res) => { await db.run(`DELETE FROM categories WHERE id=$1 AND merchant_id=$2`, [req.params.id, req.session.merchantId]); res.json(await effectiveCategories(req.session.merchantId)); });

// ---- Recurring expenses ----------------------------------------------------
app.get("/api/recurring", core.requireSession, async (req, res) => res.json({ recurring: await db.q(`SELECT * FROM recurring WHERE merchant_id=$1 ORDER BY id`, [req.session.merchantId]) }));
app.post("/api/recurring", core.requireSession, async (req, res) => {
  const b = req.body || {}; if (!(round2(b.amount) > 0)) return res.status(400).json({ error: "bad_amount" });
  const row = await db.one(`INSERT INTO recurring (merchant_id, category, amount, vendor, note, currency, day_of_month) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [req.session.merchantId, String(b.category || "Other").slice(0, 40), round2(b.amount), b.vendor || null, b.note || null, b.currency || req.session.data?.merchant?.currency_code || "JMD", Math.max(1, Math.min(28, Number(b.day_of_month) || 1))]);
  res.status(201).json({ recurring: row });
});
app.patch("/api/recurring/:id", core.requireSession, async (req, res) => {
  const b = req.body || {};
  const r = await db.one(`SELECT * FROM recurring WHERE id=$1 AND merchant_id=$2`, [req.params.id, req.session.merchantId]);
  if (!r) return res.status(404).json({ error: "not_found" });
  const u = await db.one(`UPDATE recurring SET category=$1, amount=$2, vendor=$3, note=$4, day_of_month=$5, active=$6 WHERE id=$7 RETURNING *`,
    [b.category || r.category, b.amount != null ? round2(b.amount) : r.amount, b.vendor !== undefined ? (b.vendor || null) : r.vendor, b.note !== undefined ? (b.note || null) : r.note, b.day_of_month != null ? Math.max(1, Math.min(28, Number(b.day_of_month))) : r.day_of_month, b.active != null ? !!b.active : r.active, r.id]);
  res.json({ recurring: u });
});
app.delete("/api/recurring/:id", core.requireSession, async (req, res) => { await db.run(`DELETE FROM recurring WHERE id=$1 AND merchant_id=$2`, [req.params.id, req.session.merchantId]); res.json({ ok: true }); });

// ---- Budgets ---------------------------------------------------------------
app.get("/api/budgets", core.requireSession, async (req, res) => res.json({ budgets: await db.q(`SELECT category, monthly_limit FROM budgets WHERE merchant_id=$1`, [req.session.merchantId]) }));
app.post("/api/budgets", core.requireSession, async (req, res) => {
  const cat = String(req.body?.category || "").slice(0, 40); const limit = round2(req.body?.monthly_limit);
  if (!cat) return res.status(400).json({ error: "no_category" });
  if (!(limit > 0)) await db.run(`DELETE FROM budgets WHERE merchant_id=$1 AND category=$2`, [req.session.merchantId, cat]);
  else await db.run(`INSERT INTO budgets (merchant_id, category, monthly_limit) VALUES ($1,$2,$3) ON CONFLICT (merchant_id, category) DO UPDATE SET monthly_limit=$3`, [req.session.merchantId, cat, limit]);
  res.json({ ok: true });
});

// ---- Scheduler: auto-create recurring expenses -----------------------------
async function runRecurring() {
  const day = new Date().getUTCDate(); const month = new Date().toISOString().slice(0, 7); const todayStr = new Date().toISOString().slice(0, 10);
  const due = await db.q(`SELECT * FROM recurring WHERE active=true AND day_of_month <= $1 AND (last_created IS NULL OR to_char(last_created,'YYYY-MM') < $2)`, [day, month]);
  for (const r of due) {
    try {
      await db.run(`INSERT INTO expenses (merchant_id, spent_on, amount, currency, category, vendor, note, created_by_name) VALUES ($1,$2,$3,$4,$5,$6,$7,'Recurring')`,
        [r.merchant_id, todayStr, r.amount, r.currency, r.category, r.vendor, r.note]);
      await db.run(`UPDATE recurring SET last_created=$2 WHERE id=$1`, [r.id, todayStr]);
    } catch (err) { console.error(`[expense-logger] recurring ${r.id}: ${err?.message}`); }
  }
}
setInterval(() => { runRecurring().catch(() => {}); }, 6 * 60 * 60 * 1000);
setTimeout(() => { runRecurring().catch(() => {}); }, 20000);

core.mountSpaFallback();
app.listen(PORT, HOST, () => console.log(`[expense-logger] listening on ${HOST}:${PORT}`));
