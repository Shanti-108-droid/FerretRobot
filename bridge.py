# bridge.py — FastAPI microservice (CORS + ERP auth + búsqueda “inteligente” + Realtime + Interpret con normalización/NLU/resolución)
# Requisitos base: pip install fastapi uvicorn requests httpx python-dotenv pydantic
# Recomendadas:   pip install rapidfuzz unidecode
import logging
import hashlib  
import os, json, unicodedata, re, html, time, logging, math, difflib
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import List, Dict, Any, Optional, Tuple
import httpx
import requests
from fastapi import FastAPI, HTTPException, Request, Body, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv
from fastapi.responses import JSONResponse
# ============================================================
# GUARDRAILS CENTRALIZADOS
# ============================================================
from typing import List, Dict, Any
import re
import json
from .normalize_filters import (
    parse_filters_from_query,
    BRAND_ALIASES,
    TAG_ALIASES,
)


# ========= .env =========
load_dotenv(dotenv_path=Path(__file__).with_name(".env"), override=True)

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

# ==== Políticas de interpretación / umbrales ====
INTERPRET_STRICT = os.getenv("INTERPRET_STRICT", "false").lower() == "true"
ACT_THRESHOLD    = float(os.getenv("ACT_THRESHOLD", "0.75"))
ASK_THRESHOLD    = float(os.getenv("ASK_THRESHOLD", "0.45"))
MAX_CANDIDATES   = int(os.getenv("MAX_CANDIDATES", "5"))

# ==== Defaults de negocio (tus baseline) ====
BASE_COMPANY   = os.getenv("BASE_COMPANY", "Hi Tech")
BASE_PROFILE   = os.getenv("BASE_PROFILE", "Sucursal Adrogue")
BASE_WAREHOUSE = os.getenv("BASE_WAREHOUSE", "Sucursal Adrogue - HT")
BASE_CURRENCY  = os.getenv("BASE_CURRENCY", "ARS")

# ==== Auth headers normalizados (compat con strings viejos) ====
def _make_auth_header_dict():
    token = None
    if ERP_TOKEN and ERP_TOKEN.strip():
        token = ERP_TOKEN.strip()
        if not token.lower().startswith("token "):
            token = f"token {token}"
    elif ERP_API_KEY and ERP_API_SECRET:
        token = f"token {ERP_API_KEY}:{ERP_API_SECRET}"
    elif ERP_API_KEY:
        token = f"token {ERP_API_KEY}"
    return {"Authorization": token} if token else {}

def _ensure_headers(h):
    if isinstance(h, dict):
        return h
    if isinstance(h, str) and h.strip():
        return {"Authorization": h.strip()}
    return {}

# Compat: si ya existía AUTH_HEADER (string), lo normalizo; si no, lo creo
AUTH_HEADER = _ensure_headers(globals().get("AUTH_HEADER", None)) or _make_auth_header_dict()

# DEBUG: loguea el tipo en el arranque del servidor
print("AUTH_HEADER_DEBUG:", type(AUTH_HEADER).__name__, AUTH_HEADER)

# Variable global usada por todo el código existente
AUTH_HEADER = _ensure_headers(globals().get("AUTH_HEADER", _make_auth_header_dict()))


def apply_guardrails(
    user_text: str,
    state: Dict[str, Any],
    allowed_actions: List[str],
    candidate_actions: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """
    Centraliza TODOS los guardrails. 
    Recibe user_text/state/allowed_actions/candidate_actions y devuelve safe_actions.
    """

    user_text = (user_text or "").strip()

    # ===== Helpers =====
    def _coerce_params(obj) -> Dict[str, Any]:
        if isinstance(obj, dict):
            out = {}
            for k, v in obj.items():
                if isinstance(v, (str, int, float, bool)) or v is None:
                    out[k] = v
                else:
                    try:
                        out[k] = json.loads(json.dumps(v, ensure_ascii=False))
                    except Exception:
                        continue
            return out
        return {}

    def parse_index_from_text(txt: str) -> int | None:
        txt = txt.lower()
        m = re.search(r"\b(?:í?tem|n[úu]mero|num|el)\s+(\d{1,3})\b", txt)
        if m:
            try:
                return int(m.group(1))
            except Exception:
                return None
        if re.search(r"\bcarrito\b", txt):
            m2 = re.search(r"\b(\d{1,3})\b", txt)
            if m2:
                try:
                    return int(m2.group(1))
                except Exception:
                    return None
        return None

    # ===== 0) Normalización + whitelist mínima =====
    safe_actions: List[Dict[str, Any]] = []
    for a in candidate_actions or []:
        try:
            name = a.get("action")
            if not isinstance(name, str) or name not in allowed_actions:
                continue
            params = _coerce_params(a.get("params") or {})
            if name == "search" and "query" in params and "term" not in params:
                params["term"] = params.pop("query")
            safe_actions.append({"action": name, "params": params})
        except Exception:
            continue

    # ===== Guardrail A: confirm_document solo si el usuario lo pidió explícitamente =====
    confirm_regex = re.compile(
        r"\b(confirm(ar|o|ado|ame|emos)?|factur(a|á|ar)|emit(ir|í)\s+(la\s+)?(factura|comprobante)|cerr(ar|á)\s+venta)\b",
        re.I
    )
    user_wants_confirm = bool(confirm_regex.search(user_text))
    if not user_wants_confirm:
        safe_actions = [a for a in safe_actions if a.get("action") != "confirm_document"]

    # ===== Guardrail B: add_to_cart requiere selección previa válida =====
    has_prior_select = any((a.get("action") == "select_index") for a in safe_actions)
    selected_index_state = state.get("selected_index")
    results_len = len(state.get("results") or [])

    if not has_prior_select and not selected_index_state:
        safe_actions = [a for a in safe_actions if a.get("action") != "add_to_cart"]

    if any(a.get("action") == "add_to_cart" for a in safe_actions):
        idx_actions = [a for a in safe_actions if a.get("action") == "select_index"]
        idx = None
        if idx_actions and isinstance(idx_actions[0].get("params"), dict):
            idx = idx_actions[0]["params"].get("index")
        if idx is None:
            idx = selected_index_state
        try:
            idx_ok = bool(idx) and 1 <= int(idx) <= results_len
        except Exception:
            idx_ok = False
        if not idx_ok:
            safe_actions = [a for a in safe_actions if a.get("action") != "add_to_cart"]

    # ===== Guardrail C: clear_cart solo si la frase lo pide explícito =====
    clear_regex = re.compile(r"\b(vacia(?:r)?|vaciar|limpia(?:r)?|limpiar|borra(?:r)?)\b.*\bcarrito\b", re.I)
    user_wants_clear = bool(clear_regex.search(user_text))
    if not user_wants_clear:
        safe_actions = [a for a in safe_actions if a.get("action") != "clear_cart"]

    # ===== Guardrail D: remove_from_cart solo si la frase lo pide explícito =====
    remove_regex = re.compile(
        r"\b(borra(?:r)?|elimina(?:r)?|saca(?:r)?|quita(?:r)?)\b.*\b(item|ítem|producto|artículo|carrito)\b",
        re.I
    )
    user_wants_remove = bool(remove_regex.search(user_text))
    if not user_wants_remove:
        safe_actions = [a for a in safe_actions if a.get("action") != "remove_from_cart"]

    # ===== Guardrail E: remove_last_item solo si se menciona “último” =====
    remove_last_regex = re.compile(r"\b(últim[oa]?|ultimo|lo\s+último|final)\b", re.I)
    user_wants_remove_last = bool(remove_last_regex.search(user_text))
    if not user_wants_remove_last:
        safe_actions = [a for a in safe_actions if a.get("action") != "remove_last_item"]

    # ===== Guardrail G: frases de búsqueda → SOLO search =====
    search_only_regex = re.compile(
        r"\b(busca(?:r|me)?|buscame|buscar|mostra(?:r|me)?|mostrar|mostrame|quiero ver|mostrame algo|mostrame productos)\b",
        re.I
    )
    if search_only_regex.search(user_text):
        safe_actions = [a for a in safe_actions if a.get("action") == "search"]
        for a in safe_actions:
            if a.get("action") == "search":
                params = a.setdefault("params", {})
                # normalizar origen (query→term)
                term = params.pop("query", params.get("term", "")) or ""
                # limpiar artículos/cortesía/puntuación
                term = re.sub(r'(^\s*(a|al|la|el)\s+)|\b(por\s*fa(?:vor|)|porfis)\b', ' ', term, flags=re.I)
                term = re.sub(r'[^\w\s/"]+', ' ', term)   # quita puntos finales, etc (pero deja 3/4 y ")
                term = re.sub(r'\s+', ' ', term).strip()
                params["term"] = term
    

    # ===== Guardrail H: set_mode solo si lo pide explícitamente =====
    mode_explicit_regex = re.compile(
        r"\bmodo\s+(factura|presupuesto|remito)\b|\b(pasar|pon(e|er)|cambiar)\s+a\s+modo\s+(factura|presupuesto|remito)\b",
        re.I
    )
    if not mode_explicit_regex.search(user_text):
        safe_actions = [a for a in safe_actions if a.get("action") != "set_mode"]

    # ===== Guardrail I: set_payment solo si hay intención de pago =====
    pay_intent_regex = re.compile(
        r"\b(pag(a|ar|ame)|cobr(a|ar|ame)|efectivo|tarjeta|d[eé]bito|cr[eé]dito|transferencia|qr|mercado\s*pago|mp|pago)\b",
        re.I
    )
    if not pay_intent_regex.search(user_text):
        safe_actions = [a for a in safe_actions if a.get("action") != "set_payment"]

    # ===== Guardrail J: respetar índice textual para remove_from_cart =====
    try:
        idx_from_text = parse_index_from_text(user_text)
    except Exception:
        idx_from_text = None

    if re.search(r"\bcarrito\b", user_text, flags=re.I) and idx_from_text:
        for a in safe_actions:
            if a.get("action") == "remove_from_cart":
                a.setdefault("params", {})["index"] = int(idx_from_text)

    cart_len = len(state.get("cart") or []) if isinstance(state.get("cart"), list) else 0
    safe_actions2: List[Dict[str, Any]] = []
    for a in safe_actions:
        if a.get("action") == "remove_from_cart":
            i = None
            try:
                i = int((a.get("params") or {}).get("index") or 0)
            except Exception:
                i = None

            if i is not None and cart_len > 0:
                if 1 <= i <= cart_len:
                    safe_actions2.append(a)
                else:
                    safe_actions2.append({
                        "action": "ask_user",
                        "params": {"question": f"¿Qué ítem del carrito querés borrar? Decime un número del 1 al {cart_len}."}
                    })
            else:
                name = (a.get("params") or {}).get("name")
                if name:
                    safe_actions2.append(a)
                else:
                    safe_actions2.append({
                        "action": "ask_user",
                        "params": {"question": "¿Cuál ítem del carrito querés borrar? Decime un índice (1..N) o el nombre."}
                    })
        else:
            safe_actions2.append(a)

    return safe_actions2

# Routers existentes (opcionales)
try:
    from routes.bin_qty import router as bin_qty_router
except Exception:
    bin_qty_router = None  # por si no existe en tu proyecto



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
    "company": BASE_COMPANY,
    "pos_profile": BASE_PROFILE,
    "warehouse": BASE_WAREHOUSE,
    "price_list": "Standard Selling",
    "currency": BASE_CURRENCY,
    "customer": "Consumidor Final",
    "tax_category": "IVA 21%",
}

