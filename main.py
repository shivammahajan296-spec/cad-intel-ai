import base64
import json
import logging
import math
import mimetypes
import os
import re
import shutil
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib import error, request
from urllib.parse import urlparse

import ezdxf
from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

try:
    from steputils import p21
except Exception:  # pragma: no cover
    p21 = None

try:
    import chromadb
except Exception:  # pragma: no cover
    chromadb = None


BASE_DIR = Path(__file__).resolve().parent
UPLOAD_DIR = BASE_DIR / "uploads"
GENERATED_DIR = BASE_DIR / "generated"
STATIC_DIR = BASE_DIR / "static"
DB_DIR = BASE_DIR / "vector_db"
ASSET_DB = GENERATED_DIR / "assets.json"
CONFIG_DB = GENERATED_DIR / "config.json"
DEFAULT_STRAIVE_SUMMARY_URL = "https://llmfoundry.straive.com/gemini/v1beta/openai/chat/completions"
DEFAULT_STRAIVE_MODEL = "gemini-3-pro-preview"
LOG_LEVEL = os.getenv("APP_LOG_LEVEL", "INFO").upper()
DEFAULT_STRAIVE_TIMEOUT_SECONDS = 180

UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
GENERATED_DIR.mkdir(parents=True, exist_ok=True)
DB_DIR.mkdir(parents=True, exist_ok=True)

if not ASSET_DB.exists():
    ASSET_DB.write_text("{}", encoding="utf-8")
if not CONFIG_DB.exists():
    CONFIG_DB.write_text("{}", encoding="utf-8")

logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger("cad-intel-ai")

app = FastAPI(title="CAD-Intel AI")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
app.mount("/uploads", StaticFiles(directory=UPLOAD_DIR), name="uploads")
app.mount("/generated", StaticFiles(directory=GENERATED_DIR), name="generated")


def _load_assets() -> dict[str, Any]:
    return json.loads(ASSET_DB.read_text(encoding="utf-8"))


def _save_assets(data: dict[str, Any]) -> None:
    ASSET_DB.write_text(json.dumps(data, indent=2), encoding="utf-8")


def _sanitize(name: str) -> str:
    return re.sub(r"[^a-zA-Z0-9._-]", "_", name)


def _load_config() -> dict[str, Any]:
    return json.loads(CONFIG_DB.read_text(encoding="utf-8"))


def _save_config(data: dict[str, Any]) -> None:
    CONFIG_DB.write_text(json.dumps(data, indent=2), encoding="utf-8")


def _filename_cache_key(filename: str) -> str:
    return _sanitize(filename).lower()


def _get_analysis_cache(config: dict[str, Any]) -> dict[str, str]:
    cache = config.get("analysis_cache")
    if not isinstance(cache, dict):
        return {}
    cleaned: dict[str, str] = {}
    for key, value in cache.items():
        if isinstance(key, str) and isinstance(value, str):
            cleaned[key] = value
    return cleaned


def _set_cached_asset(filename: str, asset_id: str) -> None:
    config = _load_config()
    cache = _get_analysis_cache(config)
    cache[_filename_cache_key(filename)] = asset_id
    config["analysis_cache"] = cache
    _save_config(config)


def _get_cached_asset_id(filename: str) -> str | None:
    config = _load_config()
    cache = _get_analysis_cache(config)
    return cache.get(_filename_cache_key(filename))


def _is_valid_http_url(url: str) -> bool:
    try:
        parsed = urlparse(url.strip())
        return parsed.scheme in {"http", "https"} and bool(parsed.netloc)
    except Exception:
        return False


def _clear_dir_contents(path: Path, keep_names: set[str] | None = None) -> int:
    keep = keep_names or set()
    removed = 0
    if not path.exists():
        return removed

    for item in path.iterdir():
        if item.name in keep:
            continue
        if item.is_dir():
            shutil.rmtree(item, ignore_errors=True)
            removed += 1
        else:
            try:
                item.unlink()
                removed += 1
            except FileNotFoundError:
                continue
    return removed


def _remove_web_path(web_path: str | None, root: Path) -> bool:
    if not web_path or not isinstance(web_path, str):
        return False
    name = Path(web_path).name
    if not name:
        return False
    target = root / name
    if not target.exists() or not target.is_file():
        return False
    try:
        target.unlink()
        return True
    except FileNotFoundError:
        return False


