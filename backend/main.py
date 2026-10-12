"""
FastAPI Backend Server for Rutube Playlist Parser
Provides both standard REST and Server-Sent Events (SSE) streaming API.
"""

import sys
import os
import json
import asyncio
from typing import Optional
from pathlib import Path

from fastapi import FastAPI, Query, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

# Add current directory to path
BASE_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))

from parser import RutubeParser, extract_rutube_id_and_type

app = FastAPI(
    title="Rutube Playlist Parser API",
    description="Парсер ссылок и метаданных для плейлистов Rutube",
    version="1.0.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

parser = RutubeParser(timeout=15)

class ParseRequest(BaseModel):
    url: str
    max_pages: Optional[int] = None

SAMPLE_PLAYLISTS = [
    {
        "id": "500000",
        "title": "Oxford Discover 1 Grammar in Use",
        "count": 18,
        "url": "https://rutube.ru/plst/500000/",
        "tag": "Обучение"
    },
    {
        "id": "308547",
        "title": "Chillstep & Future Garage Mix",
        "count": 23,
        "url": "https://rutube.ru/plst/308547/",
        "tag": "Музыка"
    },
    {
        "id": "200000",
        "title": "Популярный сборник видео",
        "count": 20,
        "url": "https://rutube.ru/plst/200000/",
        "tag": "Тренды"
    }
]

@app.get("/api/samples")
def get_sample_playlists():
    """Return pre-configured sample playlists for quick testing."""
    return {"samples": SAMPLE_PLAYLISTS}

@app.get("/api/info")
def get_playlist_info(url: str = Query(..., description="Rutube playlist URL or ID")):
    """Get metadata for a playlist without fetching all video pages."""
    try:
        parsed = extract_rutube_id_and_type(url)
        target_type = parsed["type"]
        target_id = parsed["id"]

        if target_type == "channel_slug":
            target_id = parser.resolve_channel_slug(target_id)
            target_type = "channel"

        if target_type == "playlist":
            meta = parser.get_playlist_metadata(target_id)
            return {"status": "ok", "metadata": meta, "target": parsed}
        else:
            return {
                "status": "ok",
                "metadata": {
                    "id": target_id,
                    "title": f"Канал Rutube #{target_id}",
                    "videos_count": None,
                    "clean_url": f"https://rutube.ru/channel/{target_id}/"
                },
                "target": parsed
            }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.post("/api/parse")
def parse_playlist_json(req: ParseRequest):
    """Parse all video links from playlist and return full JSON."""
    try:
        result = parser.parse_all(req.url, max_pages=req.max_pages)
        return {
            "status": "ok",
            **result
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.get("/api/stream")
async def stream_parse(url: str = Query(..., description="Rutube playlist URL or ID"), max_pages: Optional[int] = None):
    """
    Server-Sent Events (SSE) streaming endpoint.
    Emits real-time progress events as each page of videos is fetched.
    """
    async def event_generator():
        try:
            parsed = extract_rutube_id_and_type(url)
            target_type = parsed["type"]
            target_id = parsed["id"]

            if target_type == "channel_slug":
                yield f"data: {json.dumps({'type': 'status', 'message': f'Определение ID канала для {target_id}...'})}\n\n"
                target_id = await asyncio.to_thread(parser.resolve_channel_slug, target_id)
                target_type = "channel"

            yield f"data: {json.dumps({'type': 'status', 'message': 'Получение информации о плейлисте...'})}\n\n"

            if target_type == "playlist":
                meta = await asyncio.to_thread(parser.get_playlist_metadata, target_id)
                yield f"data: {json.dumps({'type': 'meta', 'metadata': meta, 'target': parsed})}\n\n"

                page = 1
                all_videos = []
                seen_ids = set()

                while True:
                    if max_pages and page > max_pages:
                        break

                    yield f"data: {json.dumps({'type': 'progress', 'page': page, 'message': f'Загрузка страницы {page}...'})}\n\n"

                    try:
                        page_data = await asyncio.to_thread(parser.fetch_playlist_page, target_id, page)
                    except Exception as page_err:
                        # Fallback for page 1
                        if page == 1 and not all_videos:
                            yield f"data: {json.dumps({'type': 'status', 'message': 'Использование резервного парсера страницы...'})}\n\n"
                            fallback_vids = await asyncio.to_thread(parser.fallback_scrape_playlist, target_id)
                            all_videos.extend(fallback_vids)
                            yield f"data: {json.dumps({'type': 'page', 'page': 1, 'videos': fallback_vids, 'accumulated': len(all_videos)})}\n\n"
                            break
                        raise page_err

                    page_videos = []
                    for v in page_data["videos"]:
                        if v["id"] not in seen_ids:
                            seen_ids.add(v["id"])
                            page_videos.append(v)
                            all_videos.append(v)

                    num_pages = page_data.get("num_pages")

                    yield f"data: {json.dumps({
                        'type': 'page',
                        'page': page,
                        'total_pages': num_pages,
                        'videos': page_videos,
                        'accumulated': len(all_videos),
                        'has_next': page_data.get('has_next', False)
                    })}\n\n"

                    if not page_data.get("has_next", False) or not page_data.get("videos"):
                        break
                    if num_pages and page >= num_pages:
                        break

                    page += 1
                    # Polite delay between Rutube API requests
                    await asyncio.sleep(0.08)

                yield f"data: {json.dumps({
                    'type': 'complete',
                    'total': len(all_videos),
                    'urls': [v['url'] for v in all_videos]
                })}\n\n"

            elif target_type == "channel":
                meta = {
                    "id": target_id,
                    "title": f"Канал Rutube #{target_id}",
                    "description": "",
                    "videos_count": None,
                    "clean_url": f"https://rutube.ru/channel/{target_id}/"
                }
                yield f"data: {json.dumps({'type': 'meta', 'metadata': meta, 'target': parsed})}\n\n"

                page = 1
                all_videos = []
                seen_ids = set()

                while True:
                    if max_pages and page > max_pages:
                        break

                    yield f"data: {json.dumps({'type': 'progress', 'page': page, 'message': f'Загрузка видео канала (страница {page})...'})}\n\n"
                    page_data = await asyncio.to_thread(parser.fetch_channel_page, target_id, page)

                    page_videos = []
                    for v in page_data["videos"]:
                        if v["id"] not in seen_ids:
                            seen_ids.add(v["id"])
                            page_videos.append(v)
                            all_videos.append(v)

                    num_pages = page_data.get("num_pages")
                    yield f"data: {json.dumps({
                        'type': 'page',
                        'page': page,
                        'total_pages': num_pages,
                        'videos': page_videos,
                        'accumulated': len(all_videos),
                        'has_next': page_data.get('has_next', False)
                    })}\n\n"

                    if not page_data.get("has_next", False) or not page_data.get("videos"):
                        break
                    if num_pages and page >= num_pages:
                        break

                    page += 1
                    await asyncio.sleep(0.08)

                yield f"data: {json.dumps({
                    'type': 'complete',
                    'total': len(all_videos),
                    'urls': [v['url'] for v in all_videos]
                })}\n\n"

        except Exception as e:
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"

    return StreamingResponse(event_generator(), media_type="text/event-stream")

# Mount frontend static files
frontend_dir = BASE_DIR / "frontend"
if frontend_dir.exists():
    app.mount("/static", StaticFiles(directory=str(frontend_dir)), name="static")

@app.get("/")
def serve_index():
    index_path = frontend_dir / "index.html"
    if index_path.exists():
        return FileResponse(str(index_path))
    return JSONResponse({"status": "Server running", "frontend": "index.html not found"})
