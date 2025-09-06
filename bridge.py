# bridge.py — FastAPI microservice (CORS + ERP auth + búsqueda “inteligente”)
# Requisitos: pip install fastapi uvicorn requests python-dotenv

import os, json, unicodedata, re, html
import requests
from pathlib import Path
from typing import List, Dict, Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv
from routes.bin_qty import router as bin_qty_router

# ========= .env =========
# Carga .env ubicado junto a este archivo
load_dotenv(dotenv_path=Path(__file__).with_name(".env"))

# =============================
# Configuración y App
# =============================
ERP_BASE        = os.getenv("ERP_BASE", "http://erp.localhost")
ERP_API_KEY     = os.getenv("ERP_API_KEY", "KEY")
ERP_API_SECRET  = os.getenv("ERP_API_SECRET", "SECRET")
ERP_TOKEN       = os.getenv("ERP_TOKEN")  # opcional: "APIKEY:APISECRET"

# Encabezados para Frappe/ERPNext
if ERP_TOKEN:
    # si preferís pasar todo junto
    HEADERS = {
        "Authorization": f"token {ERP_TOKEN}",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "Accept": "application/json",
    }
else:
    # clave + secreto por separado (equivalente)
    HEADERS = {
        "Authorization": f"token {ERP_API_KEY}:{ERP_API_SECRET}",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
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

# FastAPI app + CORS
app = FastAPI()
app.include_router(bin_qty_router)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173","http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
# ========= Models =========
class SearchBody(BaseModel):
    search_term: str
    start: int = 0
    page_length: int = 20
    only_in_stock: bool = False         # opcional: filtrar stock > 0
    price_gt_zero: bool = False         # opcional: filtrar precio > 0

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

# ========= Utils búsqueda =========
def strip_accents(s: str) -> str:
    """ñ/acentos tolerante."""
    if not s:
        return ""
    nkfd = unicodedata.normalize("NFKD", s)
    return "".join(ch for ch in nkfd if not unicodedata.combining(ch))

def norm(s: str) -> str:
    return strip_accents(s or "").lower().strip()

def tokenize(q: str) -> List[str]:
    """tokens alfanum (permite 1/2, 3/4, 20mm, 90°)."""
    qn = norm(q)
    return [t for t in re.findall(r"[0-9a-zA-ZñÑ°/.\-]+", qn) if t]

def build_pos_profile_str() -> str:
    """POS Awesome espera pos_profile como STRING JSON (server hace json.loads)."""
    payload = {
        "name": DEFAULTS["pos_profile"],
        "price_list": DEFAULTS["price_list"],
        "warehouse": DEFAULTS["warehouse"],
    }
    # ensure_ascii=False para conservar caracteres (ñ/°) si hiciera falta
    return json.dumps(payload, ensure_ascii=False)

def fields_text(item: Dict[str, Any]) -> str:
    """
    Texto indexable con todos los campos relevantes:
    - código, nombre, descripción, grupo, marca, atributos/medidas.
    """
    parts = [
        item.get("item_code") or item.get("name") or "",
        item.get("item_name") or "",
        item.get("description") or "",
        item.get("item_group") or "",
        item.get("brand") or "",
        item.get("attributes") or "",
        item.get("item_attributes") or "",
    ]
    # Si vienen arrays (ej. barcodes), agregarlos
    if isinstance(item.get("item_barcode"), list):
        parts.extend([str(b) for b in item.get("item_barcode")])
    return norm(" ".join(map(str, parts)))

def score_item(item: Dict[str, Any], q_tokens: List[str]) -> int:
    """
    Ranking simple:
      +5 cada token si match EXACTO en nombre/código
      +3 si el nombre empieza con el token
      +2 si el token está en el texto indexado (campos varios)
      +1 si tiene precio > 0
      +1 si stock > 0
    """
    name = norm(item.get("item_name") or item.get("name") or "")
    code = norm(item.get("item_code") or item.get("name") or "")
    text = fields_text(item)
    rate = (item.get("price_list_rate") or item.get("rate") or 0) or 0
    qty = (item.get("actual_qty") or 0) or 0

    s = 0
    for tok in q_tokens:
        if tok and (name == tok or code == tok):
            s += 5
        elif tok and (name.startswith(tok) or code.startswith(tok)):
            s += 3
        elif tok in text:
            s += 2
    if rate > 0:
        s += 1
    if qty > 0:
        s += 1
    return s

def filter_match(item: Dict[str, Any], q_tokens: List[str]) -> bool:
    """
    Un ítem matchea si TODOS los tokens están presentes en ALGÚN campo
    (nombre, código, descripción, marca, atributos, medidas).
    """
    text = fields_text(item)
    name = norm(item.get("item_name") or item.get("name") or "")
    code = norm(item.get("item_code") or item.get("name") or "")
    for tok in q_tokens:
        if not (tok in text or name.startswith(tok) or code.startswith(tok) or name == tok or code == tok):
            return False
    return True

# ========= Rutas =========
@app.get("/__env")
def __env():
    tp = (ERP_TOKEN[:6] + "...") if ERP_TOKEN else ""
    return {
        "erp_base": ERP_BASE,
        "has_token": bool(ERP_TOKEN),
        "token_prefix": tp,
        "pos_profile": DEFAULTS.get("pos_profile"),
        "warehouse": DEFAULTS.get("warehouse"),
        "price_list": DEFAULTS.get("price_list"),
    }

@app.post("/bridge/search")
def search_items(body: SearchBody):
    """
    Busca ítems en el ERP y:
    - filtra por name/code/brand/description (normalizado, sin acentos)
    - ordena por score (match + stock primero)
    - devuelve lista cruda filtrada (message) + normalizada (items) con índice y metadatos de match
    """
    try:
        # ---------- helpers locales ----------
        def normalize_text(s: str) -> str:
            if not s:
                return ""
            # unicode -> NFD y quitar diacríticos (caño -> cano)
            s = unicodedata.normalize("NFD", s)
            s = "".join(ch for ch in s if unicodedata.category(ch) != "Mn")
            s = s.lower()

            # fracciones y símbolos típicos -> ASCII
            repl = {
                "½": "1/2", "¼": "1/4", "¾": "3/4",
                "”": '"', "“": '"', "″": '"', "′": "'",
                "º": "", "°": "",
            }
            for k, v in repl.items():
                s = s.replace(k, v)

            # dejar letras, números, barra y espacios; colapsar espacios
            s = re.sub(r"[^a-z0-9/.\s-]", " ", s)
            s = re.sub(r"\s+", " ", s).strip()
            return s

        def tokenize(q: str):
            nq = normalize_text(q)
            # tokens simples por espacio (conservamos 3/4, 20mm -> 20mm)
            toks = [t for t in nq.split(" ") if t]
            return nq, toks

        def any_token_in_text(tokens, text_norm: str) -> bool:
            if not tokens:
                return True
            return all(t in text_norm for t in tokens)

        # ---------- llamada ERP ----------
        url = f"{ERP_BASE}/api/method/posawesome.posawesome.api.posapp.get_items"

        # POSAwesome: pos_profile como STRING JSON
        pos_profile_str = json.dumps(
            {
                "name": DEFAULTS["pos_profile"],
                "price_list": DEFAULTS["price_list"],
                "warehouse": DEFAULTS["warehouse"],
            },
            ensure_ascii=False,
        )

        payload = {
            "search_term": body.search_term,
            "page_length": body.page_length,
            "start": body.start,
            # estos dos muchos servers los ignoran si ya van en pos_profile, pero no molestan:
            "warehouse": DEFAULTS["warehouse"],
            "price_list": DEFAULTS["price_list"],
            "pos_profile": pos_profile_str,
        }

        # mantener el formato que ya te viene funcionando (form-data):
        r = requests.post(url, headers=HEADERS, data=payload, timeout=30)
        r.raise_for_status()
        erp_json = r.json()
        raw_list = erp_json.get("message") or erp_json.get("data") or []

        # ---------- filtrado + ranking ----------
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

            # texto combinado para exigir TODOS los tokens (en cualquiera de los campos)
            combined = "  ".join([n_name, n_code, n_brand, n_desc])

            if not any_token_in_text(q_tokens, combined):
                continue  # no matchea → fuera

            # score simple
            score = 0.0
            # boost por dónde matchea
            score += 2.0 if q_phrase and q_phrase in n_name else 0.0
            score += 1.2 if q_phrase and q_phrase in n_code else 0.0
            # por token en cada campo
            score += sum(1 for t in q_tokens if t in n_name) * 0.9
            score += sum(1 for t in q_tokens if t in n_code) * 0.7
            score += sum(1 for t in q_tokens if t in n_brand) * 0.5
            score += sum(1 for t in q_tokens if t in n_desc) * 0.3
            # stock primero
            if stock > 0:
                score += 1.5

            # metadatos de dónde hubo match (para highlight en el front)
            hit_fields = []
            if any(t in n_name for t in q_tokens) or (q_phrase and q_phrase in n_name):
                hit_fields.append("name")
            if any(t in n_code for t in q_tokens) or (q_phrase and q_phrase in n_code):
                hit_fields.append("code")
            if any(t in n_brand for t in q_tokens) or (q_phrase and q_phrase in n_brand):
                hit_fields.append("brand")
            if any(t in n_desc for t in q_tokens) or (q_phrase and q_phrase in n_desc):
                hit_fields.append("desc")

            ranked.append(
                {
                    "_score": score,
                    "_hit_fields": hit_fields,
                    **it,  # mantener el crudo (code, name, brand, desc, qty, etc.)
                }
            )

        # ordenar por score desc
        ranked.sort(key=lambda x: x["_score"], reverse=True)

        # -------- normalización con índice (para LLM + front debug) --------
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
                    "brand": it.get("brand"),         # ← marca visible para front
                    "desc": it.get("description"),
                    "hit_fields": it.get("_hit_fields", []),  # ← para resaltar luego
                    "terms": q_tokens,                           # ← tokens buscados (normalizados)
                }
            )
            index_map.append({"index": i, "item_code": code})

        # limpiar campos internos en 'message' que no forman parte del ERP crudo
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
            "message": message,     # crudo filtrado + ordenado (compatible con tu UI actual)
            "items": normalized,    # normalizado con index + brand + metadatos de match
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
    - Agregamos pos_profile como STRING JSON (igual que en /bridge/search)
    - Mejor manejo de errores: devolvemos el JSON del ERP en el detail del error
    """
    try:
        url = f"{ERP_BASE}/api/method/posawesome.posawesome.api.posapp.get_item_detail"

        update_stock = 1 if body.mode.upper() in ["FACTURA", "REMITO"] else 0

        # Doc base (POSAwesome espera strings serializados en algunos campos)
        doc = {
            "doctype": "Sales Invoice",
            "is_pos": 1,
            "ignore_pricing_rule": 1,
            "company": DEFAULTS["company"],
            "pos_profile": DEFAULTS["pos_profile"],
            "currency": DEFAULTS["currency"],
            "customer": DEFAULTS["customer"],
            "items": [
                {
                    "item_code": body.item_code,
                    "qty": body.qty,
                    "uom": "Nos",
                    "price_list_rate": 0,
                }
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
        }

        # POSAwesome: pos_profile como STRING JSON (el server hace json.loads)
        pos_profile_str = build_pos_profile_str()

        # En este endpoint, históricamente funciona mejor con form-data:
        payload = {
            "warehouse": DEFAULTS["warehouse"],
            "price_list": DEFAULTS["price_list"],  # a veces requerido para rate
            "pos_profile": pos_profile_str,         # <— clave para que no falle
            "doc": str(doc),
            "item": str(item),
        }

        r = requests.post(url, headers=HEADERS, data=payload, timeout=30)
        # Si el ERP devolvió error, exponemos el texto para ver el motivo real
        r.raise_for_status()
        return r.json()

    except requests.HTTPError as e:
        # Devolvemos la respuesta cruda del ERP para diagnosticar
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