# ==== Logger rotativo para /bridge/interpret ====
LOG_DIR = Path(__file__).with_name("logs")
LOG_DIR.mkdir(exist_ok=True)
log_file = LOG_DIR / "interpret.log"
# === Logger de bridge (trazas de requests) ===
bridge_log_file = LOG_DIR / "bridge.log"
bridge_logger = logging.getLogger("bridge")
if not bridge_logger.handlers:
    bridge_logger.setLevel(logging.INFO)
    _bh = RotatingFileHandler(bridge_log_file, maxBytes=5 * 1024 * 1024, backupCount=5, encoding="utf-8")
    _bf = logging.Formatter("%(asctime)s %(levelname)s: %(message)s")
    _bh.setFormatter(_bf)
    bridge_logger.addHandler(_bh)

def blog(msg: str, trace_id: str | None = None, **kw):
    try:
        bridge_logger.info(f"{msg} | {json.dumps({'trace_id': trace_id, **kw}, ensure_ascii=False)}")
    except Exception:
        # fallback si hay algo no serializable
        bridge_logger.info(f"{msg} | trace_id={trace_id} | {kw}")


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

# === Middleware: adjuntar X-Trace-Id (dejar antes que CORS) ===
@app.middleware("http")
async def attach_trace_id(request: Request, call_next):
    try:
        request.state.trace_id = request.headers.get("X-Trace-Id")
        resp = await call_next(request)
    except Exception:
        raise
    if getattr(request.state, "trace_id", None):
        resp.headers["X-Trace-Id"] = request.state.trace_id
    return resp

# ✅ Catch-all: siempre JSON y con X-Trace-Id si está
from fastapi.responses import JSONResponse

@app.exception_handler(Exception)
async def _catch_all(request: Request, exc: Exception):
    trace_id = getattr(getattr(request, "state", None), "trace_id", None)
    resp = JSONResponse(status_code=500, content={"ok": False, "detail": str(exc)})
    if trace_id:
        resp.headers["X-Trace-Id"] = trace_id
    return resp

# ✅ CORS debe ir ÚLTIMO (outermost)
from fastapi.middleware.cors import CORSMiddleware
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"https?://(localhost|127\.0\.0\.1)(:\d+)?",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Trace-Id"],
)



# ========= Realtime helpers =========
_LAST_ISSUED: Dict[str, Dict[str, Any]] = {}
_COOLDOWN_SEC = 2
_CACHE_TTL_SEC = 10

@app.get("/ping")
def ping():
    return {"pong": True}

@app.post("/realtime/sdp")
async def realtime_sdp(payload: dict = Body(...)):
    """
    Proxy de SDP para evitar CORS en el browser.
    Espera: {"sdp": "<offer.sdp>", "client_secret": "<ephemeral>", "model":"gpt-4o-mini-realtime-preview"}
    Devuelve: answer SDP (text/plain)
    """
    offer_sdp = (payload or {}).get("sdp")
    client_secret = (payload or {}).get("client_secret")
    model = (payload or {}).get("model") or "gpt-4o-mini-realtime-preview"
    if not offer_sdp or not client_secret:
        raise HTTPException(status_code=400, detail="faltan 'sdp' y/o 'client_secret'")
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            r = await client.post(
                f"https://api.openai.com/v1/realtime?model={model}",
                headers={
                    "Authorization": f"Bearer {client_secret}",
                    "Content-Type": "application/sdp",
                    "Accept": "application/sdp",
                    "OpenAI-Beta": "realtime=v1",
                },
                content=offer_sdp,
            )
        if r.status_code not in (200, 201):
            # Devolver texto plano de OpenAI para depurar en el Network panel
            return Response(content=r.text, media_type="text/plain", status_code=r.status_code)
        return Response(content=r.text, media_type="application/sdp")

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"sdp error: {e}")

@app.get("/realtime/session")
async def realtime_session(request: Request):
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY no configurada")
    ip = request.client.host if request and request.client else "unknown"
    now = time.time()
    prev = _LAST_ISSUED.get(ip)
    if prev:
        if now - prev["ts"] < _COOLDOWN_SEC:
            if now - prev["ts"] < _CACHE_TTL_SEC:
                return prev["json"]
        if now - prev["ts"] < _CACHE_TTL_SEC:
            return prev["json"]
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            r = await client.post(
                "https://api.openai.com/v1/realtime/sessions",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                    "OpenAI-Beta": "realtime=v1",
                },
                json={
                    "model": "gpt-4o-mini-realtime-preview",
                    "voice": "alloy",
                    "input_audio_transcription": {"model": "whisper-1", "language": "es"},
                    "turn_detection": {
                        "type": "server_vad",
                        "threshold": 0.60,
                        "silence_duration_ms": 900,
                        "create_response": False
                    },
                },
            )
        if r.status_code != 200:
            # Mostrar el error real de OpenAI (no taparlo con 500 genérico)
            try:
                return JSONResponse(status_code=r.status_code, content={"ok": False, **r.json()})
            except Exception:
                return JSONResponse(status_code=r.status_code, content={"ok": False, "detail": r.text})

        data = r.json()
        
        _LAST_ISSUED[ip] = {"ts": now, "json": data}
        return data
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"session error: {e}")

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
    warehouse: Optional[str] = DEFAULTS["warehouse"]
    uom: Optional[str] = None
    brand: Optional[str] = None
    marca: Optional[str] = None
    limit: int = 20


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
def _ok(number: str | None, doc: dict | None):
    return {"ok": True, "number": number, "doc": doc, "error": None}

def _err(code: str, message: str, **extra):
    e = {"code": code, "message": message}
    e.update(extra or {})
    return {"ok": False, "number": None, "doc": None, "error": e}

def _erp_headers() -> dict:
    if isinstance(AUTH_HEADER, dict):
        return AUTH_HEADER
    if isinstance(AUTH_HEADER, str):
        return {"Authorization": AUTH_HEADER, "Content-Type": "application/json"}
    raise HTTPException(status_code=500, detail="AUTH_HEADER mal formado (esperaba dict o str)")

# ========= Helpers de filtros extra =========
def normalize_uom(s: str) -> str:
    """Normaliza UOM comunes (unidad/unidades/u → nos)."""
    x = norm(s)
    if x in ("unidad", "unidades", "u", "uni", "und", "uds"):
        return "nos"
    return x

def _split_terms(val: Optional[str]) -> list[str]:
    """Divide cadenas tipo 'Tigre, Saladillo/IPS' en tokens normalizados"""
    if not val:
        return []
    return [norm(t) for t in re.split(r"[,|/]+", str(val)) if norm(t)]
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

# === Stock por Bin ===
def bin_qty_bulk(item_codes: List[str], warehouse: str) -> Dict[str, float]:
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
    mops = erp_get_list(
        doctype="Mode of Payment",
        fields=["name", "enabled"],
        filters=[["Mode of Payment", "enabled", "=", 1]],
        limit=200,
        page=1,
    )
    names = [m["name"] for m in mops]
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

# === Endpoints ===
@app.get("/bridge/payment_methods")
def payment_methods():
    try:
        return {"message": _erp_list_mops()}
    except requests.HTTPError as e:
        status = e.response.status_code if getattr(e, "response", None) else 502
        detail = getattr(e, "response", None).text if getattr(e, "response", None) else str(e)
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




# ====== ITEM DETAIL ======
@app.post("/bridge/item-detail")
def item_detail(body: ItemDetailBody):
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
def _mop_account(mode_of_payment: str, company: str) -> str | None:
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

