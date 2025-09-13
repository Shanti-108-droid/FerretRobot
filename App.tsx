// BEGIN App.tsx

import { useRealtimeVoice } from "./voice/useRealtimeVoice";
import React, { useMemo, useState, useRef, useEffect } from "react";
import { ArtPollock } from "./ArtPollock";
import { CustomerPicker } from "./CustomerPicker";
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
export default function App() {
  // Estado

  const resumenRef = useRef<string[]>([]);
  const pushResumen = (s: string) => { if (s) resumenRef.current.push(s); };
  const [mode, setMode] = useState<Mode>("PRESUPUESTO");
  const [customer, setCustomer] = useState<string>("Consumidor Final");
  const [discountPct, setDiscountPct] = useState<number>(0);
  const [searchTerm, setSearchTerm] = useState<string>("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [backendItems, setBackendItems] = useState<BackendItem[]>([]);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const qtyRef = useRef<number>(1);
  const lastAddRef = useRef<{ key: string; t: number } | null>(null);
  const selectedIndexRef = useRef<number | null>(null);
  const [qty, setQty] = useState<number>(1);
  const [qtyPer, setQtyPer] = useState<Record<string, number>>({});
  const [cart, setCart] = useState<CartLine[]>([]);
  const [log, setLog] = useState<string[]>([]);
  const [micOn, setMicOn] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(false);

  // 🔧 resultsRef para que onUserText pueda ver “lo último”
  const resultsRef = useRef<SearchResult[]>([]);
  useEffect(() => { resultsRef.current = results; }, [results]);
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
  // --- Dispatcher mínimo (cubre lo que usás ahora)
  type Action = { action: string; params?: Record<string, any> };
  
  async function dispatchAction(a: Action) {
    switch (a.action) {
      case "search": {
        const raw = (a.params?.term ?? a.params?.query ?? "").toString();
        const cleaned = raw.replace(/^\s*(?:busc(?:a|ar|á|ame)?|search|find)\b[:,-]?\s*/i, "");
        const term = cleaned || raw;
        const data = await apiSearch(term);
        setResults(data);
        resultsRef.current = data;
        const sel = data.length ? 1 : null;
        setSelectedIndex(sel);
        selectedIndexRef.current = sel ?? 0;
        setSearchTerm(term);
        appendLog(`buscando: "${term}" (${data.length} resultados)`);
        break;
      }
  
      case "select_index": {
        const idx1 = Number(a.params?.index ?? 0);
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
        if (!list || !list.length) { appendLog("no hay resultados (list vacía)"); break; }
        if (!idx1 || idx1 < 1 || idx1 > list.length) {
          appendLog(`no hay selección (list_len=${list.length}, sel=${idx1 || 0})`);
          break;
        }
        const res = list[idx1 - 1];
        const qEff = Number(qtyPer[res.item_code] ?? qtyRef.current ?? qty) || 1;
        const line = await apiGetItemDetail(res, qEff);
        if (line) {
          setCart((c) => [...c, line]);
          appendLog(`+ ${line.qty} x ${line.item_name} @ ${line.unit_price} → ${line.subtotal}`);
        }
        break;
      }
  
      case "confirm_document": {
        const res = await apiConfirmDocument();
        if (res.ok) {
          appendLog(`✔ confirmado (${res.number}) total: ${total.grand.toFixed(2)} ${docState.currency}`);
          setCart([]); setDiscountPct(0); setQty(1); qtyRef.current = 1;
        } else {
          appendLog("✖ error al confirmar");
        }
        break;
      }
  
      case "clear_cart": {
        setCart([]); setDiscountPct(0); setQty(1); qtyRef.current = 1;
        appendLog("carrito vacío");
        break;
      }
  
      default:
        appendLog(`acción desconocida: ${a.action}`);
    }
  }
  

  // Métodos de pago
  const [paymentMethods, setPaymentMethods] = useState<
    { name: string; accounts?: { company?: string; account?: string }[] }[]
  >([]);
  const [paymentSel, setPaymentSel] = useState<{ mop?: string; account?: string }>({});

  // VOZ (hook)
  const voice = useRealtimeVoice({
    bridgeBase: BRIDGE_BASE,
    onUserText: async (raw) => {
      // Espera hasta 3s a que aparezcan resultados (leyendo ref, no el estado “viejo”)
      const waitUntilResults = async (timeoutMs = 3000) => {
        const t0 = Date.now();
        while (Date.now() - t0 < timeoutMs) {
          if (resultsRef.current.length > 0) return true;
          await new Promise((r) => setTimeout(r, 60));
        }
        return resultsRef.current.length > 0;
      };

      // Limpieza
      let text = (raw || "").trim();
      const lower = text.toLowerCase().replace(/[.!?]\s*$/g, "");
      const norm = lower.replace(/\bpor\b/g, " x ").replace(/\s+/g, " ").trim();

      appendLog(`🎙️ usuario: ${text}`);

      // ======== 1) Planner primero (llama al /bridge/interpret) ========
      try {
        const resumen = await interpretAndDispatch(text); // ← tu función que llama al backend y ejecuta actions
        if (resumen) voice.speak(resumen);                // opcional: que diga 1 frase
        return; // 👈 si interpret resolvió, NO seguimos con atajos
      } catch (e) {
        const msg = (e as any)?.message ?? "Error procesando el pedido";
        appendLog(`✖ voz→interpret: ${msg}`);
        // No hacemos return: seguimos con atajos como fallback
      }

      // ======== 2) Atajos locales (fallback) ========

      // MODO
      if (/^modo\s+(presupuesto|factura|remito)$/i.test(norm)) {
        const m = norm.match(/^modo\s+(presupuesto|factura|remito)$/i)!;
        const modo = m[1].toUpperCase();
        await dispatchAction({ action: "set_mode", params: { mode: modo } });
        voice.speak(`Modo ${m[1]}.`);
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
          voice.speak("Decime primero qué buscar.");
          return;
        }
        await dispatchAction({ action: "select_index", params: { index: idx } });
        await dispatchAction({ action: "set_qty", params: { qty: q } });
        return;
      }

      // “del ítem N agregar Q”
      const mDelSelAdd = norm.match(/^del\s+(?:ítem|item)\s+(\d+)\s*,?\s*(?:agrega(?:r)?|sumar|añadir|poner)\s*(\d+)\s*(?:unidades?)?$/i);
      if (mDelSelAdd) {
        const idx = Number(mDelSelAdd[1]);
        const q = Math.max(1, Number(mDelSelAdd[2]));
        if (resultsRef.current.length === 0 && !(await waitUntilResults())) {
          voice.speak("Decime primero qué buscar.");
          return;
        }
        await dispatchAction({ action: "select_index", params: { index: idx } });
        await dispatchAction({ action: "set_qty", params: { qty: q } });
        await dispatchAction({ action: "add_to_cart", params: { index: idx } });
        voice.speak("Listo.");
        return;
      }

      // “item N agregar Q”
      const mSelAdd = norm.match(/^(?:ítem|item)\s+(\d+)\s*,?\s*(?:agrega(?:r)?|sumar|añadir|poner)\s*(\d+)?$/i);
      if (mSelAdd) {
        const idx = Number(mSelAdd[1]);
        const qOpt = mSelAdd[2] ? Math.max(1, Number(mSelAdd[2])) : null;
        if (resultsRef.current.length === 0 && !(await waitUntilResults())) {
          voice.speak("Decime primero qué buscar.");
          return;
        }
        await dispatchAction({ action: "select_index", params: { index: idx } });
        if (qOpt) await dispatchAction({ action: "set_qty", params: { qty: qOpt } });
        await dispatchAction({ action: "add_to_cart", params: { index: idx } });
        voice.speak("Listo.");
        return;
      }

      // “agregar (el) ítem N (x|por|de Q)?”
      const mAdd = norm.match(/^(?:agrega(?:r)?|sumar|añadir|poner)\s+(?:el\s+)?(?:ítem|item)\s+(\d+)(?:\s*(?:x|por|de)\s*(\d+))?$/i);
      if (mAdd) {
        const idx = Number(mAdd[1]);
        const qOpt = mAdd[2] ? Math.max(1, Number(mAdd[2])) : null;
        if (resultsRef.current.length === 0 && !(await waitUntilResults())) {
          voice.speak("Decime primero qué buscar.");
          return;
        }
        await dispatchAction({ action: "select_index", params: { index: idx } });
        if (qOpt) await dispatchAction({ action: "set_qty", params: { qty: qOpt } });
        await dispatchAction({ action: "add_to_cart", params: { index: idx } });
        voice.speak("Listo.");
        return;
      }

      // “agregar ítem” (sin N)
      if (/^(?:agrega(?:r)?|sumar|añadir|poner)\s+(?:el\s+)?(?:ítem|item)\b$/i.test(norm)) {
        if (resultsRef.current.length === 0 && !(await waitUntilResults())) {
          voice.speak("Decime primero qué buscar.");
          return;
        }
        const idx = selectedIndex ?? (resultsRef.current.length > 0 ? 1 : null);
        if (!idx) { appendLog("no hay selección"); return; }
        await dispatchAction({ action: "select_index", params: { index: idx } });
        await dispatchAction({ action: "add_to_cart", params: { index: idx } });
        voice.speak("Listo.");
        return;
      }

      // “cantidad Q”
      const mQty = norm.match(/^(?:cantidad|poner)\s+(\d+)$/i);
      if (mQty) {
        const q = Math.max(1, Number(mQty[1]));
        await dispatchAction({ action: "set_qty", params: { qty: q } });
        voice.speak(`Cantidad ${q}.`);
        return;
      }

      // “ítem N” (selección directa)
      const mSel = norm.match(/^(?:ítem|item)\s+(\d+)$/i);
      if (mSel) {
        const idx = Number(mSel[1]);
        if (resultsRef.current.length === 0 && !(await waitUntilResults())) {
          voice.speak("Decime primero qué buscar.");
          return;
        }
        await dispatchAction({ action: "select_index", params: { index: idx } });
        return;
      }

      // Si nada matcheó y el planner falló, último fallback: buscar literal
      await dispatchAction({ action: "search", params: { term: norm } });
    },

  });

  // ===== API
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

  function setSelectedIdx(n: number | null) {
    setSelectedIndex(n);
    selectedIndexRef.current = n;
  }

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

async function apiConfirmDocument(): Promise<{ ok: boolean; number?: string }> {
  setLoading(true);
  try {
    // Guardrail: en FACTURA exigimos un modo de pago seleccionado
    if (mode === "FACTURA" && !paymentSel?.mop) {
      appendLog("✖ falta seleccionar modo de pago (decí: 'pago efectivo' o elegilo en la UI')");
      return { ok: false };
    }

    const body: any = {
      mode,
      customer,
      items: cart.map((c) => ({
        item_code: c.item_code,
        qty: c.qty,
        uom: c.uom,
        price_list_rate: c.unit_price,
      })),
      discount_pct: discountPct,
    };

    if (mode === "FACTURA" && paymentSel?.mop) {
      body.payments = [
        {
          mode_of_payment: paymentSel.mop,
          amount: total.grand,
          ...(paymentSel.account ? { account: paymentSel.account } : {}),
        },
      ];
    }

    const r = await fetch(`${BRIDGE_BASE}/bridge/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!r.ok) {
      let rawText = "";
      try { rawText = await r.text(); } catch {}
      let parsed: any = null;
      try { parsed = rawText ? JSON.parse(rawText) : null; } catch {}

      if (r.status === 400) {
        const detail = parsed?.detail ?? parsed ?? rawText;
        let detailObj: any = null;
        try { detailObj = typeof detail === "string" ? JSON.parse(detail) : detail; } catch {}
        if (detailObj?.code === "PAYMENT_REQUIRED") {
          setPaymentMethods(Array.isArray(detailObj.payment_methods) ? detailObj.payment_methods : []);
          appendLog("Elegí un modo de pago y volvé a confirmar.");
          return { ok: false };
        }
      }

      const msg = parsed?.detail || parsed?.message || rawText || `(sin detalle)`;
      appendLog(`✖ confirmar falló: ${r.status} ${msg}`);
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

  async function interpretAndDispatch(text: string) {
    try {
      const resultsSnapshot =
        (backendItems && backendItems.length
          ? backendItems.map(bi => ({
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
        cart: cart.map(c => ({
          item_code: c.item_code,
          qty: c.qty,
          uom: c.uom,
          unit_price: c.unit_price,
        })),
        results: resultsSnapshot,
        selected_index: selectedIndex,
        qty_hint: qty,
        payment: (mode === "FACTURA" && paymentSel.mop)
          ? { mop: paymentSel.mop, account: paymentSel.account || undefined }
          : undefined,
      };

      const catalogList = [
        "set_mode","search","select_index","set_qty","add_to_cart",
        "set_global_discount","set_customer","set_payment",
        "confirm_document","clear_cart","repeat",
      ];

      // === PATCH INICIO: payload con snapshot de results (+ anti-race) ===
      
      // 1) Snapshot 1-based de los resultados visibles
      const plannerResults = (resultsRef.current ?? [])
        .slice(0, 12)
        .map((r: any, i: number) => ({
          index: i + 1,
          item_code: r.item_code,
          item_name: r.item_name,
        }));
      
      // 2) Extender el state con ese snapshot
      const stateForPlanner = {
        ...state,                // mode, customer, total, selected_index, qty_hint, payment, etc.
        results: plannerResults, // 👈 clave para referir "ítem N"
      };
      
      // 3) Log rápido para verificar que no esté vacío
      console.log("→ interpret payload.state.results.length =", stateForPlanner.results?.length || 0);
      
      // 4) Anti-race: si la orden depende de “ítem N” y todavía no hay results, reintentar breve
      const needsIndexAndQtyNow =
        /\b(ítem|item)\b/i.test(text) &&
        /\b(agregar|añadir|sumar)\b/i.test(text) &&
        /\b\d+\b/.test(text);
      
      if (needsIndexAndQtyNow && plannerResults.length === 0) {
        console.log("[voice] evitando race: comando requiere results pero results=0; reintento 150ms");
        setTimeout(() => interpretAndDispatch(text), 150);
        return;
      }
      
      // 5) Log del payload final
      console.log("→ interpret payload", { text, state: stateForPlanner, catalog: catalogList });
      
      // 6) POST a /bridge/interpret usando stateForPlanner
      const r = await fetch(`${BRIDGE_BASE}/bridge/interpret`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, state: stateForPlanner, catalog: catalogList }),
      });
      if (!r.ok) throw new Error(`/bridge/interpret ${r.status}`);
      const data = await r.json();
      const actions = Array.isArray(data?.actions) ? data.actions : [];
      console.log("→ interpret actions", JSON.stringify(actions, null, 2));
      
      if (actions.length === 0) {
        appendLog("interpret → sin acciones");
        return;
      }
      // === PATCH FIN ===
      
      
      for (const a of actions) {
        await dispatchAction(a);
      }
      // === PATCH FIN ===
      
      for (const a of actions) {
        await dispatchAction(a);
      }
    } catch (e: any) {
      appendLog(`✖ interpret falló: ${e?.message ?? e}`);
    }
  }

// ===== Dispatcher

async function dispatchAction(a: Action) {
  switch (a.action) {
    case "set_mode": {
      const m = (a.params?.mode ?? "").toString().toUpperCase();
      if (m === "PRESUPUESTO" || m === "FACTURA" || m === "REMITO") {
        setMode(m as Mode);
        appendLog(`modo → ${m}`);
        if (m === "FACTURA") {
          setPaymentSel({});
          loadPaymentMethods();
        } else {
          setPaymentSel({});
        }
      } else {
        appendLog(`modo inválido: ${a.params?.mode}`);
      }
      break;
    }

    case "set_payment": {
      const mop = (a.params?.mop ?? "").toString().trim();
      const account = (a.params?.account ?? "").toString().trim() || undefined;
      const amount = a.params?.amount != null ? Number(a.params.amount) : undefined;
      if (!mop) { appendLog("set_payment: faltan parámetros (mop)."); break; }
      if (!paymentMethods.length) await loadPaymentMethods();
      setPaymentSel({ mop, account });
      appendLog(`pago → ${mop}${account ? ` (${account})` : ""}${amount ? ` por ${amount.toFixed(2)}` : ""}`);
      break;
    }

    case "search": {
      const raw = (a.params?.term ?? a.params?.query ?? "").toString();

      // Si parece una orden con índice/cantidad, re-interpretamos ese texto
      if (/^\s*(?:item|ítem|\d+)\b/i.test(raw) || /\b(agrega(?:r)?|sumar|poner|añadir)\b/i.test(raw)) {
        await interpretAndDispatch(raw);
        break;
      }

      const cleaned = raw.replace(/^\s*(?:busc(?:a|ar|á|ame)?|search|find)\b[:,-]?\s*/i, "");
      const term = cleaned || raw;

      const data = await apiSearch(term);
      setResults(data);
      resultsRef.current = data;                 // 👈 fuente de verdad inmediata
      setSelectedIndex(data.length ? 1 : null);
      selectedIndexRef.current = data.length ? 1 : 0;  // 👈 selección 1-based en el ref
      setSearchTerm(term);
      appendLog(`buscando: "${term}" (${data.length} resultados)`);
      break;
    }

    case "select_index": {
      const idx1 = Number(a.params?.index ?? 0); // planner manda 1-based
      if (!Number.isInteger(idx1) || idx1 < 1) { appendLog(`índice inválido: ${a.params?.index}`); break; }
    
      // Usamos lista “viva”: evita estados stale
      const list = resultsRef.current ?? results;
      if (!list || idx1 > list.length) { appendLog(`índice fuera de rango (${idx1})`); break; }
    
      setSelectedIndex(idx1);              // estado visible 1-based
      selectedIndexRef.current = idx1;   // ref 1-based para próximas acciones
    
      const it = list[idx1 - 1];
      const qSel = qtyPer[it?.item_code] ?? (qtyRef.current ?? 1);
      setQty(qSel);
      qtyRef.current = qSel;             // 👈 mantener ref sincronizada
      appendLog(`seleccionado índice ${idx1} (${it?.item_name ?? it?.item_code ?? "?"})`);
      break;
    }

    
    case "set_qty": {
      const qNum = Math.max(1, Math.floor(Number(a.params?.qty ?? 1)));
      setQty(qNum);
      qtyRef.current = qNum;             // 👈 usar ref para que add_to_cart vea el valor YA
      appendLog(`cantidad → ${qNum}`);
      break;
    }
    
    case "add_to_cart": {
      const list = resultsRef.current ?? results;
    
      // índice 1-based explícito o selección previa 1-based
      const idxParam1 = Number(a.params?.index ?? 0);
      const idx1 = idxParam1 >= 1 ? idxParam1 : Number(selectedIndexRef?.current ?? 0);
    
      if (!list || !list.length) { appendLog("no hay resultados (list vacía)"); break; }
      if (!idx1 || idx1 < 1 || idx1 > list.length) {
        appendLog(`no hay selección (list_len=${list.length}, sel=${idx1 || 0})`);
        break;
      }
    
      const res = list[idx1 - 1];
    
      // 👇 cantidad efectiva: primero qtyRef (sin delay), luego qtyPer/estado
      const qEff = Number(qtyPer[res.item_code] ?? qtyRef.current ?? qty ?? 1);
      if (!Number.isFinite(qEff) || qEff <= 0) { appendLog("cantidad inválida (falta set_qty)"); break; }
    
      // 👇 anti-duplicado si la voz dispara dos add_to_cart iguales en <500ms
      const key = `${res.item_code}|${qEff}`;
      const now = Date.now();
      if (lastAddRef.current && lastAddRef.current.key === key && now - lastAddRef.current.t < 500) {
        appendLog("⏩ ignorado duplicado add_to_cart");
        break;
      }
      lastAddRef.current = { key, t: now };
    
      const line = await apiGetItemDetail(res, qEff);
      if (line) {
        // 👇 Merge en una sola línea si ya existe el mismo ítem/precio/uom
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
      if (name) { setCustomer(name); appendLog(`cliente → ${name}`); }
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
      appendLog(`TOTAL → neto ${total.net.toFixed(2)} desc ${total.discount.toFixed(2)} = ${total.grand.toFixed(2)} ${docState.currency}`);
      break;
    }

    default:
      appendLog(`acción desconocida: ${a.action}`);
  }
}

  

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
    ],
  };

  function getFrontStateSnapshot(): LLMFrontState {
    return {
      mode,
      customer,
      total: { net: total.net, discount: total.discount, grand: total.grand, currency: docState.currency },
      cart: cart.map(c => ({
        item_code: c.item_code,
        qty: c.qty,
        uom: c.uom,
        unit_price: c.unit_price,
      })),
    };
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
- set_payment({ mop, account?, amount? })
- confirm_document()
- clear_cart()
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
          {/* Header */}
          <div className="col-span-2 flex flex-wrap items-center justify-between gap-3 bg-white/80 backdrop-blur rounded-2xl shadow p-3">
            {/* Modo */}
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

            {/* Cliente */}
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">Cliente</span>
              <CustomerPicker
                value={customer}
                bridgeBase={BRIDGE_BASE}
                onSelect={(name) =>
                  dispatchAction({ action: "set_customer", params: { name } })
                }
              />
            </div>

            {/* Descuento */}
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">Desc. (%)</span>
              <input
                type="number"
                className="border rounded-xl px-3 py-2 w-24"
                value={discountPct}
                min={0} max={100}
                onChange={(e) =>
                  dispatchAction({
                    action: "set_global_discount",
                    params: { percent: Number(e.target.value) },
                  })
                }
              />
            </div>

            {/* Pago (solo FACTURA) */}
            {mode === "FACTURA" && (
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">Pago</span>
                <select
                  className="border rounded-xl px-3 py-2"
                  value={paymentSel.mop || ""}
                  onChange={(e) => {
                    const mop = e.target.value || undefined;
                    const accs = paymentMethods.find((m) => m.name === mop)?.accounts || [];
                    setPaymentSel({
                      mop,
                      account: accs && accs.length > 0 ? (accs[0]?.account || undefined) : undefined,
                    });
                  }}
                >
                  <option value="">Elegí un método…</option>
                  {paymentMethods.map((m) => (
                    <option key={m.name} value={m.name}>{m.name}</option>
                  ))}
                </select>

                {/* Si el método tiene cuentas configuradas, permitimos elegir una */}
                {paymentSel.mop && (paymentMethods.find(m => m.name === paymentSel.mop)?.accounts?.length || 0) > 0 && (
                  <select
                    className="border rounded-xl px-3 py-2"
                    value={paymentSel.account || ""}
                    onChange={(e) => setPaymentSel((prev) => ({ ...prev, account: e.target.value || undefined }))}
                  >
                    {(paymentMethods.find(m => m.name === paymentSel.mop)?.accounts || []).map((a, i) => (
                      <option key={`${a.account}-${i}`} value={a.account || ""}>
                        {a.account || "(sin cuenta)"}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            )}

            {/* Botón conectar voz */}
            <div className="flex items-center gap-2">
              <button
                onClick={async () => {
                  try {
                    await voice.connect();
                    appendLog("✅ Voz conectada");
                  } catch (e) {
                    appendLog("✖ conectar voz: " + ((e as any)?.message ?? e));
                  }
                }}
                disabled={voice.connected}
                className="rounded-xl px-3 py-2 bg-blue-600 text-white"
              >
                {voice.connected ? "Voz conectada" : "Conectar voz"}
              </button>
              <audio id="assistantAudio" autoPlay playsInline />
            </div>

            {/* Mic + prompt + confirmar */}
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
                    await interpretAndDispatch(v);
                  }
                }}
              />
              <button
                className="rounded-xl px-4 py-2 bg-neutral-800 text-white"
                onClick={async () => {
                  if (mode === "FACTURA" && !paymentSel.mop) {
                    appendLog("✖ falta seleccionar modo de pago (decí: 'pago efectivo' o elegilo en la UI)");
                    return;
                  }
                  await dispatchAction({ action: "confirm_document" });
                }}
                
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
                          <span
                            className="text-xs"
                            style={{ padding: "2px 8px", borderRadius: 999, background: "#e5e7eb", color: "#374151" }}
                          >
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

            
            {/* Totales */}
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
            
            {/* Acciones */}
            <div className="flex items-center gap-2">
              <button
                className="rounded-xl px-4 py-2 bg-neutral-800 text-white disabled:opacity-50"
                disabled={loading || cart.length === 0}
                onClick={async () => {
                  if (mode === "FACTURA" && !paymentSel.mop) {
                    appendLog("✖ falta seleccionar modo de pago (decí: 'pago efectivo' o elegilo en la UI)");
                    return;
                  }
                  await dispatchAction({ action: "confirm_document" });
                }}
              >
                {loading ? "Procesando…" : "Confirmar"}
              </button>
            
              <button
                className="rounded-xl px-4 py-2 bg-neutral-200 text-neutral-900"
                onClick={() => window.print?.()}
              >
                Imprimir
              </button>
            </div>
            
            
                         

{/* Consola */}
<div className="col-span-2 bg-white/80 backdrop-blur rounded-2xl shadow p-3">
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
