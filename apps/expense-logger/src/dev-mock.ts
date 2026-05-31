/** DEV-ONLY preview harness — tree-shaken from prod. */
import type { BvSession } from "./bv-init";

const DEFAULTS = ["Supplies", "Rent", "Salaries", "Utilities", "Marketing", "Equipment", "Inventory", "Transport", "Fees", "Other"];
let CUSTOM: { id: number; name: string }[] = [{ id: 1, name: "Insurance" }];
let catId = 1;
const catData = () => ({ names: [...DEFAULTS, ...CUSTOM.map((c) => c.name)], defaults: DEFAULTS, custom: CUSTOM });
const CATS = DEFAULTS;
const vendors = ["Sangsters", "JPS", "NWC", "Facebook Ads", "Hi-Lo", "Courier Co", "Beauty Depot"];
const EXP: any[] = [];
let id = 50;
for (let i = 0; i < 22; i++) {
  const d = new Date(); d.setDate(d.getDate() - Math.floor(Math.random() * 80));
  EXP.push({ id: id--, spent_on: d.toISOString().slice(0, 10), amount: Math.round(800 + Math.random() * 22000), currency: "JMD",
    category: CATS[Math.floor(Math.random() * 6)], vendor: vendors[Math.floor(Math.random() * vendors.length)], note: null,
    created_by: { id: 90, name: "Front Desk" }, created_at: d.toISOString() });
}

let RECUR: any[] = [{ id: 1, category: "Rent", amount: 45000, vendor: "Landlord", note: null, currency: "JMD", day_of_month: 1, active: true }];
let recId = 1;
let BUDGETS: any[] = [{ category: "Marketing", monthly_limit: 20000 }];

function overview(range: string) {
  const days = range === "30d" ? 30 : range === "365d" ? 365 : 90;
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const rows = EXP.filter((e) => e.spent_on >= since);
  const total = Math.round(rows.reduce((s, e) => s + e.amount, 0));
  const byCat = new Map<string, number>(), byVen = new Map<string, number>(), byMo = new Map<string, number>();
  for (const e of rows) { byCat.set(e.category, (byCat.get(e.category) || 0) + e.amount); if (e.vendor) byVen.set(e.vendor, (byVen.get(e.vendor) || 0) + e.amount); const mo = e.spent_on.slice(0, 7); byMo.set(mo, (byMo.get(mo) || 0) + e.amount); }
  const revenue = 317135;
  const thisMonth = new Date().toISOString().slice(0, 7);
  const budgets = BUDGETS.map((b) => { const spent = rows.filter((e) => e.category === b.category && e.spent_on.slice(0, 7) === thisMonth).reduce((s, e) => s + e.amount, 0); return { category: b.category, limit: b.monthly_limit, spent, over: spent > b.monthly_limit }; });
  return { range, currency: "JMD", revenue, revenue_ok: true, expenses_total: total, profit: revenue - total, margin: Math.round(((revenue - total) / revenue) * 100), expense_count: rows.length,
    by_category: [...byCat.entries()].map(([category, amount]) => ({ category, amount })).sort((a, b) => b.amount - a.amount),
    by_vendor: [...byVen.entries()].map(([vendor, amount]) => ({ vendor, amount })).sort((a, b) => b.amount - a.amount).slice(0, 6),
    by_month: [...byMo.entries()].sort().map(([month, amount]) => ({ month, amount })),
    budgets, recent: rows.slice(0, 6) };
}

export function installMockFetch() {
  window.fetch = async (input: any, init: any = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const method = (init.method || "GET").toUpperCase();
    const u = new URL(url, location.origin);
    const body = init.body ? JSON.parse(init.body) : {};
    const json = (d: any, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "Content-Type": "application/json" } });
    await new Promise((r) => setTimeout(r, 90));
    const idm = u.pathname.match(/\/api\/expenses\/(\d+)/);

    const catm = u.pathname.match(/\/api\/categories\/(\d+)/);
    if (u.pathname === "/api/overview") return json(overview(u.searchParams.get("range") || "30d"));
    if (u.pathname === "/api/upload") return json({ url: "https://placehold.co/400x520/png" });
    if (u.pathname === "/api/recurring" && method === "GET") return json({ recurring: RECUR });
    if (u.pathname === "/api/recurring" && method === "POST") { const r = { id: ++recId, ...body, active: true }; RECUR.push(r); return json({ recurring: r }, 201); }
    if (u.pathname.match(/\/api\/recurring\/(\d+)/) && method === "PATCH") { const r = RECUR.find((x) => String(x.id) === u.pathname.split("/").pop()); Object.assign(r, body); return json({ recurring: r }); }
    if (u.pathname.match(/\/api\/recurring\/(\d+)/) && method === "DELETE") { RECUR = RECUR.filter((x) => String(x.id) !== u.pathname.split("/").pop()); return json({ ok: true }); }
    if (u.pathname === "/api/budgets" && method === "GET") return json({ budgets: BUDGETS });
    if (u.pathname === "/api/budgets" && method === "POST") { BUDGETS = BUDGETS.filter((b) => b.category !== body.category); if (Number(body.monthly_limit) > 0) BUDGETS.push({ category: body.category, monthly_limit: Number(body.monthly_limit) }); return json({ ok: true }); }
    if (u.pathname === "/api/categories" && method === "GET") return json({ ...catData(), storage: true });
    if (u.pathname === "/api/categories" && method === "POST") { if (![...DEFAULTS, ...CUSTOM.map((c) => c.name)].some((n) => n.toLowerCase() === String(body.name).toLowerCase())) CUSTOM.push({ id: ++catId, name: body.name }); return json(catData(), 201); }
    if (catm && method === "PATCH") { const c = CUSTOM.find((x) => x.id === Number(catm[1])); if (c) c.name = body.name; return json(catData()); }
    if (catm && method === "DELETE") { CUSTOM = CUSTOM.filter((c) => c.id !== Number(catm[1])); return json(catData()); }
    if (u.pathname === "/api/expenses" && method === "GET") {
      const cat = u.searchParams.get("category");
      let rows = EXP.slice().sort((a, b) => b.spent_on.localeCompare(a.spent_on));
      if (cat) rows = rows.filter((e) => e.category === cat);
      return json({ expenses: rows, categories: catData().names });
    }
    if (u.pathname === "/api/expenses" && method === "POST") { const e = { id: ++id + 100, ...body, created_by: { id: 90, name: "Front Desk" }, created_at: new Date().toISOString() }; EXP.unshift(e); return json({ expense: e }, 201); }
    if (idm && method === "PATCH") { const e = EXP.find((x) => x.id === Number(idm[1])); Object.assign(e, body); return json({ expense: e }); }
    if (idm && method === "DELETE") { const i = EXP.findIndex((x) => x.id === Number(idm[1])); if (i >= 0) EXP.splice(i, 1); return json({ ok: true }); }
    return new Response("{}", { status: 404 });
  };
}

export function mockSession(): BvSession {
  return {
    inkress: { notify: ({ message }: any) => console.log("[toast]", message) } as any,
    merchant: { id: 183, username: "bookerva-jackjack", name: "Jack Jack Barbershop", currency_code: "JMD", email: "jack@example.com", logo: null },
    user: { id: 90, name: "Front Desk", email: "desk@jackjack.com" },
    scopes: ["orders:read"],
  };
}
