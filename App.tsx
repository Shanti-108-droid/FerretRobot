// POS Overlay — Esqueleto NL-First (React + Tailwind) — CONECTADO AL BRIDGE
// - Usa bridge (FastAPI) en http://localhost:8002 para search, item-detail y confirm.
// - nlpInterpret primero intenta /bridge/interpret (stub/LLM en el bridge); si falla, cae a heurística local.
// - IVA incluido: cálculo lo hace el ERP (usando tu template/categoría por defecto).
//
// Novedad: mergeamos el stock real desde "Bin" (por warehouse) sobre los resultados de búsqueda
// para que la UI muestre el stock correcto aunque get_items devuelva actual_qty=0 en tu versión.
//
// Notas de CORS y configuración:
// • BRIDGE_BASE se puede definir por env (VITE_BRIDGE_BASE). Por defecto: http://localhost:8002
// • ERP_BASE solo se usa como fallback directo al ERP si el bridge no expone /bridge/bin-qty.
//   Definilo con VITE_ERP_BASE (ej: http://erp.localhost). Si no, la llamada va a /api/... relativo.
// • Si ves error de CORS con ERP, tenés 3 opciones: (1) loguearte y servir la UI bajo el mismo origen,
//   (2) proxyear /api/* desde Vite, (3) implementar /bridge/bin-qty en tu FastAPI y usar sólo el bridge.

import React, { useMemo, useState } from "react";
import { ArtPollock } from "./ArtPollock";

// ====== Config ======
const BRIDGE_BASE =
  (import.meta as any).env?.VITE_BRIDGE_BASE || "http://localhost:8002";
const ERP_BASE = (import.meta as any).env?.VITE_ERP_BASE || ""; // ej: "http://erp.localhost"

// ====== Tipos base ======
type Mode = "PRESUPUESTO" | "FACTURA" | "REMITO";

type SearchResult = {
  item_code: string;
  item_name: string;
  stock_uom?: string;
  price_list_rate?: number;
  actual_qty?: number; // será sobreescrito con Bin si está disponible
  // el backend puede devolver más campos, pero para la UI alcanza con estos
};

type BackendItem = {
  index: number;
  code: string;
  name: string;
  uom: string;
  rate: number;
  qty: number;
  group?: string | null;
  brand?: string | null;
  desc?: string | null;
  hit_fields?: string[]; // ["name","code","brand","desc"]
  terms?: string[];      // tokens normalizados desde el backend
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
  additional_discount_percentage?: number; // %
  discount_amount?: number; // absoluto
  update_stock: 0 | 1;
};

// ====== Catálogo de Acciones (para el LLM) ======
const ACTIONS_DOC = `
[CATALOGO_ACCIONES]
- set_mode(mode)
- search(term)
- select_index(index)
- set_qty(qty)
- add_to_cart()
- set_global_discount(percent|amount)
- set_customer(name)
- confirm_document(print?)
- clear_cart()
- repeat()
[REGLAS]
- Si el usuario dice "presupuesto/factura/remito" → set_mode.
- Si dice "buscar …" → search(term).
- "ítem N" → select_index(N).
- "cantidad X" o "agregar X" → set_qty(X), luego add_to_cart.
- "descuento X%" → set_global_discount(percent=X).
- "finalizar" → confirm_document.
- Dudar → pedir aclaración breve (1 línea) y proponer 2-3 opciones.
`;

// ====== Utils de highlight (acentos-insensible, no destructivo) ======
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

  // merge de solapamientos
  ranges.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Range[] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (!last || r.start > last.end) {
      merged.push({ ...r });
    } else {
      last.end = Math.max(last.end, r.end);
    }
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
      <span
        key={`hl-${i}-${r.start}-${r.end}`}
        className="bg-yellow-200/60 rounded-sm px-0.5"
      >
        {text.slice(r.start, r.end)}
      </span>
    );
    cursor = r.end;
  });
  if (cursor < text.length) out.push(text.slice(cursor));
  return <>{out}</>;
}