def _default_extraction_engine() -> dict[str, Any]:
    return {
        "role": "You are a senior mechanical design engineer, CAD expert, and manufacturing specialist.",
        "objective": [
            "Analyze the provided CAD image and extract complete engineering intelligence from it.",
            "Your task is NOT to recreate the image, but to deeply understand and describe it from a professional product engineering perspective.",
        ],
        "sections": [
            {
                "title": "Object Identification",
                "items": [
                    "What is the likely object type?",
                    "What industry could it belong to?",
                    "Is it consumer, industrial, automotive, packaging, medical, etc.?",
                ],
            },
            {
                "title": "Geometric Analysis",
                "items": [
                    "Identify symmetry (axial / planar / none).",
                    "Identify primary geometric primitives (cylinders, cones, extrudes, revolves, lofts, sweeps).",
                    "Identify secondary features (ribs, grooves, knurls, fillets, chamfers, threads, draft angles).",
                    "Detect hollow regions.",
                    "Detect wall thickness logic.",
                    "Detect undercuts.",
                    "Detect assembly parts or multi-body structure.",
                ],
            },
            {
                "title": "Dimension Inference",
                "items": [
                    "If scale is not provided, infer realistic industrial dimensions in millimeters.",
                    "Estimate overall height, width / diameter, wall thickness, feature depth, fillet radius, chamfer size, and thread pitch (if visible).",
                    "Explain reasoning behind each estimate.",
                ],
            },
            {
                "title": "Manufacturing Analysis",
                "items": [
                    "Likely manufacturing method (Injection molding / CNC machining / die casting / extrusion / 3D print / etc.).",
                    "Required tolerances.",
                    "Surface finish requirements.",
                    "Draft angle presence.",
                    "Tooling complexity level (Low / Medium / High).",
                    "Cost category (Low / Medium / High).",
                ],
            },
            {
                "title": "Design For Manufacturing (DFM) Review",
                "items": [
                    "Strength weaknesses.",
                    "Stress concentration areas.",
                    "Thin wall risks.",
                    "Warpage risks (if molded).",
                    "Over-engineering detection.",
                    "Undercut or tooling problems.",
                ],
            },
            {
                "title": "Material Recommendation",
                "items": [
                    "Suggest 2-3 suitable materials.",
                    "Why each would be used.",
                    "Alternative cost-effective material.",
                ],
            },
            {
                "title": "Improvement Suggestions",
                "items": [
                    "Weight reduction opportunities.",
                    "Structural reinforcement suggestions.",
                    "Manufacturing simplification ideas.",
                    "Assembly improvement ideas.",
                ],
            },
        ],
        "closing": [
            "Be precise.",
            "Think like a manufacturing engineer.",
            "Use millimeters.",
            "Do not hallucinate decorative assumptions.",
            "Explain logic clearly.",
        ],
    }


def _normalize_extraction_engine(engine_cfg: Any) -> dict[str, Any]:
    default_engine = _default_extraction_engine()
    if not isinstance(engine_cfg, dict):
        return default_engine

    role = str(engine_cfg.get("role", "")).strip() or default_engine["role"]

    raw_objective = engine_cfg.get("objective")
    objective = []
    if isinstance(raw_objective, list):
        objective = [str(item).strip() for item in raw_objective if str(item).strip()]
    if not objective:
        objective = default_engine["objective"]

    raw_sections = engine_cfg.get("sections")
    sections: list[dict[str, Any]] = []
    if isinstance(raw_sections, list):
        for section in raw_sections:
            if not isinstance(section, dict):
                continue
            title = str(section.get("title", "")).strip()
            raw_items = section.get("items")
            items: list[str] = []
            if isinstance(raw_items, list):
                items = [str(item).strip() for item in raw_items if str(item).strip()]
            if title and items:
                sections.append({"title": title, "items": items})
    if not sections:
        sections = default_engine["sections"]

    raw_closing = engine_cfg.get("closing")
    closing = []
    if isinstance(raw_closing, list):
        closing = [str(item).strip() for item in raw_closing if str(item).strip()]
    if not closing:
        closing = default_engine["closing"]

    return {
        "role": role,
        "objective": objective,
        "sections": sections,
        "closing": closing,
    }


def _build_extraction_prompt(engine_cfg: Any) -> str:
    engine = _normalize_extraction_engine(engine_cfg)
    lines: list[str] = [engine["role"], ""]
    lines.extend(engine["objective"])
    lines.append("")

    for idx, section in enumerate(engine["sections"], start=1):
        title = str(section.get("title", "")).strip().upper()
        items = section.get("items", [])
        lines.extend(
            [
                "--------------------------------------------",
                f"{idx}) {title}",
                "--------------------------------------------",
            ]
        )
        for item in items:
            lines.append(f"- {item}")
        lines.append("")

    lines.extend(["--------------------------------------------", ""])
    lines.extend(engine["closing"])
    return "\n".join(lines).strip()


