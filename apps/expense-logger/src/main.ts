import "./index.css";
import {
  initBv, bvApi, makeToast, type BvToastFn,
  mountShell, statRow, dataTable, card, openModal, flash,
  fmtMoney, fmtDate, pill, emptyState, h, iconEl,
} from "./bv-init";

interface Expense { id: number; spent_on: string; amount: number; tax_amount: number; currency: string; category: string; vendor: string | null; note: string | null; receipt_url: string | null; created_by: { id: number; name: string } | null; created_at: string; }
interface Overview { range: string; currency: string; revenue: number; revenue_ok: boolean; expenses_total: number; profit: number; margin: number | null; expense_count: number; by_category: { category: string; amount: number }[]; by_vendor: { vendor: string; amount: number }[]; by_month: { month: string; amount: number }[]; budgets: { category: string; limit: number; spent: number; over: boolean }[]; recent: Expense[]; }
interface Recurring { id: number; category: string; amount: number; vendor: string | null; note: string | null; currency: string; day_of_month: number; active: boolean; }
let canStore = false;

const root = document.getElementById("root")!;
let toast: BvToastFn;
let merchantName = "Merchant";
let currency = "JMD";
let range = "30d";
let expFilter = "";
let activeTab = "overview";
let categories: string[] = ["Supplies", "Rent", "Salaries", "Utilities", "Marketing", "Equipment", "Inventory", "Transport", "Fees", "Other"];
let shell: ReturnType<typeof mountShell>;

const RANGES: [string, string][] = [["30d", "30 days"], ["90d", "90 days"], ["365d", "12 months"]];

(async () => {
  let session;
  if (import.meta.env.DEV && !new URLSearchParams(location.search).has("inkress_session")) {
    const m = await import("./dev-mock"); m.installMockFetch(); session = m.mockSession();
  } else {
    try { session = await initBv(); }
    catch (err: any) { root.innerHTML = ""; root.append(fatal(err?.message)); return; }
  }
  toast = makeToast(session.inkress);
  merchantName = session.merchant.name || session.merchant.username || "Merchant";
  currency = session.merchant.currency_code || "JMD";
  try { const c = await bvApi<{ names: string[]; storage: boolean }>("/api/categories"); categories = c.names; canStore = !!c.storage; } catch { /* keep defaults */ }

  shell = mountShell({
    brandIcon: "wallet",
    brandLogo: "/logo.svg",
    title: "Expense Logger",
    subtitle: `${merchantName} · track spend, see real profit`,
    poweredBy: "Marketplace",
    tabs: [
      { id: "overview", label: "Overview", icon: "pie", render: renderOverview },
      { id: "expenses", label: "Expenses", icon: "list", render: renderExpenses },
      { id: "recurring", label: "Recurring", icon: "clock", render: renderRecurring },
    ],
  });
})();

