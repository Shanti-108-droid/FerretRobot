
import React, { useMemo, useState } from "react";
import { ArtPollock } from "./ArtPollock";

// ===== Config =====
const BRIDGE_BASE =
  (import.meta as any).env?.VITE_BRIDGE_BASE || "http://localhost:8002";

// ===== Tipos =====
type Mode = "PRESUPUESTO" | "FACTURA" | "REMITO";

type SearchResult = {
  item_code: string;
  item_name: string;
  stock_uom?: string;
  price_list_rate?: number;
  rate?: number;
  actual_qty?: number;
  description?: string | null;
};

type BackendItem = {
  index: number;
  code: string;
  name: string;
  uom: string;
  rate: number;
  qty: number;
  brand?: string | null;
  desc?: string | null;
  hit_fields?: string[];
  terms?: string[];
};

type CartLine = {
  item_code: string;
  item_name: string;
  uom: string;
  qty: number;
  unit_price: number;
  subtotal: number;
  warehouse?: string;
  taxes?: Record<string, any>;
};

type DocumentState = {
  mode: Mode;
  company: string;
  pos_profile: string;
  currency: string;
  customer?: string;
  apply_discount_on?: "Grand Total" | "Net Total";
  additional_discount_percentage?: number;
  discount_amount?: number;
  update_stock: 0 | 1;
};