def _extract_dxf(path: Path) -> dict[str, Any]:
    doc = ezdxf.readfile(path)
    header = doc.header
    modelspace = doc.modelspace()

    text_entities: list[str] = []
    preview_lines: list[list[float]] = []
    max_segments = 7000

    def _add_segment(a: tuple[float, float, float], b: tuple[float, float, float]) -> bool:
        if len(preview_lines) // 2 >= max_segments:
            return False
        preview_lines.append([float(a[0]), float(a[1]), float(a[2])])
        preview_lines.append([float(b[0]), float(b[1]), float(b[2])])
        return True

    def _point(x: float, y: float, z: float = 0.0) -> tuple[float, float, float]:
        return (float(x), float(y), float(z))

    for entity in modelspace:
        t = entity.dxftype()
        if t in {"TEXT", "MTEXT"}:
            text = getattr(entity.dxf, "text", "") or getattr(entity, "text", "")
            if text:
                text_entities.append(str(text).strip())
        elif t == "LINE":
            try:
                s = entity.dxf.start
                e = entity.dxf.end
                if not _add_segment(_point(s.x, s.y, getattr(s, "z", 0.0)), _point(e.x, e.y, getattr(e, "z", 0.0))):
                    break
            except Exception:
                continue
        elif t == "LWPOLYLINE":
            try:
                points = [_point(p[0], p[1], 0.0) for p in entity.get_points("xy")]
                for idx in range(len(points) - 1):
                    if not _add_segment(points[idx], points[idx + 1]):
                        break
                if entity.closed and len(points) > 2:
                    _add_segment(points[-1], points[0])
            except Exception:
                continue
        elif t == "POLYLINE":
            try:
                verts = [_point(v.dxf.location.x, v.dxf.location.y, v.dxf.location.z) for v in entity.vertices]
                for idx in range(len(verts) - 1):
                    if not _add_segment(verts[idx], verts[idx + 1]):
                        break
                if entity.is_closed and len(verts) > 2:
                    _add_segment(verts[-1], verts[0])
            except Exception:
                continue
        elif t in {"ARC", "CIRCLE"}:
            try:
                center = entity.dxf.center
                radius = float(entity.dxf.radius)
                start_angle = float(getattr(entity.dxf, "start_angle", 0.0))
                end_angle = float(getattr(entity.dxf, "end_angle", 360.0))
                if t == "CIRCLE":
                    end_angle = start_angle + 360.0
                if end_angle <= start_angle:
                    end_angle += 360.0
                steps = max(20, min(80, int((end_angle - start_angle) / 6)))
                prev = None
                for step in range(steps + 1):
                    ang = (start_angle + (end_angle - start_angle) * (step / steps)) * (3.141592653589793 / 180.0)
                    px = center.x + radius * float(math.cos(ang))
                    py = center.y + radius * float(math.sin(ang))
                    cur = _point(px, py, getattr(center, "z", 0.0))
                    if prev:
                        if not _add_segment(prev, cur):
                            break
                    prev = cur
            except Exception:
                continue

    metadata = {
        "author": header.get("$LASTSAVEDBY") or header.get("$AUTHOR") or "Unknown",
        "version": header.get("$ACADVER", "Unknown"),
        "created_date": header.get("$TDCREATE", "Unknown"),
    }
    return {
        "type": "dxf",
        "metadata": metadata,
        "texts": text_entities,
        "preview_lines": preview_lines,
    }


def _step_hierarchy(path: Path) -> dict[str, Any]:
    hierarchy: list[str] = []
    if p21:
        try:
            step_file = p21.readfile(str(path))
            for line in str(step_file).splitlines()[:300]:
                if "PRODUCT" in line or "MANIFOLD_SOLID_BREP" in line:
                    hierarchy.append(line.strip())
        except Exception:
            hierarchy = []

    if not hierarchy:
        hierarchy = ["STEP hierarchy parsing unavailable; extracted basic file metadata only."]

    return {
        "type": "step",
        "metadata": {
            "author": "Unknown",
            "version": "STEP",
            "created_date": datetime.utcnow().isoformat(),
        },
        "hierarchy": hierarchy[:50],
        "glb": None,
        "step_path": f"/uploads/{path.name}",
    }


def _index_asset(asset_id: str, filename: str, text_blob: str, summary: str) -> None:
    if not chromadb:
        return

    client = chromadb.PersistentClient(path=str(DB_DIR))
    collection = client.get_or_create_collection(name="cad_assets")
    collection.upsert(
        ids=[asset_id],
        documents=[f"{filename}\n{text_blob}\n{summary}"],
        metadatas=[{"filename": filename}],
    )


def _structured_summary_from_text(
    summary: str,
    source_type: str,
    metadata: dict[str, Any],
    raw_text: str,
    screenshots_count: int,
) -> dict[str, Any]:
    blob = f"{summary}\n{raw_text}".lower()

    complexity = "Medium Complexity"
    complexity_tone = "medium"
    if "high-complexity" in blob or "high complexity" in blob:
        complexity = "High Complexity"
        complexity_tone = "high"
    elif "low-complexity" in blob or "low complexity" in blob:
        complexity = "Low Complexity"
        complexity_tone = "low"

    material = "Material Unconfirmed"
    material_tone = "neutral"
    if "aluminum" in blob:
        material = "Aluminum"
        material_tone = "info"
    elif "steel" in blob:
        material = "Steel"
        material_tone = "info"
    elif "stainless" in blob:
        material = "Stainless Steel"
        material_tone = "info"
    elif "abs" in blob:
        material = "ABS"
        material_tone = "info"
    elif "polycarbonate" in blob:
        material = "Polycarbonate"
        material_tone = "info"

    manufacturing = "General Machined/Assembled"
    manufacturing_tone = "neutral"
    if "injection" in blob and "mold" in blob:
        manufacturing = "Injection Molded"
        manufacturing_tone = "good"
    elif "sheet metal" in blob:
        manufacturing = "Sheet Metal"
        manufacturing_tone = "good"
    elif "cast" in blob:
        manufacturing = "Casting"
        manufacturing_tone = "good"
    elif "cnc" in blob or "machin" in blob:
        manufacturing = "CNC Machined"
        manufacturing_tone = "good"

    part_identification = [
        f"File type: {source_type.upper()}",
        f"Author: {metadata.get('author', 'Unknown')}",
        f"Revision/Version: {metadata.get('version', 'Unknown')}",
    ]
    materials = [
        f"Detected material signal: {material}",
        "Validate against BOM/title block for production sign-off.",
    ]
    manufacturing_notes = [
        f"Likely manufacturing route: {manufacturing}",
        f"Available geometric views captured: {screenshots_count}",
    ]
    complexity_notes = [
        f"Overall complexity assessment: {complexity}",
        "Use assembly hierarchy and annotation density to prioritize review depth.",
    ]
    recommendation = [
        "Confirm part numbers and revision lineage before release.",
        "Run DFM checks after BOM/material validation.",
        "Escalate unclear tolerances or missing annotations to CAD owner.",
    ]

    return {
        "badges": [
            {"label": complexity, "tone": complexity_tone},
            {"label": material, "tone": material_tone},
            {"label": manufacturing, "tone": manufacturing_tone},
        ],
        "sections": {
            "part_identification": part_identification,
            "materials": materials,
            "manufacturing": manufacturing_notes,
            "complexity": complexity_notes,
            "recommendation": recommendation,
        },
    }