// ====== Componente principal ======
export default function POSOverlaySkeleton() {
  // Estado del documento y UI
  const [mode, setMode] = useState<Mode>("PRESUPUESTO");
  const [customer, setCustomer] = useState<string>("Consumidor Final");
  const [discountPct, setDiscountPct] = useState<number>(0);
  const [searchTerm, setSearchTerm] = useState<string>("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [backendItems, setBackendItems] = useState<BackendItem[]>([]); // ← items con index/brand/terms/hit_fields
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null); // 1..N
  const [qty, setQty] = useState<number>(1);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [log, setLog] = useState<string[]>([]);
  const [micOn, setMicOn] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(false);
  // qtyMap: sobreescribe actual_qty por item_code usando "Bin" del warehouse activo
  const [qtyMap, setQtyMap] = useState<Record<string, number>>({});

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

  // ====== Helpers de UI ======
  const appendLog = (line: string) =>
    setLog((l) => [line, ...l].slice(0, 100));

  const total = useMemo(() => {
    const net = cart.reduce((s, r) => s + r.subtotal, 0);
    const disc = discountPct > 0 ? net * (discountPct / 100) : 0;
    return { net, discount: disc, grand: Math.max(0, net - disc) };
  }, [cart, discountPct]);

  // ====== Llamadas al BRIDGE / ERP ======
  async function apiSearch(term: string): Promise<SearchResult[]> {
    setLoading(true);
    try {
      const r = await fetch(`${BRIDGE_BASE}/bridge/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          search_term: term,
          start: 0,
          page_length: 20,
        }),
      });
      if (!r.ok) throw new Error(`search status ${r.status}`);
      const data = await r.json();
      const list: SearchResult[] = data?.message ?? [];
      // guardamos también los items normalizados con índice y metadatos
      setBackendItems(Array.isArray(data?.items) ? (data.items as BackendItem[]) : []);
      return list;
    } catch (e: any) {
      appendLog(`✖ búsqueda falló: ${e?.message ?? e}`);
      setBackendItems([]);
      return [];
    } finally {
      setLoading(false);
    }
  }

  // Intenta usar el bridge (/bridge/bin-qty) y si no existe, hace fallback al ERP /api/method/frappe.client.get_list
  async function fetchBinQtys(itemCodes: string[], warehouse: string): Promise<Record<string, number>> {
    if (!itemCodes.length) return {};

    // 1) Preferir bridge si está implementado
    try {
      const r = await fetch(`${BRIDGE_BASE}/bridge/bin-qty`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ item_codes: itemCodes, warehouse }),
        credentials: "include",
      });
      if (r.ok) {
        const j = await r.json();
        // se espera: { message: [{ item_code, actual_qty }, ...] }
        const arr: Array<{ item_code: string; actual_qty: number }> = j?.message ?? [];
        const out: Record<string, number> = {};
        for (const row of arr) out[row.item_code] = Number(row.actual_qty || 0);
        return out;
      }
    } catch (e) {
      // sigue al fallback
    }

    // 2) Fallback: ERP directo (requiere sesión/token y CORS OK)
    try {
      const r = await fetch(`${ERP_BASE}/api/method/frappe.client.get_list`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          doctype: "Bin",
          fields: ["item_code", "warehouse", "actual_qty"],
          filters: [
            ["item_code", "in", itemCodes],
            ["warehouse", "=", warehouse],
          ],
          limit_page_length: 1000,
        }),
      });
      if (!r.ok) throw new Error(`bin status ${r.status}`);
      const j = await r.json();
      const arr: Array<{ item_code: string; warehouse: string; actual_qty: number }> = j?.message ?? [];
      const out: Record<string, number> = {};
      for (const row of arr) out[row.item_code] = Number(row.actual_qty || 0);
      return out;
    } catch (e: any) {
      appendLog(`⚠ no pude leer Bin: ${e?.message ?? e}`);
      return {};
    }
  }

  async function apiGetItemDetail(res: SearchResult): Promise<CartLine | null> {
    setLoading(true);
    try {
      const r = await fetch(`${BRIDGE_BASE}/bridge/item-detail`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          item_code: res.item_code,
          qty,
          mode,
        }),
      });
      if (!r.ok) throw new Error(`detail status ${r.status}`);
      const data = await r.json();
      const m = data?.message ?? {};
      const unit =
        typeof m.price_list_rate === "number"
          ? m.price_list_rate
          : res.price_list_rate ?? 0;
      const uom = m.uom || res.stock_uom || "Nos";
      const line: CartLine = {
        item_code: res.item_code,
        item_name: res.item_name,
        uom,
        qty,
        unit_price: unit,
        subtotal: +(unit * qty).toFixed(2),
        warehouse: "Sucursal Adrogue - HT",
        taxes: {}, // El ERP aplica IVA 21% incluido por template; aquí no duplicamos.
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

  // ====== Dispatcher de acciones (NL → UI/Bridge) ======
  type Action = {
    action: string;
    params?: Record<string, any>;
    confirm?: boolean;
    reason?: string;
  };

  async function dispatchAction(a: Action) {
    switch (a.action) {
      case "set_mode": {
        const m = (a.params?.mode ?? "").toString().toUpperCase();
        if (m === "PRESUPUESTO" || m === "FACTURA" || m === "REMITO") {
          setMode(m as Mode);
          appendLog(`modo → ${m}`);
        } else {
          appendLog(`modo inválido: ${a.params?.mode}`);
        }
        break;
      }
      case "search": {
        const term = (a.params?.term ?? "").toString();
        // 1) traer items desde el bridge
        const data = await apiSearch(term);
        setResults(data);
        setSelectedIndex(data.length ? 1 : null);
        setSearchTerm(term);
        appendLog(`buscando: "${term}" (${data.length} resultados)`);

        // 2) mergear cantidades desde Bin para el warehouse activo
        try {
          const codes = data.map((it) => it.item_code).filter(Boolean);
          const qmap = await fetchBinQtys(codes, "Sucursal Adrogue - HT");
          setQtyMap(qmap);
          // Actualizamos los resultados con actual_qty real
          setResults((prev) => prev.map((it) => ({ ...it, actual_qty: qmap[it.item_code] ?? it.actual_qty ?? 0 })));
        } catch (e: any) {
          appendLog(`⚠ merge Bin falló: ${e?.message ?? e}`);
        }
        break;
      }
      case "select_index": {
        const idx = Number(a.params?.index ?? 0);
        if (idx >= 1 && idx <= results.length) {
          setSelectedIndex(idx);
          appendLog(`seleccionado índice ${idx} (${results[idx - 1]?.item_name})`);
        } else {
          appendLog(`índice fuera de rango (${idx})`);
        }
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
        const line = await apiGetItemDetail(res);
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
        } else if (a.params?.amount != null) {
          const amt = Math.max(0, Number(a.params.amount));
          const net = cart.reduce((s, r) => s + r.subtotal, 0) || 1;
          const p = Math.max(0, Math.min(100, (amt / net) * 100));
          setDiscountPct(+p.toFixed(2));
          appendLog(`descuento ≈ ${p.toFixed(2)}% (monto ${amt})`);
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
          // Reset liviano
          setCart([]);
          setDiscountPct(0);
          setQty(1);
        } else {
          appendLog("✖ error al confirmar");
        }
        break;
      }
      case "clear_cart": {
        setCart([]);
        setDiscountPct(0);
        setQty(1);
        appendLog("carrito vacío");
        break;
      }
      case "repeat": {
        appendLog(
          `TOTAL → neto ${total.net.toFixed(2)} desc ${total.discount.toFixed(
            2
          )} = ${total.grand.toFixed(2)} ${docState.currency}`
        );
        break;
      }
      default: {
        appendLog(`acción desconocida: ${a.action}`);
      }
    }
  }

  // ====== Intérprete NL → acciones (bridge primero, fallback local) ======
  async function nlpInterpret(userText: string): Promise<Action[]> {
    // 1) intentar en el bridge (stub/LLM)
    try {
      const r = await fetch(`${BRIDGE_BASE}/bridge/interpret`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: userText,
          state: {
            mode,
            customer,
            discount_pct: discountPct,
            cart,
            currency: docState.currency,
          },
          catalog: [
            "set_mode",
            "search",
            "select_index",
            "set_qty",
            "add_to_cart",
            "set_global_discount",
            "set_customer",
            "confirm_document",
            "clear_cart",
            "repeat",
          ],
        }),
      });
      if (r.ok) {
        const data = await r.json();
        if (Array.isArray(data?.actions) && data.actions.length) {
          return data.actions;
        }
      }
    } catch {
      // sigue al fallback
    }

    // 2) Fallback local mínimo para no cortar flujo
    const t = userText.trim().toLowerCase();
    if (t === "presupuesto" || t === "hacer presupuesto")
      return [{ action: "set_mode", params: { mode: "PRESUPUESTO" } }];
    if (t === "factura" || t === "facturar")
      return [{ action: "set_mode", params: { mode: "FACTURA" } }];
    if (t === "remito" || t === "hacer remito")
      return [{ action: "set_mode", params: { mode: "REMITO" } }];

    const mBuscar = t.match(/^buscar\s+(.+)/);
    if (mBuscar) return [{ action: "search", params: { term: mBuscar[1] } }];

    const mItem = t.match(/^i\u00ED?tem\s+(\d+)/) || t.match(/^item\s+(\d+)/);
    if (mItem) return [{ action: "select_index", params: { index: Number(mItem[1]) } }];

    const mCant = t.match(/cantidad\s+(\d+)/) || t.match(/agregar\s+(\d+)/);
    if (mCant) return [{ action: "set_qty", params: { qty: Number(mCant[1]) } }, { action: "add_to_cart" }];

    const mDesc = t.match(/descuento\s+(\d+)(?:\s*%|\s*por ciento)?/);
    if (mDesc) return [{ action: "set_global_discount", params: { percent: Number(mDesc[1]) } }];

    if (t === "finalizar" || t === "confirmar") return [{ action: "confirm_document" }];
    if (t === "vaciar") return [{ action: "clear_cart" }];
    if (t === "total" || t === "repetir") return [{ action: "repeat" }];

    // Por defecto → búsqueda directa
    return [{ action: "search", params: { term: userText } }];
  }

  async function handleUserText(text: string) {
    appendLog(`🗣️ ${text}`);
    const actions = await nlpInterpret(text);
    for (const a of actions) {
      await dispatchAction(a);
    }
  }

  // ====== UI ======
  return (
    <div className="relative min-h-screen w-full text-neutral-900 bg-neutral-50">
      {/* Fondo artístico con intensidad alta */}
      <ArtPollock
        density={140}
        opacityRange={[0.25, 0.4]}
        strokeRange={[1.5, 3]}
        colors={["#E8D5FF", "#C7F2F0", "#FFE2B8", "#FFD6E0", "#DDE8FF"]}
      />

      {/* Capa de contenido */}
      <div className="relative z-10 p-4">
        <div className="mx-auto max-w-6xl grid grid-cols-2 gap-4">
          {/* Header */}
          <div className="col-span-2 flex flex-wrap items-center justify-between gap-3 bg-white/80 backdrop-blur rounded-2xl shadow p-3">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">Modo</span>
              <select
                className="border rounded-xl px-3 py-2"
                value={mode}
                onChange={(e) =>
                  dispatchAction({ action: "set_mode", params: { mode: e.target.value } })
                }
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
                onChange={(e) =>
                  dispatchAction({ action: "set_customer", params: { name: e.target.value } })
                }
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">Desc. (%)</span>
              <input
                type="number"
                className="border rounded-xl px-3 py-2 w-24"
                value={discountPct}
                onChange={(e) =>
                  dispatchAction({
                    action: "set_global_discount",
                    params: { percent: Number(e.target.value) },
                  })
                }
                min={0}
                max={100}
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
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    const v = (e.target as HTMLInputElement).value;
                    (e.target as HTMLInputElement).value = "";
                    handleUserText(v);
                  }
                }}
              />
              <button
                className="rounded-xl px-4 py-2 bg-neutral-800 text-white"
                onClick={() => handleUserText("finalizar")}
              >
                Confirmar
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
                  if (e.key === "Enter")
                    await dispatchAction({ action: "search", params: { term: searchTerm } });
                }}
              />
              <button
                className="rounded-xl px-3 py-2 bg-neutral-800 text-white"
                onClick={async () =>
                  await dispatchAction({ action: "search", params: { term: searchTerm } })
                }
                disabled={loading}
              >
                {loading ? "Buscando…" : "Buscar"}
              </button>
            </div>

            <div className="divide-y border rounded-xl overflow-hidden max-h-96 overflow-y-auto">
              {results.map((r, i) => {
                const bi = backendItems.find((x) => x.code === r.item_code);
                const index = bi?.index ?? (i + 1);

                // prioridad de qty: qtyMap[item_code] → r.actual_qty → bi.qty → 0
                const mergedQty = qtyMap[r.item_code] ?? r.actual_qty ?? bi?.qty ?? 0;
                const inStock = mergedQty > 0;
                const price = r.price_list_rate ?? bi?.rate ?? 0;
                const uom = r.stock_uom ?? bi?.uom ?? "Nos";
                const code = r.item_code ?? "";
                const brand = (bi?.brand ?? undefined) || undefined;

                const terms = bi?.terms ?? [];
                const hit = new Set(bi?.hit_fields ?? []);
                const nameNode = hit.has("name") ? highlightText(r.item_name, terms) : r.item_name;
                const codeNode = hit.has("code") ? highlightText(code, terms) : code;
                const brandNode = brand && hit.has("brand") ? highlightText(brand, terms) : brand;

                return (
                  <div
                    key={code + index}
                    className={`flex items-center justify-between gap-3 p-3 cursor-pointer ${
                      selectedIndex === index ? "bg-neutral-100" : ""
                    }`}
                    onClick={() =>
                      dispatchAction({ action: "select_index", params: { index } })
                    }
                    style={{ backgroundColor: inStock ? undefined : "#fafafa" }}
                  >
                    <div className="flex-1">
                      <div className="text-sm font-medium flex items-center gap-2">
                        <span>{index}. {nameNode}</span>
                        {!inStock && (
                          <span
                            className="text-xs"
                            style={{
                              padding: "2px 8px",
                              borderRadius: 999,
                              background: "#e5e7eb",
                              color: "#374151",
                            }}
                          >
                            sin stock
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-neutral-500">
                        {codeNode} • {uom} • ${price} • stock {mergedQty}
                        {brand ? <> • {brandNode}</> : null}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        min={1}
                        className="w-20 border rounded-xl px-2 py-1"
                        value={qty}
                        onChange={(e) =>
                          dispatchAction({ action: "set_qty", params: { qty: Number(e.target.value) } })
                        }
                      />
                      <button
                        className="rounded-xl px-3 py-2 bg-neutral-800 text-white disabled:opacity-60"
                        onClick={async () => {
                          await dispatchAction({ action: "select_index", params: { index } });
                          await dispatchAction({ action: "add_to_cart" });
                        }}
                        disabled={loading || (!inStock && mode !== "PRESUPUESTO")}
                        title={
                          (!inStock && mode !== "PRESUPUESTO")
                            ? "Sin stock en este modo"
                            : "Agregar al carrito"
                        }
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
                <button
                  className="rounded-xl px-3 py-2 bg-neutral-200"
                  onClick={() => dispatchAction({ action: "clear_cart" })}
                >
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
                      <td className="p-2 text-right">
                        {c.qty} {c.uom}
                      </td>
                      <td className="p-2 text-right">{c.unit_price.toFixed(2)}</td>
                      <td className="p-2 text-right">{c.subtotal.toFixed(2)}</td>
                    </tr>
                  ))}
                  {cart.length === 0 && (
                    <tr>
                      <td colSpan={4} className="p-4 text-center text-neutral-500">
                        Sin ítems
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="ml-auto text-sm">
              <div>
                Neto: {" "}
                <span className="font-medium">
                  {total.net.toFixed(2)} {docState.currency}
                </span>
              </div>
              <div>
                Desc.: <span className="font-medium">{total.discount.toFixed(2)}</span>
              </div>
              <div className="text-lg">
                TOTAL: {" "}
                <span className="font-semibold">
                  {total.grand.toFixed(2)} {docState.currency}
                </span>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                className="rounded-xl px-4 py-2 bg-neutral-800 text-white"
                onClick={() => dispatchAction({ action: "confirm_document" })}
                disabled={loading || cart.length === 0}
              >
                {loading ? "Procesando…" : "Confirmar"}
              </button>
              <button className="rounded-xl px-4 py-2 bg-neutral-200">Imprimir</button>
            </div>
          </div>

          {/* Consola / Log */}
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

// ====== TODO (siguientes pasos) ======
// 1) Confirmación real en /bridge/confirm: insertar + submit según modo (Quotation / Sales Invoice / Delivery Note),
//    IVA 21% incluido via template/categoría por defecto del ERP.
// 2) /bridge/interpret: reemplazar stub por LLM real (prompts + acciones JSON).
// 3) (Opcional recomendado) Implementar en el bridge un endpoint /bridge/bin-qty que reciba {item_codes[], warehouse}
//    y haga el get_list(Bin) del ERP, devolviendo {message: [{item_code, actual_qty}, ...]}. Así evitás CORS.
// 4) Guardrails de voz: confirmaciones por monto, stock bajo, etc.
