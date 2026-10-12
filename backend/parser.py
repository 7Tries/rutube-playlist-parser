"""
Rutube Playlist Parser Module
Fetches all videos from Rutube playlists (and channels) with full pagination and fallback support.
"""

import urllib.request
import urllib.error
import json
import re
import math
import logging
from typing import Dict, Any, List, Optional, AsyncGenerator

logger = logging.getLogger(__name__)

DEFAULT_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
}

def format_duration(seconds: Optional[int]) -> str:
    """Format duration in seconds to HH:MM:SS or MM:SS."""
    if seconds is None or seconds < 0:
        return "--:--"
    hrs = seconds // 3600
    mins = (seconds % 3600) // 60
    secs = seconds % 60
    if hrs > 0:
        return f"{hrs:02d}:{mins:02d}:{secs:02d}"
    return f"{mins:02d}:{secs:02d}"

def extract_rutube_id_and_type(raw_input: str) -> Dict[str, Any]:
    """
    Analyzes input string (URL or ID) and detects target type and ID.
    Supported formats:
    - https://rutube.ru/plst/308547/
    - https://rutube.ru/plst/308547
    - https://rutube.ru/playlist/308547/
    - rutube.ru/plst/308547
    - https://rutube.ru/video/.../?plst=308547
    - 308547 (raw id)
    - https://rutube.ru/channel/639184/
    - https://rutube.ru/u/rutube/
    """
    raw = raw_input.strip()
    
    # 1. Plain numeric ID
    if raw.isdigit():
        return {"type": "playlist", "id": raw, "clean_url": f"https://rutube.ru/plst/{raw}/"}

    # 2. plst/XXXXX or playlist/XXXXX
    m_plst = re.search(r'(?:plst|playlist)[/:]+(\d+)', raw, re.IGNORECASE)
    if m_plst:
        pl_id = m_plst.group(1)
        return {"type": "playlist", "id": pl_id, "clean_url": f"https://rutube.ru/plst/{pl_id}/"}

    # 3. Query param ?plst=XXXX or ?playlist=XXXX
    m_param = re.search(r'[?&](?:plst|playlist)=(\d+)', raw, re.IGNORECASE)
    if m_param:
        pl_id = m_param.group(1)
        return {"type": "playlist", "id": pl_id, "clean_url": f"https://rutube.ru/plst/{pl_id}/"}

    # 4. Channel ID: rutube.ru/channel/12345/
    m_chan = re.search(r'rutube\.ru/channel/(\d+)', raw, re.IGNORECASE)
    if m_chan:
        ch_id = m_chan.group(1)
        return {"type": "channel", "id": ch_id, "clean_url": f"https://rutube.ru/channel/{ch_id}/"}

    # 5. Channel slug: rutube.ru/u/channel_name/
    m_slug = re.search(r'rutube\.ru/u/([a-zA-Z0-9_\-]+)', raw, re.IGNORECASE)
    if m_slug:
        slug = m_slug.group(1)
        return {"type": "channel_slug", "id": slug, "clean_url": f"https://rutube.ru/u/{slug}/"}

    raise ValueError("Не удалось распознать ссылку на плейлист Rutube. Убедитесь, что ссылка содержит /plst/ID или укажите ID плейлиста.")