def _generate_summary(payload: dict[str, Any]) -> tuple[str, str, str]:
    prompt = payload.get("prompt", "")
    config = _load_config()
    env_url = os.getenv("STRAIVE_SUMMARY_URL", "").strip()
    saved_url = str(config.get("straive_summary_url", "")).strip()
    if _is_valid_http_url(env_url):
        straive_url = env_url
    elif _is_valid_http_url(saved_url):
        straive_url = saved_url
    else:
        if saved_url and not _is_valid_http_url(saved_url):
            logger.warning("summary.config.invalid_saved_url=%s", saved_url)
        straive_url = DEFAULT_STRAIVE_SUMMARY_URL
    straive_model = os.getenv("STRAIVE_MODEL", "").strip() or DEFAULT_STRAIVE_MODEL
    try:
        straive_timeout = int(os.getenv("STRAIVE_TIMEOUT_SECONDS", str(DEFAULT_STRAIVE_TIMEOUT_SECONDS)))
    except ValueError:
        straive_timeout = DEFAULT_STRAIVE_TIMEOUT_SECONDS
    api_key = os.getenv("STRAIVE_API_KEY", "").strip() or str(
        config.get("straive_api_key", "")
    ).strip()
    logger.info(
        "summary.start source_type=%s screenshots=%s text_len=%s straive_url=%s key_set=%s",
        payload.get("source_type", "unknown"),
        len(payload.get("screenshots", []) or []),
        len(payload.get("text", "") or ""),
        straive_url,
        "yes" if bool(api_key) else "no",
    )
    if straive_url and api_key:
        try:
            source_type = payload.get("source_type", "unknown")
            metadata = payload.get("metadata", {})
            text = payload.get("text", "")
            screenshots = payload.get("screenshots", []) or []

            merged_prompt = (
                f"{prompt}\n\n"
                f"Source type: {source_type}\n"
                f"Metadata: {json.dumps(metadata, ensure_ascii=True)}\n\n"
                f"Extracted CAD text:\n{text[:12000]}"
            )
            content_parts: list[dict[str, Any]] = [{"type": "text", "text": merged_prompt}]
            for image_ref in screenshots[:4]:
                if not isinstance(image_ref, str):
                    continue

                if image_ref.startswith("data:image"):
                    content_parts.append({"type": "image_url", "image_url": {"url": image_ref}})
                    continue

                if image_ref.startswith("/generated/"):
                    local_path = BASE_DIR / image_ref.lstrip("/")
                    if local_path.exists():
                        mime = mimetypes.guess_type(local_path.name)[0] or "image/png"
                        img_b64 = base64.b64encode(local_path.read_bytes()).decode("utf-8")
                        content_parts.append(
                            {
                                "type": "image_url",
                                "image_url": {"url": f"data:{mime};base64,{img_b64}"},
                            }
                        )
            logger.info(
                "summary.straive.request model=%s content_parts=%s image_parts=%s timeout=%ss",
                straive_model,
                len(content_parts),
                max(len(content_parts) - 1, 0),
                straive_timeout,
            )

            req_payload = {
                "model": straive_model,
                "messages": [{"role": "user", "content": content_parts}],
                "temperature": 0.1,
            }
            headers = {
                "Content-Type": "application/json",
                "Authorization": f"Bearer {api_key}",
            }

            req = request.Request(
                straive_url,
                method="POST",
                headers=headers,
                data=json.dumps(req_payload).encode("utf-8"),
            )
            body = ""
            for attempt in (1, 2):
                try:
                    with request.urlopen(req, timeout=straive_timeout) as resp:
                        logger.info(
                            "summary.straive.http_status=%s attempt=%s",
                            getattr(resp, "status", "unknown"),
                            attempt,
                        )
                        body = resp.read().decode("utf-8", errors="ignore")
                    break
                except TimeoutError:
                    logger.warning("summary.straive.timeout attempt=%s timeout=%ss", attempt, straive_timeout)
                    if attempt == 2:
                        raise
            parsed = json.loads(body) if body else {}

            # OpenAI-compatible response parsing.
            choices = parsed.get("choices")
            if isinstance(choices, list) and choices and isinstance(choices[0], dict):
                msg = choices[0].get("message")
                if isinstance(msg, dict):
                    content = msg.get("content")
                    if isinstance(content, str) and content.strip():
                        logger.info("summary.straive.success mode=string")
                        return content.strip(), "straive", ""
                    if isinstance(content, list):
                        text_parts: list[str] = []
                        for part in content:
                            if isinstance(part, dict) and part.get("type") == "text":
                                txt = part.get("text")
                                if isinstance(txt, str) and txt.strip():
                                    text_parts.append(txt.strip())
                        if text_parts:
                            logger.info("summary.straive.success mode=content_list")
                            return "\n".join(text_parts).strip(), "straive", ""
            logger.warning("summary.straive.invalid_response keys=%s", list(parsed.keys())[:12])
            return (
                "Project Manager Summary: Straive response did not contain summary text. "
                "Check model permissions or endpoint response format.",
                "fallback",
                "invalid_straive_response",
            )
        except error.HTTPError as exc:
            err_body = ""
            try:
                err_body = exc.read().decode("utf-8", errors="ignore")[:400]
            except Exception:
                err_body = ""
            logger.error(
                "summary.straive.http_error code=%s reason=%s body=%s",
                exc.code,
                getattr(exc, "reason", ""),
                err_body,
            )
            return (
                "Project Manager Summary: Straive API request failed. "
                "Check API key, endpoint access, and model permissions.",
                "fallback",
                f"straive_http_error_{exc.code}",
            )
        except TimeoutError:
            logger.exception("summary.straive.timeout_final")
            return (
                "Project Manager Summary: Straive request timed out. "
                "Try again or increase STRAIVE_TIMEOUT_SECONDS.",
                "fallback",
                "straive_timeout",
            )
        except (error.URLError, ValueError, json.JSONDecodeError):
            logger.exception("summary.straive.request_failed")
            return (
                "Project Manager Summary: Straive API request failed due to connectivity or payload parse issue.",
                "fallback",
                "straive_request_failed",
            )
    elif not api_key:
        logger.warning("summary.fallback missing_straive_api_key")
        return (
            "Project Manager Summary: Straive API key is not configured. "
            "Use 'Set Key' on dashboard to enable LLM summaries.",
            "fallback",
            "missing_straive_api_key",
        )

    # Deterministic fallback when external AI is unavailable.
    meta = payload.get("metadata", {})
    text = payload.get("text", "")
    screenshots = payload.get("screenshots", [])
    source_type = payload.get("source_type", "unknown")

    complexity = "medium"
    if len(text) > 1200 or len(screenshots) >= 4:
        complexity = "high"
    if len(text) < 200 and len(screenshots) < 2:
        complexity = "low"

    return (
        "Project Manager Summary: "
        f"This {source_type.upper()} asset appears to be a {complexity}-complexity design. "
        f"Identified author: {meta.get('author', 'Unknown')}; revision/version: {meta.get('version', 'Unknown')}. "
        "Likely material cannot be fully confirmed from metadata alone; recommend validating BOM or title block. "
        "Part identification should prioritize assembly hierarchy tags and drawing annotations.",
        "fallback",
        "deterministic_fallback",
    )


