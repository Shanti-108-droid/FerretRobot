# bridge.py — FastAPI microservice (CORS + ERP auth + búsqueda “inteligente” + search_with_stock)
# Requisitos: pip install fastapi uvicorn requests python-dotenv pydantic

import os, json, unicodedata, re, html, time, logging
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import List, Dict, Any, Optional

import requests
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv

# Routers existentes
try:
    from routes.bin_qty import router as bin_qty_router
except Exception:
    bin_qty_router = None  # por si no existe en tu proyecto

# ========= .env =========
# Carga .env ubicado junto a este archivo
load_dotenv(dotenv_path=Path(__file__).with_name(".env"))

# =============================
# Configuración y headers
# =============================
ERP_BASE         = os.getenv("ERP_BASE", "http://erp.localhost")
ERP_API_KEY      = os.getenv("ERP_API_KEY", "")
ERP_API_SECRET   = os.getenv("ERP_API_SECRET", "")
ERP_TOKEN        = os.getenv("ERP_TOKEN")  # opcional: "APIKEY:APISECRET"
BRIDGE_CACHE_TTL = int(os.getenv("BRIDGE_CACHE_TTL", "20"))  # segundos
# ==== OpenAI LLM ====
OPENAI_API_KEY   = os.getenv("OPENAI_API_KEY", "")
LLM_MODEL        = os.getenv("LLM_MODEL", "gpt-4o-mini")
# === PATCH A (constantes + helper MOP) ===
BASE_COMPANY   = "Hi Tech"
BASE_PROFILE   = "Sucursal Adrogue"
BASE_WAREHOUSE = "Sucursal Adrogue - HT"
BASE_CURRENCY  = "ARS"

def get_mop_account(mop: str, company: str) -> str | None:
    """Devuelve la cuenta por defecto para un Mode of Payment y compañía (o None)."""
    import requests
    from requests.utils import quote
    url = f"{ERP_BASE}/api/resource/Mode of Payment/{quote(mop, safe='')}"
    r = requests.get(url, headers=erp_headers(), timeout=10)
    if r.status_code != 200:
        return None
    data = r.json().get("data", {})
    for row in (data.get("accounts") or []):
        if row.get("company") == company and row.get("default_account"):
            return row["default_account"]
    return None
# === /PATCH A ===

# Encabezados para Frappe/ERPNext
if ERP_TOKEN:
    AUTH_HEADER = f"token {ERP_TOKEN}"
elif ERP_API_KEY and ERP_API_SECRET:
    AUTH_HEADER = f"token {ERP_API_KEY}:{ERP_API_SECRET}"
else:
    AUTH_HEADER = ""

HEADERS_FORM = {
    "Authorization": AUTH_HEADER,
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    "Accept": "application/json",
}

HEADERS_JSON = {
    "Authorization": AUTH_HEADER,
    "Content-Type": "application/json",
    "Accept": "application/json",
}

# Defaults conocidos
DEFAULTS = {
    "company": "Hi Tech",
    "pos_profile": "Sucursal Adrogue",
    "warehouse": "Sucursal Adrogue - HT",
    "price_list": "Standard Selling",
    "currency": "ARS",
    "customer": "Consumidor Final",
    "tax_category": "IVA 21%",
}
# ==== Logger rotativo para /bridge/interpret ====
LOG_DIR = Path(__file__).with_name("logs")
LOG_DIR.mkdir(exist_ok=True)
log_file = LOG_DIR / "interpret.log"

logger = logging.getLogger("interpret")
if not logger.handlers:
    logger.setLevel(logging.INFO)
    handler = RotatingFileHandler(log_file, maxBytes=5 * 1024 * 1024, backupCount=5, encoding="utf-8")
    formatter = logging.Formatter("%(asctime)s %(levelname)s: %(message)s")
    handler.setFormatter(formatter)
    logger.addHandler(handler)

# ========= App + CORS =========
app = FastAPI()
if bin_qty_router:
    app.include_router(bin_qty_router)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173", "*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ========= Cache simple (TTL) =========
class _CacheEntry(BaseModel):
    ts: float
    data: Any

_cache: Dict[str, _CacheEntry] = {}

def _cache_get(key: str) -> Optional[Any]:
    e = _cache.get(key)
    if not e:
        return None
    if (time.time() - e.ts) > BRIDGE_CACHE_TTL:
        _cache.pop(key, None)
        return None
    return e.data

def _cache_set(key: str, data: Any) -> None:
    _cache[key] = _CacheEntry(ts=time.time(), data=data)

def _ck(*parts: Any) -> str:
    return json.dumps(parts, ensure_ascii=False, sort_keys=True)