/* ------------------------------------------------------------------ Overview */
async function renderOverview(host: HTMLElement) {
  activeTab = "overview";
  const rangeBar = h("div", { class: "ex-ranges" },
    ...RANGES.map(([v, l]) => h("button", { class: "ex-range" + (range === v ? " is-on" : ""), onClick: () => { range = v; shell.select("overview"); } }, l)));
  const addBtn = h("button", { class: "primary", onClick: () => openExpense(null) }, iconEl("plus", 16), "Add expense");

  host.append(h("div", { class: "ex-top" }, h("h2", null, "Profit & loss"), h("div", { class: "ex-top-actions" }, rangeBar, addBtn)));

  const body = h("div");
  host.append(body);
  body.append(h("div", { class: "bv-muted", style: { padding: "12px 2px" } }, "Loading…"));
  let o: Overview;
  try { o = await bvApi(`/api/overview?range=${range}`); }
  catch (err: any) { body.innerHTML = ""; body.append(emptyState({ icon: "alert", title: "Couldn't load", text: err?.message })); return; }
  body.innerHTML = "";

  body.append(statRow([
    { k: "Revenue (Inkress)", v: o.revenue_ok ? fmtMoney(o.revenue, o.currency) : "—", tone: "ok", icon: "coins" },
    { k: "Expenses", v: fmtMoney(o.expenses_total, o.currency), tone: "bad", icon: "receipt" },
    { k: "Profit", v: fmtMoney(o.profit, o.currency), d: o.margin != null ? `${o.margin}% margin` : undefined, tone: o.profit >= 0 ? "accent" : "bad", icon: "chart" },
    { k: "Logged", v: String(o.expense_count), icon: "edit" },
  ]));

  if (o.budgets.length) body.append(card({ title: "Budgets (this month)", body: h("div", { class: "ex-budgets" }, ...o.budgets.map((b) => {
    const pct = Math.min(100, Math.round((b.spent / b.limit) * 100));
    return h("div", { class: "ex-budget" + (b.over ? " is-over" : "") },
      h("div", { class: "ex-budget-head" }, h("span", null, b.category), h("b", null, `${fmtMoney(b.spent, o.currency)} / ${fmtMoney(b.limit, o.currency)}`)),
      h("div", { class: "ex-cat-track" }, h("div", { class: "ex-cat-fill", style: { width: `${pct}%` } })));
  })) }));

  if (o.by_month.length > 1) body.append(card({ title: "Spend over time", body: monthBars(o.by_month, o.currency) }));

  const cols = h("div", { class: "ex-cols" });
  cols.append(card({ title: "By category", body: o.by_category.length ? catBars(o.by_category, o.currency) : h("div", { class: "bv-muted", style: { padding: "6px 2px" } }, "No expenses in this range.") }));
  if (o.by_vendor.length) cols.append(card({ title: "Top vendors", body: h("table", { class: "bv-table" }, h("tbody", null, ...o.by_vendor.map((v) => h("tr", null, h("td", null, v.vendor), h("td", { class: "num" }, fmtMoney(v.amount, o.currency)))))) }));
  cols.append(card({
    title: "Recent expenses",
    action: o.recent.length ? h("button", { class: "ghost sm", onClick: () => shell.select("expenses") }, "View all") : undefined,
    body: o.recent.length ? h("table", { class: "bv-table" }, h("tbody", null, ...o.recent.map((e) =>
      h("tr", { onClick: () => openExpense(e), style: { cursor: "pointer" } },
        h("td", null, h("strong", null, e.category), h("div", { class: "bv-muted" }, `${fmtDate(e.spent_on)}${e.vendor ? ` · ${e.vendor}` : ""}`)),
        h("td", { class: "num" }, fmtMoney(e.amount, e.currency))))))
      : emptyState({ icon: "wallet", title: "No expenses yet", text: "Log your first expense to see profit." }),
  }));
  body.append(cols);
  if (!o.revenue_ok) body.append(h("div", { class: "ex-note bv-muted" }, iconEl("alert", 14), "Couldn't read Inkress revenue — profit excludes sales for now."));
}

function monthBars(byMonth: { month: string; amount: number }[], cur: string) {
  const max = Math.max(...byMonth.map((m) => m.amount), 1);
  const wrap = h("div", { class: "ex-months" });
  for (const m of byMonth) wrap.append(h("div", { class: "ex-month", title: `${m.month}: ${fmtMoney(m.amount, cur)}` },
    h("div", { class: "ex-month-fill", style: { height: `${Math.max(4, Math.round((m.amount / max) * 100))}%` } }), h("div", { class: "ex-month-label" }, m.month.slice(5))));
  return wrap;
}
function catBars(byCat: { category: string; amount: number }[], cur: string) {
  const max = Math.max(...byCat.map((c) => c.amount), 1);
  const wrap = h("div", { class: "ex-cats" });
  for (const c of byCat) {
    wrap.append(h("div", { class: "ex-cat" },
      h("div", { class: "ex-cat-head" }, h("span", null, c.category), h("b", null, fmtMoney(c.amount, cur))),
      h("div", { class: "ex-cat-track" }, h("div", { class: "ex-cat-fill", style: { width: `${Math.round((c.amount / max) * 100)}%` } }))));
  }
  return wrap;
}