// ===== Utils highlight/ranking =====
function stripDiacritics(s: string) {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[”“″′]/g, '"')
    .replace(/[º°]/g, "")
    .replace(/½/g, "1/2")
    .replace(/¼/g, "1/4")
    .replace(/¾/g, "3/4");
}
function normalizeTextFront(s: string) {
  return stripDiacritics((s || "") + "")
    .replace(/[^a-z0-9/.\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function tokenizeTerms(q: string): string[] {
  const t = normalizeTextFront(q);
  return t ? t.split(" ") : [];
}
type Range = { start: number; end: number };
function findMatchRanges(text: string, terms: string[]): Range[] {
  if (!text || !terms?.length) return [];
  const norm = stripDiacritics(text);
  const ranges: Range[] = [];
  for (const rawTerm of terms) {
    const term = stripDiacritics(rawTerm);
    if (!term) continue;
    let idx = 0;
    while (true) {
      const pos = norm.indexOf(term, idx);
      if (pos === -1) break;
      ranges.push({ start: pos, end: pos + term.length });
      idx = pos + term.length;
    }
  }
  ranges.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Range[] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (!last || r.start > last.end) merged.push({ ...r });
    else last.end = Math.max(last.end, r.end);
  }
  return merged;
}
function highlightText(text: string, terms: string[] | undefined) {
  if (!text || !terms || !terms.length) return text;
  const ranges = findMatchRanges(text, terms);
  if (ranges.length === 0) return text;
  const out: React.ReactNode[] = [];
  let cursor = 0;
  ranges.forEach((r, i) => {
    if (cursor < r.start) out.push(text.slice(cursor, r.start));
    out.push(
      <span key={`hl-${i}-${r.start}-${r.end}`} className="bg-yellow-200/60 rounded-sm px-0.5">
        {text.slice(r.start, r.end)}
      </span>
    );
    cursor = r.end;
  });
  if (cursor < text.length) out.push(text.slice(cursor));
  return <>{out}</>;
}

// ===== App =====
export default function POSOverlaySkeleton() {
  // Estado
  const [mode, setMode] = useState<Mode>("PRESUPUESTO");
  const [customer, setCustomer] = useState<string>("Consumidor Final");
  const [discountPct, setDiscountPct] = useState<number>(0);
  const [searchTerm, setSearchTerm] = useState<string>("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [backendItems, setBackendItems] = useState<BackendItem[]>([]);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [qty, setQty] = useState<number>(1); // qty “global” (atajos/voz)
  const [qtyPer, setQtyPer] = useState<Record<string, number>>({}); // qty por fila
  const [cart, setCart] = useState<CartLine[]>([]);
  const [log, setLog] = useState<string[]>([]);
  const [micOn, setMicOn] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(false);

  const docState: DocumentState = useMemo(
    () => ({
      mode,
      company: "Hi Tech",
      pos_profile: "Sucursal Adrogue",
      currency: "ARS",
      customer,
      apply_discount_on: "Grand Total",
      additional_discount_percentage: discountPct,
      discount_amount: 0,
      update_stock: mode === "FACTURA" || mode === "REMITO" ? 1 : 0,
    }),
    [mode, customer, discountPct]
  );

  // Helpers
  const appendLog = (line: string) => setLog((l) => [line, ...l].slice(0, 100));
  const total = useMemo(() => {
    const net = cart.reduce((s, r) => s + r.subtotal, 0);
    const disc = discountPct > 0 ? net * (discountPct / 100) : 0;
    return { net, discount: disc, grand: Math.max(0, net - disc) };
  }, [cart, discountPct]);

  // ===== API
  // /bridge/search_with_stock + filtro + ranking + highlight en el front
  async function apiSearch(term: string): Promise<SearchResult[]> {
    setLoading(true);
    try {
      const r = await fetch(`${BRIDGE_BASE}/bridge/search_with_stock`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: term,
          warehouse: "Sucursal Adrogue - HT",
          pos_profile: "Sucursal Adrogue",
          limit: 20,
          page: 1,
        }),
      });
      if (!r.ok) throw new Error(`search_with_stock status ${r.status}`);
      const data = await r.json();
      const list: SearchResult[] = (data && data.message) || [];

      // tokens, filtro (exigir TODOS los tokens en name/code/desc) y score (stock primero + relevancia)
      const toks = tokenizeTerms(term);
      const isMatch = (it: SearchResult) => {
        if (toks.length === 0) return true;
        const nName = normalizeTextFront(it.item_name || "");
        const nCode = normalizeTextFront(it.item_code || "");
        const nDesc = normalizeTextFront(it.description || "");
        return toks.every((t) => nName.includes(t) || nCode.includes(t) || nDesc.includes(t));
      };
      const filtered = list.filter(isMatch);

      type Scored = { it: SearchResult; score: number; hit_fields: string[] };
      const scored: Scored[] = filtered.map((it) => {
        const nName = normalizeTextFront(it.item_name || "");
        const nCode = normalizeTextFront(it.item_code || "");
        const qty = Number(it.actual_qty || 0);
        let score = 0;
        if (qty > 0) score += 1000;
        for (const tok of toks) {
          if (!tok) continue;
          if (nName === tok || nCode === tok) score += 50;
          if (nName.startsWith(tok) || nCode.startsWith(tok)) score += 20;
          if (nName.includes(tok)) score += 10;
          if (nCode.includes(tok)) score += 8;
        }
        const hit_fields: string[] = [];
        if (toks.some((t) => nName.includes(t))) hit_fields.push("name");
        if (toks.some((t) => nCode.includes(t))) hit_fields.push("code");
        return { it, score, hit_fields };
      });

      scored.sort((a, b) => b.score - a.score);

      // construir backendItems para highlight + numeración 1..N
      const newBackendItems: BackendItem[] = scored.map((s, idx) => ({
        index: idx + 1,
        code: s.it.item_code,
        name: s.it.item_name,
        uom: s.it.stock_uom || "Nos",
        rate: (s.it.price_list_rate ?? s.it.rate ?? 0) as number,
        qty: (s.it.actual_qty ?? 0) as number,
        brand: undefined,
        desc: undefined,
        hit_fields: s.hit_fields,
        terms: toks,
      }));
      setBackendItems(newBackendItems);

      return scored.slice(0, 20).map((s) => s.it);
    } catch (e: any) {
      appendLog(`✖ búsqueda falló: ${e?.message ?? e}`);
      setBackendItems([]);
      return [];
    } finally {
      setLoading(false);
    }
  }

  async function apiGetItemDetail(res: SearchResult, qOverride?: number): Promise<CartLine | null> {
    setLoading(true);
    try {
      const q = (qOverride ?? qty) as number;
      const r = await fetch(`${BRIDGE_BASE}/bridge/item-detail`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ item_code: res.item_code, qty: q, mode }),
      });
      if (!r.ok) throw new Error(`detail status ${r.status}`);
      const data = await r.json();
      const m = data?.message ?? {};
      const unit =
        typeof m.price_list_rate === "number"
          ? m.price_list_rate
          : (res.price_list_rate ?? res.rate ?? 0);
      const uom = m.uom || res.stock_uom || "Nos";
      const line: CartLine = {
        item_code: res.item_code,
        item_name: res.item_name,
        uom,
        qty: q,
        unit_price: unit,
        subtotal: +(unit * q).toFixed(2),
        warehouse: "Sucursal Adrogue - HT",
        taxes: {},
      };
      return line;
    } catch (e: any) {
      appendLog(`✖ item-detail falló: ${e?.message ?? e}`);
      return null;
    } finally {
      setLoading(false);
    }
  }

  async function apiConfirmDocument(): Promise<{ ok: boolean; number?: string }> {
    setLoading(true);
    try {
      const r = await fetch(`${BRIDGE_BASE}/bridge/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode,
          customer,
          items: cart.map((c) => ({
            item_code: c.item_code,
            qty: c.qty,
            uom: c.uom,
            price_list_rate: c.unit_price,
          })),
          discount_pct: discountPct,
        }),
      });
      if (!r.ok) throw new Error(`confirm status ${r.status}`);
      const data = await r.json();
      return { ok: !!data?.ok, number: data?.number };
    } catch (e: any) {
      appendLog(`✖ confirmar falló: ${e?.message ?? e}`);
      return { ok: false };
    } finally {
      setLoading(false);
    }
  }

  // ===== Dispatcher
  type Action = { action: string; params?: Record<string, any> };
  async function dispatchAction(a: Action) {
    switch (a.action) {
      case "set_mode": {
        const m = (a.params?.mode ?? "").toString().toUpperCase();
        if (m === "PRESUPUESTO" || m === "FACTURA" || m === "REMITO") {
          setMode(m as Mode);
          appendLog(`modo → ${m}`);
        } else appendLog(`modo inválido: ${a.params?.mode}`);
        break;
      }
      case "search": {
        const term = (a.params?.term ?? "").toString();
        const data = await apiSearch(term);
        setResults(data);
        setSelectedIndex(data.length ? 1 : null);
        setSearchTerm(term);
        appendLog(`buscando: "${term}" (${data.length} resultados)`);
        break;
      }
      case "select_index": {
        const idx = Number(a.params?.index ?? 0);
        if (idx >= 1 && idx <= results.length) {
          setSelectedIndex(idx);
          const codeSel = results[idx - 1]?.item_code;
          const qSel = qtyPer[codeSel] ?? qty;
          setQty(qSel);
          appendLog(`seleccionado índice ${idx} (${results[idx - 1]?.item_name})`);
        } else appendLog(`índice fuera de rango (${idx})`);
        break;
      }
      case "set_qty": {
        const q = Math.max(1, Math.floor(Number(a.params?.qty ?? 1)));
        setQty(q);
        appendLog(`cantidad → ${q}`);
        break;
      }
      case "add_to_cart": {
        if (selectedIndex == null) {
          appendLog("no hay selección");
          break;
        }
        const res = results[selectedIndex - 1];
        const q = qtyPer[res.item_code] ?? qty; // cantidad de esa fila (o global si no hay)
        const line = await apiGetItemDetail(res, q);
        if (line) {
          setCart((c) => [...c, line]);
          appendLog(`+ ${line.qty} x ${line.item_name} @ ${line.unit_price} → ${line.subtotal}`);
        }
        break;
      }
      case "set_global_discount": {
        if (a.params?.percent != null) {
          const p = Math.max(0, Math.min(100, Number(a.params.percent)));
          setDiscountPct(p);
          appendLog(`descuento → ${p}%`);
        }
        break;
      }
      case "set_customer": {
        const name = (a.params?.name ?? "").toString().trim();
        if (name) {
          setCustomer(name);
          appendLog(`cliente → ${name}`);
        }
        break;
      }
      case "confirm_document": {
        const res = await apiConfirmDocument();
        if (res.ok) {
          appendLog(`✔ confirmado (${res.number}) total: ${total.grand.toFixed(2)} ${docState.currency}`);
          setCart([]); setDiscountPct(0); setQty(1);
        } else appendLog("✖ error al confirmar");
        break;
      }
      case "clear_cart": {
        setCart([]); setDiscountPct(0); setQty(1);
        appendLog("carrito vacío");
        break;
      }
      case "repeat": {
        appendLog(
          `TOTAL → neto ${total.net.toFixed(2)} desc ${total.discount.toFixed(2)} = ${total.grand.toFixed(2)} ${docState.currency}`
        );
        break;
      }
      default: appendLog(`acción desconocida: ${a.action}`);
    }
  }

  // ===== UI
  const ACTIONS_DOC = `
[CATALOGO_ACCIONES]
- set_mode(mode)
- search(term)
- select_index(index)
- set_qty(qty)
- add_to_cart()
- set_global_discount(percent)
- set_customer(name)
- confirm_document()
- clear_cart()
- repeat()
`;

  return (
    <div className="relative min-h-screen w-full text-neutral-900 bg-neutral-50">
      <ArtPollock
        density={140}
        opacityRange={[0.25, 0.4]}
        strokeRange={[1.5, 3]}
        colors={["#E8D5FF", "#C7F2F0", "#FFE2B8", "#FFD6E0", "#DDE8FF"]}
      />
      <div className="relative z-10 p-4">
        <div className="mx-auto max-w-6xl grid grid-cols-2 gap-4">
          {/* Header */}
          <div className="col-span-2 flex flex-wrap items-center justify-between gap-3 bg-white/80 backdrop-blur rounded-2xl shadow p-3">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">Modo</span>
              <select
                className="border rounded-xl px-3 py-2"
                value={mode}
                onChange={(e) => dispatchAction({ action: "set_mode", params: { mode: e.target.value } })}
              >
                <option value="PRESUPUESTO">Presupuesto</option>
                <option value="FACTURA">Factura</option>
                <option value="REMITO">Remito</option>
              </select>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">Cliente</span>
              <input
                className="border rounded-xl px-3 py-2 w-60"
                value={customer}
                onChange={(e) => dispatchAction({ action: "set_customer", params: { name: e.target.value } })}
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">Desc. (%)</span>
              <input
                type="number"
                className="border rounded-xl px-3 py-2 w-24"
                value={discountPct}
                min={0} max={100}
                onChange={(e) => dispatchAction({ action: "set_global_discount", params: { percent: Number(e.target.value) } })}
              />
            </div>
            <div className="flex items-center gap-2">
              <button
                className={`rounded-xl px-3 py-2 ${micOn ? "bg-green-600 text-white" : "bg-neutral-200"}`}
                onClick={() => setMicOn((m) => !m)}
                title="Mic (stub)"
              >
                🎤 {micOn ? "ON" : "OFF"}
              </button>
              <input
                className="border rounded-xl px-3 py-2 w-80"
                placeholder="Decí algo… ej: 'buscar caño 3/4', 'ítem 1', 'cantidad 3'"
                onKeyDown={async (e) => {
                  if (e.key === "Enter") {
                    const v = (e.target as HTMLInputElement).value;
                    (e.target as HTMLInputElement).value = "";
                    await dispatchAction({ action: "search", params: { term: v } });
                  }
                }}
              />
              <button
                className="rounded-xl px-4 py-2 bg-neutral-800 text-white"
                onClick={() => dispatchAction({ action: "confirm_document" })}
                disabled={loading || cart.length === 0}
              >
                {loading ? "Procesando…" : "Confirmar"}
              </button>
            </div>
          </div>

          {/* Panel izquierdo: búsqueda */}
          <div className="bg-white/80 backdrop-blur rounded-2xl shadow p-3">
            <div className="flex items-center gap-2 mb-3">
              <input
                className="border rounded-xl px-3 py-2 w-full"
                placeholder="¿Qué buscás?"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                onKeyDown={async (e) => {
                  if (e.key === "Enter") await dispatchAction({ action: "search", params: { term: searchTerm } });
                }}
              />
              <button
                className="rounded-xl px-3 py-2 bg-neutral-800 text-white"
                onClick={async () => await dispatchAction({ action: "search", params: { term: searchTerm } })}
                disabled={loading}
              >
                {loading ? "Buscando…" : "Buscar"}
              </button>
            </div>

            <div className="divide-y border rounded-xl overflow-hidden max-h-96 overflow-y-auto">
              {results.map((r, i) => {
                const bi = backendItems.find((x) => x.code === r.item_code);
                const index = bi?.index ?? (i + 1);
                const mergedQty = r.actual_qty ?? bi?.qty ?? 0;
                const inStock = mergedQty > 0;
                const price = r.price_list_rate ?? r.rate ?? bi?.rate ?? 0;
                const uom = r.stock_uom ?? bi?.uom ?? "Nos";
                const code = r.item_code ?? "";
                const brand = bi?.brand ?? undefined;
                const terms = bi?.terms ?? [];
                const hit = new Set(bi?.hit_fields ?? []);
                const nameNode = hit.has("name") ? highlightText(r.item_name, terms) : r.item_name;
                const codeNode = hit.has("code") ? highlightText(code, terms) : code;

                return (
                  <div
                    key={code + index}
                    className={`flex items-center justify-between gap-3 p-3 cursor-pointer ${selectedIndex === index ? "bg-neutral-100" : ""}`}
                    onClick={() => dispatchAction({ action: "select_index", params: { index } })}
                    style={{ backgroundColor: inStock ? undefined : "#fafafa" }}
                  >
                    <div className="flex-1">
                      <div className="text-sm font-medium flex items-center gap-2">
                        <span>{index}. {nameNode}</span>
                        {!inStock && (
                          <span className="text-xs" style={{ padding: "2px 8px", borderRadius: 999, background: "#e5e7eb", color: "#374151" }}>
                            sin stock
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-neutral-500">
                        {codeNode} • {uom} • ${price} • stock {mergedQty}
                        {brand ? <> • {brand}</> : null}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        min={1}
                        className="w-20 border rounded-xl px-2 py-1"
                        value={qtyPer[code] ?? 1}
                        onChange={(e) => {
                          const qn = Math.max(1, Math.floor(Number(e.target.value || 1)));
                          setQtyPer(prev => ({ ...prev, [code]: qn }));
                        }}
                      />
                      <button
                        className="rounded-xl px-3 py-2 bg-neutral-800 text-white disabled:opacity-60"
                        onClick={async () => {
                          await dispatchAction({ action: "select_index", params: { index } });
                          await dispatchAction({ action: "add_to_cart" });
                        }}
                        disabled={loading || (!inStock && mode !== "PRESUPUESTO")}
                        title={(!inStock && mode !== "PRESUPUESTO") ? "Sin stock en este modo" : "Agregar al carrito"}
                      >
                        Agregar
                      </button>
                    </div>
                  </div>
                );
              })}
              {results.length === 0 && (
                <div className="p-4 text-center text-neutral-500 text-sm">
                  {loading ? "Cargando…" : "Sin resultados"}
                </div>
              )}
            </div>
          </div>

          {/* Panel derecho: carrito */}
          <div className="bg-white/80 backdrop-blur rounded-2xl shadow p-3 flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <div className="text-sm font-semibold">Carrito</div>
              <div className="flex items-center gap-2">
                <button className="rounded-xl px-3 py-2 bg-neutral-200" onClick={() => dispatchAction({ action: "clear_cart" })}>
                  Vaciar
                </button>
              </div>
            </div>
            <div className="border rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-neutral-100">
                  <tr>
                    <th className="text-left p-2">Item</th>
                    <th className="text-right p-2">Cant.</th>
                    <th className="text-right p-2">U$</th>
                    <th className="text-right p-2">Subtot.</th>
                  </tr>
                </thead>
                <tbody>
                  {cart.map((c, i) => (
                    <tr key={c.item_code + i} className="border-t">
                      <td className="p-2">{c.item_name}</td>
                      <td className="p-2 text-right">{c.qty} {c.uom}</td>
                      <td className="p-2 text-right">{c.unit_price.toFixed(2)}</td>
                      <td className="p-2 text-right">{c.subtotal.toFixed(2)}</td>
                    </tr>
                  ))}
                  {cart.length === 0 && (
                    <tr>
                      <td colSpan={4} className="p-4 text-center text-neutral-500">Sin ítems</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="ml-auto text-sm">
              <div> Neto: <span className="font-medium">{total.net.toFixed(2)} {docState.currency}</span></div>
              <div> Desc.: <span className="font-medium">{total.discount.toFixed(2)}</span></div>
              <div className="text-lg"> TOTAL: <span className="font-semibold">{total.grand.toFixed(2)} {docState.currency}</span></div>
            </div>
            <div className="flex items-center gap-2">
              <button className="rounded-xl px-4 py-2 bg-neutral-800 text-white" onClick={() => dispatchAction({ action: "confirm_document" })} disabled={loading || cart.length === 0}>
                {loading ? "Procesando…" : "Confirmar"}
              </button>
              <button className="rounded-xl px-4 py-2 bg-neutral-200">Imprimir</button>
            </div>
          </div>

          {/* Consola */}
          <div className="col-span-2 bg-white/80 backdrop-blur rounded-2xl shadow p-3">
            <div className="text-sm font-semibold mb-2">Consola</div>
            <pre className="text-xs whitespace-pre-wrap max-h-48 overflow-auto border rounded-xl p-3 bg-neutral-50">
{ACTIONS_DOC}

{log.map((l) => `• ${l}`).join("\n")}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}
TSX