class SummarizeRequest(BaseModel):
    asset_id: str
    source_type: str
    text: str | None = ""
    screenshots: list[str] | None = []


class CaptureRequest(BaseModel):
    asset_id: str
    screenshots: list[str]


class SearchRequest(BaseModel):
    query: str


class CompareRequest(BaseModel):
    asset_id_a: str
    asset_id_b: str


class StraiveConfigRequest(BaseModel):
    api_key: str | None = ""


class ExtractionEngineConfigRequest(BaseModel):
    engine: dict[str, Any] | None = None


@app.get("/")
def home() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/analysis.html")
def analysis_page() -> FileResponse:
    return FileResponse(STATIC_DIR / "analysis.html")


@app.get("/library.html")
def library_page() -> FileResponse:
    return FileResponse(STATIC_DIR / "library.html")


@app.post("/api/upload")
async def upload_asset(file: UploadFile = File(...)) -> dict[str, Any]:
    ext = Path(file.filename or "").suffix.lower()
    if ext not in {".dxf", ".step", ".stp", ".glb", ".gltf", ".stl"}:
        raise HTTPException(status_code=400, detail="Unsupported file type")

    safe_name = _sanitize(file.filename or f"asset{ext}")
    cached_asset_id = _get_cached_asset_id(safe_name)
    if cached_asset_id:
        assets = _load_assets()
        if cached_asset_id in assets:
            logger.info("upload.cache_hit filename=%s asset_id=%s", safe_name, cached_asset_id)
            return {
                "asset_id": cached_asset_id,
                "analysis_url": f"/analysis.html?asset_id={cached_asset_id}",
                "cached": True,
            }

    asset_id = uuid.uuid4().hex
    stored_name = f"{asset_id}_{safe_name}"
    target = UPLOAD_DIR / stored_name
    content = await file.read()
    target.write_bytes(content)

    record: dict[str, Any]
    if ext == ".dxf":
        record = _extract_dxf(target)
    elif ext in {".step", ".stp"}:
        record = _step_hierarchy(target)
    else:
        # Preconverted mesh formats for quick preview.
        record = {
            "type": "step",
            "metadata": {
                "author": "Unknown",
                "version": ext.upper().lstrip("."),
                "created_date": datetime.utcnow().isoformat(),
            },
            "hierarchy": ["Direct mesh upload"],
            "glb": f"/uploads/{stored_name}",
        }

    assets = _load_assets()
    assets[asset_id] = {
        "asset_id": asset_id,
        "filename": safe_name,
        "uploaded_at": datetime.utcnow().isoformat(),
        "metadata": record.get("metadata", {}),
        "source_type": record["type"],
        "texts": record.get("texts", []),
        "hierarchy": record.get("hierarchy", []),
        "preview_lines": record.get("preview_lines", []),
        "glb": record.get("glb"),
        "dxf_path": f"/uploads/{stored_name}" if ext == ".dxf" else None,
        "step_path": record.get("step_path"),
        "screenshots": [],
        "summary": "",
    }
    _save_assets(assets)
    _set_cached_asset(safe_name, asset_id)

    return {"asset_id": asset_id, "analysis_url": f"/analysis.html?asset_id={asset_id}", "cached": False}