# ========= Models =========
class SearchBody(BaseModel):
    search_term: str
    start: int = 0
    page_length: int = 20
    only_in_stock: bool = False
    price_gt_zero: bool = False

class ItemDetailBody(BaseModel):
    item_code: str
    qty: int = 1
    mode: str = "PRESUPUESTO"

class PaymentRow(BaseModel):
    mode_of_payment: str
    amount: float
    account: Optional[str] = None

class ConfirmBody(BaseModel):
    mode: str
    customer: str
    items: list
    discount_pct: float = 0.0
    payments: Optional[List[PaymentRow]] = None  # para FACTURA

class InterpretBody(BaseModel):
    text: str
    state: dict
    catalog: list

# Nuevos modelos para search_with_stock
class SearchByQuery(BaseModel):
    query: str
    warehouse: str
    pos_profile: Optional[str] = None
    limit: int = 20
    page: int = 1

class SearchByCodes(BaseModel):
    item_codes: List[str]
    warehouse: str

# ==== BÚSQUEDA DE CLIENTES / PROVEEDORES (mínimo útil) ====
class PartySearchIn(BaseModel):
    query: str
    limit: int = 20
    page: int = 1

# ========= Utils texto =========
def strip_accents(s: str) -> str:
    if not s:
        return ""
    nkfd = unicodedata.normalize("NFKD", s)
    return "".join(ch for ch in nkfd if not unicodedata.combining(ch))

def norm(s: str) -> str:
    return strip_accents(s or "").lower().strip()

def fields_text(item: Dict[str, Any]) -> str:
    parts = [
        item.get("item_code") or item.get("name") or "",
        item.get("item_name") or "",
        item.get("description") or "",
        item.get("item_group") or "",
        item.get("brand") or "",
        item.get("attributes") or "",
        item.get("item_attributes") or "",
    ]
    if isinstance(item.get("item_barcode"), list):
        parts.extend([str(b) for b in item.get("item_barcode")])
    return norm(" ".join(map(str, parts)))

# ========= Helpers ERP =========
# === helper headers seguro ===
# === helpers de respuesta unificada ===
def _ok(number: str | None, doc: dict | None):
    return {"ok": True, "number": number, "doc": doc, "error": None}

def _err(code: str, message: str, **extra):
    e = {"code": code, "message": message}
    e.update(extra or {})
    return {"ok": False, "number": None, "doc": None, "error": e}
# === fin helpers ===


def _erp_headers() -> dict:
    """Normaliza AUTH_HEADER para requests."""
    if isinstance(AUTH_HEADER, dict):
        return AUTH_HEADER
    if isinstance(AUTH_HEADER, str):
        # acepta "token api_key:api_secret" o "Bearer xxx"
        return {"Authorization": AUTH_HEADER, "Content-Type": "application/json"}
    raise HTTPException(status_code=500, detail="AUTH_HEADER mal formado (esperaba dict o str)")
# === fin helper ===

def _pos_profile_str(pos_profile_name: Optional[str] = None) -> str:
    payload = {
        "name": pos_profile_name or DEFAULTS["pos_profile"],
        "price_list": DEFAULTS["price_list"],
        "price_list_currency": DEFAULTS["currency"],
        "plc_conversion_rate": 1,
        "conversion_rate": 1,
        "warehouse": DEFAULTS["warehouse"],
    }
    return json.dumps(payload, ensure_ascii=False)

def _json_headers():
    return dict(HEADERS_JSON)

def erp_get_list(doctype: str, fields: List[str], filters: Any, limit: int = 20, page: int = 1) -> List[Dict[str, Any]]:
    """
    Wrapper de frappe.client.get_list
    """
    if not AUTH_HEADER:
        raise HTTPException(status_code=500, detail="ERP auth no configurada (ERP_TOKEN o API_KEY:SECRET).")
    url = f"{ERP_BASE}/api/method/frappe.client.get_list"
    payload = {
        "doctype": doctype,
        "fields": fields,
        "filters": filters,
        "limit_page_length": limit,
        "limit_start": (max(page, 1) - 1) * limit,
    }
    r = requests.post(url, headers=HEADERS_JSON, data=json.dumps(payload), timeout=30)
    if r.status_code != 200:
        raise HTTPException(status_code=502, detail=f"ERP get_list {doctype} falló: {r.text}")
    js = r.json()
    return js.get("message", [])

