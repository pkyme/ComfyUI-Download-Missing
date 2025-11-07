"""Download manager for the Download Missing extension."""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Dict, Optional

import aiofiles
import aiohttp

from .folder_registry import FolderRegistry
from .models import DownloadJob, DownloadStatus


class DownloadManager:
    """Handles queued downloads and progress tracking."""

    DOWNLOAD_CHUNK_SIZE = 4 * 1024 * 1024  # 4MB
    DOWNLOAD_PROGRESS_UPDATE_INTERVAL = 20 * 1024 * 1024  # 20MB

    def __init__(self, session: aiohttp.ClientSession, folder_registry: FolderRegistry):
        self.session = session
        self.folder_registry = folder_registry
        self._tasks: Dict[str, asyncio.Task] = {}
        self._progress: Dict[str, DownloadStatus] = {}

    def get_all_progress(self) -> Dict[str, Dict]:
        return {name: status.to_payload() for name, status in self._progress.items()}

    def get_progress(self, model_name: str) -> Optional[Dict]:
        status = self._progress.get(model_name)
        return status.to_payload() if status else None

    def cancel(self, model_name: str) -> bool:
        task = self._tasks.get(model_name)
        if task:
            task.cancel()
            status = self._progress.get(model_name)
            if status:
                status.status = "cancelled"
            return True
        return False

    def start(self, job: DownloadJob) -> None:
        if job.expected_filename in self._tasks:
            self._tasks[job.expected_filename].cancel()

        task = asyncio.create_task(self._download(job))
        self._tasks[job.expected_filename] = task

    async def _download(self, job: DownloadJob) -> None:
        model_name = job.expected_filename.replace("\\", "/")
        actual_filename = (
            job.actual_filename.replace("\\", "/")
            if job.actual_filename
            else model_name
        )

        if actual_filename != model_name:
            logging.info(
                "[Download Missing Models] Renaming '%s' to '%s'",
                actual_filename,
                model_name,
            )

        self._progress[model_name] = DownloadStatus(
            status="downloading", progress=0.0, downloaded=0, total=0
        )

        dest_folder = self.folder_registry.get_model_destination(job.folder)
        os.makedirs(dest_folder, exist_ok=True)
        dest_path = os.path.join(dest_folder, model_name)
        temp_path = dest_path + ".tmp"

        try:
            async with self.session.get(job.download_url) as response:
                if response.status != 200:
                    raise Exception(f"HTTP {response.status}: {response.reason}")

                total_size = int(response.headers.get("content-length", 0))
                status = self._progress[model_name]
                status.total = total_size
                downloaded = 0
                last_update_bytes = 0

                async with aiofiles.open(temp_path, "wb") as file_handle:
                    async for chunk in response.content.iter_chunked(
                        self.DOWNLOAD_CHUNK_SIZE
                    ):
                        if chunk:
                            await file_handle.write(chunk)
                            downloaded += len(chunk)
                            if (
                                downloaded - last_update_bytes
                                >= self.DOWNLOAD_PROGRESS_UPDATE_INTERVAL
                                or downloaded >= total_size
                            ):
                                status.downloaded = downloaded
                                status.progress = (
                                    round((downloaded / total_size) * 100, 2)
                                    if total_size > 0
                                    else 0.0
                                )
                                last_update_bytes = downloaded

                if os.path.exists(dest_path):
                    os.remove(dest_path)
                os.rename(temp_path, dest_path)

                status.status = "completed"
                status.progress = 100.0
                status.downloaded = downloaded
                logging.info(
                    "[Download Missing Models] Successfully downloaded %s (%.2f MB)",
                    model_name,
                    downloaded / 1024 / 1024,
                )

        except asyncio.CancelledError:
            if os.path.exists(temp_path):
                os.remove(temp_path)
            self._progress[model_name].status = "cancelled"
            logging.info(
                "[Download Missing Models] Download cancelled for %s", model_name
            )
        except Exception as exc:
            if os.path.exists(temp_path):
                os.remove(temp_path)
            status = self._progress[model_name]
            status.status = "error"
            status.error = str(exc)
            logging.error(
                "[Download Missing Models] Error downloading %s: %s",
                model_name,
                exc,
            )
        finally:
            self._tasks.pop(model_name, None)