/* ------------------------------------------------------------------ Expenses */
async function renderExpenses(host: HTMLElement) {
  activeTab = "expenses";
  host.append(h("div", { class: "bv-muted", style: { padding: "12px 2px" } }, "Loading…"));
  let data: { expenses: Expense[]; categories: string[] };
  try { data = await bvApi(`/api/expenses?range=365d${expFilter ? `&category=${encodeURIComponent(expFilter)}` : ""}`); categories = data.categories; }
  catch (err: any) { host.innerHTML = ""; host.append(emptyState({ icon: "alert", title: "Couldn't load", text: err?.message })); return; }
  host.innerHTML = "";

  const cats = [...new Set(data.expenses.map((e) => e.category))];
  const filters = h("div", { class: "ex-filters" },
    h("button", { class: "ex-filter" + (expFilter === "" ? " is-on" : ""), onClick: () => { expFilter = ""; shell.select("expenses"); } }, "All"),
    ...cats.map((c) => h("button", { class: "ex-filter" + (expFilter === c ? " is-on" : ""), onClick: () => { expFilter = c; shell.select("expenses"); } }, c)));
  const addBtn = h("button", { class: "primary", onClick: () => openExpense(null) }, iconEl("plus", 15), "Add");
  const catBtn = h("button", { class: "ghost sm", onClick: () => manageCategories() }, iconEl("tag", 14), "Categories");
  const csvBtn = h("button", { class: "ghost sm", onClick: () => exportCsv(data.expenses) }, iconEl("download", 14), "CSV");

  host.append(card({
    title: "Expenses", action: h("div", { class: "ex-top-actions" }, filters, catBtn, csvBtn, addBtn),
    body: data.expenses.length ? dataTable<Expense>({
      columns: [
        { head: "Date", cell: (e) => fmtDate(e.spent_on) },
        { head: "Category", cell: (e) => pill(e.category) },
        { head: "Vendor", cell: (e) => h("span", { class: "bv-muted" }, e.vendor || "—") },
        { head: "Receipt", cell: (e) => e.receipt_url ? h("a", { href: e.receipt_url, target: "_blank", rel: "noopener", onClick: (ev: Event) => ev.stopPropagation() }, iconEl("eye", 14)) : h("span", { class: "bv-muted" }, "—") },
        { head: "Amount", num: true, cell: (e) => fmtMoney(e.amount, e.currency) },
      ],
      rows: data.expenses,
      onRowClick: (e) => openExpense(e),
    }) : emptyState({ icon: "wallet", title: "No expenses logged", text: "Add expenses to track your spend and profit." }),
  }));
}

