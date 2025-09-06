# bridge.py — FastAPI microservice (CORS + ERP auth + búsqueda “inteligente” + search_with_stock)
# Requisitos: pip install fastapi uvicorn requests python-dotenv pydantic

import os, json, unicodedata, re, html, time
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
ERP_BASE        = os.getenv("ERP_BASE", "http://erp.localhost")
ERP_API_KEY     = os.getenv("ERP_API_KEY", "")
ERP_API_SECRET  = os.getenv("ERP_API_SECRET", "")
ERP_TOKEN       = os.getenv("ERP_TOKEN")  # opcional: "APIKEY:APISECRET"
BRIDGE_CACHE_TTL = int(os.getenv("BRIDGE_CACHE_TTL", "20"))  # segundos

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

# ========= App + CORS =========
app = FastAPI()
if bin_qty_router:
    app.include_router(bin_qty_router)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173","http://127.0.0.1:5173","*"],
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

class ConfirmBody(BaseModel):
    mode: str
    customer: str
    items: list
    discount_pct: float = 0.0

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

# ========= Endpoints existentes =========
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
        detail = getattr(e.response, "text", str(e))
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
        detail = getattr(e.response, "text", str(e))
        raise HTTPException(status_code=status, detail=detail)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/bridge/confirm")
def confirm_document(body: ConfirmBody):
    prefix = "QTN" if body.mode.upper() == "PRESUPUESTO" else "SINV" if body.mode.upper() == "FACTURA" else "DN"
    return {"ok": True, "number": f"{prefix}-DEMO-0001"}

@app.post("/bridge/interpret")
def interpret(body: InterpretBody):
    t = (body.text or "").lower()
    if "presupuesto" in t:
        return {"actions": [{"action": "set_mode", "params": {"mode": "PRESUPUESTO"}}]}
    if "factura" in t:
        return {"actions": [{"action": "set_mode", "params": {"mode": "FACTURA"}}]}
    if "remito" in t:
        return {"actions": [{"action": "set_mode", "params": {"mode": "REMITO"}}]}
    return {"actions": [{"action": "search", "params": {"term": body.text}}]}

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
class PartySearchIn(BaseModel):
    query: str
    limit: int = 20
    page: int = 1

def _erp_get_list_party(doctype: str, fields: list[str], q: str, limit: int, page: int):
    url = f"{ERP_BASE}/api/method/frappe.client.get_list"
    payload = {
        "doctype": doctype,
        "fields": fields,
        "or_filters": [
            [doctype, "name", "like", f"%{q}%"],
            [doctype, fields[1] if len(fields) > 1 else "name", "like", f"%{q}%"],
            [doctype, "mobile_no", "like", f"%{q}%"],
            [doctype, "email_id", "like", f"%{q}%"],
            [doctype, "tax_id", "like", f"%{q}%"],
        ],
        "limit_page_length": limit,
        "limit_start": (max(page, 1) - 1) * limit,
        "order_by": "modified desc",
    }

    # Usa HEADERS global si existe; si no, lo arma acá
    try:
        hdrs = HEADERS  # type: ignore[name-defined]
    except NameError:
        token = ERP_TOKEN if ERP_TOKEN else f"{ERP_API_KEY}:{ERP_API_SECRET}"
        hdrs = {
            "Authorization": f"token {token}",
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "Accept": "application/json",
        }

    r = requests.post(url, headers={**hdrs, "Content-Type":"application/json", "Accept":"application/json"}, data=json.dumps(payload), timeout=30)
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
        detail = getattr(e.response, "text", str(e))
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
        detail = getattr(e.response, "text", str(e))
        raise HTTPException(status_code=status, detail=detail)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
