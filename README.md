# CAD-Intel AI

FastAPI + Three.js CAD intelligence asset manager (white/orange/grey industrial theme).

## Run

```bash
cd cad-intel-ai
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload
```

Open:
- http://127.0.0.1:8000/
- http://127.0.0.1:8000/analysis.html
- http://127.0.0.1:8000/library.html

## Implemented Modules

- DXF processor using `ezdxf` (`/api/upload`) for header metadata and text entity extraction.
- STEP processor using `steputils` with direct Three.js preview from uploaded STEP data.
- Auto-analyzer view capture (`/api/capture`) for Top/Side/Front/Iso screenshots as Base64 payloads.
- Summary endpoint (`/api/summarize`) with Straive endpoint integration (fallback summary when endpoint is unavailable).
- Natural-language search (`/api/search`) using ChromaDB with lexical fallback when vector DB is unavailable.
- Asset comparison endpoint (`/api/compare`) for side-by-side technical differences.

## Environment

Optional for live Straive summary:
- `STRAIVE_API_KEY` (required; static backend key)
- `STRAIVE_SUMMARY_URL` (optional override; default is `https://llmfoundry.straive.com/gemini/v1beta/openai/chat/completions`)
- `STRAIVE_MODEL` (optional override; default is `gemini-3-pro-preview`)

UI settings ask for API key only; endpoint/model are treated as backend static defaults unless overridden in environment.