def pos_get_items(query: str, pos_profile: Optional[str], limit: int, page: int) -> List[Dict[str, Any]]:
    """
    Llama al endpoint de POS Awesome get_items (como en /bridge/search),
    con pos_profile serializado como string JSON.
    """
    if not AUTH_HEADER:
        raise HTTPException(status_code=500, detail="ERP auth no configurada (ERP_TOKEN o API_KEY:SECRET).")
    url = f"{ERP_BASE}/api/method/posawesome.posawesome.api.posapp.get_items"
    payload = {
        "search_term": query,
        "page_length": limit,
        "start": (max(page, 1) - 1) * limit,
        "warehouse": DEFAULTS["warehouse"],
        "price_list": DEFAULTS["price_list"],
        "price_list_currency": DEFAULTS["currency"],
        "plc_conversion_rate": 1,
        "conversion_rate": 1,
        "pos_profile": _pos_profile_str(pos_profile),
    }
    r = requests.post(url, headers=HEADERS_FORM, data=payload, timeout=30)
    if r.status_code != 200:
        raise HTTPException(status_code=502, detail=f"get_items falló: {r.text}")
    erp_json = r.json()
    return erp_json.get("message") or erp_json.get("data") or []

def bin_qty_bulk(item_codes: List[str], warehouse: str) -> Dict[str, float]:
    """
    Lee stock real desde Bin para {item_code} en un warehouse.
    Devuelve { code: qty } (suma por si hubiese múltiples filas).
    Cachea por TTL.
    """
    key = _ck("bin_qty_bulk", sorted(item_codes), warehouse)
    cached = _cache_get(key)
    if cached is not None:
        return cached

    if not item_codes:
        return {}

    filters = [
        ["Bin", "item_code", "in", item_codes],
        ["Bin", "warehouse", "=", warehouse],
    ]
    rows = erp_get_list(
        doctype="Bin",
        fields=["item_code", "warehouse", "actual_qty"],
        filters=filters,
        limit=len(item_codes),
        page=1,
    )
    out: Dict[str, float] = {}
    for row in rows:
        code = row.get("item_code")
        qty = float(row.get("actual_qty") or 0)
        out[code] = out.get(code, 0.0) + qty

    _cache_set(key, out)
    return out

def _erp_list_mops() -> List[Dict[str, Any]]:
    """
    Lista modos de pago habilitados y, si hay, sus cuentas por compañía.
    Devuelve: [{name: "Cash", accounts: [{company, account}, ...]}, ...]
    """
    # Modos de pago habilitados
    mops = erp_get_list(
        doctype="Mode of Payment",
        fields=["name", "enabled"],
        filters=[["Mode of Payment", "enabled", "=", 1]],
        limit=200,
        page=1,
    )
    names = [m["name"] for m in mops]

    # Cuentas asociadas (child table)
    try:
        acc_rows = erp_get_list(
            doctype="Mode of Payment Account",
            fields=["parent as mode_of_payment", "company", "default_account as account"],
            filters=[["Mode of Payment Account", "company", "=", DEFAULTS["company"]]],
            limit=500,
            page=1,
        )
    except HTTPException:
        acc_rows = []

    acc_map: Dict[str, List[Dict[str, Any]]] = {}
    for a in acc_rows:
        mop = a.get("mode_of_payment")
        if mop:
            acc_map.setdefault(mop, []).append({"company": a.get("company"), "account": a.get("account")})

    out = []
    for n in names:
        out.append({"name": n, "accounts": acc_map.get(n, [])})
    return out

# ========= Endpoints =========
@app.get("/bridge/payment_methods")
def payment_methods():
    try:
        return {"message": _erp_list_mops()}
    except requests.HTTPError as e:
        status = e.response.status_code if getattr(e, "response", None) else 502
        detail = getattr(e.response, "text", str(e))
        raise HTTPException(status_code=status, detail=detail)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/__env")
def __env():
    tp = (ERP_TOKEN[:6] + "...") if ERP_TOKEN else ""
    return {
        "erp_base": ERP_BASE,
        "has_token": bool(AUTH_HEADER),
        "token_prefix": tp,
        "pos_profile": DEFAULTS.get("pos_profile"),
        "warehouse": DEFAULTS.get("warehouse"),
        "price_list": DEFAULTS.get("price_list"),
        "cache_ttl": BRIDGE_CACHE_TTL,
    }

