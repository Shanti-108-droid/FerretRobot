// BEGIN App.tsx

import { useRealtimeVoice } from "./voice/useRealtimeVoice";
import React, { useMemo, useState, useRef, useEffect } from "react";
import { ArtPollock } from "./ArtPollock";
import { CustomerPicker } from "./CustomerPicker";
// App.tsx (arriba con el resto de imports)
import { preloadBrandAliases } from "./llm/interpret";
import { newTrace } from "./utils/trace";
import { preloadAttributes, _debugAttributes } from "./llm/attributes";
import {
  // interpretAndDispatch (REMOVIDO: ya lo definimos abajo)
  type ActionsDoc as LLMActionsDoc,
  type FrontState as LLMFrontState,
} from "./llm/interpret";

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

// === Nuevo: tipos para filtros del backend NLU ===
type AppliedFilters = {
  name?: string | null;
  size_mm?: number | null;
  size_in?: number | null;
  unit_pref?: "mm" | "in" | null;
  brands?: string[];
  tags?: string[];
  attributes?: Record<string, string>; // ⬅️ nuevo
};

type SearchResponseV2 = {
  term: string;
  term_raw?: string;
  applied_filters?: AppliedFilters;
  items?: Array<{
    code: string;
    name: string;
    uom: string;
    rate: number;
    qty: number;
    brand?: string | null;
    desc?: string | null;
    hit_fields?: string[];
  }>;
  meta?: { tried_terms?: string[] };
};

// Para compat legacy (mensaje viejo)
type LegacySearchMessage = SearchResult[];

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
  index?: number;
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

// ===== Pagos: normalización =====
const MOP_MAP: Record<string, string> = {
  efectivo: "Cash",
  cash: "Cash",
  tarjeta: "Credit Card",
  "tarjeta credito": "Credit Card",
  "tarjeta crédito": "Credit Card",
  "tarjeta debito": "Debit Card",
  "tarjeta débito": "Debit Card",
  transferencia: "Bank Draft",
  banco: "Bank Draft",
};
function normalizeMop(input?: string): string | null {
  if (!input) return null;
  const k = input.trim().toLowerCase();
  return MOP_MAP[k] ?? input;
}

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
    .toLowerCase()
    .trim()
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
// === Helpers de filtros → chips
// Etiquetas amigables para atributos del ERP
const ATTR_LABELS: Record<string, string> = {
  Size: "Diámetro",
  Colour: "Color",
};

function filtersToChips(f: AppliedFilters | null | undefined): { key: string; label: string }[] {
  if (!f) return [];
  const chips: { key: string; label: string }[] = [];

  if (f.name) chips.push({ key: "name", label: f.name });

  if (f.unit_pref === "mm" && f.size_mm != null) {
    chips.push({ key: "size_mm", label: `${f.size_mm} mm` });
  }
  if (f.unit_pref === "in" && f.size_in != null) {
    chips.push({ key: "size_in", label: `${f.size_in} in` });
  }

  if (Array.isArray(f.brands) && f.brands.length) {
    f.brands.forEach((b, i) => chips.push({ key: `brand:${i}`, label: b }));
  }
  if (Array.isArray(f.tags) && f.tags.length) {
    f.tags.forEach((t, i) => chips.push({ key: `tag:${i}`, label: t }));
  }

  // ⬇️ NUEVO: chips para atributos del ERP (p.ej. Size / Colour)
  if (f.attributes) {
    for (const [k, v] of Object.entries(f.attributes)) {
      const label = `${ATTR_LABELS[k] ?? k}: ${v}`;
      chips.push({ key: `attr:${k}`, label });
    }
  }

  return chips;
}

function removeChip(f: AppliedFilters | null, chipKey: string): AppliedFilters | null {
  if (!f) return f;
  const nf: AppliedFilters = JSON.parse(JSON.stringify(f));

  if (chipKey === "name") {
    nf.name = null;
  } else if (chipKey === "size_mm") {
    nf.size_mm = null;
    nf.unit_pref = nf.size_in != null ? "in" : nf.unit_pref;
  } else if (chipKey === "size_in") {
    nf.size_in = null;
    nf.unit_pref = nf.size_mm != null ? "mm" : nf.unit_pref;
  } else if (chipKey.startsWith("brand:")) {
    const i = Number(chipKey.split(":")[1] || -1);
    if (Array.isArray(nf.brands)) nf.brands = nf.brands.filter((_, idx) => idx !== i);
  } else if (chipKey.startsWith("tag:")) {
    const i = Number(chipKey.split(":")[1] || -1);
    if (Array.isArray(nf.tags)) nf.tags = nf.tags.filter((_, idx) => idx !== i);
  } else if (chipKey.startsWith("attr:")) {
    // Quitar un atributo específico (p.ej. "attr:Size")
    const key = chipKey.slice(5);
    if (nf.attributes) {
      const { [key]: _omit, ...rest } = nf.attributes;
      nf.attributes = Object.keys(rest).length ? rest : undefined;
    }
  }

  return nf;
}