@app.post("/bridge/confirm")
def confirm_document(body: ConfirmBody):
    try:
        mode = (body.mode or "").upper()
        if mode not in ("PRESUPUESTO", "FACTURA", "REMITO"):
            return _err("BAD_MODE", f"Modo inválido: {body.mode}")
        if not body.items:
            return _err("NO_ITEMS", "No hay ítems para confirmar.")
        if not AUTH_HEADER:
            return _err("NO_AUTH", "ERP auth no configurada.")

        if mode == "PRESUPUESTO":
            doctype = "Quotation"
        elif mode == "FACTURA":
            doctype = "Sales Invoice"
        else:
            doctype = "Delivery Note"

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

        if doctype == "Quotation":
            doc.update({"quotation_to": "Customer"})
        elif doctype == "Sales Invoice":
            doc.update({
                "is_pos": 1,
                "pos_profile": DEFAULTS["pos_profile"],
                "update_stock": 1 if DEFAULTS.get("warehouse") else 0,
            })
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

        # Insert
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

        if r_ins.status_code != 200:
            return _err(f"ERP_{r_ins.status_code}", r_ins.text)

        created = r_ins.json().get("data") or {}
        name = created.get("name")

        if doctype in ("Sales Invoice", "Delivery Note"):
            try:
                r_sub = requests.post(
                    f"{ERP_BASE}/api/method/frappe.client.submit",
                    headers=_erp_headers(),
                    json={"doc": created},
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

        return _ok(name, created)

    except Exception as e:
        return _err("UNEXPECTED", str(e))

# ========= Normalizador ES (capa 1) =========
_NUM_MAP = {
    "cero":0,"uno":1,"una":1,"dos":2,"tres":3,"cuatro":4,"cinco":5,"seis":6,"siete":7,"ocho":8,"nueve":9,
    "diez":10,"once":11,"doce":12,"trece":13,"catorce":14,"quince":15,"dieciseis":16,"dieciséis":16,
    "diecisiete":17,"dieciocho":18,"diecinueve":19,"veinte":20,"veintiuno":21,"veintidos":22,"veintidós":22,
    "veintitres":23,"veintitrés":23,"veinticuatro":24,"veinticinco":25,"veintiseis":26,"veintiséis":26,
    "veintisiete":27,"veintiocho":28,"veintinueve":29,
    "treinta":30,"cuarenta":40,"cincuenta":50,"sesenta":60,"setenta":70,"ochenta":80,"noventa":90,
    "media":0.5,"medio":0.5
}
_ORD_MAP = {"primero":1,"segundo":2,"tercero":3,"cuarto":4,"quinto":5}

def _normalize_quotes_punct(s: str) -> str:
    if not s: return ""
    repl = {"½":"1/2","¼":"1/4","¾":"3/4","”":'"',"“":'"',"″":'"',"′":"'", "º":"", "°":""}
    for k,v in repl.items(): s = s.replace(k,v)
    return s

def _words_to_number_simple(tok: str) -> Optional[float]:
    # Maneja 0..29 + decenas + "decena y unidad"
    t = tok
    if t in _NUM_MAP: return float(_NUM_MAP[t])
    # "treinta y cinco"
    if " y " in t:
        parts = t.split(" y ")
        if len(parts)==2 and parts[0] in _NUM_MAP and parts[1] in _NUM_MAP:
            base = _NUM_MAP[parts[0]]
            add  = _NUM_MAP[parts[1]]
            if base in (30,40,50,60,70,80,90):
                return float(base+add)
    return None

def _replace_spelled_numbers(text: str) -> str:
    # Reemplaza secuencias simples; no intenta cientos/miles (no lo necesitás para POS hablado)
    # También resuelve "tres cuartos" / "un cuarto"
    s = f" {text} "
    s = re.sub(r"\b(tres\s+cuartos)\b", " 3/4 ", s)
    s = re.sub(r"\b(un\s+cuarto)\b", " 1/4 ", s)
    s = re.sub(r"\b(media|medio)\s+pulgada(s)?\b", " 1/2 in ", s)

    # Ordinales
    for w, n in _ORD_MAP.items():
        s = re.sub(rf"\b{w}\b", f" {n} ", s)

    # Decenas "treinta y cinco"
    decenas = ["treinta","cuarenta","cincuenta","sesenta","setenta","ochenta","noventa"]
    unidades = ["uno","una","dos","tres","cuatro","cinco","seis","siete","ocho","nueve"]
    for d in decenas:
        for u in unidades:
            s = re.sub(rf"\b{d}\s+y\s+{u}\b", lambda m: f" {int(_NUM_MAP[d]+_NUM_MAP[u])} ", s)

    # Token por token simples
    tokens = s.split()
    out = []
    for t in tokens:
        val = _words_to_number_simple(t)
        if val is not None:
            # si es entero, sin .0
            out.append(str(int(val)) if abs(val - int(val)) < 1e-9 else str(val))
        else:
            out.append(t)
    return " ".join(out).strip()

def normalize_es(text: str) -> Dict[str, Any]:
    """
    Devuelve: {"text": <normalizado>, "tokens": [...], "units": {"mm": int|None, "in": float|None}}
    - quita tildes, baja a minúsculas, colapsa espacios
    - reemplaza números en palabras por dígitos
    - unifica unidades (mm, in)
    - corrige fonéticas típicas: "canon"→"caño", "canyo"→"caño"
    """
    if not text: 
        return {"text":"", "tokens":[], "units":{"mm":None, "in":None}}

    s = _normalize_quotes_punct(text)
    s = strip_accents(s).lower()
    s = _replace_spelled_numbers(s)

    # normaliza comillas y caracteres
    s = re.sub(r'[^a-z0-9/.\s"\'-]', " ", s)
    s = re.sub(r"\s+", " ", s).strip()

    # correcciones fonéticas comunes del dominio (cuidado con falsos positivos)
    s = re.sub(r"\bcanon\b", " caño ", s)   # cañón→caño (dominio ferre)
    s = re.sub(r"\bcanyo\b", " caño ", s)
    s = re.sub(r"\bcano\b",  " caño ", s)

    # unidades mm
    mm = None
    m_mm = re.search(r"\b(\d{1,3})\s*mm\b", s)
    if m_mm:
        try: mm = int(m_mm.group(1))
        except: mm = None

    # pulgadas como 1/2, 3/4, 1", 0.5 in, etc.
    inch = None
    # fracciones clásicas
    frac_map = {"1/4":0.25,"1/2":0.5,"3/4":0.75}
    m_frac = re.search(r"\b(1/4|1/2|3/4)\b", s)
    if m_frac: inch = frac_map[m_frac.group(1)]
    # formato decimal con in o "
    if inch is None:
        m_in = re.search(r'\b(\d+(?:\.\d+)?)\s*(in|pulg|pulgadas|")\b', s)
        if m_in:
            try: inch = float(m_in.group(1))
            except: inch = None

    tokens = [t for t in s.split(" ") if t]
    return {"text": s, "tokens": tokens, "units": {"mm": mm, "in": inch}}

def parse_index_from_text(norm_text: str) -> Optional[int]:
    # "item 1", "ítem 2", "item numero 3"
    m = re.search(r"\bitem[s]?\s*(numero\s*)?(\d+)\b", norm_text)
    if m:
        try: return int(m.group(2))
        except: pass
    # "el 1", "el primero" ya viene convertido a 1 por normalize_es
    m2 = re.search(r"\bel\s*(\d+)\b", norm_text)
    if m2:
        try: return int(m2.group(1))
        except: pass
    return None

def parse_qty_ops(norm_text: str) -> Tuple[Optional[int], Optional[int], Optional[int]]:
    """
    Devuelve (qty_abs, delta_plus, delta_minus)

    Soporta:
    - "cantidad 3", "dejalo en 3", "deja en 3", "pone en 3", "ajusta a 3"
    - "agrega 3", "agregar 3", "sumar 2"
    - "agregado a 3 (unidades)", "a 3 unidades"
    - "sumale 2", "sacale 1" (deltas)
    """
    qty_abs = None
    delta_plus = None
    delta_minus = None

    m_abs = re.search(r"\b(cantidad|dejalo en|deja en|poner cantidad|pone cantidad|pone en|ajusta a|ajustar a)\s*(\d+)\b", norm_text)
    if m_abs:
        qty_abs = int(m_abs.group(2))

    if qty_abs is None:
        m_set = re.search(r"\b(agregado|agrega(?:r|do)?|puesto|pone(?:r|do)?)\s*a\s*(\d+)\b", norm_text)
        if m_set:
            qty_abs = int(m_set.group(2))
    if qty_abs is None:
        m_un = re.search(r"\ba\s*(\d+)\s*unidades?\b", norm_text)
        if m_un:
            qty_abs = int(m_un.group(1))

    m_plus = re.search(r"\b(sumale|agregale|aumenta|subi|subile|sumar|agregar)\s*(\d+)\b", norm_text)
    if m_plus:
        delta_plus = int(m_plus.group(2))

    m_minus = re.search(r"\b(sacale|quitale|disminui|baja|bajale|restale|restar)\s*(\d+)\b", norm_text)
    if m_minus:
        delta_minus = int(m_minus.group(2))

    if qty_abs is None:
        m_add_qty = re.search(r"\b(agrega|agregar|pone|poner|sumar)\b.*\b(\d+)\b", norm_text)
        if m_add_qty:
            qty_abs = int(m_add_qty.group(2))

    return qty_abs, delta_plus, delta_minus

def deterministic_fastpath(user_text: str, state: dict, allowed: set[str]) -> Optional[List[Dict[str, Any]]]:
    """Reglas deterministas para órdenes comunes sin depender del LLM."""
    try:
        info = normalize_es(user_text)
        ntext = info["text"]
        idx = parse_index_from_text(ntext)  # 1-based o None
        qty_abs, delta_plus, delta_minus = parse_qty_ops(ntext)

        actions: List[Dict[str, Any]] = []
        results = state.get("results") or []
        selected_index = state.get("selected_index")
        qty_hint = int(state.get("qty_hint") or 1)
        cart = state.get("cart") or []  # [{item_code,item_name,qty,uom,unit_price}...]

        # --- INTENCIONES DIRECTAS (confirmar / pago / modo / buscar) ---
        # confirmar
        if "confirm_document" in allowed and re.search(r"\b(confirm(ar|o|ado|ame|emos)?|factur(a|ar|á)|cerr(ar|á)\s*venta)\b", ntext, re.I):
            return [{"action": "confirm_document", "params": {}}]

        # set_payment (efectivo / transferencia / tarjeta crédito|débito)
        if "set_payment" in allowed:
            if re.search(r"\b(efectivo|cash)\b", ntext):
                return [{"action": "set_payment", "params": {"mop": "Cash"}}]
            if re.search(r"\btransferenc(ia|ias)\b", ntext):
                return [{"action": "set_payment", "params": {"mop": "Bank Draft"}}]
            if re.search(r"\btarjeta\s+(credito|cr[eé]dito)\b", ntext):
                return [{"action": "set_payment", "params": {"mop": "Credit Card"}}]
            if re.search(r"\btarjeta\s+(debito|d[eé]bito)\b", ntext):
                return [{"action": "set_payment", "params": {"mop": "Debit Card"}}]

        # set_mode
        if "set_mode" in allowed:
            m_mode = re.search(r"\bmodo\s+(presupuesto|factura|remito)\b", ntext)
            if m_mode:
                return [{"action": "set_mode", "params": {"mode": m_mode.group(1).upper()}}]

        # búsqueda simple ("busca/mostrar ...")
        if "search" in allowed and re.search(r"\b(busca[r]?|buscame|mostra[r]?|mostrame)\b", ntext):
            # quitar el verbo inicial
            term = re.sub(r"^\s*(busca[r]?|buscame|mostra[r]?|mostrame)\s*[:,-]?\s*", "", ntext).strip()
            if term:
                return [{"action": "search", "params": {"term": term}}]

        # --- Borrado "último" del carrito ---
        if "carrito" in ntext and re.search(r"\b(ultimo|último|final)\b", ntext) and "remove_last_item" in allowed:
            return [{"action": "remove_last_item", "params": {}}]

        # --- Borrado por índice/nombre en carrito ---
        if "carrito" in ntext and "remove_from_cart" in allowed:
            if idx is not None and isinstance(cart, list) and len(cart) >= idx >= 1:
                return [{"action": "remove_from_cart", "params": {"index": int(idx)}}]
            m_name = re.search(r"\b(?:borra(?:r)?|saca(?:r)?|quita(?:r)?)\s+(?:el|la)?\s*(.+)\s+del\s+carrito\b", ntext)
            if m_name:
                name = m_name.group(1).strip()
                if name and len(name) >= 2:
                    return [{"action": "remove_from_cart", "params": {"name": name}}]

        # Helpers
        def item_code_from_index(i: Optional[int]) -> Optional[str]:
            if not i:
                return None
            if isinstance(results, list) and 1 <= i <= len(results):
                row = results[i-1] or {}
                return row.get("item_code") or row.get("code") or row.get("name")
            return None

        def current_qty_for_item_code(code: Optional[str]) -> Optional[int]:
            if not code:
                return None
            try:
                for it in cart:
                    if not isinstance(it, dict):
                        continue
                    if (it.get("item_code") or it.get("code") or it.get("name")) == code:
                        q = it.get("qty")
                        if q is not None:
                            return int(q)
            except Exception:
                pass
            return None

        # Si vino índice, seleccionarlo
        target_index = idx or selected_index
        if idx is not None and "select_index" in allowed:
            actions.append({"action": "select_index", "params": {"index": idx}})

        # Cantidad absoluta
        if qty_abs is not None:
            if "set_qty" in allowed:
                actions.append({"action": "set_qty", "params": {"qty": int(qty_abs)}})
            if re.search(r"\b(agrega(?:r)?|agregado|sumar|agregame|añadir|poner)\b", ntext) and "add_to_cart" in allowed:
                actions.append({"action": "add_to_cart", "params": {}})
            return actions or None

        # Deltas (sumale / sacale)
        if (delta_plus or delta_minus):
            if not target_index:
                if "ask_user" in allowed:
                    return [{"action": "ask_user", "params": {"question": "¿Sobre qué ítem aplico el cambio de cantidad?"}}]
                return None

            code = item_code_from_index(target_index)
            base = current_qty_for_item_code(code)
            if base is None:
                base = qty_hint if isinstance(qty_hint, int) and qty_hint >= 0 else 1

            new_qty = int(max(0, base + int(delta_plus or 0) - int(delta_minus or 0)))
            if "set_qty" in allowed:
                if idx is None and selected_index and "select_index" in allowed:
                    actions.append({"action": "select_index", "params": {"index": int(selected_index)}})
                actions.append({"action": "set_qty", "params": {"qty": new_qty}})
                return actions or None

            return None

        return None
    except Exception:
        return None



# ========= Resolver candidatos (capa 2.5) =========
try:
    from rapidfuzz import fuzz
    def _sim(a: str, b: str) -> float:
        return fuzz.token_sort_ratio(a, b) / 100.0
except Exception:
    def _sim(a: str, b: str) -> float:
        return difflib.SequenceMatcher(None, a, b).ratio()

def resolve_item(query: str, limit: int = 20, page: int = 1) -> Dict[str, Any]:
    """
    Usa POS get_items para traer candidatos y devuelve el mejor match con score.
    """
    items = pos_get_items(query, DEFAULTS["pos_profile"], limit, page)
    if not items:
        # intento variante sin tildes/ñ→n ya lo hacemos en normalize_es()
        return {"best": None, "candidates": [], "resolution_confidence": 0.0}

    # score sobre campos relevantes
    ranked = []
    qn = norm(query)
    for it in items:
        text_all = fields_text(it)
        score = _sim(qn, text_all)
        # bonus si coincide medida explícita
        mm = re.search(r"\b(\d{1,3})\s*mm\b", qn)
        frac = re.search(r"\b(1/2|3/4|1/4)\b", qn)
        if mm and re.search(rf"\b{mm.group(1)}\s*mm\b", text_all):
            score += 0.08
        if frac and re.search(rf"\b{frac.group(1)}\b", text_all):
            score += 0.06
        ranked.append((score, it))

    ranked.sort(key=lambda x: x[0], reverse=True)
    best_score, best_item = ranked[0]
    candidates = [{"score": round(s,3), **it} for (s, it) in ranked[:MAX_CANDIDATES]]
    return {"best": best_item, "candidates": candidates, "resolution_confidence": max(0.0, min(1.0, float(best_score)))}

def blend_confidence(llm_conf: Optional[float], res_conf: Optional[float]) -> float:
    if llm_conf is None and res_conf is None:
        return 0.0
    if llm_conf is None:
        return float(res_conf)
    if res_conf is None:
        return float(llm_conf)
    # ponderación suave
    return float(0.6 * llm_conf + 0.4 * res_conf)

# ========= Prompting (capa 2/3) =========
RESPONSE_SCHEMA_FULL = {
    "type": "json_schema",
    "json_schema": {
        "name": "plan_con_criterio",
        "schema": {
            "type": "object",
            "properties": {
                "ok": {"type":"boolean"},
                "normalized": {
                    "type":"object",
                    "properties": {
                        "text":{"type":"string"},
                        "tokens":{"type":"array","items":{"type":"string"}}
                    }
                },
                "nlu": {
                    "type":"object",
                    "properties": {
                        "intent":{"type":"string"},
                        "slots":{"type":"object"},
                        "llm_confidence":{"type":"number"}
                    }
                },
                "resolution": {
                    "type":"object",
                    "properties": {
                        "item_code":{"type":["string","null"]},
                        "candidates":{"type":"array"},
                        "resolution_confidence":{"type":["number","null"]}
                    }
                },
                "confidence":{"type":"number"},
                "safe":{"type":"boolean"},
                "actions":{
                    "type":"array",
                    "items":{
                        "type":"object",
                        "properties":{
                            "action":{"type":"string"},
                            "params":{"type":"object"}
                        },
                        "required":["action"]
                    }
                },
                "ask":{"type":["string","null"]},
                "say":{"type":["string","null"]},
                "reason":{"type":["string","null"]}
            },
            "required":["actions"]
        }
    }
}

BASE_SYSTEM_PROMPT = """
Sos un **intérprete de intenciones para un POS**. Tu trabajo es:
(1) NORMALIZAR la frase (números en palabras→dígitos, fracciones, unidades, errores típicos de ASR),
(2) detectar INTENCIÓN + SLOTS,
(3) producir un **plan de ACCIONES** usando SOLO el catálogo permitido.

Política:
- Convertí números en palabras a dígitos (“veinte”→20). Fracciones: “media/medio”→0.5, “tres cuartos”→0.75, “un cuarto”→0.25.
- Tolerá errores de reconocimiento: “canon/canyo/cano”≈“caño”.
- Si el usuario dice “ítem 1 agregar 3” → plan: select_index(1) → set_qty(3) → add_to_cart().
- Si falta info (ítem ambiguo, sin índice ni nombre claro), devolvé un **ask** con la pregunta mínima.
- Para acciones críticas (p.ej. clear_cart, pay, confirm) usá **safe=false** si faltan precondiciones.
- Tu salida DEBE ser **EXCLUSIVAMENTE JSON** con el shape: {ok, normalized, nlu, resolution, confidence, actions, ask|null, say|null, reason|null, safe}.
- NO inventes item_code. Si el usuario nombró un ítem, devolvé `resolution` con item_code=null y item_query en slots para que un resolver externo elija.
- Nunca hables al usuario en texto fuera de `say`/`ask`. No uses Markdown.

Catálogo permitido (whitelist) vendrá en el INPUT.
Convenciones:
- Índices nombrados por el usuario son 1-based.
- “cantidad 3” fija cantidad sin agregar.
- “sumale 2”, “sacale 1” son deltas sobre el seleccionado.
- **“borrá el último del carrito” → remove_last_item().**
- **“borrá/sacá el N del carrito” → remove_from_cart({index:N}).**
- **“borrá/sacá <nombre> del carrito” → remove_from_cart({name:"<nombre>"}).**
- **add_to_cart requiere un ítem seleccionado (o select_index previo); si no, devolvé ask_user con la pregunta mínima.**
"""

FEWSHOTS = [
    {
        "role": "user",
        "content": """INPUT:
{"text":"modo factura","state":{"mode":"PRESUPUESTO","results":[],"selected_index":null,"qty_hint":1},"catalog":["set_mode","search","select_index","set_qty","add_to_cart","set_global_discount","set_customer","set_payment","confirm_document","clear_cart","repeat","ask_user"]}"""
    },
    {
        "role": "assistant",
        "content": """{"ok":true,"normalized":{"text":"modo factura","tokens":["modo","factura"]},"nlu":{"intent":"set_mode","slots":{"mode":"FACTURA"},"llm_confidence":0.92},"resolution":{"item_code":null,"candidates":[],"resolution_confidence":1.0},"confidence":0.92,"safe":true,"actions":[{"action":"set_mode","params":{"mode":"FACTURA"}}],"ask":null,"say":"Paso a modo FACTURA.","reason":"Instrucción directa."}"""
    },
    {
        "role": "user",
        "content": """INPUT:
{"text":"ítem 1 agregá tres","state":{"mode":"PRESUPUESTO","results":[{"index":1,"item_code":"X","item_name":"Caño 3/4"}],"selected_index":null,"qty_hint":1},"catalog":["set_mode","search","select_index","set_qty","add_to_cart","set_global_discount","set_customer","set_payment","confirm_document","clear_cart","repeat","ask_user"]}"""
    },
    {
        "role": "assistant",
        "content": """{"ok":true,"normalized":{"text":"item 1 agregar 3","tokens":["item","1","agregar","3"]},"nlu":{"intent":"add_to_cart","slots":{"item_index":1,"qty":3},"llm_confidence":0.88},"resolution":{"item_code":null,"candidates":[],"resolution_confidence":1.0},"confidence":0.88,"safe":true,"actions":[{"action":"select_index","params":{"index":1}},{"action":"set_qty","params":{"qty":3}},{"action":"add_to_cart","params":{}}],"ask":null,"say":"Agrego 3 del ítem 1.","reason":"Patrón ‘ítem N agregar Q’."}"""
    },
    {
        "role": "user",
        "content": """INPUT:
{"text":"cañon 20 mm poneme dos","state":{"mode":"PRESUPUESTO","results":[],"selected_index":null,"qty_hint":1},"catalog":["set_mode","search","select_index","set_qty","add_to_cart","set_global_discount","set_customer","set_payment","confirm_document","clear_cart","repeat","ask_user"]}"""
    },
    {
        "role": "assistant",
        "content": """{"ok":true,"normalized":{"text":"caño 20 mm pone 2","tokens":["caño","20","mm","pone","2"]},"nlu":{"intent":"search_then_add","slots":{"item_query":"caño 20 mm","qty":2},"llm_confidence":0.79},"resolution":{"item_code":null,"candidates":[],"resolution_confidence":0.5},"confidence":0.79,"safe":true,"actions":[{"action":"search","params":{"term":"caño 20 mm"}},{"action":"set_qty","params":{"qty":2}},{"action":"add_to_cart","params":{}}],"ask":null,"say":"Busco caño 20 mm y agrego 2.","reason":"Corrección de ASR ‘cañon’→‘caño’; búsqueda + agregado."}"""
    }
]


def _build_messages_es(user_payload: dict, allowed_actions: List[str], extra_rule: str = "") -> List[dict]:
    u = dict(user_payload)
    u["catalog"] = allowed_actions
    user_block = "INPUT:\n" + json.dumps(u, ensure_ascii=False)
    sys_prompt = BASE_SYSTEM_PROMPT + ("\n" + extra_rule if extra_rule else "")
    msgs = [{"role": "system", "content": sys_prompt}]
    msgs.extend(FEWSHOTS)
    msgs.append({"role": "user", "content": user_block})
    return msgs

# ========= LLM: interpretar texto → plan enriquecido =========
@app.post("/bridge/interpret")
def interpret(body: InterpretBody, request: Request = None):
    """
    Interpreta {text, state, catalog} y devuelve SOLO:
      {"actions":[{"action":"...", "params": {...}}, ...]}
    """
    # Prologue: trace + timer antes de cualquier excepción
    trace_id = getattr(request.state, "trace_id", None) if request else None
    t0 = time.time()

    if not OPENAI_API_KEY:
        # Ya tenemos trace_id/t0 seteados por si logueás más abajo
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY no configurada en .env")

    # Log de entrada (tolerante a formas raras de body)
    try:
        safe_catalog = body.catalog if isinstance(body.catalog, list) else str(type(body.catalog))
        safe_state = body.state or {}
        blog(
            "IN /bridge/interpret",
            trace_id,
            text=body.text,
            catalog=safe_catalog,
            results_len=len(safe_state.get("results") or []),
            selected_index=safe_state.get("selected_index"),
        )
    except Exception:
        pass

    # ↓↓↓ A partir de acá seguí con tu lógica (normalize, reglas deterministas, LLM, guardrails, etc.)




    # --- 1) Normalizar catálogo entrante a una whitelist ---
    def _normalize_catalog(cat) -> List[str]:
        allowed: set[str] = set()
        try:
            if isinstance(cat, dict):
                arr = cat.get("actions", [])
                if isinstance(arr, list):
                    for x in arr:
                        if isinstance(x, dict) and "action" in x:
                            allowed.add(str(x["action"]))
                        elif isinstance(x, str):
                            allowed.add(x)
            elif isinstance(cat, list):
                for x in cat:
                    if isinstance(x, dict) and "action" in x:
                        allowed.add(str(x["action"]))
                    elif isinstance(x, str):
                        allowed.add(x)
            elif isinstance(cat, str):
                for line in cat.splitlines():
                    m = re.search(r"-\s*([a-z_][a-z0-9_]*)\s*\(", line, re.I)
                    if m:
                        allowed.add(m.group(1))
        except Exception:
            pass
        if not allowed:
            allowed = {
                "set_mode","search","select_index","set_qty","add_to_cart",
                "set_global_discount","set_customer","set_payment",
                "confirm_document","clear_cart","repeat","ask_user",
                "remove_from_cart","remove_last_item",
            }
        return sorted(allowed)

    allowed_actions = _normalize_catalog(body.catalog)
    state = body.state or {}
    user_text = (body.text or "").strip()

    # ---- FAST-PATH determinista (genérico) ----
    fast = deterministic_fastpath(user_text, state, set(allowed_actions))
    if fast:
        try:
            logger.info("FAST_PATH %s -> %s", user_text, json.dumps(fast, ensure_ascii=False))
        except Exception:
            pass
        return {"actions": fast}

    # --- 2) Regla opcional: FACTURA sin pago -> pedir set_payment antes de confirm ---
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
            f"usando uno de: {json.dumps(mops, ensure_ascii=False)} y SOLO después confirm_document.\n"
        )

    # --- 3) Prompt del sistema ---
    whitelist_lines = "\n".join(
        f"- {a}()" if a in ("add_to_cart","confirm_document","clear_cart","repeat") else f"- {a}(...)" 
        for a in allowed_actions
    )
    system_prompt = f"""
Sos un PLANIFICADOR de acciones para una UI POS. Tu ÚNICA salida es JSON válido:
{{"actions":[{{"action":"<nombre>","params":{{...}}}} , ...]}}

Reglas:
- No hablás con el usuario y no devolvés texto libre ni Markdown, SOLO JSON con "actions".
- Usás EXCLUSIVAMENTE la whitelist (catálogo) que te doy.
- Si falta un dato, NO inventes: devolvé una única acción ask_user con la mínima pregunta necesaria.
- Entendés español coloquial (es-AR). Frases como “ítem 1 agregar 3”, “modo factura”, “cantidad 2”, “buscar caño 3/4” mapean a acciones.
- Índices que nombra el usuario son 1-based (1 = primer resultado).
- Si el modo es FACTURA y no hay pago seleccionado, primero set_payment({{mop, account?}}) y después confirm_document().

Whitelist permitida:
{whitelist_lines}

Convenciones:
- "results" viene numerado (index 1..N). Usalo para “ítem N”.
- "selected_index" puede venir null. Si agregan sin index, usá el seleccionado; si no hay, preguntá.
- "qty_hint" es la cantidad “global” si el usuario no dijo otra.
- Para “ítem 1 agregar 3”: select_index(1), set_qty(3), add_to_cart().
- Para “cantidad 3”: set_qty(3) (no agregues todavía).
- Para “agregar ítem”: add_to_cart() sobre el seleccionado; si no hay, preguntá.

Devolvé SIEMPRE un objeto JSON EXACTO con la forma {{"actions":[...]}}.
{extra_rule}
""".strip()

    # --- 4) Few-shots mínimos ---
    fewshots = [
        {
            "role": "user",
            "content": 'INPUT:\n{"text":"modo factura","state":{"mode":"PRESUPUESTO","results":[],"selected_index":null,"qty_hint":1}}'
        },
        {"role":"assistant","content":'{"actions":[{"action":"set_mode","params":{"mode":"FACTURA"}}]}'},
        {
            "role": "user",
            "content": 'INPUT:\n{"text":"ítem 1 agregar 3","state":{"mode":"PRESUPUESTO","results":[{"index":1,"item_code":"X","item_name":"Caño 3/4"}],"selected_index":null,"qty_hint":1}}'
        },
        {"role":"assistant","content":'{"actions":[{"action":"select_index","params":{"index":1}},{"action":"set_qty","params":{"qty":3}},{"action":"add_to_cart","params":{}}]}'},
        {
            "role": "user",
            "content": 'INPUT:\n{"text":"borrá el último del carrito","state":{"cart":[{"item_code":"X","qty":1}],"results":[],"selected_index":null,"qty_hint":1},"catalog":'+json.dumps(allowed_actions, ensure_ascii=False)+'}'
        },
        {"role":"assistant","content":'{"actions":[{"action":"remove_last_item","params":{}}]}'},
        # borrar por índice del carrito
        {
            "role": "user",
            "content": 'INPUT:\n{"text":"sacá el tercero del carrito","state":{"cart":[{"item_code":"A"},{"item_code":"B"},{"item_code":"C"}],"results":[],"selected_index":null,"qty_hint":1},"catalog":'+json.dumps(allowed_actions, ensure_ascii=False)+'}'
        },
        {"role":"assistant","content":'{"actions":[{"action":"remove_from_cart","params":{"index":3}}]}'},
    ]

    payload_user = {"text": user_text, "state": state, "catalog": allowed_actions}
    messages = [{"role":"system","content":system_prompt}]
    messages.extend(fewshots)
    messages.append({"role":"user","content":"INPUT:\n"+json.dumps(payload_user, ensure_ascii=False)})

    # === fingerprint para auditar cambios de prompt/modelo ===
    prompt_fp = hashlib.sha256(system_prompt.encode("utf-8")).hexdigest()[:8]
    try:
        logger.info("PROMPT_FP=%s MODEL=%s", prompt_fp, LLM_MODEL)
    except Exception:
        pass

    # --- 5) Schema y request ---
    response_schema = {
        "type": "json_schema",
        "json_schema": {
            "name": "planner_actions",
            "schema": {
                "type": "object",
                "properties": {
                    "actions": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "action": {"type": "string"},
                                "params": {"type": "object"},
                            },
                            "required": ["action"],
                            "additionalProperties": True
                        }
                    }
                },
                "required": ["actions"],
                "additionalProperties": False
            }
        }
    }

    req = {
        "model": LLM_MODEL,
        "temperature": 0,
        "top_p": 0,
        "seed": 7,
        "n": 1,
        "max_tokens": 120,
        "response_format": response_schema,
        "messages": messages,
    }

    try:
        logger.info("REQUEST %s", json.dumps({"text": user_text, "state": state, "catalog": allowed_actions}, ensure_ascii=False))
    except Exception:
        pass

    # --- 6) Llamado al modelo ---
    try:
        r = requests.post(
            "https://api.openai.com/v1/chat/completions",
            headers={"Authorization": f"Bearer {OPENAI_API_KEY}", "Content-Type": "application/json"},
            data=json.dumps(req),
            timeout=30,
        )
        r.raise_for_status()
        content = (r.json().get("choices",[{}])[0].get("message",{}) or {}).get("content") or "{}"
        logger.info("RAW_RESPONSE %s", content)
        parsed = json.loads(content)
        candidate_actions = parsed.get("actions", [])
        if not isinstance(candidate_actions, list):
            candidate_actions = []
    except Exception as e:
        logger.error("LLM_ERROR %s", repr(e))
        return {"actions":[{"action":"search","params":{"term": user_text}}]}

        # --- 7) Guardrails centralizados: de candidatos -> safe_actions ---
    try:
        safe_actions = apply_guardrails(
            user_text=user_text,
            state=state,
            allowed_actions=allowed_actions,
            candidate_actions=candidate_actions,
        )
        if not isinstance(safe_actions, list):
            safe_actions = []
    except Exception as _e:
        # Fallback: quedate con acciones válidas de la whitelist y params serializables
        safe_actions = []
        for a in (candidate_actions or []):
            try:
                if not isinstance(a, dict):
                    continue
                name = a.get("action")
                if not isinstance(name, str) or name not in allowed_actions:
                    continue
                params = a.get("params") or {}
                # serializar params (defensivo)
                json.dumps(params, ensure_ascii=False)
                safe_actions.append({"action": name, "params": params})
            except Exception:
                continue


       # --- 7.1) Coherencia final (A4) ---
    # a) FACTURA sin pagos → no confirmar; pedir modo de pago primero
    need_payment_first = (str(state.get("mode", "")).upper() == "FACTURA" and not state.get("payments"))
    if need_payment_first and any(a.get("action") == "confirm_document" for a in safe_actions):
        safe_actions = [a for a in safe_actions if a.get("action") != "confirm_document"]
        if not any(a.get("action") == "set_payment" for a in safe_actions):
            safe_actions.insert(0, {
                "action": "ask_user",
                "params": {"question": "¿Cómo vas a pagar? Indicá el modo de pago (efectivo, débito, crédito, transferencia, QR)."}
            })

    # b) Normalizar orden típico: select_index → set_qty → add_to_cart
    order = {"select_index": 10, "set_qty": 20, "add_to_cart": 30}
    def _key(a): return (order.get(a.get("action"), 50),)
    # si hay las 3, las reordenamos manteniendo el resto
    trio = [a for a in safe_actions if a.get("action") in order]
    others = [a for a in safe_actions if a.get("action") not in order]
    if trio:
        trio_sorted = sorted(trio, key=_key)
        safe_actions = trio_sorted + others

    # c) Deduplicar acciones exactas preservando orden
    seen = set()
    deduped = []
    for a in safe_actions:
        k = json.dumps(a, sort_keys=True, ensure_ascii=False)
        if k not in seen:
            deduped.append(a)
            seen.add(k)
    safe_actions = deduped

    # --- 8) Log + Salida ---
    try:
        blog(
            "OUT /bridge/interpret",
            trace_id,
            actions=safe_actions,
            dt_ms=round((time.time() - t0) * 1000, 1),
        )
    except Exception:
        pass

    return {"actions": safe_actions}

    


