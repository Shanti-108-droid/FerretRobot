// src/llm/interpret.ts
// Integra el endpoint /bridge/interpret con tu dispatcher de UI
// No importa tu framework/store: le pasás el dispatcher por parámetro y listo.

export type CartLine = {
  item_code: string;
  qty: number;
  uom?: string;
  unit_price?: number;
};

export type FrontState = {
  mode: string; // p.ej. "PRESUPUESTO" | "FACTURA"
  customer?: string;
  total?: number;
  cart?: CartLine[];
  // extendé con lo que haga falta
};

export type Action =
  | { action: "search"; params: { query: string } }
  | { action: "add_item"; params: { item_code: string; qty: number; uom?: string; price_list_rate?: number } }
  | { action: "remove_item"; params: { item_code: string } }
  | { action: "clear_cart"; params?: {} }
  | { action: "pay"; params?: {} }
  | { action: "set_payment"; params: { mop: string; account?: string; amount?: number } }
  | { action: "confirm_document"; params?: {} }
  | { action: string; params?: Record<string, any> }; // fallback (si tu catálogo tiene más)

export type ActionsDoc = {
  // Lista blanca de acciones que el LLM puede devolver
  actions: Array<{
    action: string;
    schema?: Record<string, unknown>; // opcional: podés formalizar params
  }>;
};

export type InterpretResponse = {
  actions: Action[];
  meta?: Record<string, any>;
};

export type DispatchFn = (a: Action) => Promise<any> | any;

export async function interpretAndDispatch(opts: {
  apiBase: string; // p.ej. "http://localhost:8002"
  text: string;
  state: FrontState;
  catalog: ActionsDoc;
  dispatchAction: DispatchFn;
  signal?: AbortSignal;
  onLog?: (ev: { type: "request" | "response" | "dispatch" | "warn" | "error"; data: any }) => void;
}) {
  const { apiBase, text, state, catalog, dispatchAction, signal, onLog } = opts;

  const body = { text, state, catalog };
  const url = `${apiBase.replace(/\/$/, "")}/bridge/interpret`;

  onLog?.({ type: "request", data: { url, body } });

  let payload: InterpretResponse;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} ${res.statusText} — ${txt}`);
    }
    payload = (await res.json()) as InterpretResponse;
  } catch (e) {
    onLog?.({ type: "error", data: String(e) });
    throw e;
  }

  onLog?.({ type: "response", data: payload });

  // Validación rápida por whitelist:
  const allowed = new Set(catalog.actions.map(a => a.action));
  const actions = (payload.actions || []).filter(a => {
    const ok = a && typeof a.action === "string" && allowed.has(a.action);
    if (!ok) onLog?.({ type: "warn", data: { dropped: a } });
    return ok;
  });

  const results: Array<{ action: Action; ok: boolean; result?: any; error?: string }> = [];

  for (const a of actions) {
    try {
      onLog?.({ type: "dispatch", data: a });
      const r = await dispatchAction(a);
      results.push({ action: a, ok: true, result: r });
    } catch (err: any) {
      results.push({ action: a, ok: false, error: String(err?.message || err) });
    }
  }

  return { actions, results };
}