@app.get("/api/assets")
def list_assets() -> dict[str, Any]:
    assets = _load_assets()
    return {"items": list(assets.values())}


@app.delete("/api/assets/{asset_id}")
def delete_asset(asset_id: str) -> dict[str, Any]:
    assets = _load_assets()
    asset = assets.get(asset_id)
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")

    removed_uploads = 0
    removed_generated = 0

    if _remove_web_path(asset.get("dxf_path"), UPLOAD_DIR):
        removed_uploads += 1
    if _remove_web_path(asset.get("step_path"), UPLOAD_DIR):
        removed_uploads += 1
    if _remove_web_path(asset.get("glb"), UPLOAD_DIR):
        removed_uploads += 1

    for screenshot_path in asset.get("screenshots", []) or []:
        if _remove_web_path(screenshot_path, GENERATED_DIR):
            removed_generated += 1

    # Extra safety: remove any files tied to this asset id prefix.
    for path in UPLOAD_DIR.glob(f"{asset_id}_*"):
        if path.is_file():
            try:
                path.unlink()
                removed_uploads += 1
            except FileNotFoundError:
                continue
    for path in GENERATED_DIR.glob(f"{asset_id}_*"):
        if path.is_file():
            try:
                path.unlink()
                removed_generated += 1
            except FileNotFoundError:
                continue

    del assets[asset_id]
    _save_assets(assets)

    config = _load_config()
    cache = _get_analysis_cache(config)
    cache = {k: v for k, v in cache.items() if v != asset_id}
    config["analysis_cache"] = cache
    _save_config(config)

    if chromadb:
        try:
            client = chromadb.PersistentClient(path=str(DB_DIR))
            collection = client.get_or_create_collection(name="cad_assets")
            collection.delete(ids=[asset_id])
        except Exception:
            logger.exception("asset.delete.vector_index_failed asset_id=%s", asset_id)

    logger.info(
        "asset.deleted asset_id=%s filename=%s removed_uploads=%s removed_generated=%s",
        asset_id,
        asset.get("filename", ""),
        removed_uploads,
        removed_generated,
    )
    return {
        "status": "deleted",
        "asset_id": asset_id,
        "filename": asset.get("filename", ""),
        "removed_uploads": removed_uploads,
        "removed_generated": removed_generated,
    }


@app.post("/api/assets/clear")
def clear_assets() -> dict[str, Any]:
    assets = _load_assets()
    cleared_assets = len(assets)
    _save_assets({})

    removed_uploads = _clear_dir_contents(UPLOAD_DIR)
    removed_generated = _clear_dir_contents(GENERATED_DIR, keep_names={ASSET_DB.name, CONFIG_DB.name})
    _clear_dir_contents(DB_DIR)
    DB_DIR.mkdir(parents=True, exist_ok=True)
    config = _load_config()
    if "analysis_cache" in config:
        config["analysis_cache"] = {}
        _save_config(config)

    return {
        "status": "cleared",
        "cleared_assets": cleared_assets,
        "removed_uploads": removed_uploads,
        "removed_generated": removed_generated,
    }


@app.get("/api/analysis-cache")
def resolve_analysis_cache(filename: str = Query(...)) -> dict[str, Any]:
    cached_asset_id = _get_cached_asset_id(filename)
    if not cached_asset_id:
        raise HTTPException(status_code=404, detail="No cached analysis for filename")
    assets = _load_assets()
    if cached_asset_id not in assets:
        raise HTTPException(status_code=404, detail="Cached asset not found")
    return {"asset_id": cached_asset_id, "analysis_url": f"/analysis.html?asset_id={cached_asset_id}"}