# ========= NUEVO: endpoints unificados con stock =========
@app.get("/nlu/aliases")
def nlu_aliases():
    return {
        "brands": BRAND_ALIASES,  # normalizado -> canónico ERP
        "tags": TAG_ALIASES       # normalizado -> canónico
    }




# ======= SEARCH WITH STOCK (motor único, tolerante y unificado) =======

@app.post("/bridge/search_with_stock")
def search_with_stock(payload: dict = Body(...), request: Request = None):

    """
    Búsqueda central con NLU + compatibilidad hacia atrás.
    - Acepta: {q|query|search_term}, {limit|page_length}, {page|start}, {brand|marca}, {uom},
              {filters:{...}}, opcional {applied_filters:{...}} (se mergea con filters)
    - NLU: nombre + medida (mm/in/fracción) + brands[] + tags[]
    - Intenta múltiples términos ERP (laxo → estricto)
    - Re-filtra localmente por medida/nombre/marca/tags y (NUEVO) atributos ERP (Item Variant Attribute)
    - Merge de stock por Bin
    - Devuelve v2: { ok, term, term_raw, count, message[], items[], index_map[],
                     meta:{tried_terms[]},
                     applied_filters: {name,size_mm,size_in,unit_pref,brands[],tags[], attributes?} }
    """
    if not AUTH_HEADER:
        raise HTTPException(status_code=500, detail="ERP auth no configurada.")
    trace_id = getattr(request.state, "trace_id", None)
    t0 = time.time()


    # ---------------- Helpers locales ----------------
    STOPWORDS_ES = {
        "de","del","la","el","los","las","un","una","unos","unas","y","o","a","en","por","para",
        "porfavor","favor","porf","ahora","mostrame","mostrar","muestrame","quiero","busca","buscar","buscame","buscá",
        "hay","algun","alguna","algunas","algunos","porfa","porfis","esto","eso","estos","esas","esos","aca","aqui","allí","alli",
        "por","favor"
    }

    def _strip_accents_lower(s: str) -> str:
        if not s:
            return ""
        t = unicodedata.normalize("NFD", s)
        t = "".join(ch for ch in t if unicodedata.category(ch) != "Mn")
        t = t.lower()
        return re.sub(r"\s+", " ", t).strip()

    def _normalize_units(text: str) -> str:
        x = text
        x = re.sub(r"\b(milimetros?|milímetros?)\b", "mm", x)
        x = re.sub(r"\b(tres\s+cuartos)\b", " 3/4 ", x)
        x = re.sub(r"\b(un\s+cuarto)\b", " 1/4 ", x)
        x = re.sub(r"\b(media|medio)\s+pulg(adas?)?\b", " 1/2 in ", x)
        return x

    def _singularize_token(t: str) -> str:
        if not t or t.isdigit(): return t
        EX = {"mm","cm","m","in","ips","rowajet"}
        if t in EX: return t
        if len(t) > 4 and t.endswith("es"): return t[:-2]
        if len(t) > 3 and t.endswith("s"):  return t[:-1]
        return t

    def _tokenize_q(q: str) -> tuple[str, list[str]]:
        q0 = _strip_accents_lower(q)
        q1 = _normalize_units(q0)
        q1 = re.sub(r'[^a-z0-9/.\s"-]', " ", q1)
        q1 = re.sub(r"\s+", " ", q1).strip()
        raw_tokens = [t for t in q1.split(" ") if t]
        toks = [_singularize_token(t) for t in raw_tokens if t not in STOPWORDS_ES]
        return q1, toks

    def _require_match(tokens: list[str], text_norm: str) -> bool:
        if not tokens: return True
        k = 1 if len(tokens) == 1 else 2
        hits = sum(1 for t in tokens if t and t in text_norm)
        return hits >= k

    def _split_brand_terms(v) -> list[str]:
        return [b.strip() for b in (v or "").split(",") if b and b.strip()]

    # ---------------- Entrada ----------------
    term_raw = (payload.get("query") or payload.get("q") or payload.get("search_term") or "").strip()
    if not term_raw:
        raise HTTPException(status_code=422, detail="Falta 'query'/'q'/'search_term'.")

    pos_profile = payload.get("pos_profile") or DEFAULTS["pos_profile"]
    warehouse   = payload.get("warehouse")    or DEFAULTS["warehouse"]

    limit = int(payload.get("limit") or payload.get("page_length") or 20)
    page  = int(payload.get("page")  or 1)
    if "start" in payload and payload["start"] is not None:
        try:
            start = int(payload["start"])
            page = (start // max(limit, 1)) + 1
        except Exception:
            pass

    # legacy params
    brand_param = payload.get("brand") or payload.get("marca")
    uom_param   = payload.get("uom")

    # NLU params
    incoming_filters: Dict[str, Any] = payload.get("filters") or {}
    if not isinstance(incoming_filters, dict):
        incoming_filters = {}

    # (Opcional) soportar applied_filters desde el cliente y mergear con filters
    applied_filters_in = payload.get("applied_filters") or {}
    if isinstance(applied_filters_in, dict):
        # attributes (dict)
        attrs_in = applied_filters_in.get("attributes")
        if isinstance(attrs_in, dict):
            base_attrs = incoming_filters.get("attributes")
            if not isinstance(base_attrs, dict):
                base_attrs = {}
            base_attrs.update(attrs_in)
            incoming_filters["attributes"] = base_attrs
        # brands / brand
        if isinstance(applied_filters_in.get("brands"), list):
            incoming_filters["brands"] = list(set((incoming_filters.get("brands") or []) + applied_filters_in["brands"]))
        if isinstance(applied_filters_in.get("brand"), list):  # compat
            incoming_filters["brands"] = list(set((incoming_filters.get("brands") or []) + applied_filters_in["brand"]))
        # name/size/unit/tags si vinieron explícitos
        for k in ("name", "size_mm", "size_in", "unit_pref", "tags"):
            if k in applied_filters_in and incoming_filters.get(k) is None:
                incoming_filters[k] = applied_filters_in[k]

    # ---------------- Parse NLU y merge de filtros ----------------
    parsed = parse_filters_from_query(term_raw)  # {filters:{...}, term:"..."}
    filters = {**parsed["filters"], **incoming_filters}  # payload pisa a lo inferido

    # Unificá marcas: legacy (brand|marca) + NLU (brands[])
    legacy_brands = set(_split_brand_terms(brand_param))
    nlu_brands    = set(filters.get("brands") or [])
    brands_all    = list(legacy_brands.union(nlu_brands))
    filters["brands"] = brands_all

    # Término compacto (para logging/UI)
    compact_term = parsed["term"] or (filters.get("name") or "")
    if filters.get("size_mm") and filters.get("name"):
        v = filters["size_mm"]
        v = int(v) if float(v).is_integer() else v
        compact_term = f'{filters["name"]} {v}mm'

    # ---------------- Candidatos ERP (de laxo a estricto) ----------------
    name = filters.get("name")
    size_mm = filters.get("size_mm")
    first_brand = (brands_all[0] if brands_all else "").strip()

    def _mm_int_or_str(v):
        return int(v) if (isinstance(v, (int, float)) and float(v).is_integer()) else v

    # helper nominal: pulgadas → mm comerciales (plástico/agua)
    def _inch_to_nominal_mm(x: float | None) -> int | None:
        if x is None:
            return None
        # redondeo por si vino 0.5 como 0.50
        x = round(float(x), 3)
        table = {
            0.25: 16,   # 1/4" ≈ 16 mm (a veces 13–16; elegimos 16 que es común)
            0.5:  20,   # 1/2" → 20 mm
            0.75: 25,   # 3/4" → 25 mm
            1.0:  32,   # 1"   → 32 mm
            1.25: 40,   # 1 1/4" → 40 mm
            1.5:  50,   # 1 1/2" → 50 mm
            2.0:  63,   # 2"   → 63 mm
            2.5:  75,   # 2 1/2" → 75 mm
            3.0:  90,   # 3"   → 90 mm
        }
        return table.get(x)
    
    size_in = filters.get("size_in")
    size_mm_from_in = _inch_to_nominal_mm(float(size_in)) if size_in not in (None, "", 0) else None
    
    
    candidates: List[str] = []
    
    # preferimos armar términos “que entiende el ERP”
    first_brand = (brands_all[0] if brands_all else "").strip()
    name = filters.get("name")
    size_mm = filters.get("size_mm")
    size_mm_eff = size_mm or size_mm_from_in  # 👈 usamos el mm derivado de pulgadas si hace falta
    
    if name and size_mm_eff and first_brand:
        v = _mm_int_or_str(size_mm_eff)
        candidates += [f"{name} {v} {first_brand}", f"{name} {v}mm {first_brand}"]
    if name and size_mm_eff:
        v = _mm_int_or_str(size_mm_eff)
        candidates += [f"{name} {v}", f"{name} {v} mm", f"{name} {v}mm"]
    if name and first_brand:
        candidates += [f"{name} {first_brand}", f"{first_brand} {name}"]
    # si hay sólo pulgadas y ningún mm mapeado, igualmente probamos literal (por las dudas)
    if name and size_in and not size_mm_eff:
        candidates += [f'{name} {size_in}"', f"{name} {size_in} in"]
    
    if compact_term:
        candidates += [compact_term]
    candidates += [term_raw]  # literal del usuario
    
    # dedup manteniendo orden
    seen_c = set()
    erp_terms = [t for t in candidates if not (t in seen_c or seen_c.add(t))]
    
        # ---------------- Caché ----------------
    # Incluir atributos en la clave de caché (si vienen)
    attrs_req = filters.get("attributes")
    if isinstance(attrs_req, dict) and attrs_req:
        # clave determinística: lista ordenada de (attr, valor) como tuplas de str
        attrs_key = tuple(sorted((str(k), str(v)) for k, v in attrs_req.items()))
    else:
        attrs_key = None

    # ---------------- Caché ----------------
    cache_key_hint = (name, size_mm, tuple(brands_all), uom_param, attrs_key)
    ckey = _ck("search_with_stock_v9", cache_key_hint, pos_profile, warehouse, limit, page)  # bump key
    cached = _cache_get(ckey)

    if cached is not None:
        return cached

    # ---------------- Consulta ERP ----------------
    tried_terms: List[str] = []
    items: List[Dict[str, Any]] = []
    used_term = None

    for t in erp_terms:
        tried_terms.append(t)
        batch = pos_get_items(t, pos_profile, limit, page) or []
        if batch:
            seen_codes = set()
            merged_once = []
            for it in items + batch:
                code_key = (it.get("item_code") or it.get("name") or "").strip()
                if not code_key or code_key in seen_codes:
                    continue
                seen_codes.add(code_key)
                merged_once.append(it)
            items = merged_once
            used_term = t
            if len(items) >= max(3, limit // 2):
                break

    if used_term is None:
        used_term = erp_terms[0] if erp_terms else term_raw
        applied_filters_out = {
            "name": filters.get("name"),
            "size_mm": filters.get("size_mm"),
            "size_in": filters.get("size_in"),
            "unit_pref": filters.get("unit_pref"),
            "brands": filters.get("brands") or [],
            "tags": filters.get("tags") or [],
        }
        attrs = filters.get("attributes")
        if isinstance(attrs, dict) and attrs:
            applied_filters_out["attributes"] = attrs  # eco para chips

        out = {
            "ok": True,
            "term": used_term,
            "term_raw": term_raw,
            "count": 0,
            "message": [],
            "items": [],
            "index_map": [],
            "meta": {"tried_terms": tried_terms},
            "applied_filters": applied_filters_out,
        }
        _cache_set(ckey, out)
        return out

    # ---------------- Re-filtro local (name/brand/mm/tags) ----------------
    def _name_text(item: Dict[str, Any]) -> str:
        name = (item.get("item_name","") or "")
        desc = (item.get("description","") or "")
        joined = f"{name} {desc}"
        return unicodedata.normalize("NFD", joined).encode("ascii","ignore").decode().lower()

    def _mm_ok(name_l: str) -> bool:
        if not filters.get("size_mm"):
            return True
        v = filters["size_mm"]
        v = int(v) if float(v).is_integer() else v
        pat = rf"(\b|[^0-9]){v}\s*mm\b"
        return re.search(pat, name_l) is not None

    want_uoms   = set(normalize_uom(u) for u in _split_brand_terms(uom_param))
    want_brands = set((b or "").strip().lower() for b in (filters.get("brands") or []))
    req_name_norm = _strip_accents_lower(filters.get("name") or "")
    tags_req_norm = { _strip_accents_lower(t) for t in (filters.get("tags") or []) }

    _filtered: List[Dict[str, Any]] = []
    for it in items:
        name_l = _name_text(it)                          # ascii + lower
        iuom   = normalize_uom(it.get("stock_uom") or it.get("uom") or "")
        ibrand = (it.get("brand") or "").strip().lower()

        ok_uom   = True if not want_uoms   else (iuom in want_uoms)
        ok_brand = True if not want_brands else ((ibrand and (ibrand in want_brands)) or any(b in name_l for b in want_brands))
        ok_name  = True 
        ok_mm    = True
        ok_tags  = True if not tags_req_norm else all(t in name_l for t in tags_req_norm)

        if ok_uom and ok_brand and ok_tags:
            _filtered.append(it)
        

    items = _filtered

    # ---------------- Filtro por ATTRIBUTES (real + fallback textual) ----------------
    attrs_req = filters.get("attributes")
    if isinstance(attrs_req, dict) and attrs_req:
        # Helpers de normalización / patrones
        def _norm_txt(s: str) -> str:
            if not s: return ""
            t = unicodedata.normalize("NFD", s)
            t = "".join(ch for ch in t if unicodedata.category(ch) != "Mn")
            return re.sub(r"\s+", " ", t).strip().lower()

        def _size_patterns(v: str) -> list[str]:
            """Genera variantes textuales comunes: '20 mm', '20mm', '3/4"', '0.75 in', etc."""
            v0 = (v or "").strip().lower()
            pats = set()
            m_mm = re.match(r"^\s*(\d+(?:[.,]\d+)?)\s*mm\s*$", v0)
            if m_mm:
                n = m_mm.group(1).replace(",", ".")
                n_int = str(int(float(n))) if float(n).is_integer() else n
                pats.update([f"{n_int} mm", f"{n_int}mm", f"{n} mm", f"{n}mm"])
                return list(pats)
            m_frac = re.match(r'^\s*(\d+)\s*/\s*(\d+)\s*(?:in|")?\s*$', v0)
            if m_frac:
                nn = f"{m_frac.group(1)}/{m_frac.group(2)}"
                pats.update([f'{nn}"', f'{nn} "', f"{nn}in", f"{nn} in", nn])
                return list(pats)
            m_in = re.match(r"^\s*(\d+(?:[.,]\d+)?)\s*in\s*$", v0)
            if m_in:
                n = m_in.group(1).replace(",", ".")
                pats.update([f'{n} in', f'{n}"', n])
                return list(pats)
            pats.update([v0, v0.replace("  ", " "), v0.replace(" ", "")])
            return list(pats)

                # 1) bulk fetch de Item Variant Attribute (si existen variantes)
        def _fetch_variant_attrs_bulk(codes: list[str]) -> dict[str, dict[str, str]]:
            if not codes:
                return {}
            url = f"{ERP_BASE}/api/resource/Item Variant Attribute"
            params = {
                "fields": '["parent","attribute","attribute_value"]',
                "filters": json.dumps([["parent","in", codes]]),
                "limit_page_length": 10000,
            }
            rv = requests.get(url, headers=_ensure_headers(AUTH_HEADER), params=params, timeout=15)
            rv.raise_for_status()
            rows = rv.json().get("data", [])
            out: dict[str, dict[str, str]] = {}
            for row in rows:
                p = row.get("parent")
                a = row.get("attribute")
                v = row.get("attribute_value")
                if not p or not a:
                    continue
                out.setdefault(p, {})[a] = v
            return out

        codes = [(it.get("item_code") or it.get("name")) for it in items if (it.get("item_code") or it.get("name"))]
        try:
            attr_map = _fetch_variant_attrs_bulk(codes)
        except Exception:
            attr_map = {}  # sin permisos o sin variants → fallback textual

        def _match_attrs(it: dict) -> bool:
            code = (it.get("item_code") or it.get("name") or "")
            name = (it.get("item_name") or it.get("name") or "")
            desc = (it.get("description") or "")
            text_norm = _norm_txt(f"{name} {desc}")
            have = attr_map.get(code) or {}

            for k, v in attrs_req.items():
                if v is None:
                    continue
                # Si el atributo existe en ERP (modo real)
                if have:
                    hv = have.get(k)
                    if hv is not None:
                        if _norm_txt(str(hv)) != _norm_txt(str(v)):
                            return False
                        else:
                            continue  # este k pasó por ERP
                # Fallback textual
                if str(k).lower() == "size":
                    patterns = _size_patterns(str(v))
                    if not any(pat in text_norm for pat in patterns):
                        return False
                else:
                    if _norm_txt(str(v)) not in text_norm:
                        return False
            return True

        items = [it for it in items if _match_attrs(it)]

    # ---------------- Merge stock por Bin ----------------
    codes = [i.get("item_code") or i.get("name") for i in items if (i.get("item_code") or i.get("name"))]
    stock_map = bin_qty_bulk(codes, warehouse)

    merged: List[Dict[str, Any]] = []
    for it in items:
        code = it.get("item_code") or it.get("name")
        it2 = dict(it)
        if code:
            it2["actual_qty"] = stock_map.get(code, it.get("actual_qty", 0))
        merged.append(it2)

    # ---------------- Ranking (size-first, laxo con nombres) ----------------
    def _inch_to_nominal_mm(x: float | None) -> int | None:
        if x is None:
            return None
        x = round(float(x), 3)
        table = {
            0.25: 16,  # 1/4"
            0.5:  20,  # 1/2"
            0.75: 25,  # 3/4"
            1.0:  32,  # 1"
            1.25: 40,  # 1 1/4"
            1.5:  50,  # 1 1/2"
            2.0:  63,  # 2"
            2.5:  75,  # 2 1/2"
            3.0:  90,  # 3"
        }
        return table.get(x)

    def _size_patterns_from_filters(flt: dict) -> list[str]:
        pats: set[str] = set()
        # mm directos o derivados de pulgadas
        size_mm_eff = flt.get("size_mm")
        if size_mm_eff in (None, "", 0):
            si = flt.get("size_in")
            try:
                si = float(si) if si not in (None, "", 0) else None
            except Exception:
                si = None
            size_mm_eff = _inch_to_nominal_mm(si) if si is not None else None

        if size_mm_eff not in (None, "", 0):
            v = size_mm_eff
            try:
                v_int = int(v) if float(v).is_integer() else v
            except Exception:
                v_int = v
            pats.update({f"{v_int} mm", f"{v_int}mm", f"{v} mm", f"{v}mm"})

        # variantes textuales por pulgadas si vienen
        si = flt.get("size_in")
        try:
            si = float(si) if si not in (None, "", 0) else None
        except Exception:
            si = None
        if si is not None:
            # fracciones clásicas si matchea 0.25 / 0.5 / 0.75
            frac_map = {0.25: "1/4", 0.5: "1/2", 0.75: "3/4"}
            if si in frac_map:
                nn = frac_map[si]
                pats.update({nn, f'{nn}"', f"{nn} in", f"{nn}in"})
            # decimales
            s = str(si).rstrip("0").rstrip(".") if isinstance(si, float) else str(si)
            pats.update({s, f'{s}"', f"{s} in", f"{s}in"})
        return [p.lower() for p in pats if p]

    size_pats = _size_patterns_from_filters(filters)

    # tokens del término usado (por si no hay size; más laxo)
    q_phrase, q_tokens = _tokenize_q(used_term or "")
    def _tokens_lax_ok(tokens: list[str], text_norm: str) -> bool:
        if not tokens:
            return True
        return any(t for t in tokens if t and t in text_norm)

    ranked: List[Dict[str, Any]] = []
    for it in merged:
        name  = it.get("item_name") or it.get("name") or ""
        code  = it.get("item_code") or it.get("name") or ""
        brand = it.get("brand") or ""
        desc  = it.get("description") or ""
        stock = float(it.get("actual_qty") or 0)

        n_name  = _strip_accents_lower(name)
        n_code  = _strip_accents_lower(code)
        n_brand = _strip_accents_lower(brand)
        n_desc  = _strip_accents_lower(desc)
        combined = "  ".join([n_name, n_code, n_brand, n_desc])

        # 1) Si hay medida, la medida es condición necesaria (cualquier variante)
        if size_pats:
            if not any(pat in combined for pat in size_pats):
                continue
        # 2) Si NO hay medida, pedimos al menos un token (laxo)
        else:
            if not _tokens_lax_ok(q_tokens, combined):
                continue

        # Scoring
        score = 0.0
        if size_pats:
            score += min(3.0, sum(1.0 for pat in size_pats if pat in combined))  # medida fuerte

        if q_phrase and q_phrase in n_name: score += 1.2
        if q_phrase and q_phrase in n_code: score += 1.0

        score += sum(1 for t in q_tokens if t in n_name)  * 0.8
        score += sum(1 for t in q_tokens if t in n_code)  * 0.7
        score += sum(1 for t in q_tokens if t in n_brand) * 0.4
        score += sum(1 for t in q_tokens if t in n_desc)  * 0.3

        if stock > 0: score += 1.0

        hit_fields = []
        if size_pats and any(p in n_name for p in size_pats):  hit_fields.append("size:name")
        if size_pats and any(p in n_desc for p in size_pats):  hit_fields.append("size:desc")
        if any(t in n_name for t in q_tokens):                 hit_fields.append("name")
        if any(t in n_code for t in q_tokens):                 hit_fields.append("code")
        if any(t in n_brand for t in q_tokens):                hit_fields.append("brand")
        if any(t in n_desc for t in q_tokens):                 hit_fields.append("desc")

        ranked.append({"_score": score, "_hit_fields": hit_fields, **it})

    ranked.sort(key=lambda x: x["_score"], reverse=True)

    # ---------------- Salida ----------------
    items_norm: List[dict] = []
    index_map:  List[dict] = []
    for i, it in enumerate(ranked[:limit], start=1):
        code = it.get("item_code") or it.get("name")
        items_norm.append({
            "index": i,
            "code": code,
            "name": it.get("item_name") or it.get("name") or it.get("description"),
            "uom": it.get("stock_uom") or it.get("uom") or "Nos",
            "rate": (it.get("price_list_rate") or it.get("rate") or 0) or 0,
            "qty":  (it.get("actual_qty") or 0) or 0,
            "group": it.get("item_group"),
            "brand": it.get("brand"),
            "desc": it.get("description"),
            "hit_fields": it.get("_hit_fields", []),
            "terms": q_tokens,
        })
        index_map.append({"index": i, "item_code": code})

    message = []
    for it in ranked[:limit]:
        it = dict(it)
        it.pop("_score", None)
        it.pop("_hit_fields", None)
        message.append(it)

    applied_filters_out = {
        "name": filters.get("name"),
        "size_mm": filters.get("size_mm"),
        "size_in": filters.get("size_in"),
        "unit_pref": filters.get("unit_pref"),
        "brands": filters.get("brands") or [],
        "tags": filters.get("tags") or [],
    }
    attrs = filters.get("attributes")
    if isinstance(attrs, dict) and attrs:
        applied_filters_out["attributes"] = attrs  # chips

    out = {
        "ok": True,
        "term": used_term,
        "term_raw": term_raw,
        "count": len(message),
        "message": message,
        "items": items_norm,
        "index_map": index_map,
        "meta": {"tried_terms": tried_terms},
        "applied_filters": applied_filters_out,
    }

    # === LOG OUT ===
    try:
        blog(
            "OUT /bridge/search_with_stock",
            trace_id,
            term_raw=term_raw,
            used_term=used_term,
            count=len(message),
            tried_terms=tried_terms,
            filters=applied_filters_out,
            dt_ms=round((time.time() - t0) * 1000, 1),
        )
    except Exception:
        pass

    # === ECO OPCIONAL (para front / diagnóstico) ===
    out["echo"] = {
        "trace_id": trace_id,
        "used_term": used_term,
        "dt_ms": round((time.time() - t0) * 1000, 1),
    }

    _cache_set(ckey, out)
    return out



# ============================================================
# BRANDS ENDPOINT
# ============================================================

import time, unicodedata, re

# Cache simple en memoria
_BRANDS_CACHE = {"ts": 0.0, "ttl": 12*3600, "data": None}  # 12 horas

def _slug(s: str) -> str:
    s = unicodedata.normalize("NFD", s)
    s = "".join(ch for ch in s if unicodedata.category(ch) != "Mn")  # sin acentos
    s = s.lower().strip()
    s = re.sub(r"[^a-z0-9\s]+", " ", s)
    s = re.sub(r"\s+", " ", s)
    return s

def _build_alias_map(brands: list[str]) -> dict[str, str]:
    """
    Genera alias básicos:
      - slug con espacios: 'aqua system' -> 'Aqua System'
      - slug sin espacios: 'aquasystem'  -> 'Aqua System'
    """
    alias = {}
    for b in brands:
        slug = _slug(b)
        alias[slug] = b
        alias[slug.replace(" ", "")] = b
    return alias

async def _fetch_brands_from_erp() -> list[str]:
    url = f"{ERP_BASE}/api/resource/Brand"
    params = {
        "fields": '["name"]',
        "limit_page_length": 1000,
        "order_by": "modified desc"
    }
    r = requests.get(url, headers=_ensure_headers(AUTH_HEADER), params=params, timeout=15)
    r.raise_for_status()
    data = r.json().get("data", [])
    names = [row.get("name", "").strip() for row in data if row.get("name")]
    # únicos preservando orden
    seen, uniq = set(), []
    for n in names:
        if n not in seen:
            uniq.append(n)
            seen.add(n)
    return uniq


async def _get_brands(refresh: bool = False) -> dict:
    now = time.time()
    if (not refresh) and _BRANDS_CACHE["data"] and (now - _BRANDS_CACHE["ts"] < _BRANDS_CACHE["ttl"]):
        return _BRANDS_CACHE["data"]

    brands = await _fetch_brands_from_erp()
    alias = _build_alias_map(brands)
    payload = {"ok": True, "brands": brands, "aliases": alias, "count": len(brands)}
    _BRANDS_CACHE["data"] = payload
    _BRANDS_CACHE["ts"] = now
    return payload

@app.get("/bridge/brands")
async def bridge_get_brands(refresh: bool = False):
    """
    Devuelve todas las marcas activas del ERP.
    Ejemplo de respuesta:
      {
        "ok": true,
        "brands": ["Tigre","Aquaplas","IPS"],
        "aliases": {"tigre":"Tigre","aquaplas":"Aquaplas","ips":"IPS"},
        "count": 3
      }
    """
    try:
        return await _get_brands(refresh=refresh)
    except Exception as e:
        return {"ok": False, "error": str(e)}

# ============================================================
# ATTRIBUTES ENDPOINT
# ============================================================

from urllib.parse import quote  # <-- agregado para URL-encode del nombre

_ATTRIBUTES_CACHE = {"ts": 0.0, "ttl": 12*3600, "data": None}  # 12 horas

async def _fetch_attributes_from_erp(names: list[str] | None = None) -> dict:
    """Devuelve atributos y sus valores desde ERPNext."""
    result = {}

    # 1) Lista de atributos (Item Attribute)
    url_attr = f"{ERP_BASE}/api/resource/Item Attribute"
    params = {
        "fields": '["name"]',
        "limit_page_length": 1000,
        "order_by": "modified desc",
    }
    r = requests.get(url_attr, headers=_ensure_headers(AUTH_HEADER), params=params, timeout=15)
    r.raise_for_status()
    attrs = [row["name"] for row in r.json().get("data", []) if row.get("name")]

    if names:
        # Filtrado por lista proveída en query
        attrs = [a for a in attrs if a in names]

    # 2) Para cada atributo, leer el DOC PADRE con expand=1 (incluye item_attribute_values)
    for attr in attrs:
        url_doc = f"{ERP_BASE}/api/resource/Item Attribute/{quote(attr)}"
        params_doc = {
            "fields": '["name","numeric_values","from_range","to_range","increment","uom","item_attribute_values"]',
            "expand": 1,  # <-- clave para traer el child table embebido
        }
        rd = requests.get(url_doc, headers=_ensure_headers(AUTH_HEADER), params=params_doc, timeout=15)
        rd.raise_for_status()
        doc = rd.json().get("data", {}) or {}

        # Extraer valores únicos preservando orden
        vals = []
        for row in (doc.get("item_attribute_values") or []):
            v = row.get("attribute_value")
            if v:
                vals.append(str(v).strip())

        seen, uniq = set(), []
        for v in vals:
            if v not in seen:
                uniq.append(v)
                seen.add(v)

        result[attr] = uniq

    return result

async def _get_attributes(names: list[str] | None = None, refresh: bool = False) -> dict:
    now = time.time()
    cache_ok = (
        (not refresh)
        and _ATTRIBUTES_CACHE["data"] is not None
        and (now - _ATTRIBUTES_CACHE["ts"] < _ATTRIBUTES_CACHE["ttl"])
    )
    if cache_ok:
        # Si pidieron una lista de nombres, devolvemos sólo ese subset del cache
        if names:
            full = _ATTRIBUTES_CACHE["data"]["attributes"]
            subset = {k: v for k, v in full.items() if k in names}
            return {"ok": True, "attributes": subset, "count": sum(len(v) for v in subset.values())}
        return _ATTRIBUTES_CACHE["data"]

    data = await _fetch_attributes_from_erp(names=None)  # cachea TODO
    payload_all = {"ok": True, "attributes": data, "count": sum(len(v) for v in data.values())}
    _ATTRIBUTES_CACHE["data"] = payload_all
    _ATTRIBUTES_CACHE["ts"] = now

    if names:
        subset = {k: v for k, v in data.items() if k in names}
        return {"ok": True, "attributes": subset, "count": sum(len(v) for v in subset.values())}
    return payload_all

@app.get("/bridge/attributes")
async def bridge_get_attributes(names: str | None = None, refresh: bool = False):
    """
    Devuelve atributos y valores desde ERP.
    Query:
      ?names=Diametro,Rosca   (opcional, filtra por nombres)
      &refresh=1              (opcional, fuerza refetch global)
    """
    try:
        names_list = [n.strip() for n in names.split(",")] if names else None
        return await _get_attributes(names=names_list, refresh=refresh)
    except Exception as e:
        return {"ok": False, "error": str(e)}

# ========= Alias /bridge/search (reusa el motor único) =========
@app.post("/bridge/search")
def search_items_alias(body: dict = Body(...)):
    return search_with_stock(body)



@app.get("/bridge/health")
def health():
    return {"ok": True, "warehouse": DEFAULTS.get("warehouse"), "pos_profile": DEFAULTS.get("pos_profile")}


@app.post("/bridge/codes_with_stock")
def codes_with_stock(payload: SearchByCodes):
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