@app.post("/bridge/search")
def search_items(body: SearchBody):
    """
    Busca ítems en el ERP, filtra por tokens y ordena por score simple.
    """
    try:
        # Normalización básica (sin acentos)
        def normalize_text(s: str) -> str:
            if not s:
                return ""
            s = unicodedata.normalize("NFD", s)
            s = "".join(ch for ch in s if unicodedata.category(ch) != "Mn")
            s = s.lower()
            repl = {"½": "1/2", "¼": "1/4", "¾": "3/4", "”": '"', "“": '"', "″": '"', "′": "'", "º": "", "°": ""}
            for k, v in repl.items():
                s = s.replace(k, v)
            s = re.sub(r"[^a-z0-9/.\s-]", " ", s)
            s = re.sub(r"\s+", " ", s).strip()
            return s

        def tokenize(q: str):
            nq = normalize_text(q)
            toks = [t for t in nq.split(" ") if t]
            return nq, toks

        def any_token_in_text(tokens, text_norm: str) -> bool:
            if not tokens:
                return True
            return all(t in text_norm for t in tokens)

        # Llamada ERP get_items
        raw_list = pos_get_items(body.search_term, DEFAULTS["pos_profile"], body.page_length, (body.start // max(body.page_length,1)) + 1)

        q_phrase, q_tokens = tokenize(body.search_term)
        ranked = []
        for it in raw_list:
            name = it.get("item_name") or it.get("name") or ""
            code = it.get("item_code") or it.get("name") or ""
            brand = it.get("brand") or ""
            desc = it.get("description") or ""
            stock = float(it.get("actual_qty") or 0)

            n_name = normalize_text(name)
            n_code = normalize_text(code)
            n_brand = normalize_text(brand)
            n_desc = normalize_text(desc)
            combined = "  ".join([n_name, n_code, n_brand, n_desc])

            if not any_token_in_text(q_tokens, combined):
                continue

            score = 0.0
            score += 2.0 if q_phrase and q_phrase in n_name else 0.0
            score += 1.2 if q_phrase and q_phrase in n_code else 0.0
            score += sum(1 for t in q_tokens if t in n_name) * 0.9
            score += sum(1 for t in q_tokens if t in n_code) * 0.7
            score += sum(1 for t in q_tokens if t in n_brand) * 0.5
            score += sum(1 for t in q_tokens if t in n_desc) * 0.3
            if stock > 0:
                score += 1.5

            hit_fields = []
            if any(t in n_name for t in q_tokens) or (q_phrase and q_phrase in n_name): hit_fields.append("name")
            if any(t in n_code for t in q_tokens) or (q_phrase and q_phrase in n_code): hit_fields.append("code")
            if any(t in n_brand for t in q_tokens) or (q_phrase and q_phrase in n_brand): hit_fields.append("brand")
            if any(t in n_desc for t in q_tokens) or (q_phrase and q_phrase in n_desc): hit_fields.append("desc")

            ranked.append({ "_score": score, "_hit_fields": hit_fields, **it })

        ranked.sort(key=lambda x: x["_score"], reverse=True)

        limit = body.page_length
        normalized = []
        index_map = []

        for i, it in enumerate(ranked[:limit], start=1):
            code = it.get("item_code") or it.get("name")
            normalized.append(
                {
                    "index": i,
                    "code": code,
                    "name": it.get("item_name") or it.get("name") or it.get("description"),
                    "uom": it.get("stock_uom") or it.get("uom") or "Nos",
                    "rate": (it.get("price_list_rate") or it.get("rate") or 0) or 0,
                    "qty": (it.get("actual_qty") or 0) or 0,
                    "group": it.get("item_group"),
                    "brand": it.get("brand"),
                    "desc": it.get("description"),
                    "hit_fields": it.get("_hit_fields", []),
                    "terms": q_tokens,
                }
            )
            index_map.append({"index": i, "item_code": code})

        message = []
        for it in ranked[:limit]:
            it = dict(it)
            it.pop("_score", None)
            it.pop("_hit_fields", None)
            message.append(it)

        return {
            "ok": True,
            "term": body.search_term,
            "count": len(message),
            "message": message,
            "items": normalized,
            "index_map": index_map,
        }

    except requests.HTTPError as e:
        status = e.response.status_code if getattr(e, "response", None) else 502
        detail = getattr(e, "response", None).text if getattr(e, "response", None) else str(e)
        raise HTTPException(status_code=status, detail=detail)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/bridge/item-detail")
def item_detail(body: ItemDetailBody):
    """
    Llama a posawesome.posawesome.api.posapp.get_item_detail
    """
    try:
        url = f"{ERP_BASE}/api/method/posawesome.posawesome.api.posapp.get_item_detail"
        update_stock = 1 if body.mode.upper() in ["FACTURA", "REMITO"] else 0

        doc = {
            "doctype": "Sales Invoice",
            "is_pos": 1,
            "ignore_pricing_rule": 1,
            "company": DEFAULTS["company"],
            "pos_profile": DEFAULTS["pos_profile"],
            "currency": DEFAULTS["currency"],
            "customer": DEFAULTS["customer"],
            "items": [
                {"item_code": body.item_code, "qty": body.qty, "uom": "Nos", "price_list_rate": 0}
            ],
            "update_stock": update_stock,
        }

        item = {
            "item_code": body.item_code,
            "customer": DEFAULTS["customer"],
            "doctype": "Sales Invoice",
            "name": "New Sales Invoice 1",
            "company": DEFAULTS["company"],
            "qty": body.qty,
            "pos_profile": DEFAULTS["pos_profile"],
            "uom": "Nos",
            "transaction_type": "selling",
            "update_stock": update_stock,
            "price_list": DEFAULTS["price_list"],
            "price_list_currency": DEFAULTS["currency"],
            "plc_conversion_rate": 1,
            "conversion_rate": 1,
        }

        payload = {
            "warehouse": DEFAULTS["warehouse"],
            "price_list": DEFAULTS["price_list"],
            "price_list_currency": DEFAULTS["currency"],
            "plc_conversion_rate": 1,
            "conversion_rate": 1,
            "pos_profile": _pos_profile_str(DEFAULTS["pos_profile"]),
            "doc": json.dumps(doc, ensure_ascii=False),
            "item": json.dumps(item, ensure_ascii=False),
        }

        r = requests.post(url, headers=HEADERS_FORM, data=payload, timeout=30)
        r.raise_for_status()
        return r.json()

    except requests.HTTPError as e:
        status = e.response.status_code if getattr(e, "response", None) else 502
        detail = getattr(e, "response", None).text if getattr(e, "response", None) else str(e)
        raise HTTPException(status_code=status, detail=detail)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# ===== /bridge/confirm REAL =====
# === HELPER: cuenta por Mode of Payment ===
def _mop_account(mode_of_payment: str, company: str) -> str | None:
    """
    Devuelve la Default Account del Mode of Payment para la compañía, o None.
    Requiere ERP_BASE + AUTH_HEADER ya configurados.
    """
    import requests
    from urllib.parse import quote
    url = f"{ERP_BASE}/api/resource/Mode of Payment/{quote(mode_of_payment, safe='')}"
    r = requests.get(url, headers=_erp_headers(), timeout=10)
    if r.status_code != 200:
        return None
    data = r.json().get("data", {})
    for row in (data.get("accounts") or []):
        if row.get("company") == company and row.get("default_account"):
            return row["default_account"]
    return None
# === fin helper ===


@app.post("/bridge/confirm")
def confirm_document(body: ConfirmBody):
    """
    Crea el documento real:
      - PRESUPUESTO -> Quotation (borrador)
      - FACTURA     -> Sales Invoice (submit)  **requiere payments explícitos**
      - REMITO      -> Delivery Note (submit)
    """
    try:
        import requests

        # --- Validaciones iniciales
        mode = (body.mode or "").upper()
        if mode not in ("PRESUPUESTO", "FACTURA", "REMITO"):
            return _err("BAD_MODE", f"Modo inválido: {body.mode}")
        if not body.items:
            return _err("NO_ITEMS", "No hay ítems para confirmar.")
        if not AUTH_HEADER:
            return _err("NO_AUTH", "ERP auth no configurada.")

        # --- Doctype según modo
        if mode == "PRESUPUESTO":
            doctype = "Quotation"
        elif mode == "FACTURA":
            doctype = "Sales Invoice"
        else:
            doctype = "Delivery Note"

        # --- Items (usar 'rate' en Sales Invoice, 'price_list_rate' en el resto)
        items_list = []
        for it in body.items:
            base = {
                "item_code": it.get("item_code"),
                "qty": float(it.get("qty", 1)),
                "uom": it.get("uom") or "Nos",
                "warehouse": DEFAULTS["warehouse"],
            }
            price = float(it.get("price_list_rate", it.get("rate", 0)) or 0)
            if doctype == "Sales Invoice":
                base["rate"] = price
            else:
                base["price_list_rate"] = price
            items_list.append(base)

        customer = body.customer or DEFAULTS["customer"]

        # --- Documento base
        doc = {
            "doctype": doctype,
            "company": DEFAULTS["company"],
            "currency": DEFAULTS["currency"],
            "customer": customer,
            "set_warehouse": DEFAULTS["warehouse"],
            "price_list": DEFAULTS["price_list"],
            "apply_discount_on": "Grand Total",
            "additional_discount_percentage": float(body.discount_pct or 0),
            "items": items_list,
        }

        # --- Ajustes por tipo de doc
        if doctype == "Quotation":
            doc.update({"quotation_to": "Customer"})

        elif doctype == "Sales Invoice":
            doc.update({
                "is_pos": 1,
                "pos_profile": DEFAULTS["pos_profile"],
                "update_stock": 1 if DEFAULTS.get("warehouse") else 0,
            })

            # Payments (obligatorios): normalizar Pydantic->dict y completar account por MOP
            raw_payments = body.payments or []
            if not raw_payments:
                return _err(
                    "PAYMENT_REQUIRED",
                    "Elegí un modo de pago y reenviá la confirmación con 'payments'.",
                    payment_methods=[]
                )

            payments: list[dict] = []
            for p in raw_payments:
                if hasattr(p, "dict"):
                    p = p.dict()
                elif not isinstance(p, dict):
                    p = dict(p)

                mop = p.get("mode_of_payment") or p.get("mop") or p.get("mode")
                if not mop:
                    return _err("PAYMENT_INVALID", "Falta 'mode_of_payment' en payments.")

                amt = float(p.get("amount", 0) or 0)
                acc = p.get("account") or _mop_account(mop, DEFAULTS["company"])

                pay_row = {"mode_of_payment": mop, "amount": amt}
                if acc:
                    pay_row["account"] = acc
                payments.append(pay_row)

            doc["payments"] = payments

        # --- Insert en ERP
        print(f"→ ERP insert {doctype} for {customer} items={len(doc.get('items', []))}", flush=True)
        try:
            r_ins = requests.post(
                f"{ERP_BASE}/api/resource/{doctype}",
                headers=_erp_headers(),
                json={"data": doc},
                timeout=12,
            )
        except requests.Timeout:
            return _err("ERP_TIMEOUT", "El ERP no respondió en 12s.")
        except requests.ConnectionError as e:
            return _err("ERP_CONN", f"No me pude conectar al ERP: {e}")
        except requests.RequestException as e:
            return _err("ERP_HTTP", f"Error HTTP al llamar al ERP: {e}")

        print(f"← ERP resp {r_ins.status_code}", flush=True)

        if r_ins.status_code != 200:
            return _err(f"ERP_{r_ins.status_code}", r_ins.text)

        created = r_ins.json().get("data") or {}
        name = created.get("name")

        # --- Submit para FACTURA y REMITO
        if doctype in ("Sales Invoice", "Delivery Note"):
            try:
                r_sub = requests.post(
                    f"{ERP_BASE}/api/method/frappe.client.submit",
                    headers=_erp_headers(),
                    json={"doc": created},   # enviar el doc completo
                    timeout=12,
                )
            except requests.Timeout:
                return _err("ERP_TIMEOUT", "El ERP no respondió al submit en 12s.")
            except requests.ConnectionError as e:
                return _err("ERP_CONN", f"No me pude conectar al ERP en submit: {e}")
            except requests.RequestException as e:
                return _err("ERP_HTTP", f"Error HTTP al hacer submit: {e}")

            if r_sub.status_code != 200:
                return _err(f"ERP_{r_sub.status_code}", r_sub.text)

            submitted = r_sub.json().get("message") or {}
            return _ok(submitted.get("name") or name, submitted)

        # Quotation queda en borrador
        return _ok(name, created)

    except Exception as e:
        # Cualquier otra excepción inesperada
        return _err("UNEXPECTED", str(e))


# ========= LLM: interpretar texto → lista segura de acciones =========
@app.post("/bridge/interpret")
def interpret(body: InterpretBody):
    """
    Usa OpenAI (gpt-4o-mini) para interpretar {text, state, catalog} y devolver:
      {"actions":[{"action":"...", "params": {...}}, ...]}
    Reglas:
      - SOLO acciones de la whitelist (catálogo normalizado).
      - Si mode == FACTURA y no hay pago seleccionado en el estado, sugerir primero set_payment(...)
        usando alguno de los métodos válidos del ERP, luego confirm_document().
    Log:
      - Guarda request completo y respuesta cruda del modelo en logs/interpret.log (rotativo).
    """
    if not OPENAI_API_KEY:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY no configurada en .env")

    # ---- Normalizar catálogo (acepta varios formatos del front) ----
    def _normalize_catalog(cat) -> List[str]:
        allowed: set[str] = set()
        try:
            if isinstance(cat, dict):
                # { actions: [ "set_mode", ... ] } o { actions: [ {action:"set_mode"}, ... ] }
                arr = cat.get("actions", [])
                if isinstance(arr, list):
                    for x in arr:
                        if isinstance(x, dict) and "action" in x:
                            allowed.add(str(x["action"]))
                        elif isinstance(x, str):
                            allowed.add(x)
            elif isinstance(cat, list):
                # ["set_mode", ...] o [{action:"set_mode"}, ...]
                for x in cat:
                    if isinstance(x, dict) and "action" in x:
                        allowed.add(str(x["action"]))
                    elif isinstance(x, str):
                        allowed.add(x)
            elif isinstance(cat, str):
                # Documento de texto (ACTIONS_DOC). Extrae líneas "- nombre(...)".
                for line in cat.splitlines():
                    m = re.search(r"-\s*([a-z_][a-z0-9_]*)\s*\(", line, re.I)
                    if m:
                        allowed.add(m.group(1))
        except Exception:
            pass
        # Fallback seguro si viene vacío
        if not allowed:
            allowed = {
                "set_mode","search","select_index","set_qty","add_to_cart",
                "set_global_discount","set_customer","set_payment",
                "confirm_document","clear_cart","repeat",
            }
        return sorted(allowed)

    catalog_in = body.catalog
    allowed_actions = _normalize_catalog(catalog_in)

    # ---- Datos del request ----
    state = body.state or {}
    user_text = body.text or ""

    # ---- Regla especial para FACTURA ----
    # Si el front aún no expone "payments" en state, igual inyectamos la instrucción proactiva.
    mops = []
    try:
        mops = _erp_list_mops()
    except Exception:
        mops = []

    need_payment_first = str(state.get("mode", "")).upper() == "FACTURA" and not state.get("payments")

    extra_rule = ""
    if need_payment_first:
        extra_rule = (
            "Si el modo actual es FACTURA y el estado no registra un pago seleccionado, "
            "primero debes emitir la acción set_payment con params {\"mop\":\"<uno de estos métodos>\", \"account\":\"<opcional>\"} "
            "usando obligatoriamente uno de los siguientes métodos admitidos (con cuentas si las hay):\n"
            f"{json.dumps(mops, ensure_ascii=False)}\n"
            "y solo después emitir confirm_document.\n"
        )

    # ---- Prompts ----
    system_prompt = (
        "Sos un parser que convierte la intención del usuario en acciones de UI.\n"
        "Respondé EXCLUSIVAMENTE un objeto JSON con esta forma exacta:\n"
        "{\"actions\":[{\"action\":\"<nombre>\",\"params\":{}}]}\n"
        "No incluyas Markdown, comentarios, ni texto adicional.\n"
        "Usá solo acciones de la whitelist. Si algo no aplica, devolvé actions: [].\n"
        + extra_rule +
        "Whitelist: " + json.dumps(allowed_actions)
    )

    user_payload = {
        "text": user_text,
        "state": state,
        "hint": "De ser necesario, podés encadenar varias acciones. Ej: buscar → seleccionar → set_qty → add_to_cart → repeat."
    }

    # ---- Log de request completo ----
    try:
        logger.info("REQUEST %s", json.dumps({"text": user_text, "state": state, "catalog": catalog_in}, ensure_ascii=False))
    except Exception:
        pass

    # ---- Llamada a OpenAI ----
    payload = {
        "model": LLM_MODEL,
        "temperature": 0.1,
        "max_tokens": 600,
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": json.dumps(user_payload, ensure_ascii=False)},
        ],
    }

    try:
        resp = requests.post(
            "https://api.openai.com/v1/chat/completions",
            headers={"Authorization": f"Bearer {OPENAI_API_KEY}", "Content-Type": "application/json"},
            data=json.dumps(payload),
            timeout=30,
        )
        resp.raise_for_status()
        js = resp.json()
        content = js.get("choices", [{}])[0].get("message", {}).get("content", "")
        try:
            logger.info("RAW_RESPONSE %s", content)
        except Exception:
            pass

        parsed = json.loads(content) if content else {}
        candidate_actions = parsed.get("actions", [])
        if not isinstance(candidate_actions, list):
            candidate_actions = []

    except Exception as e:
        # Fallback MUY conservador (mismo comportamiento que tu stub)
        logger.error("LLM_ERROR %s", repr(e))
        t = (user_text or "").lower()
        if "presupuesto" in t:
            return {"actions": [{"action": "set_mode", "params": {"mode": "PRESUPUESTO"}}]}
        if "factura" in t:
            return {"actions": [{"action": "set_mode", "params": {"mode": "FACTURA"}}]}
        if "remito" in t:
            return {"actions": [{"action": "set_mode", "params": {"mode": "REMITO"}}]}
        return {"actions": [{"action": "search", "params": {"term": user_text}}]}

    # ---- Whitelist + saneamiento de params ----
    safe_actions: List[Dict[str, Any]] = []
    for a in candidate_actions:
        try:
            name = a.get("action")
            if not isinstance(name, str) or name not in allowed_actions:
                continue
            params = a.get("params") or {}
            if not isinstance(params, dict):
                params = {}
            # Opcional: limpieza básica de params para evitar tipos raros
            clean_params: Dict[str, Any] = {}
            for k, v in params.items():
                if isinstance(v, (str, int, float, bool)) or v is None:
                    clean_params[k] = v
                else:
                    # serializa estructuras simples
                    try:
                        clean_params[k] = json.loads(json.dumps(v, ensure_ascii=False))
                    except Exception:
                        continue
            safe_actions.append({"action": name, "params": clean_params})
        except Exception:
            continue

    try:
        logger.info("PARSED_ACTIONS %s", json.dumps(safe_actions, ensure_ascii=False))
    except Exception:
        pass

    return {"actions": safe_actions}

# ========= NUEVO: endpoints unificados con stock =========
@app.post("/bridge/search_with_stock")
def search_with_stock(payload: SearchByQuery):
    """
    Busca por texto y devuelve ítems MERGEADOS con stock real de Bin en 'warehouse'.
    Cachea por TTL.
    """
    if not AUTH_HEADER:
        raise HTTPException(status_code=500, detail="ERP auth no configurada.")
    # Cache por combinación (query, pos_profile, warehouse, limit, page)
    ckey = _ck("search_with_stock", payload.query, payload.pos_profile, payload.warehouse, payload.limit, payload.page)
    cached = _cache_get(ckey)
    if cached is not None:
        return {"message": cached}

    items = pos_get_items(payload.query, payload.pos_profile, payload.limit, payload.page)
    codes = [i.get("item_code") or i.get("name") for i in items if (i.get("item_code") or i.get("name"))]
    stock = bin_qty_bulk(codes, payload.warehouse)

    merged = []
    for it in items:
        code = it.get("item_code") or it.get("name")
        it2 = dict(it)
        if code:
            it2["actual_qty"] = stock.get(code, it.get("actual_qty", 0))
        merged.append(it2)

    _cache_set(ckey, merged)
    return {"message": merged}

@app.post("/bridge/codes_with_stock")
def codes_with_stock(payload: SearchByCodes):
    """
    Si ya tenés los item_codes, devolvemos {item_code, warehouse, actual_qty} usando Bin.
    Cachea por TTL.
    """
    if not AUTH_HEADER:
        raise HTTPException(status_code=500, detail="ERP auth no configurada.")
    ckey = _ck("codes_with_stock", sorted(payload.item_codes), payload.warehouse)
    cached = _cache_get(ckey)
    if cached is not None:
        return {"message": cached}

    stock = bin_qty_bulk(payload.item_codes, payload.warehouse)
    result = [{"item_code": c, "warehouse": payload.warehouse, "actual_qty": stock.get(c, 0.0)} for c in payload.item_codes]

    _cache_set(ckey, result)
    return {"message": result}

@app.post("/bridge/cache_clear")
def cache_clear():
    _cache.clear()
    return {"ok": True, "size": 0}

# ==== BÚSQUEDA DE CLIENTES / PROVEEDORES (mínimo útil) ====
def _erp_get_list_party(doctype: str, fields: List[str], q: str, limit: int, page: int):
    if not AUTH_HEADER:
        raise HTTPException(status_code=500, detail="ERP auth no configurada.")
    url = f"{ERP_BASE}/api/method/frappe.client.get_list"
    # Usamos OR entre varios campos típicos
    name_field = fields[1] if len(fields) > 1 else "name"
    payload = {
        "doctype": doctype,
        "fields": fields,
        "or_filters": [
            [doctype, "name", "like", f"%{q}%"],
            [doctype, name_field, "like", f"%{q}%"],
            [doctype, "mobile_no", "like", f"%{q}%"],
            [doctype, "email_id", "like", f"%{q}%"],
            [doctype, "tax_id", "like", f"%{q}%"],
        ],
        "limit_page_length": limit,
        "limit_start": (max(page, 1) - 1) * limit,
        "order_by": "modified desc",
    }
    r = requests.post(url, headers=HEADERS_JSON, data=json.dumps(payload), timeout=30)
    r.raise_for_status()
    return r.json().get("message", [])

@app.post("/bridge/search_customers")
def search_customers(payload: PartySearchIn):
    try:
        rows = _erp_get_list_party(
            "Customer",
            ["name", "customer_name", "customer_type", "tax_id", "mobile_no", "email_id", "default_price_list"],
            payload.query, payload.limit, payload.page
        )
        return {"message": rows}
    except requests.HTTPError as e:
        status = e.response.status_code if getattr(e, "response", None) else 502
        detail = getattr(e, "response", None).text if getattr(e, "response", None) else str(e)
        raise HTTPException(status_code=status, detail=detail)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/bridge/search_suppliers")
def search_suppliers(payload: PartySearchIn):
    try:
        rows = _erp_get_list_party(
            "Supplier",
            ["name", "supplier_name", "supplier_type", "tax_id", "mobile_no", "email_id", "default_price_list"],
            payload.query, payload.limit, payload.page
        )
        return {"message": rows}
    except requests.HTTPError as e:
        status = e.response.status_code if getattr(e, "response", None) else 502
        detail = getattr(e, "response", None).text if getattr(e, "response", None) else str(e)
        raise HTTPException(status_code=status, detail=detail)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