@app.get("/api/assets/{asset_id}")
def get_asset(asset_id: str) -> dict[str, Any]:
    assets = _load_assets()
    if asset_id not in assets:
        raise HTTPException(status_code=404, detail="Asset not found")
    asset = assets[asset_id]
    changed = False

    # Backfill DXF preview for previously uploaded assets.
    if asset.get("source_type") == "dxf" and not asset.get("preview_lines"):
        candidate = UPLOAD_DIR / f"{asset_id}_{_sanitize(asset.get('filename', ''))}"
        if candidate.exists():
            try:
                extracted = _extract_dxf(candidate)
                asset["preview_lines"] = extracted.get("preview_lines", [])
                if not asset.get("texts"):
                    asset["texts"] = extracted.get("texts", [])
                changed = True
            except Exception:
                pass
    if asset.get("source_type") == "dxf" and not asset.get("dxf_path"):
        candidate = UPLOAD_DIR / f"{asset_id}_{_sanitize(asset.get('filename', ''))}"
        if candidate.exists():
            asset["dxf_path"] = f"/uploads/{candidate.name}"
            changed = True

    if asset.get("source_type") == "step" and not asset.get("step_path"):
        candidate = UPLOAD_DIR / f"{asset_id}_{_sanitize(asset.get('filename', ''))}"
        if candidate.exists():
            asset["step_path"] = f"/uploads/{candidate.name}"
            changed = True

    if asset.get("summary") and not asset.get("summary_structured"):
        asset["summary_structured"] = _structured_summary_from_text(
            summary=asset.get("summary", ""),
            source_type=asset.get("source_type", "unknown"),
            metadata=asset.get("metadata", {}),
            raw_text="\n".join(asset.get("texts", [])),
            screenshots_count=len(asset.get("screenshots", [])),
        )
        changed = True

    if changed:
        assets[asset_id] = asset
        _save_assets(assets)
    return asset


@app.get("/api/config/straive")
def get_straive_config() -> dict[str, str]:
    config = _load_config()
    env_url = os.getenv("STRAIVE_SUMMARY_URL", "").strip()
    saved_url = str(config.get("straive_summary_url", "")).strip()
    if _is_valid_http_url(env_url):
        effective_url = env_url
    elif _is_valid_http_url(saved_url):
        effective_url = saved_url
    else:
        effective_url = DEFAULT_STRAIVE_SUMMARY_URL
    env_key = os.getenv("STRAIVE_API_KEY", "").strip()
    saved_key = str(config.get("straive_api_key", "")).strip()
    return {
        "summary_url": effective_url,
        "default_summary_url": env_url or DEFAULT_STRAIVE_SUMMARY_URL,
        "api_key_set": "yes" if (env_key or saved_key) else "no",
    }


@app.post("/api/config/straive")
def set_straive_config(payload: StraiveConfigRequest) -> dict[str, str]:
    config = _load_config()
    config["straive_api_key"] = (payload.api_key or "").strip()
    _save_config(config)
    return {"status": "saved"}


@app.get("/api/config/extraction-engine")
def get_extraction_engine_config() -> dict[str, Any]:
    config = _load_config()
    engine = _normalize_extraction_engine(config.get("extraction_engine"))
    return {"engine": engine, "prompt": _build_extraction_prompt(engine)}


@app.post("/api/config/extraction-engine")
def set_extraction_engine_config(payload: ExtractionEngineConfigRequest) -> dict[str, Any]:
    engine = _normalize_extraction_engine(payload.engine or {})
    config = _load_config()
    config["extraction_engine"] = engine
    _save_config(config)
    return {"status": "saved", "engine": engine, "prompt": _build_extraction_prompt(engine)}


@app.post("/api/capture")
def save_capture(payload: CaptureRequest) -> dict[str, Any]:
    assets = _load_assets()
    asset = assets.get(payload.asset_id)
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")

    cleaned: list[str] = []
    for idx, image_uri in enumerate(payload.screenshots):
        if not image_uri.startswith("data:image"):
            continue
        b64 = image_uri.split(",", 1)[1]
        img_bytes = base64.b64decode(b64)
        fname = f"{payload.asset_id}_view_{idx + 1}.png"
        out_path = GENERATED_DIR / fname
        out_path.write_bytes(img_bytes)
        cleaned.append(f"/generated/{fname}")

    asset["screenshots"] = cleaned
    assets[payload.asset_id] = asset
    _save_assets(assets)
    logger.info("capture.saved asset_id=%s count=%s", payload.asset_id, len(cleaned))
    return {"saved": len(cleaned), "screenshots": cleaned}


