"""HuggingFace search utilities with caching support."""

from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import Dict, List, Optional, Tuple

from huggingface_hub import HfApi

POPULAR_HF_USERS = [
    "Kijai",
    "city96",
    "Comfy-Org",
    "comfyanonymous",
    "lightx2v",
]


class HuggingFaceSearch:
    """Encapsulates repo listing, caching, and filename matching."""

    def __init__(self, cache_file: str):
        self.cache_file = cache_file
        self.cache_data: Dict[str, Dict] = self._load_cache()
        self.repo_files_cache: Dict[str, List[str]] = {}

    async def search_popular_repos(self, filename: str) -> List[dict]:
        """Search through popular repos for a filename."""
        try:
            search_filename = os.path.basename(filename)
            logging.info(
                "[Download Missing Models] Searching for: %s", search_filename
            )

            results: List[dict] = []
            api = HfApi()

            for entry in POPULAR_HF_USERS:
                try:
                    if "/" in entry:
                        repo_data = [(entry, None)]
                    else:
                        repo_data = await self.list_user_repos(entry)

                    for repo_id, repo_last_modified in repo_data:
                        file_list = await self._fetch_repo_files_with_cache(
                            api, repo_id, repo_last_modified
                        )
                        matches = self._match_files_in_repo(
                            file_list, search_filename, repo_id
                        )
                        results.extend(matches)
                except Exception as exc:
                    logging.warning(
                        "[Download Missing Models] Error processing %s: %s",
                        entry,
                        exc,
                    )

            return results
        except Exception as exc:
            logging.error(
                "[Download Missing Models] Error searching popular repos: %s", exc
            )
            return []

    async def search_huggingface_api(
        self, model_name: str, folder_type: Optional[str] = None
    ) -> List[dict]:
        """Public search endpoint used by the API layer."""
        try:
            filename = os.path.basename(model_name.replace("\\", "/"))
            logging.info(
                "[Download Missing Models] Searching HuggingFace for: %s", filename
            )
            results = await self.search_popular_repos(filename)
            if results:
                logging.info(
                    "[Download Missing Models] ✓ Found %d matches in popular repos",
                    len(results),
                )
            else:
                logging.info(
                    "[Download Missing Models] No matches found in popular repos"
                )
            return results
        except Exception as exc:
            logging.error(
                "[Download Missing Models] Error searching HuggingFace: %s", exc
            )
            return []

    async def list_user_repos(self, username: str) -> List[Tuple[str, Optional[str]]]:
        """List repos for a HuggingFace user."""
        try:
            api = HfApi()
            loop = asyncio.get_event_loop()
            models = await loop.run_in_executor(
                None,
                lambda: api.list_models(author=username, expand=["lastModified"]),
            )

            repo_data: List[Tuple[str, Optional[str]]] = []
            for model in models:
                repo_id = model.id
                last_modified = (
                    model.lastModified.isoformat()
                    if hasattr(model, "lastModified") and model.lastModified
                    else None
                )
                repo_data.append((repo_id, last_modified))

            return repo_data
        except Exception as exc:
            logging.warning(
                "[Download Missing Models] Error listing repos for %s: %s",
                username,
                exc,
            )
            return []

    async def _fetch_repo_files_with_cache(
        self, api: HfApi, repo_id: str, repo_last_modified: Optional[str]
    ) -> List[str]:
        """Fetch repository file list with cache support."""
        if repo_last_modified is None:
            try:
                loop = asyncio.get_event_loop()
                repo_info = await loop.run_in_executor(
                    None, api.repo_info, repo_id, "model"
                )
                if hasattr(repo_info, "lastModified") and repo_info.lastModified:
                    repo_last_modified = repo_info.lastModified.isoformat()
            except Exception as exc:
                logging.warning(
                    "[Download Missing Models] Could not fetch lastModified for %s: %s",
                    repo_id,
                    exc,
                )

        cache_data = self.cache_data.get(repo_id)
        file_list: Optional[List[str]] = None

        if cache_data and repo_last_modified:
            if cache_data.get("last_modified") == repo_last_modified:
                file_list = cache_data.get("files", [])

        if file_list is None:
            loop = asyncio.get_event_loop()
            file_list = await loop.run_in_executor(None, api.list_repo_files, repo_id)
            if repo_last_modified:
                self._update_repo_in_cache(repo_id, file_list, repo_last_modified)
            else:
                logging.warning(
                    "[Download Missing Models] ⚠ No last_modified available, not caching"
                )

        self.repo_files_cache[repo_id] = file_list
        return file_list

    def _create_match_result(
        self, repo_id: str, file_path: str, search_filename: str, score: float
    ) -> dict:
        file_basename = os.path.basename(file_path)
        return {
            "repo_id": repo_id,
            "filename": file_path,
            "actual_filename": file_basename,
            "expected_filename": search_filename,
            "file_size": 0,
            "downloads": 0,
            "likes": 0,
            "score": score,
            "download_url": f"https://huggingface.co/{repo_id}/resolve/main/{file_path}",
            "source": "popular_repos",
        }

    def _match_files_in_repo(
        self, file_list: List[str], search_filename: str, repo_id: str
    ) -> List[dict]:
        results: List[dict] = []
        for file_path in file_list:
            file_basename = os.path.basename(file_path)
            if file_basename.lower() == search_filename.lower():
                results.append(
                    self._create_match_result(repo_id, file_path, search_filename, 1.0)
                )

        if not results:
            for file_path in file_list:
                file_basename = os.path.basename(file_path)
                if self._flexible_filename_match(file_basename, search_filename):
                    results.append(
                        self._create_match_result(repo_id, file_path, search_filename, 0.9)
                    )

        return results

    @staticmethod
    def _flexible_filename_match(filename1: str, filename2: str) -> bool:
        normalized1 = filename1.replace("-", "").replace("_", "").replace(" ", "").lower()
        normalized2 = filename2.replace("-", "").replace("_", "").replace(" ", "").lower()
        return normalized1 == normalized2

    def _load_cache(self) -> Dict[str, Dict]:
        try:
            if not os.path.exists(self.cache_file):
                return {}
            with open(self.cache_file, "r", encoding="utf-8") as file_handle:
                return json.load(file_handle)
        except Exception as exc:
            logging.warning(
                "[Download Missing Models] Error loading cache: %s", exc
            )
            return {}

    def _save_cache(self) -> None:
        try:
            temp_file = self.cache_file + ".tmp"
            with open(temp_file, "w", encoding="utf-8") as file_handle:
                json.dump(self.cache_data, file_handle, indent=2)
            os.replace(temp_file, self.cache_file)
        except Exception as exc:
            logging.warning(
                "[Download Missing Models] Error saving cache: %s", exc
            )

    def _update_repo_in_cache(
        self, repo_id: str, files: List[str], last_modified: str
    ) -> None:
        self.cache_data[repo_id] = {"last_modified": last_modified, "files": files}
        self._save_cache()