class RutubeParser:
    def __init__(self, timeout: int = 15):
        self.timeout = timeout

    def _fetch_json(self, url: str, referer: Optional[str] = None) -> Dict[str, Any]:
        """Fetch JSON data from URL with custom headers."""
        headers = dict(DEFAULT_HEADERS)
        if referer:
            headers['Referer'] = referer
            
        req = urllib.request.Request(url, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                data = resp.read().decode('utf-8', errors='replace')
                return json.loads(data)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                raise ValueError("Плейлист или ресурс не найден (404). Проверьте правильность ссылки.")
            elif e.code == 403:
                raise ValueError("Доступ к плейлисту ограничен (403) или требуется авторизация.")
            raise ValueError(f"Ошибка запроса Rutube API (HTTP {e.code}): {e.reason}")
        except urllib.error.URLError as e:
            raise ValueError(f"Сетевая ошибка при подключении к Rutube: {e.reason}")
        except json.JSONDecodeError:
            raise ValueError("Rutube вернул некорректный ответ (не JSON).")

    def _fetch_html(self, url: str) -> str:
        """Fetch HTML content."""
        headers = dict(DEFAULT_HEADERS)
        headers['Accept'] = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=self.timeout) as resp:
            return resp.read().decode('utf-8', errors='replace')

    def resolve_channel_slug(self, slug: str) -> str:
        """Resolves channel slug into numeric channel ID by inspecting the channel page."""
        url = f"https://rutube.ru/u/{slug}/videos/"
        html = self._fetch_html(url)
        # Look for channel_id in reduxState
        m = re.search(r'\"channel_id\"\s*:\s*(\d+)', html)
        if m:
            return m.group(1)
        m = re.search(r'\"channelIdBySlug[^\"]*\":\{\"data\":\{\"channel_id\":(\d+)', html)
        if m:
            return m.group(1)
        m = re.search(r'channel/(\d+)', html)
        if m:
            return m.group(1)
        raise ValueError(f"Не удалось определить ID канала для автора '{slug}'.")

    def get_playlist_metadata(self, playlist_id: str) -> Dict[str, Any]:
        """Fetch playlist header info: title, description, video count, etc."""
        api_url = f"https://rutube.ru/api/playlist/custom/{playlist_id}/?format=json"
        referer = f"https://rutube.ru/plst/{playlist_id}/"
        try:
            info = self._fetch_json(api_url, referer=referer)
            return {
                "id": str(info.get("id", playlist_id)),
                "title": info.get("title") or f"Плейлист #{playlist_id}",
                "description": info.get("description", "") or "",
                "videos_count": info.get("videos_count", 0),
                "thumbnail_url": info.get("thumbnail_url"),
                "total_views": info.get("total_views", 0),
                "author_id": info.get("user_id"),
                "clean_url": f"https://rutube.ru/plst/{playlist_id}/"
            }
        except Exception as e:
            logger.warning(f"Metadata fetch failed for {playlist_id}: {e}")
            return {
                "id": playlist_id,
                "title": f"Плейлист #{playlist_id}",
                "description": "",
                "videos_count": None,
                "thumbnail_url": None,
                "total_views": None,
                "clean_url": f"https://rutube.ru/plst/{playlist_id}/"
            }

    def _normalize_video(self, item: Dict[str, Any], playlist_id: Optional[str] = None) -> Dict[str, Any]:
        """Normalize Rutube raw video JSON into clean standardized structure."""
        vid = item.get("id") or ""
        video_url = item.get("video_url")
        if not video_url and vid:
            video_url = f"https://rutube.ru/video/{vid}/"

        author_data = item.get("author") or {}
        author_name = author_data.get("name") if isinstance(author_data, dict) else None
        author_avatar = author_data.get("avatar_url") if isinstance(author_data, dict) else None
        author_site = author_data.get("site_url") if isinstance(author_data, dict) else None

        duration = item.get("duration")

        return {
            "id": vid,
            "title": (item.get("title") or "Без названия").strip(),
            "url": video_url,
            "duration": duration,
            "duration_formatted": format_duration(duration),
            "thumbnail": item.get("thumbnail_url") or "",
            "views": item.get("hits") or 0,
            "created_ts": item.get("created_ts") or item.get("publication_ts"),
            "author_name": author_name or "Автор",
            "author_avatar": author_avatar or "",
            "author_url": author_site or "",
            "playlist_id": playlist_id,
        }

    def fetch_playlist_page(self, playlist_id: str, page: int = 1) -> Dict[str, Any]:
        """Fetch a single page of playlist videos."""
        api_url = f"https://rutube.ru/api/playlist/custom/{playlist_id}/videos?page={page}&format=json"
        referer = f"https://rutube.ru/plst/{playlist_id}/"
        data = self._fetch_json(api_url, referer=referer)

        raw_results = data.get("results", [])
        videos = [self._normalize_video(item, playlist_id) for item in raw_results]

        has_next = bool(data.get("has_next", False))
        num_pages = data.get("num_pages")
        per_page = data.get("per_page", len(raw_results))

        return {
            "page": page,
            "num_pages": num_pages,
            "per_page": per_page,
            "has_next": has_next,
            "count": len(videos),
            "videos": videos
        }

    def fetch_channel_page(self, channel_id: str, page: int = 1) -> Dict[str, Any]:
        """Fetch a single page of channel videos."""
        api_url = f"https://rutube.ru/api/video/person/{channel_id}/?page={page}&format=json"
        referer = f"https://rutube.ru/channel/{channel_id}/"
        data = self._fetch_json(api_url, referer=referer)

        raw_results = data.get("results", [])
        videos = [self._normalize_video(item) for item in raw_results]

        has_next = bool(data.get("has_next", False))
        num_pages = data.get("num_pages")
        per_page = data.get("per_page", len(raw_results))

        return {
            "page": page,
            "num_pages": num_pages,
            "per_page": per_page,
            "has_next": has_next,
            "count": len(videos),
            "videos": videos
        }

    def fallback_scrape_playlist(self, playlist_id: str) -> List[Dict[str, Any]]:
        """Fallback method: parse window.reduxState or regex from raw HTML."""
        url = f"https://rutube.ru/plst/{playlist_id}/"
        html = self._fetch_html(url)
        videos = []
        seen_ids = set()

        # Try to extract window.reduxState JSON
        m = re.search(r'window\.reduxState\s*=\s*(\{.*?\});\s*</script>', html, re.DOTALL)
        if m:
            try:
                state = json.loads(m.group(1))
                # Traverse reduxState queries
                queries = state.get("api", {}).get("queries", {})
                for k, v in queries.items():
                    data_obj = v.get("data")
                    if isinstance(data_obj, dict) and "results" in data_obj:
                        for item in data_obj["results"]:
                            vid = item.get("id")
                            if vid and vid not in seen_ids:
                                seen_ids.add(vid)
                                videos.append(self._normalize_video(item, playlist_id))
            except Exception as e:
                logger.warning(f"Redux state parse failed: {e}")

        # If redux state had no results, extract via regex
        if not videos:
            pattern = re.findall(r'\"video_url\"\s*:\s*\"(https://rutube\.ru/video/([a-zA-Z0-9]+)/?)\"', html)
            for vurl, vid in pattern:
                if vid not in seen_ids:
                    seen_ids.add(vid)
                    videos.append({
                        "id": vid,
                        "title": f"Rutube Video ({vid[:8]})",
                        "url": vurl,
                        "duration": None,
                        "duration_formatted": "--:--",
                        "thumbnail": "",
                        "views": 0,
                        "created_ts": None,
                        "author_name": "Rutube",
                        "author_avatar": "",
                        "author_url": "",
                        "playlist_id": playlist_id
                    })

        return videos

    def parse_all(self, target_input: str, max_pages: Optional[int] = None) -> Dict[str, Any]:
        """
        Parses all videos from target input.
        Returns complete metadata and all parsed video links.
        """
        parsed_target = extract_rutube_id_and_type(target_input)
        target_type = parsed_target["type"]
        target_id = parsed_target["id"]

        if target_type == "channel_slug":
            target_id = self.resolve_channel_slug(target_id)
            target_type = "channel"

        all_videos: List[Dict[str, Any]] = []
        meta = {}

        if target_type == "playlist":
            meta = self.get_playlist_metadata(target_id)
            page = 1
            expected_pages = None

            while True:
                if max_pages and page > max_pages:
                    break
                try:
                    page_data = self.fetch_playlist_page(target_id, page=page)
                    all_videos.extend(page_data["videos"])
                    expected_pages = page_data.get("num_pages")

                    if not page_data["has_next"] or not page_data["videos"]:
                        break
                    if expected_pages and page >= expected_pages:
                        break
                    page += 1
                except Exception as e:
                    logger.error(f"Error fetching page {page}: {e}")
                    # If page 1 failed, attempt fallback HTML scraping
                    if page == 1 and not all_videos:
                        logger.info("Attempting HTML fallback...")
                        fallback_videos = self.fallback_scrape_playlist(target_id)
                        if fallback_videos:
                            all_videos = fallback_videos
                            break
                    raise

        elif target_type == "channel":
            meta = {
                "id": target_id,
                "title": f"Канал #{target_id}",
                "description": "",
                "videos_count": None,
                "thumbnail_url": None,
                "clean_url": f"https://rutube.ru/channel/{target_id}/"
            }
            page = 1
            while True:
                if max_pages and page > max_pages:
                    break
                page_data = self.fetch_channel_page(target_id, page=page)
                all_videos.extend(page_data["videos"])
                if not page_data["has_next"] or not page_data["videos"]:
                    break
                if page_data.get("num_pages") and page >= page_data["num_pages"]:
                    break
                page += 1

        # Deduplicate videos by ID while preserving order
        unique_videos = []
        seen = set()
        for v in all_videos:
            if v["id"] not in seen:
                seen.add(v["id"])
                unique_videos.append(v)

        # Update metadata video count if available
        meta["total_parsed"] = len(unique_videos)
        if not meta.get("videos_count"):
            meta["videos_count"] = len(unique_videos)

        return {
            "metadata": meta,
            "target": parsed_target,
            "total": len(unique_videos),
            "videos": unique_videos,
            "urls": [v["url"] for v in unique_videos]
        }