@app.post("/api/summarize")
def summarize(payload: SummarizeRequest) -> dict[str, Any]:
    assets = _load_assets()
    asset = assets.get(payload.asset_id)
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")

    config = _load_config()
    prompt = _build_extraction_prompt(config.get("extraction_engine"))
    summary, summary_source, summary_reason = _generate_summary(
        {
            "source_type": payload.source_type,
            "metadata": asset.get("metadata", {}),
            "text": payload.text or "",
            "screenshots": payload.screenshots or [],
            "prompt": prompt,
        }
    )

    asset["summary"] = summary
    asset["summary_source"] = summary_source
    asset["summary_reason"] = summary_reason
    asset["summary_structured"] = _structured_summary_from_text(
        summary=summary,
        source_type=payload.source_type,
        metadata=asset.get("metadata", {}),
        raw_text=payload.text or "",
        screenshots_count=len(payload.screenshots or []),
    )
    assets[payload.asset_id] = asset
    _save_assets(assets)

    search_text = "\n".join(asset.get("texts", []) + asset.get("hierarchy", []))
    _index_asset(asset["asset_id"], asset["filename"], search_text, summary)
    logger.info(
        "summary.done asset_id=%s source=%s reason=%s screenshots=%s",
        payload.asset_id,
        summary_source,
        summary_reason,
        len(payload.screenshots or []),
    )

    return {
        "summary": summary,
        "prompt": prompt,
        "summary_source": summary_source,
        "summary_reason": summary_reason,
        "screenshots_count": len(payload.screenshots or []),
        "summary_structured": asset["summary_structured"],
    }


@app.post("/api/search")
def semantic_search(payload: SearchRequest) -> dict[str, Any]:
    query = payload.query.strip()
    if not query:
        return {"items": []}

    if chromadb:
        try:
            client = chromadb.PersistentClient(path=str(DB_DIR))
            collection = client.get_or_create_collection(name="cad_assets")
            results = collection.query(query_texts=[query], n_results=6)

            items = []
            for idx, asset_id in enumerate(results.get("ids", [[]])[0]):
                items.append(
                    {
                        "asset_id": asset_id,
                        "document": results.get("documents", [[]])[0][idx],
                        "metadata": results.get("metadatas", [[]])[0][idx],
                        "distance": results.get("distances", [[]])[0][idx]
                        if results.get("distances")
                        else None,
                    }
                )
            if items:
                return {"items": items}
        except Exception:
            pass

    # Lexical fallback so search still works without vector DB.
    terms = [t for t in re.split(r"\W+", query.lower()) if t]
    assets = _load_assets()
    scored: list[dict[str, Any]] = []
    for asset in assets.values():
        blob = " ".join(
            [
                asset.get("filename", ""),
                asset.get("summary", ""),
                " ".join(asset.get("texts", [])),
                " ".join(asset.get("hierarchy", [])),
            ]
        ).lower()
        if not blob:
            continue
        score = sum(blob.count(term) for term in terms)
        if score > 0:
            scored.append(
                {
                    "asset_id": asset.get("asset_id"),
                    "document": (asset.get("summary") or "Match found in metadata/text.")[:350],
                    "metadata": {"filename": asset.get("filename")},
                    "distance": round(1 / (score + 1), 4),
                }
            )

    scored.sort(key=lambda item: item["distance"])
    return {"items": scored[:6]}


@app.post("/api/compare")
def compare_assets(payload: CompareRequest) -> dict[str, Any]:
    assets = _load_assets()
    asset_a = assets.get(payload.asset_id_a)
    asset_b = assets.get(payload.asset_id_b)
    if not asset_a or not asset_b:
        raise HTTPException(status_code=404, detail="One or both assets not found")

    def _count_words(text: str) -> int:
        return len([w for w in re.split(r"\W+", text) if w])

    summary_a = asset_a.get("summary", "") or ""
    summary_b = asset_b.get("summary", "") or ""

    compare = {
        "a": {
            "asset_id": asset_a.get("asset_id"),
            "filename": asset_a.get("filename"),
            "source_type": asset_a.get("source_type"),
            "author": asset_a.get("metadata", {}).get("author", "Unknown"),
            "version": asset_a.get("metadata", {}).get("version", "Unknown"),
            "texts_count": len(asset_a.get("texts", [])),
            "hierarchy_count": len(asset_a.get("hierarchy", [])),
            "screenshots_count": len(asset_a.get("screenshots", [])),
            "summary_words": _count_words(summary_a),
        },
        "b": {
            "asset_id": asset_b.get("asset_id"),
            "filename": asset_b.get("filename"),
            "source_type": asset_b.get("source_type"),
            "author": asset_b.get("metadata", {}).get("author", "Unknown"),
            "version": asset_b.get("metadata", {}).get("version", "Unknown"),
            "texts_count": len(asset_b.get("texts", [])),
            "hierarchy_count": len(asset_b.get("hierarchy", [])),
            "screenshots_count": len(asset_b.get("screenshots", [])),
            "summary_words": _count_words(summary_b),
        },
        "highlights": [
            f"Source types: {asset_a.get('source_type', 'unknown').upper()} vs {asset_b.get('source_type', 'unknown').upper()}",
            f"Annotation density (text entities): {len(asset_a.get('texts', []))} vs {len(asset_b.get('texts', []))}",
            f"Hierarchy depth markers: {len(asset_a.get('hierarchy', []))} vs {len(asset_b.get('hierarchy', []))}",
            f"Summary detail (word count): {_count_words(summary_a)} vs {_count_words(summary_b)}",
        ],
    }
    return compare


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