// ===== App =====
export default function App() {
  // Estado
  const lastQueryRef = useRef<string>("");
  const resumenRef = useRef<string[]>([]);
  const pushResumen = (s: string) => {
    if (s) resumenRef.current.push(s);
  };
  const [mode, setMode] = useState<Mode>("PRESUPUESTO");
  const [customer, setCustomer] = useState<string>("Consumidor Final");
  const [discountPct, setDiscountPct] = useState<number>(0);
  const [searchTerm, setSearchTerm] = useState<string>("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [backendItems, setBackendItems] = useState<BackendItem[]>([]);
  // === Nuevo: guardamos filtros aplicado por el backend y términos alternativos intentados
  const [appliedFilters, setAppliedFilters] = useState<AppliedFilters | null>(null);
  const [triedTerms, setTriedTerms] = useState<string[]>([]);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const qtyRef = useRef<number>(1);
  const lastAddRef = useRef<{ key: string; t: number } | null>(null);
  const selectedIndexRef = useRef<number | null>(null);
  const [qty, setQty] = useState<number>(1);
  const [qtyPer, setQtyPer] = useState<Record<string, number>>({});
  const [cart, setCart] = useState<CartLine[]>([]);
  const [log, setLog] = useState<string[]>([]);
  const [listening, setListening] = useState(false);
  const lastSpaceDownRef = useRef<number>(0);

  const [loading, setLoading] = useState<boolean>(false);
  // Anti-duplicado de voz: evita procesar el MISMO texto más de una vez en ~1.5s
  const recentVoiceRef = useRef<{ text: string; t: number }[]>([]);

  // Pagos
  const [paymentMethods, setPaymentMethods] = useState<
    { name: string; accounts?: { company?: string; account?: string }[] }[]
  >([]);
  const [paymentSel, setPaymentSel] = useState<{ mop?: string; account?: string }>({});
  // ===== Carga de datos inicial (brands + attributes) =====
  useEffect(() => {
    let cancelled = false;
  
    async function initData() {
      try {
        // BRANDS
        await preloadBrandAliases(BRIDGE_BASE);
        if (!cancelled) appendLog?.("• brands alias precargados desde /bridge/brands");
  
        // ATTRIBUTES (primero sin nombres; luego podés filtrar)
        await preloadAttributes(BRIDGE_BASE, ["Size", "Colour"]);
        if (!cancelled) appendLog?.("• atributos precargados: Size, Colour");
      } catch (e) {
        appendLog?.(`• error precargando datos: ${String(e)}`);
      }
    }
  
    initData();
    return () => { cancelled = true; };
  }, []);
  
    
  
  // resultsRef para voz/planner
  const resultsRef = useRef<SearchResult[]>([]);
  useEffect(() => {
    resultsRef.current = results;
  }, [results]);

  // === Refs de snapshot para evitar stale state en confirmaciones encadenadas ===
  const modeRef = useRef(mode);
  const customerRef = useRef(customer);
  const discountPctRef = useRef(discountPct);
  const cartRef = useRef(cart);
  const paymentSelRef = useRef(paymentSel);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);
  useEffect(() => {
    customerRef.current = customer;
  }, [customer]);
  useEffect(() => {
    discountPctRef.current = discountPct;
  }, [discountPct]);
  useEffect(() => {
    cartRef.current = cart;
  }, [cart]);
  useEffect(() => {
    paymentSelRef.current = paymentSel;
  }, [paymentSel]);

  // --- API: detalle de ítem (debe estar dentro del componente App)
  async function apiGetItemDetail(res: SearchResult, qOverride?: number): Promise<CartLine | null> {
    setLoading(true);
    try {
      const q = (qOverride ?? qtyRef.current ?? qty) as number;
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
          : (res as any).price_list_rate ?? (res as any).rate ?? 0;
      const uom = m.uom || (res as any).stock_uom || "Nos";
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

  // ===== Helpers generales =====
  const appendLog = (line: string) => setLog((l) => [line, ...l].slice(0, 100));

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

  const total = useMemo(() => {
    const net = cart.reduce((s, r) => s + r.subtotal, 0);
    const disc = discountPct > 0 ? net * (discountPct / 100) : 0;
    return { net, discount: disc, grand: Math.max(0, net - disc) };
  }, [cart, discountPct]);

  function setSelectedIdx(n: number | null) {
    setSelectedIndex(n);
    selectedIndexRef.current = n;
  }

  // ===== API =====
  async function loadPaymentMethods() {
    try {
      const r = await fetch(`${BRIDGE_BASE}/bridge/payment_methods`);
      if (!r.ok) throw new Error(`payment_methods ${r.status}`);
      const j = await r.json();
      setPaymentMethods(Array.isArray(j?.message) ? j.message : []);
    } catch (e: any) {
      appendLog(`⚠ no pude leer métodos de pago: ${e?.message ?? e}`);
    }
  }

// /bridge/search_with_stock + filtro + ranking + highlight en el front (v2 + legacy)
async function apiSearch(term: string, filters?: AppliedFilters | null): Promise<SearchResult[]> {
  setLoading(true);

  // === TRACE: iniciamos un trazo por búsqueda
  const tr = newTrace("search")
    .mark("original_text", term)
    .mark("filters_sent", filters || null);

  try {
    const body: any = {
      query: term,
      warehouse: "Sucursal Adrogue - HT",
      pos_profile: "Sucursal Adrogue",
      limit: 20,
      page: 1,
    };
    if (filters) body.filters = filters;

    const r = await fetch(`${BRIDGE_BASE}/bridge/search_with_stock`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // ⬇️ mandamos el trace_id al backend (si después querés loguearlo ahí)
        "X-Trace-Id": tr.id,
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`search_with_stock status ${r.status}`);

    const data = await r.json();

    const isV2 =
      data && (data.term || data.applied_filters || data.items || (data.meta && data.meta.tried_terms));

    let list: SearchResult[] = [];
    let v2Items: BackendItem[] = [];

    if (isV2) {
      const v2: SearchResponseV2 = data;

      setAppliedFilters(v2.applied_filters || null);
      setTriedTerms(v2.meta?.tried_terms || []);

      const items = Array.isArray(v2.items) ? v2.items : [];
      v2Items = items.map((it, idx) => ({
        index: idx + 1,
        code: it.code,
        name: it.name,
        uom: it.uom || "Nos",
        rate: Number(it.rate ?? 0),
        qty: Number(it.qty ?? 0),
        brand: it.brand ?? null,
        desc: it.desc ?? null,
        hit_fields: it.hit_fields || [],
        terms: tokenizeTerms(v2.term || term),
      }));
      setBackendItems(v2Items);

      list = items.map((it) => ({
        item_code: it.code,
        item_name: it.name,
        stock_uom: it.uom || "Nos",
        price_list_rate: Number(it.rate ?? 0),
        actual_qty: Number(it.qty ?? 0),
        description: it.desc ?? null,
      }));

      // cerrar traza con info útil
      tr.end({
        isV2: true,
        term_normalized: v2.term ?? null,
        count: items.length,
        applied_filters_final: v2.applied_filters ?? null,
        tried_terms: v2.meta?.tried_terms ?? [],
      });

    } else {
      // === Legacy (data.message es una lista de SearchResult) ===
      const legacy: LegacySearchMessage = (data && data.message) || [];

      // preservamos filtros
      setAppliedFilters((prev) => (filters ?? prev ?? null));
      setTriedTerms([]);

      const toks = tokenizeTerms(term);
      const isMatch = (it: SearchResult) => {
        if (toks.length === 0) return true;
        const nName = normalizeTextFront(it.item_name || "");
        const nCode = normalizeTextFront(it.item_code || "");
        const nDesc = normalizeTextFront(it.description || "");
        return toks.every((t) => nName.includes(t) || nCode.includes(t) || nDesc.includes(t));
      };
      const filtered = legacy.filter(isMatch);

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

      v2Items = scored.map((s, idx) => ({
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
      setBackendItems(v2Items);

      list = scored.slice(0, 20).map((s) => s.it);

      tr.end({
        isV2: false,
        count: list.length,
        tokens: toks,
        applied_filters_final: filters ?? null,
      });
    }

    return list;
  } catch (e: any) {
    appendLog(`✖ búsqueda falló: ${e?.message ?? e}`);
    setBackendItems([]);
    setAppliedFilters(null);
    setTriedTerms([]);
    tr.end({ error: String(e?.message ?? e) });
    return [];
  } finally {
    setLoading(false);
  }
}

  

  // ===== Confirmación =====
  function buildConfirmPayload() {
    // Snapshot consistente tomado de refs
    const modeSnap = modeRef.current;
    const customerSnap = customerRef.current;
    const discountSnap = discountPctRef.current || 0;
    const cartSnap = cartRef.current || [];
    const paymentSnap = paymentSelRef.current || {};

    const items = cartSnap.map((c) => ({
      item_code: c.item_code,
      qty: c.qty,
      uom: c.uom,
      price_list_rate: c.unit_price,
    }));

    // Calcular total/grand a partir del snapshot del carrito (consistente con discountSnap)
    const netSnap = cartSnap.reduce((s, r) => s + r.subtotal, 0);
    const discSnap = discountSnap > 0 ? netSnap * (discountSnap / 100) : 0;
    const grandSnap = Math.max(0, netSnap - discSnap);

    const payments =
      modeSnap === "FACTURA" && paymentSnap.mop
        ? [
            {
              mode_of_payment: normalizeMop(paymentSnap.mop) ?? paymentSnap.mop,
              account: paymentSnap.account ?? null,
              amount: grandSnap,
            },
          ]
        : undefined;

    const payload: any = {
      mode: modeSnap,
      customer: customerSnap,
      discount_pct: discountSnap,
      items,
    };
    if (payments) payload.payments = payments;

    return payload;
  }

  async function apiConfirmDocument(): Promise<{ ok: boolean; number?: string }> {
    setLoading(true);
    try {
      // Guardrail mejorado: si estamos en FACTURA y no hay MOP, asumimos "Cash" por defecto
      if (modeRef.current === "FACTURA" && !paymentSelRef.current?.mop) {
        appendLog("⚠ no había método de pago, uso 'Cash' por defecto.");
        setPaymentSel({ mop: "Cash", account: undefined });
        // Actualizamos el ref inmediatamente para que el snapshot lo tome
        paymentSelRef.current = { mop: "Cash", account: undefined };
      }

      const payload = buildConfirmPayload();
      console.log("→ confirm payload", payload);

      const r = await fetch(`${BRIDGE_BASE}/bridge/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!r.ok) {
        let rawText = "";
        try {
          rawText = await r.text();
        } catch {}
        let parsed: any = null;
        try {
          parsed = rawText ? JSON.parse(rawText) : null;
        } catch {}

        if (r.status === 400) {
          const detail = parsed?.detail ?? parsed ?? rawText;
          let detailObj: any = null;
          try {
            detailObj = typeof detail === "string" ? JSON.parse(detail) : detail;
          } catch {}
          if (detailObj?.code === "PAYMENT_REQUIRED") {
            setPaymentMethods(Array.isArray(detailObj.payment_methods) ? detailObj.payment_methods : []);
            appendLog("Elegí un modo de pago y volvé a confirmar.");
            return { ok: false };
          }
        }

        const msg = parsed?.detail || parsed?.message || rawText || `(sin detalle)`;
        appendLog(`✖ confirmar falló: ${r.status} ${msg}`);
        console.error("confirm_document error:", { status: r.status, parsed, rawText });
        return { ok: false };
      }

      const data = await r.json();
      return { ok: !!data?.ok, number: data?.number };
    } catch (e: any) {
      appendLog(`✖ confirmar falló (excepción): ${e?.message ?? e}`);
      return { ok: false };
    } finally {
      setLoading(false);
    }
  }

// ===== Planner + Voz =====
async function interpretAndDispatch(text: string) {
  try {
    const resultsSnapshot =
      (backendItems && backendItems.length
        ? backendItems.map((bi) => ({
            index: bi.index,
            item_code: bi.code,
            item_name: bi.name,
          }))
        : results.map((r, i) => ({
            index: i + 1,
            item_code: r.item_code,
            item_name: r.item_name,
          }))) || [];

    const state = {
      mode,
      customer,
      total: {
        net: total.net,
        discount: total.discount,
        grand: total.grand,
        currency: docState.currency,
      },
      cart: cart.map((c) => ({
        item_code: c.item_code,
        qty: c.qty,
        uom: c.uom,
        unit_price: c.unit_price,
      })),
      results: resultsSnapshot,
      selected_index: selectedIndex,
      qty_hint: qty,
      payment:
        mode === "FACTURA" && paymentSel.mop
          ? { mop: paymentSel.mop, account: paymentSel.account || undefined }
          : undefined,
    };

    const catalogList = [
      "set_mode",
      "search",
      "select_index",
      "set_qty",
      "add_to_cart",
      "set_global_discount",
      "set_customer",
      "set_payment",
      "confirm_document",
      "clear_cart",
      "repeat",
      "remove_from_cart",
      "remove_last_item",
    ];

    // Snapshot fresco para planner + anti-race básico
    const plannerResults = (resultsRef.current ?? [])
      .slice(0, 12)
      .map((r: any, i: number) => ({
        index: i + 1,
        item_code: r.item_code,
        item_name: r.item_name,
      }));
    const stateForPlanner = { ...state, results: plannerResults };

    console.log("→ interpret payload.state.results.length =", stateForPlanner.results?.length || 0);
    console.log("→ interpret payload", { text, state: stateForPlanner, catalog: catalogList });

    // --- llamada a /bridge/interpret con trazado y log de error detallado ---
    const trace = newTrace("interpret");
    const resp = await fetch(`${BRIDGE_BASE}/bridge/interpret`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Trace-Id": trace.id,
      },
      body: JSON.stringify({ text, state: stateForPlanner, catalog: catalogList }),
    });
    if (!resp.ok) {
      let raw = "";
      try { raw = await resp.text(); } catch {}
      console.error("interpret HTTP error", {
        status: resp.status,
        statusText: resp.statusText,
        headers: Object.fromEntries(resp.headers.entries()),
        body: raw,
      });
      throw new Error(`/bridge/interpret ${resp.status}`);
    }
    const data = await resp.json();

    const actions = Array.isArray(data?.actions) ? data.actions : [];
    console.log("→ interpret actions", JSON.stringify(actions, null, 2));

    // --- SAFE GUARDS (confirmación + browse vs. acción) ---

    // Confirm solo si lo pidió explícitamente
    const confirmRegex =
      /\b(confirm(ar|o|ado|ame|emos)?|factur(a|á|ar)|emit(ir|í)[^\w]*(la )?(factura|comprobante)|cerr(a|ar)\s*venta)\b/i;
    const userAskedToConfirm = confirmRegex.test(text);

    // Detectar intención de agregar, seleccionar y “listar/mostrar/buscar”
    const addRegex = /\b(agrega(?:r|me)?|sumar|añadir|poner|meter|insertar|agregá|agrega)\b/i;
    const selectRegex = /\b(?:ítem|item)\s+\d+\b/i;
    const browseRegex =
      /\b(mostr(a|ame|ar)|busc(a|ame|ar|á)|que\s+tenemos|qué\s+tenemos|qué\s+hay|que\s+hay|ver|listar|listá|listame|muestrame|muéstrame|ten(e|é)s|tenemos|hay|existe|alg[uú]n|alguna)\b/i;

    const userAskedToAdd = addRegex.test(text);
    const userAskedToSelect = selectRegex.test(text);
    const userBrowse = browseRegex.test(text);

    // 1) Confirmación: si no lo pidió, sacamos confirm_document
    let safeActions = userAskedToConfirm
      ? actions
      : actions.filter((a) => a.action !== "confirm_document");

    if (!userAskedToConfirm && actions.some((a) => a.action === "confirm_document")) {
      appendLog("🔒 confirmación bloqueada: falta pedido explícito (decí 'confirmar').");
    }

    // 2) Agregado: si NO dijo "agregar/sumar/..." removemos add_to_cart SIEMPRE
    const hadAdd = actions.some((a) => a.action === "add_to_cart");
    if (!userAskedToAdd) {
      safeActions = safeActions.filter((a) => a.action !== "add_to_cart");
      if (hadAdd) appendLog("🔒 agregado bloqueado: decí 'agregar' si querés sumar al carrito.");
    }

    // 3) Browse: si está consultando/listando y NO pidió seleccionar NI agregar,
    //    quitamos select_index y set_qty (no tiene sentido mover la selección sola)
    if (userBrowse && !userAskedToAdd && !userAskedToSelect) {
      const beforeSel = safeActions.length;
      safeActions = safeActions.filter((a) => !["select_index", "set_qty"].includes(a.action));
      if (beforeSel !== safeActions.length) {
        appendLog("🔒 selección bloqueada: consulta/listado sin pedido explícito.");
      }
    }

    // Ejecutamos SOLO las acciones seguras (filtradas) en lote coherente
    if (safeActions.length === 0) {
      appendLog("interpret → sin acciones");
      return;
    }
    await dispatchActionsBatch(safeActions);
  } catch (e: any) {
    appendLog(`✖ interpret falló: ${e?.message ?? e}`);
  }
}

      

  // ===== Dispatcher (ÚNICO) =====
  type Action = { action: string; params?: Record<string, any> };
  // Ejecuta un lote coherente: aplica select/set antes, y hace UNA sola add_to_cart al final
  async function dispatchActionsBatch(actions: Action[]) {
    if (!Array.isArray(actions) || actions.length === 0) return;

    const addActions = actions.filter((a) => a.action === "add_to_cart");
    const hasAdd = addActions.length > 0;

    for (const a of actions) {
      if (a.action === "add_to_cart") continue;
      await dispatchAction(a);
    }

    if (hasAdd) {
      let idxFromSelect: number | null = null;
      for (const a of actions) {
        if (a.action === "select_index") {
          const idx1 = Number(a.params?.index ?? 0);
          if (Number.isInteger(idx1) && idx1 > 0) idxFromSelect = idx1;
        }
      }
      const idxFromAdd = Number(addActions[0]?.params?.index ?? 0) || null;

      const indexToUse = idxFromSelect || idxFromAdd || undefined;
      await dispatchAction({ action: "add_to_cart", params: indexToUse ? { index: indexToUse } : {} });
    }
  }

  async function dispatchAction(a: Action) {
    switch (a.action) {
      case "set_mode": {
        const m = (a.params?.mode ?? "").toString().toUpperCase();
        if (m === "PRESUPUESTO" || m === "FACTURA" || m === "REMITO") {
          setMode(m as Mode);
          appendLog(`modo → ${m}`);
          setPaymentSel({});
          if (m === "FACTURA") loadPaymentMethods();
        } else {
          appendLog(`modo inválido: ${a.params?.mode}`);
        }
        break;
      }

      case "set_payment": {
        const mopRaw = (a.params?.mop ?? "").toString().trim();
        if (!mopRaw) {
          appendLog("set_payment: faltan parámetros (mop).");
          break;
        }
        const mop = normalizeMop(mopRaw) ?? mopRaw;
        const account = (a.params?.account ?? "").toString().trim() || undefined;
        if (!paymentMethods.length) await loadPaymentMethods();
        setPaymentSel({ mop, account });
        appendLog(`pago → ${mopRaw || mop}${account ? ` (${account})` : ""}`);
        break;
      }

      case "search": {
        const raw = (a.params?.term ?? a.params?.query ?? "").toString();
      
        // Si parece una orden con índice/cantidad, re-interpretamos ese texto
        if (
          /^\s*(?:item|ítem|\d+)\b/i.test(raw) ||
          /\b(agrega(?:r)?|sumar|poner|añadir)\b/i.test(raw)
        ) {
          await interpretAndDispatch(raw);
          break;
        }
      
        // Limpieza de prefijo "busca/buscar/buscá/buscame..."
        const cleaned = raw.replace(
          /^\s*(?:busc(?:a|ar|á|ame)?|search|find)\b[:,-]?\s*/i,
          ""
        );
        const term = cleaned || raw;
      
        // --- Normalización anti-ASR + unidades ---
        const normalizeASR = (s: string) =>
          s
            // ruidos de ASR
            .replace(/\bcañidos?\b/gi, "caños")
            .replace(/\bcanios?\b/gi, "caños")
            .replace(/\baquaplas?t\b/gi, "Aquaplas")
            // unidades
            .replace(/\bmil[ií]metros?\b/gi, "mm")
            .replace(/\bcent[ií]metros?\b/gi, "cm")
            .replace(/\bpulg(?:ada|adas)?\b/gi, "in")
            // fracciones en palabras
            .replace(/\btres\s+cuartos\b/gi, "3/4")
            .replace(/\bun\s+cuarto\b/gi, "1/4")
            // “de media” muy usado → 1/2
            .replace(/\bde\s+(?:la\s+)?media\b/gi, "1/2")
            .replace(
              /\bmedia\s+(cañ[oa]s?|codos?|tees?|tubos?|niples?|nipple|rosca|válvulas?)\b/gi,
              "1/2 $1"
            )
            // variantes con in + espacios
            .replace(/\b1\/2\s*in\b/gi, '1/2"')
            .replace(/\b3\/4\s*in\b/gi, '3/4"');
      
        const termNorm = normalizeASR(term);
      
        // --- Heurística: deducir filtros de tamaño si el usuario dijo “N mm” o “N in / N" / fracción” ---
        const evalFraction = (s: string) => {
          const m = String(s).trim().match(/^(\d+)\s*\/\s*(\d+)$/);
          if (!m) return parseFloat(String(s).replace(",", "."));
          const n = parseFloat(m[1] || "0");
          const d = parseFloat(m[2] || "1");
          return d ? n / d : n;
        };
      
        let filtersHint: AppliedFilters | null = null;
      
        const mmMatch = termNorm.match(/\b(\d+(?:[.,]\d+)?)\s*mm\b/i);
        const inMatch = termNorm.match(/\b(\d+(?:[.,]\d+)?)\s*(?:in|")\b/i);
        const fracMatch = termNorm.match(/\b(\d+)\s*\/\s*(\d+)\s*(?:in|")?\b/i);
      
        if (mmMatch) {
          const val = parseFloat(mmMatch[1].replace(",", "."));
          filtersHint = {
            unit_pref: "mm",
            size_mm: val,
            size_in: +(val / 25.4).toFixed(4),
            brands: [],
            tags: [],
            name: undefined,
          };
        } else if (inMatch) {
          const val = parseFloat(inMatch[1].replace(",", "."));
          filtersHint = {
            unit_pref: "in",
            size_in: val,
            size_mm: +(val * 25.4).toFixed(2),
            brands: [],
            tags: [],
            name: undefined,
          };
        } else if (fracMatch) {
          const val = evalFraction(`${fracMatch[1]}/${fracMatch[2]}`);
          filtersHint = {
            unit_pref: "in",
            size_in: val,
            size_mm: +(val * 25.4).toFixed(2),
            brands: [],
            tags: [],
            name: undefined,
          };
        }
      
        // --- Singularización MUY básica (último token) para mostrar en el input ---
        const toSingular = (w: string) => {
          const lw = w.toLowerCase();
          if (lw.length > 3 && lw.endsWith("es")) return w.slice(0, -2);
          if (lw.length > 2 && lw.endsWith("s")) return w.slice(0, -1);
          return w;
        };
        const parts = termNorm.trim().split(/\s+/);
        if (parts.length > 0) {
          parts[parts.length - 1] = toSingular(parts[parts.length - 1]);
        }
        const displayTerm = parts.join(" ");
      
        // detectar si es “consulta nueva” (solo para métricas/UX, no para arrastrar filtros)
        const isNewQuery =
          normalizeTextFront(displayTerm) !==
          normalizeTextFront(lastQueryRef.current || "");
      
        // Traza (debug)
        const trReset = newTrace("reset-decision")
          .mark("display_term", displayTerm)
          .mark("isNewQuery", isNewQuery)
          .mark("filters_before", appliedFilters || null);
      
        // ✅ Stateless: esta búsqueda usa SOLO lo deducido ahora
        const filtersToSend = filtersHint ?? null;
      
        // Sobrescribimos chips para esta búsqueda (no quedan pegados a la próxima)
        setAppliedFilters(filtersToSend);
      
        trReset.end({ filters_sent: filtersToSend || null });
      
        // ejecutar búsqueda
        const data = await apiSearch(displayTerm, filtersToSend);
      
        setResults(data);
        resultsRef.current = data;
      
        const sel = data.length ? 1 : null;
        setSelectedIndex(sel);
        selectedIndexRef.current = sel ?? 0;
      
        // Mostramos el término "amigable" en el input
        setSearchTerm(displayTerm);
      
        appendLog(`buscando: "${displayTerm}" (${data.length} resultados)`);
        break;
      }
      
      
      
      

      case "select_index": {
        const idx1 = Number(a.params?.index ?? 0); // 1-based
        const list = resultsRef.current ?? results;
        if (!Number.isInteger(idx1) || idx1 < 1 || !list || idx1 > list.length) {
          appendLog(`índice fuera de rango (${a.params?.index})`);
          break;
        }
        setSelectedIndex(idx1);
        selectedIndexRef.current = idx1;
        const it = list[idx1 - 1];
        const qSel = qtyPer[it?.item_code] ?? qtyRef.current ?? qty;
        setQty(qSel);
        qtyRef.current = qSel;
        appendLog(`seleccionado índice ${idx1} (${it?.item_name ?? it?.item_code ?? "?"})`);
        break;
      }

      case "set_qty": {
        const qNum = Math.max(1, Math.floor(Number(a.params?.qty ?? 1)));
        setQty(qNum);
        qtyRef.current = qNum;
        appendLog(`cantidad → ${qNum}`);
        break;
      }

      case "add_to_cart": {
        const list = resultsRef.current ?? results;
        const idxParam1 = Number(a.params?.index ?? 0);
        const idx1 = idxParam1 >= 1 ? idxParam1 : Number(selectedIndexRef?.current ?? 0);
        if (!list || !list.length) {
          appendLog("no hay resultados (list vacía)");
          break;
        }
        if (!idx1 || idx1 < 1 || idx1 > list.length) {
          appendLog(`no hay selección (list_len=${list.length}, sel=${idx1 || 0})`);
          break;
        }
        const res = list[idx1 - 1];
        const qEff = Number(qtyPer[res.item_code] ?? qtyRef.current ?? qty ?? 1);
        if (!Number.isFinite(qEff) || qEff <= 0) {
          appendLog("cantidad inválida (falta set_qty)");
          break;
        }

        // anti-duplicado si la voz dispara dos add_to_cart iguales en <500ms
        const key = `${res.item_code}|${qEff}`;
        const now = Date.now();
        if (lastAddRef.current && lastAddRef.current.key === key && now - lastAddRef.current.t < 500) {
          appendLog("⏩ ignorado duplicado add_to_cart");
          break;
        }
        lastAddRef.current = { key, t: now };

        const line = await apiGetItemDetail(res, qEff);
        if (line) {
          setCart((c) => {
            const i = c.findIndex(
              (row) =>
                row.item_code === line.item_code &&
                row.unit_price === line.unit_price &&
                row.uom === line.uom
            );
            if (i >= 0) {
              const updated = [...c];
              const newQty = (Number(updated[i].qty) || 0) + Number(line.qty);
              const newSubtotal = newQty * Number(line.unit_price);
              updated[i] = { ...updated[i], qty: newQty, subtotal: newSubtotal };
              return updated;
            }
            return [...c, line];
          });
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
        try {
          // Microespera para permitir asentar setStates previos en cadenas del planner
          await new Promise((r) => setTimeout(r, 0));
          const res = await apiConfirmDocument();
          if (res.ok) {
            appendLog(`✔ confirmado (${res.number}) total: ${total.grand.toFixed(2)} ${docState.currency}`);
            setCart([]);
            setDiscountPct(0);
            setQty(1);
            qtyRef.current = 1;
          } else {
            appendLog("✖ error al confirmar");
          }
        } catch {
          appendLog("✖ error al confirmar");
        }
        break;
      }

      case "clear_cart": {
        showConfirm({
          message: "¿Vaciar carrito?",
          onOk: () => {
            setCart([]);
            setDiscountPct(0);
            setQty(1);
            qtyRef.current = 1;
            appendLog("carrito vacío");
          },
        });
        break;
      }
      

      case "repeat": {
        appendLog(
          `TOTAL → neto ${total.net.toFixed(2)} desc ${total.discount.toFixed(2)} = ${total.grand.toFixed(
            2
          )} ${docState.currency}`
        );
        break;
      }

      case "remove_last_item": {
        setCart((c) => {
          if (!c.length) { appendLog("carrito vacío"); return c; }
          const removed = c[c.length - 1];
          appendLog(`- eliminado último: ${removed.item_name} x${removed.qty}`);
          return c.slice(0, -1);
        });
        break;
      }
      
      case "remove_from_cart": {
        const idxRaw = a.params?.index;
        const itemCode = (a.params as any)?.item_code || (a.params as any)?.code;
        const nameRaw = (a.params as any)?.name || (a.params as any)?.item_name;
      
        setCart((c) => {
          if (!c.length) { appendLog("carrito vacío"); return c; }
      
          // 1) Por índice (1-based)
          const idx = Number(idxRaw);
          if (Number.isInteger(idx) && idx >= 1 && idx <= c.length) {
            const removed = c[idx - 1];
            appendLog(`- eliminado #${idx}: ${removed.item_name} x${removed.qty}`);
            return [...c.slice(0, idx - 1), ...c.slice(idx)];
          }
      
          // 2) Por item_code exacto
          if (itemCode) {
            const i = c.findIndex(row => row.item_code === itemCode);
            if (i >= 0) {
              const removed = c[i];
              appendLog(`- eliminado ${removed.item_name} (${itemCode})`);
              return [...c.slice(0, i), ...c.slice(i + 1)];
            }
          }
      
          // 3) Por nombre (contains, insensible a acentos)
          if (nameRaw) {
            const norm = (s:string) => stripDiacritics(s).toLowerCase().replace(/\s+/g, " ").trim();
            const target = norm(nameRaw);
            const i = c.findIndex(row => norm(row.item_name).includes(target));
            if (i >= 0) {
              const removed = c[i];
              appendLog(`- eliminado ${removed.item_name}`);
              return [...c.slice(0, i), ...c.slice(i + 1)];
            }
          }
      
          appendLog("⚠ no encontré el ítem a eliminar");
          return c;
        });
        break;
      }
      
      

      default:
        appendLog(`acción desconocida: ${a.action}`);
    }
  }

// ===== VOZ (hook)
// ===== VOZ (hook)
const phraseBufRef = useRef<{ acc: string; timer: number | null }>({ acc: "", timer: null });

const voice = useRealtimeVoice({
  bridgeBase: BRIDGE_BASE,

  onUserText: async (raw) => {
    // ----- 0) Ensamblador de micro-frases con debounce -----
    const seg = (raw || "").trim();
    if (!seg) return;

    // acumulamos en buffer
    if (phraseBufRef.current.timer) {
      clearTimeout(phraseBufRef.current.timer);
      phraseBufRef.current.timer = null;
    }
    phraseBufRef.current.acc = (phraseBufRef.current.acc ? phraseBufRef.current.acc + " " : "") + seg;

    // cuando pasan 700ms sin nuevos segmentos, “cerramos” la frase y recién ahí interpretamos
    phraseBufRef.current.timer = window.setTimeout(async () => {
      const buffered = phraseBufRef.current.acc.trim();
      phraseBufRef.current.acc = "";
      phraseBufRef.current.timer = null;
      if (!buffered) return;

      // ----- 1) lo que ya tenías (idéntico), pero usando `buffered` en lugar de `raw` -----
      const waitUntilResults = async (timeoutMs = 3000) => {
        const t0 = Date.now();
        while (Date.now() - t0 < timeoutMs) {
          if (resultsRef.current.length > 0) return true;
          await new Promise((r) => setTimeout(r, 60));
        }
        return resultsRef.current.length > 0;
      };

      let text = buffered;
      {
        const now = Date.now();
        const arr = recentVoiceRef.current;
        while (arr.length && now - arr[0].t > 3000) arr.shift();
        const already =
          (arr as any).findLast?.((x: any) => x.text === text) ||
          arr.slice().reverse().find((x) => x.text === text);
        if (already && now - (already as any).t < 2500) {
          appendLog("⏩ ignorado duplicado de voz (texto repetido)");
          return;
        }
        arr.push({ text, t: now });
      }

      const lower = text.toLowerCase().replace(/[.!?]\s*$/g, "");
      const norm = lower.replace(/\bpor\b/g, " x ").replace(/\s+/g, " ").trim();

      appendLog(`🎙️ usuario: ${text}`);

      // Confirmar directo
      if (/\bconfirm\w*\b/i.test(norm)) {
        if (mode === "FACTURA" && !paymentSel.mop) {
          await dispatchAction({ action: "set_payment", params: { mop: "Cash" } });
        }
        await dispatchAction({ action: "confirm_document" });
        return;
      }

      // "pago <método>"
      const mPago = norm.match(/^pago\s+(.+)$/i);
      if (mPago) {
        const mopRaw = mPago[1].trim();
        const mop = normalizeMop(mopRaw) ?? mopRaw;
        await dispatchAction({ action: "set_payment", params: { mop } });
        return;
      }
      if (
        mode === "FACTURA" &&
        /^(efectivo|cash|transferencia|tarjeta(?:\s+(?:credito|crédito|debito|débito))?)$/i.test(norm)
      ) {
        const mop = normalizeMop(norm) ?? norm;
        await dispatchAction({ action: "set_payment", params: { mop } });
        return;
      }

      // 1) Planner primero
      try {
        const resumen = await interpretAndDispatch(text);
        if (resumen) (voice as any).speak(resumen);
        return;
      } catch (e) {
        const msg = (e as any)?.message ?? "Error procesando el pedido";
        appendLog(`✖ voz→interpret: ${msg}`);
      }

      // 2) Atajos locales (fallback)

      // MODO
      if (/^modo\s+(presupuesto|factura|remito)$/i.test(norm)) {
        const m = norm.match(/^modo\s+(presupuesto|factura|remito)$/i)!;
        const modo = m[1].toUpperCase();
        await dispatchAction({ action: "set_mode", params: { mode: modo } });
        (voice as any).speak(`Modo ${m[1]}.`);
        return;
      }

      // “Buscar <algo>”
      const mBuscar = norm.match(/^(?:busca|buscar|buscá|buscame|buscáme)\s+(.+)$/i);
      if (mBuscar) {
        const term = mBuscar[1].trim();
        await dispatchAction({ action: "search", params: { term } });
        return;
      }

      // Fallback 1 palabra → búsqueda
      if (!/\s/.test(norm) && norm.length >= 2) {
        await dispatchAction({ action: "search", params: { term: norm } });
        return;
      }

      // “ítem N, cantidad Q”
      const mSelQty = norm.match(/^(?:ítem|item)\s+(\d+)\s*,?\s*cantidad\s+(\d+)$/i);
      if (mSelQty) {
        const idx = Number(mSelQty[1]);
        const q = Math.max(1, Number(mSelQty[2]));
        if (resultsRef.current.length === 0 && !(await waitUntilResults())) {
          (voice as any).speak("Decime primero qué buscar.");
          return;
        }
        await dispatchAction({ action: "select_index", params: { index: idx } });
        await dispatchAction({ action: "set_qty", params: { qty: q } });
        return;
      }

      // “del ítem N agregar Q”
      const mDelSelAdd = norm.match(
        /^del\s+(?:ítem|item)\s+(\d+)\s*,?\s*(?:agrega(?:r)?|sumar|añadir|poner)\s*(\d+)\s*(?:unidades?)?$/i
      );
      if (mDelSelAdd) {
        const idx = Number(mDelSelAdd[1]);
        const q = Math.max(1, Number(mDelSelAdd[2]));
        if (resultsRef.current.length === 0 && !(await waitUntilResults())) {
          (voice as any).speak("Decime primero qué buscar.");
          return;
        }
        await dispatchAction({ action: "select_index", params: { index: idx } });
        await dispatchAction({ action: "set_qty", params: { qty: q } });
        await dispatchAction({ action: "add_to_cart", params: { index: idx } });
        (voice as any).speak("Listo.");
        return;
      }

      // “item N agregar Q”
      const mSelAdd = norm.match(/^(?:ítem|item)\s+(\d+)\s*,?\s*(?:agrega(?:r)?|sumar|añadir|poner)\s*(\d+)?$/i);
      if (mSelAdd) {
        const idx = Number(mSelAdd[1]);
        const qOpt = mSelAdd[2] ? Math.max(1, Number(mSelAdd[2])) : null;
        if (resultsRef.current.length === 0 && !(await waitUntilResults())) {
          (voice as any).speak("Decime primero qué buscar.");
          return;
        }
        await dispatchAction({ action: "select_index", params: { index: idx } });
        if (qOpt) await dispatchAction({ action: "set_qty", params: { qty: qOpt } });
        await dispatchAction({ action: "add_to_cart", params: { index: idx } });
        (voice as any).speak("Listo.");
        return;
      }

      // “agregar ítem” (sin N)
      if (/^(?:agrega(?:r)?|sumar|añadir|poner)\s+(?:el\s+)?(?:ítem|item)\b$/i.test(norm)) {
        if (resultsRef.current.length === 0 && !(await waitUntilResults())) {
          (voice as any).speak("Decime primero qué buscar.");
          return;
        }
        const idx = selectedIndex ?? (resultsRef.current.length > 0 ? 1 : null);
        if (!idx) {
          appendLog("no hay selección");
          return;
        }
        await dispatchAction({ action: "select_index", params: { index: idx } });
        await dispatchAction({ action: "add_to_cart", params: { index: idx } });
        (voice as any).speak("Listo.");
        return;
      }

      // “cantidad Q”
      const mQty = norm.match(/^(?:cantidad|poner)\s+(\d+)$/i);
      if (mQty) {
        const q = Math.max(1, Number(mQty[1]));
        await dispatchAction({ action: "set_qty", params: { qty: q } });
        (voice as any).speak(`Cantidad ${q}.`);
        return;
      }

      // “ítem N” (selección directa)
      const mSel = norm.match(/^(?:ítem|item)\s+(\d+)$/i);
      if (mSel) {
        const idx = Number(mSel[1]);
        if (resultsRef.current.length === 0 && !(await waitUntilResults())) {
          (voice as any).speak("Decime primero qué buscar.");
          return;
        }
        await dispatchAction({ action: "select_index", params: { index: idx } });
        return;
      }

      // último fallback
      await dispatchAction({ action: "search", params: { term: norm } });
    }, 700); // <-- ventana de “silencio” antes de interpretar
  },

  // Opciones del hook
  audioElId: "assistantAudio",
  onListeningChange(on: boolean) {
    setListening(on);
    console.log("[voice] listening:", on);
  },
  beeps: true,
  pttMaxMs: 8000,
  onError: (e: any) => appendLog(`⚠ voz: ${e?.message ?? e}`),
}); // <-- cierre de useRealtimeVoice


// cleanup del buffer de frases
useEffect(() => {
  return () => {
    if (phraseBufRef.current.timer) {
      clearTimeout(phraseBufRef.current.timer);
      phraseBufRef.current.timer = null;
    }
  };
}, []);


// Hotkeys globales: Space / Esc
useEffect(() => {
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.code === "Space" && !e.repeat) {
      e.preventDefault();
      (voice as any).startListening?.();
      (voice as any).pttDown?.();
    } else if (e.code === "Escape") {
      e.preventDefault();
      (voice as any).stopListening?.();
      (voice as any).cancelCurrentTurn?.();
    }
  };
  const onKeyUp = (e: KeyboardEvent) => {
    if (e.code === "Space") {
      e.preventDefault();
      if (!(voice as any).latch) {
        (voice as any).stopListening?.();
        (voice as any).pttUp?.();
      }
    }
  };
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  return () => {
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
  };
}, [voice]);

// Helper opcional: latch + start
const toggleLatchAndStart = () => {
  try { (voice as any).toggleLatch?.(); } catch {}
  setTimeout(() => {
    try {
      if ((voice as any).latch) {
        (voice as any).startListening?.();
        (voice as any).pttDown?.();
        (voice as any).beginListening?.();
      }
    } catch {}
  }, 0);
};


// === DEBUG: exponer y loguear 'voice' ===
useEffect(() => {
  // @ts-ignore
  (window as any).voice = voice;
  try {
    const keys = Object.keys(voice || {});
    console.log("[voice] objeto exportado:", keys);
  } catch (e) {
    console.log("[voice] no pude inspeccionar keys:", e);
  }
}, [voice]);



  // ===== Catálogo (whitelist) y snapshot para el LLM =====
  const ACTIONS_CATALOG: LLMActionsDoc = {
    actions: [
      { action: "set_mode" },
      { action: "search" },
      { action: "select_index" },
      { action: "set_qty" },
      { action: "add_to_cart" },
      { action: "set_global_discount" },
      { action: "set_customer" },
      { action: "set_payment" },
      { action: "confirm_document" },
      { action: "clear_cart" },
      { action: "repeat" },
      { action: "remove_from_cart" },
      { action: "remove_last_item" },
    ],
  };

  function getFrontStateSnapshot(): LLMFrontState {
    return {
      mode,
      customer,
      total: { net: total.net, discount: total.discount, grand: total.grand, currency: docState.currency },
      cart: cart.map((c) => ({
        item_code: c.item_code,
        qty: c.qty,
        uom: c.uom,
        unit_price: c.unit_price,
      })),
    };
  }

// ===== UI =====
const ACTIONS_DOC = `
[CATALOGO_ACCIONES]
- set_mode(mode)
- search(term)
- select_index(index)
- set_qty(qty)
- add_to_cart()
- set_global_discount(percent)
- set_customer(name)
- set_payment({ mop, account?, amount? })
- confirm_document()
- clear_cart()
- remove_from_cart(index|name)
- remove_last_item()
- repeat()
`;

return (
  <div className="relative min-h-screen w-full text-neutral-900 bg-transparent">
    <ArtPollock
      density={140}
      opacityRange={[0.25, 0.4]}
      strokeRange={[1.5, 3]}
      colors={["#E8D5FF", "#C7F2F0", "#FFE2B8", "#FFD6E0", "#DDE8FF"]}
    />
    <div className="relative z-10 p-4">
      <div className="mx-auto max-w-6xl grid grid-cols-2 gap-4">
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
            <CustomerPicker
              value={customer}
              bridgeBase={BRIDGE_BASE}
              onSelect={(name) => dispatchAction({ action: "set_customer", params: { name } })}
            />
          </div>

          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">Desc. (%)</span>
            <input
              type="number"
              className="border rounded-xl px-3 py-2 w-24"
              value={discountPct}
              min={0}
              max={100}
              onChange={(e) => dispatchAction({ action: "set_global_discount", params: { percent: Number(e.target.value) } })}
            />
          </div>

          {mode === "FACTURA" && (
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">Pago</span>
              <select
                className="border rounded-xl px-3 py-2"
                value={paymentSel.mop || ""}
                onChange={(e) => {
                  const mopRaw = e.target.value || undefined;
                  const mop = mopRaw ? (normalizeMop(mopRaw) ?? mopRaw) : undefined;
                  const accs = mop ? (paymentMethods.find((m) => m.name === mop)?.accounts || []) : [];
                  setPaymentSel({
                    mop,
                    account: accs && accs.length > 0 ? (accs[0]?.account || undefined) : undefined,
                  });
                }}
              >
                <option value="">Elegí un método…</option>
                {paymentMethods.map((m) => (
                  <option key={m.name} value={m.name}>
                    {m.name}
                  </option>
                ))}
              </select>
              {paymentSel.mop &&
                (paymentMethods.find((m) => m.name === paymentSel.mop)?.accounts?.length || 0) > 0 && (
                  <select
                    className="border rounded-xl px-3 py-2"
                    value={paymentSel.account || ""}
                    onChange={(e) => setPaymentSel((prev) => ({ ...prev, account: e.target.value || undefined }))}
                  >
                    {(paymentMethods.find((m) => m.name === paymentSel.mop)?.accounts || []).map((a, i) => (
                      <option key={`${a.account}-${i}`} value={a.account || ""}>
                        {a.account || "(sin cuenta)"}
                      </option>
                    ))}
                  </select>
                )}
            </div>
          )}

          <div className="flex items-center gap-2">
            <button
              onClick={async () => {
                try {
                  // Pide permiso de mic explícitamente (ayuda con permisos en Opera/Chrome)
                  try {
                    await navigator.mediaDevices.getUserMedia({ audio: true });
                  } catch {
                    appendLog("⚠ permiso de mic denegado o falló");
                  }
          
                  await (voice as any).connect();
                  appendLog("✅ Voz conectada");
          
                  // Adjuntar el <audio> de salida
                  const el = document.getElementById("assistantAudio") as HTMLAudioElement | null;
                  if (el) {
                    (voice as any).attachAudioElement?.(el);
                    (voice as any).setAudioElement?.(el);
                    appendLog("🔊 audio de asistente adjuntado");
                  } else {
                    appendLog("⚠ no encontré <audio id='assistantAudio'> en el DOM");
                  }
                } catch (e) {
                  appendLog("✖ conectar voz: " + ((e as any)?.message ?? e));
                }
              }}
              disabled={(voice as any).connected}
              className="rounded-xl px-3 py-2 bg-blue-600 text-white"
            >
              {(voice as any).connected ? "Voz conectada" : "Conectar voz"}
            </button>
          
            {/* ⬇️ ESTE elemento es clave */}
            <audio id="assistantAudio" autoPlay playsInline />
          
            {/* Indicador de escucha */}
            <div
              className={`ml-2 w-2 h-2 rounded-full ${
                listening ? "bg-red-500 animate-pulse" : "bg-neutral-300"
              }`}
              title={listening ? "Escuchando" : "Silencio"}
            />
          </div>
          

          <div className="flex flex-wrap items-center gap-2">
            <button
              className={`rounded-xl px-3 py-2 ${listening ? "bg-green-600 text-white" : "bg-neutral-200"}`}
              onMouseDown={() => {
                (voice as any).startListening?.();
                (voice as any).pttDown?.();
                (voice as any).beginListening?.();
              }}
              onMouseUp={() => {
                if (!(voice as any).latch) {
                  (voice as any).stopListening?.();
                  (voice as any).pttUp?.();
                  (voice as any).endListening?.();
                }
              }}
              onDoubleClick={() => {
                (voice as any).toggleLatch?.();
                setTimeout(() => {
                  if ((voice as any).latch) {
                    (voice as any).startListening?.();
                    (voice as any).pttDown?.();
                    (voice as any).beginListening?.();
                  }
                }, 0);
              }}
              title={(voice as any).latch ? "Latch ON (doble click para cortar)" : "Push-to-Talk (doble click para latch)"}
            >
              {(voice as any).latch ? "🎙️ LATCH" : listening ? "🎙️ ESCUCHANDO" : "🎤 Hablar"}
            </button>

            <input
              className="border rounded-xl px-3 py-2 w-80"
              placeholder="Decí algo… ej: 'buscar caño 3/4', 'ítem 1', 'cantidad 3'"
              onKeyDown={async (e) => {
                if (e.key === "Enter") {
                  const v = (e.target as HTMLInputElement).value;
                  (e.target as HTMLInputElement).value = "";
                  await interpretAndDispatch(v);
                }
              }}
            />
            {/* === Chips de filtros aplicados (si existen) === */}
            {filtersToChips(appliedFilters).length > 0 && (
              <div className="flex flex-wrap items-center gap-2 mb-2">
                {filtersToChips(appliedFilters).map((c) => (
                  <button
                    key={c.key}
                    className="text-xs px-2 py-1 rounded-full bg-neutral-100 hover:bg-neutral-200 border"
                    title="Quitar filtro"
                    onClick={async () => {
                      const nf = removeChip(appliedFilters, c.key);
                      setAppliedFilters(nf);
                      const term = (searchTerm || "").trim();
                      if (term) {
                        const data = await apiSearch(term, nf);
                        setResults(data);
                        resultsRef.current = data;
                        setSelectedIndex(data.length ? 1 : null);
                        selectedIndexRef.current = data.length ? 1 : 0; // ✅ sincronizado
                      }
                    }}
                  >
                    {c.label} ×
                  </button>
                ))}
                <button
                  className="text-xs px-2 py-1 rounded-full bg-neutral-100 hover:bg-neutral-200 border ml-1"
                  onClick={async () => {
                    setAppliedFilters(null);
                    const term = (searchTerm || "").trim();
                    if (term) {
                      const data = await apiSearch(term, null);
                      setResults(data);
                      resultsRef.current = data;
                      setSelectedIndex(data.length ? 1 : null);
                      selectedIndexRef.current = data.length ? 1 : 0; // ✅ sincronizado
                    }
                  }}
                  title="Quitar todos los filtros"
                >
                  Limpiar filtros
                </button>
              </div>
            )}
            
            {/* Sugerencias del backend (meta.tried_terms) */}
            {triedTerms.length > 0 && (
              <div className="text-xs text-neutral-500 mb-2">
                ¿No apareció lo que buscabas? Probá:{" "}
                {triedTerms.map((tt, i) => (
                  <button
                    key={tt + i}
                    className="underline mr-2"
                    onClick={async () => {
                      setSearchTerm(tt);
                      const data = await apiSearch(tt, appliedFilters);
                      setResults(data);
                      resultsRef.current = data;
                      setSelectedIndex(data.length ? 1 : null);
                      selectedIndexRef.current = data.length ? 1 : 0; // ✅ sincronizado
                    }}
                  >
                    {tt}
                  </button>
                ))}
              </div>
            )}
            
            
            <button
              className="rounded-xl px-4 py-2 bg-neutral-800 text-white"
              onClick={async () => {
                if (mode === "FACTURA" && !paymentSel.mop) {
                  appendLog("✖ falta seleccionar modo de pago (decí: 'pago efectivo' o elegilo en la UI')");
                  return;
                }
                await dispatchAction({ action: "confirm_document" });
              }}
            >
              {loading ? "Procesando…" : "Confirmar"}
            </button>

            <div className="flex items-center gap-1 ml-3 text-xs">
              <span className="px-2 py-1 rounded bg-neutral-100">listening: {String(listening)}</span>
              <span className="px-2 py-1 rounded bg-neutral-100">latch: {String((voice as any).latch)}</span>
              <button
                className="px-2 py-1 rounded bg-neutral-200"
                onClick={() => {
                  try {
                    const keys = Object.keys(voice || {});
                    console.log("[voice] keys:", keys);
                    appendLog("debug → mirá consola: Object.keys(voice)");
                  } catch {}
                }}
              >
                🔎 keys
              </button>
              <button
                className="px-2 py-1 rounded bg-neutral-200"
                onClick={() => {
                  (voice as any).startListening?.();
                  (voice as any).pttDown?.();
                  (voice as any).beginListening?.();
                }}
              >
                ▶ start
              </button>
              <button
                className="px-2 py-1 rounded bg-neutral-200"
                onClick={() => {
                  (voice as any).stopListening?.();
                  (voice as any).pttUp?.();
                  (voice as any).endListening?.();
                }}
              >
                ⏹ stop
              </button>
              <button
                className="px-2 py-1 rounded bg-neutral-200"
                onClick={() => {
                  (voice as any).toggleLatch?.();
                }}
              >
                🔁 latch
              </button>
            </div>
          </div>
        </div>

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

          <div className="divide-y border rounded-XL overflow-hidden max-h-96 overflow-y-auto">
            {results.map((r, i) => {
              const bi = backendItems.find((x) => x.code === r.item_code);
              const index = bi?.index ?? i + 1;
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
                  <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="number"
                      min={1}
                      className="w-20 border rounded-xl px-2 py-1"
                      value={qtyPer[code] ?? 1}
                      onChange={(e) => {
                        const qn = Math.max(1, Math.floor(Number(e.target.value || 1)));
                        setQtyPer((prev) => ({ ...prev, [code]: qn }));
                      }}
                    />
                    <button
                      className="rounded-xl px-3 py-2 bg-neutral-800 text-white disabled:opacity-60"
                      onClick={async () => {
                        await dispatchAction({ action: "select_index", params: { index } });
                        await dispatchAction({ action: "add_to_cart" });
                      }}
                      disabled={loading || (!inStock && mode !== "PRESUPUESTO")}
                      title={!inStock && mode !== "PRESUPUESTO" ? "Sin stock en este modo" : "Agregar al carrito"}
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
                    <td className="p-2">{i + 1}. {c.item_name}</td>
                    <td className="p-2 text-right">{c.qty} {c.uom}</td>
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
              Neto: <span className="font-medium">{total.net.toFixed(2)} {docState.currency}</span>
            </div>
            <div>
              Desc.: <span className="font-medium">{total.discount.toFixed(2)}</span>
            </div>
            <div className="text-lg">
              TOTAL: <span className="font-semibold">{total.grand.toFixed(2)} {docState.currency}</span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              className="rounded-xl px-4 py-2 bg-neutral-800 text-white disabled:opacity-50"
              disabled={loading || cart.length === 0}
              onClick={async () => {
                if (mode === "FACTURA" && !paymentSel.mop) {
                  appendLog("✖ falta seleccionar modo de pago (decí: 'pago efectivo' o elegilo en la UI')");
                  return;
                }
                await dispatchAction({ action: "confirm_document" });
              }}
            >
              {loading ? "Procesando…" : "Confirmar"}
            </button>

            <button className="rounded-xl px-4 py-2 bg-neutral-200 text-neutral-900" onClick={() => window.print?.()}>
              Imprimir
            </button>
          </div>

          <div className="bg-white/80 backdrop-blur rounded-2xl shadow p-3">
            <div className="text-sm font-semibold mb-2">Consola</div>
            <pre className="text-xs whitespace-pre-wrap max-h-48 overflow-auto border rounded-xl p-3 bg-neutral-50">
              {ACTIONS_DOC}
              {"\n"}
              {log.map((l) => `• ${l}`).join("\n")}
            </pre>
          </div>
        </div>
      </div>
    </div>
  </div>
);
}