function exportCsv(rows: Expense[]) {
  const esc = (v: any) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = ["date,category,vendor,amount,tax,currency,note"];
  for (const e of rows) lines.push([e.spent_on, e.category, e.vendor, e.amount, e.tax_amount, e.currency, e.note].map(esc).join(","));
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }));
  a.download = `expenses-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000); flash(`Exported ${rows.length}`, "success");
}

/* ------------------------------------------------------------------ Recurring */
async function renderRecurring(host: HTMLElement) {
  activeTab = "recurring";
  let rows: Recurring[];
  try { rows = (await bvApi<{ recurring: Recurring[] }>("/api/recurring")).recurring; }
  catch (err: any) { host.append(emptyState({ icon: "alert", title: "Couldn't load", text: err?.message })); return; }
  const list = rows.length ? dataTable<Recurring>({
    columns: [
      { head: "Category", cell: (r) => pill(r.category) },
      { head: "Amount", num: true, cell: (r) => fmtMoney(r.amount, r.currency) },
      { head: "Vendor", cell: (r) => h("span", { class: "bv-muted" }, r.vendor || "—") },
      { head: "Day", cell: (r) => `day ${r.day_of_month}` },
      { head: "Active", cell: (r) => r.active ? pill("on", "ok") : pill("off") },
    ], rows,
    rowActions: (r) => h("div", { class: "ex-top-actions" },
      h("button", { class: "ghost sm", onClick: () => openRecurring(r) }, iconEl("edit", 14)),
      h("button", { class: "ghost sm", onClick: async () => { await bvApi(`/api/recurring/${r.id}`, { method: "DELETE" }); shell.select("recurring"); } }, iconEl("trash", 14))),
  }) : emptyState({ icon: "clock", title: "No recurring expenses", text: "Add rent, salaries or utilities — they'll be logged automatically each month." });
  const add = h("button", { class: "primary", onClick: () => openRecurring(null) }, iconEl("plus", 15), "New recurring");
  host.append(card({ title: "Recurring expenses", action: add, body: list }));
}

function openRecurring(r: Recurring | null) {
  const amount = h("input", { type: "number", min: "0", step: "0.01", value: r ? String(r.amount) : "", placeholder: "0.00" }) as HTMLInputElement;
  const category = h("select", null, ...categories.map((c) => h("option", { value: c, selected: r?.category === c }, c))) as HTMLSelectElement;
  const vendor = h("input", { value: r?.vendor || "", placeholder: "Vendor (optional)" }) as HTMLInputElement;
  const day = h("input", { type: "number", min: "1", max: "28", value: String(r?.day_of_month || 1) }) as HTMLInputElement;
  const active = h("input", { type: "checkbox", checked: r ? r.active : true }) as HTMLInputElement;
  const body = h("div", { class: "ex-form" }, h("div", { class: "ex-form-grid" }, field("Amount", amount), field("Category", category), field("Vendor", vendor), field("Day of month", day)),
    r ? h("label", { class: "ex-check" }, active, " Active") : null);
  openModal({ title: r ? "Edit recurring" : "New recurring expense", body, actions: [{ label: r ? "Save" : "Add", primary: true, onClick: () => { void (async () => {
    if (!(Number(amount.value) > 0)) { toast("Enter an amount", "warning"); return; }
    const payload: any = { amount: Number(amount.value), category: category.value, vendor: vendor.value || null, day_of_month: Number(day.value), currency };
    try { if (r) { payload.active = active.checked; await bvApi(`/api/recurring/${r.id}`, { method: "PATCH", body: JSON.stringify(payload) }); } else await bvApi("/api/recurring", { method: "POST", body: JSON.stringify(payload) }); flash("Saved", "success"); shell.select("recurring"); }
    catch (err: any) { toast(err?.message || "error", "error"); } })(); } }] });
}

function openExpense(e: Expense | null) {
  const today = new Date().toISOString().slice(0, 10);
  const date = h("input", { type: "date", value: e?.spent_on?.slice(0, 10) || today }) as HTMLInputElement;
  const amount = h("input", { type: "number", min: "0", step: "0.01", value: e ? String(e.amount) : "", placeholder: "0.00" }) as HTMLInputElement;
  const category = h("select", null, ...categories.map((c) => h("option", { value: c, selected: e?.category === c }, c))) as HTMLSelectElement;
  const vendor = h("input", { value: e?.vendor || "", placeholder: "Who you paid (optional)" }) as HTMLInputElement;
  const tax = h("input", { type: "number", min: "0", step: "0.01", value: e?.tax_amount ? String(e.tax_amount) : "", placeholder: "0.00" }) as HTMLInputElement;
  const note = h("input", { value: e?.note || "", placeholder: "Note (optional)" }) as HTMLInputElement;
  let receiptUrl: string | null = e?.receipt_url ?? null;

  const preview = h("span", { class: "ex-receipt" + (receiptUrl ? "" : " is-empty"), style: receiptUrl ? { backgroundImage: `url('${receiptUrl}')` } : {} });
  const fileInput = h("input", { type: "file", accept: "image/*", style: { display: "none" } }) as HTMLInputElement;
  fileInput.addEventListener("change", () => {
    const f = fileInput.files?.[0]; if (!f) return;
    if (f.size > 5 * 1024 * 1024) { toast("Image must be under 5MB", "warning"); return; }
    const reader = new FileReader();
    reader.onload = async () => { try { const r = await bvApi<{ url: string }>("/api/upload", { method: "POST", body: JSON.stringify({ data: reader.result }) }); receiptUrl = r.url; preview.className = "ex-receipt"; preview.style.backgroundImage = `url('${r.url}')`; flash("Receipt attached", "success"); } catch (err: any) { toast(err?.message || "Upload failed", "error"); } };
    reader.readAsDataURL(f);
  });
  const upBtn = h("button", { class: "ghost sm", disabled: !canStore, title: canStore ? "" : "Receipt hosting not configured", onClick: () => fileInput.click() }, iconEl("download", 14), receiptUrl ? "Replace receipt" : "Attach receipt");

  const body = h("div", { class: "ex-form" },
    h("div", { class: "ex-form-grid" }, field("Date", date), field("Amount", amount), field("Tax (of amount)", tax), field("Category", category), field("Vendor", vendor)),
    field("Note", note),
    h("div", { class: "ex-receiptrow" }, preview, upBtn, fileInput));

  const save = async () => {
    const amt = Number(amount.value);
    if (!(amt > 0)) { toast("Enter an amount", "warning"); return; }
    const payload = { spent_on: date.value, amount: amt, tax_amount: Number(tax.value) || 0, category: category.value, vendor: vendor.value || null, note: note.value || null, receipt_url: receiptUrl, currency };
    try {
      if (e) await bvApi(`/api/expenses/${e.id}`, { method: "PATCH", body: JSON.stringify(payload) });
      else await bvApi("/api/expenses", { method: "POST", body: JSON.stringify(payload) });
      flash(e ? "Expense updated" : "Expense added", "success");
      shell.select(activeTab);
    } catch (err: any) { toast(err?.message || "error", "error"); }
  };

  const actions: { label: string; primary?: boolean; danger?: boolean; onClick?: () => void | boolean }[] = [
    { label: e ? "Save" : "Add expense", primary: true, onClick: () => { void save(); } },
  ];
  if (e) actions.unshift({ label: "Delete", danger: true, onClick: () => { void (async () => { try { await bvApi(`/api/expenses/${e.id}`, { method: "DELETE" }); flash("Deleted", "info"); shell.select("expenses"); } catch (err: any) { toast(err?.message || "error", "error"); } })(); } });
  openModal({ title: e ? "Edit expense" : "Add expense", body, actions });
}

/* ---------------------------------------------------------------- Categories */
interface CatData { names: string[]; defaults: string[]; custom: { id: number; name: string }[]; }

function manageCategories() {
  const list = h("div", { class: "ex-cat-list" });
  const input = h("input", { placeholder: "New category, e.g. Insurance", maxlength: "40" }) as HTMLInputElement;
  const apply = (d: CatData) => { categories = d.names; };
  const reload = async () => {
    list.innerHTML = "";
    let d: CatData;
    try { d = await bvApi<CatData>("/api/categories"); } catch (err: any) { list.append(h("div", { class: "bv-muted" }, err?.message || "Couldn't load")); return; }
    apply(d);
    list.append(h("div", { class: "ex-cat-section" }, "Built-in"));
    list.append(h("div", { class: "ex-cat-chips" }, ...d.defaults.map((c) => h("span", { class: "bv-pill" }, c))));
    list.append(h("div", { class: "ex-cat-section" }, "Your categories"));
    if (!d.custom.length) list.append(h("div", { class: "bv-muted", style: { padding: "2px 0 4px" } }, "None yet — add one below."));
    else list.append(h("div", { class: "ex-cat-chips" }, ...d.custom.map((c) =>
      h("span", { class: "ex-cat-chip" }, c.name,
        h("button", { class: "ex-cat-x", title: "Rename", onClick: () => { const nv = prompt("Rename category", c.name); if (nv && nv.trim()) void (async () => { try { apply(await bvApi<CatData>(`/api/categories/${c.id}`, { method: "PATCH", body: JSON.stringify({ name: nv.trim() }) })); await reload(); } catch (err: any) { toast(err?.message || "error", "error"); } })(); } }, iconEl("edit", 12)),
        h("button", { class: "ex-cat-x", title: "Remove", onClick: async () => { try { apply(await bvApi<CatData>(`/api/categories/${c.id}`, { method: "DELETE" })); await reload(); } catch (err: any) { toast(err?.message || "error", "error"); } } }, iconEl("x", 12))))));
  };
  const add = async () => {
    const name = input.value.trim();
    if (!name) return;
    try { apply(await bvApi<CatData>("/api/categories", { method: "POST", body: JSON.stringify({ name }) })); input.value = ""; flash("Category added", "success"); await reload(); }
    catch (err: any) { toast(err?.message || "error", "error"); }
  };
  input.addEventListener("keydown", (e: KeyboardEvent) => { if (e.key === "Enter") { e.preventDefault(); void add(); } });
  const body = h("div", { class: "ex-cat-manage" }, list,
    h("div", { class: "ex-cat-add" }, input, h("button", { class: "primary sm", onClick: () => { void add(); } }, iconEl("plus", 14), "Add")));
  openModal({ title: "Expense categories", body, actions: [{ label: "Done", onClick: () => { shell.select(activeTab); } }] });
  void reload();
}

/* -------------------------------------------------------------------- helpers */
function field(label: string, el: HTMLElement) { return h("label", { class: "ex-field" }, h("span", { class: "bv-label" }, label), el); }
function fatal(msg?: string) {
  return h("div", { class: "bv-empty", style: { margin: "40px auto" } }, h("h3", null, "Expense Logger couldn't load"), h("p", null, msg || "Open this app from the Inkress dashboard."));
}
