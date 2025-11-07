"""
ComfyUI Extension: Download Missing Models

This extension scans workflows for missing models and provides a UI to download them.
"""

import logging
import os
from typing import Dict, Optional

import aiohttp
from aiohttp import web

from server import PromptServer

try:
    from .missing_models.download_manager import DownloadManager
    from .missing_models.folder_registry import FolderRegistry, available_folders
    from .missing_models.hf_search import HuggingFaceSearch
    from .missing_models.models import Correction, DownloadJob, ScanStatus
    from .missing_models.workflow_scanner import WorkflowScanner
except ImportError:
    from missing_models.download_manager import DownloadManager
    from missing_models.folder_registry import FolderRegistry, available_folders
    from missing_models.hf_search import HuggingFaceSearch
    from missing_models.models import Correction, DownloadJob, ScanStatus
    from missing_models.workflow_scanner import WorkflowScanner


WEB_DIRECTORY = "./web"
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]


class MissingModelsExtension:
    """Extension to find and download missing models from workflows."""

    HTTP_CONNECTION_LIMIT = 10
    HTTP_CONNECTION_LIMIT_PER_HOST = 5
    DNS_CACHE_TTL = 300
    CONNECT_TIMEOUT = 60
    SOCKET_READ_TIMEOUT = 120

    def __init__(self):
        self.routes = PromptServer.instance.routes

        connector = aiohttp.TCPConnector(
            limit=self.HTTP_CONNECTION_LIMIT,
            limit_per_host=self.HTTP_CONNECTION_LIMIT_PER_HOST,
            ttl_dns_cache=self.DNS_CACHE_TTL,
            enable_cleanup_closed=True,
        )
        timeout = aiohttp.ClientTimeout(
            total=None,
            connect=self.CONNECT_TIMEOUT,
            sock_read=self.SOCKET_READ_TIMEOUT,
        )
        self.session = aiohttp.ClientSession(
            connector=connector,
            timeout=timeout,
            raise_for_status=False,
        )

        self.extension_dir = os.path.dirname(os.path.realpath(__file__))
        cache_file = os.path.join(self.extension_dir, "repo_cache.json")

        self.scan_progress: Dict[str, ScanStatus] = {}
        self.folder_registry = FolderRegistry(self.extension_dir)
        self.hf_search = HuggingFaceSearch(cache_file)
        self.scanner = WorkflowScanner(
            folder_registry=self.folder_registry,
            hf_search=self.hf_search,
            session=self.session,
            scan_progress=self.scan_progress,
        )
        self.download_manager = DownloadManager(self.session, self.folder_registry)

        self.setup_routes()
        logging.info(
            "[Download Missing Models] Extension initialized with connection pooling"
        )

    # ---------------------------------------------------------------------#
    # Route registration and helpers
    # ---------------------------------------------------------------------#

    def setup_routes(self):
        """Register API routes."""
        self.routes.post("/download-missing/scan")(
            self.handle_api_errors(self.handle_scan_workflow)
        )
        self.routes.post("/download-missing/download")(
            self.handle_api_errors(self.handle_download_model)
        )
        self.routes.get("/download-missing/status")(
            self.handle_api_errors(self.handle_get_status)
        )
        self.routes.get("/download-missing/status/{model_name}")(
            self.handle_api_errors(self.handle_get_model_status)
        )
        self.routes.get("/download-missing/scan-progress")(
            self.handle_api_errors(self.handle_get_scan_progress)
        )
        self.routes.post("/download-missing/cancel")(
            self.handle_api_errors(self.handle_cancel_download)
        )
        self.routes.post("/download-missing/search-hf")(
            self.handle_api_errors(self.handle_search_huggingface)
        )
        self.routes.get("/download-missing/folders")(
            self.handle_api_errors(self.handle_get_available_folders)
        )

    @staticmethod
    def handle_api_errors(handler):
        """Decorator for route handlers to provide consistent error handling."""

        async def wrapper(request):
            try:
                return await handler(request)
            except Exception as exc:  # pragma: no cover - defensive logging
                logging.error(
                    "[Download Missing Models] API error in %s: %s",
                    handler.__name__,
                    exc,
                )
                return web.json_response(
                    {"status": "error", "message": str(exc)}, status=500
                )

        wrapper.__name__ = handler.__name__
        wrapper.__doc__ = handler.__doc__
        return wrapper

    @staticmethod
    def _normalize_path(path: str) -> str:
        return path.replace("\\", "/")

    @staticmethod
    def _create_response(
        status: str = "success", data: Optional[dict] = None, message: Optional[str] = None
    ) -> web.Response:
        payload = {"status": status}
        if message:
            payload["message"] = message
        if data:
            payload.update(data)
        return web.json_response(payload)

    # ---------------------------------------------------------------------#
    # Route handlers
    # ---------------------------------------------------------------------#

    async def handle_scan_workflow(self, request):
        """Scan workflow for missing models."""
        data = await request.json()
        workflow = data.get("workflow", {})

        result = await self.scanner.find_missing_models(workflow)
        payload = result.to_payload()
        payload.update(
            {
                "missing_count": len(payload["missing_models"]),
                "not_found_count": len(payload["not_found_models"]),
                "corrected_count": len(payload["corrected_models"]),
            }
        )
        return self._create_response(data=payload)

    async def handle_download_model(self, request):
        """Start downloading a model."""
        data = await request.json()
        model_name = data.get("model_name")
        model_url = data.get("model_url")
        model_folder = data.get("model_folder")
        expected_filename = data.get("expected_filename") or model_name
        actual_filename = data.get("actual_filename") or expected_filename
        node_id = data.get("node_id")
        node_type = data.get("node_type")
        correction_type = data.get("correction_type")
        widget_index = data.get("widget_index")
        property_index = data.get("property_index")

        if not model_name or not model_url:
            return self._create_response(
                status="error",
                message="Missing model_name or model_url",
            )

        if not model_folder or model_folder == "MANUAL_SELECTION_REQUIRED":
            return self._create_response(
                status="error",
                message="Folder must be specified for this model. Please select a folder from the dropdown.",
            )

        job = DownloadJob(
            expected_filename=self._normalize_path(expected_filename),
            download_url=model_url,
            folder=model_folder,
            actual_filename=self._normalize_path(actual_filename),
        )
        self.download_manager.start(job)

        correction_payload = None
        if node_id is not None and correction_type:
            correction = Correction(
                name=os.path.basename(self._normalize_path(model_name)),
                old_path=model_name,
                new_path=expected_filename,
                folder=model_folder,
                directory=model_folder,
                node_id=node_id,
                node_type=node_type,
                correction_type=correction_type,
                widget_index=widget_index,
                property_index=property_index,
            )
            correction_payload = correction.to_payload()

        return self._create_response(
            data={
                "message": f"Download started for {expected_filename}",
                "correction": correction_payload,
            }
        )

    async def handle_get_status(self, _request):
        """Get download progress for all models."""
        return self._create_response(
            data={"downloads": self.download_manager.get_all_progress()}
        )

    async def handle_get_model_status(self, request):
        """Get download progress for a specific model."""
        model_name = request.match_info.get("model_name")
        progress = self.download_manager.get_progress(model_name)
        if progress:
            return self._create_response(data={"progress": progress})
        return self._create_response(
            status="error", message="Model not found in download queue"
        )

    async def handle_get_scan_progress(self, _request):
        """Get scanning progress."""
        progress_data = {
            scan_id: status.to_payload() for scan_id, status in self.scan_progress.items()
        }
        return self._create_response(data={"progress": progress_data})

    async def handle_cancel_download(self, request):
        """Cancel a running download."""
        data = await request.json()
        model_name = data.get("model_name")
        if model_name and self.download_manager.cancel(model_name):
            return self._create_response(
                data={"message": f"Download cancelled for {model_name}"}
            )
        return self._create_response(
            status="error", message="No active download found"
        )

    async def handle_search_huggingface(self, request):
        """Search HuggingFace for a model."""
        data = await request.json()
        model_name = data.get("model_name")
        folder_type = data.get("folder_type")

        if not model_name:
            return self._create_response(
                status="error", message="Missing model_name parameter"
            )

        results = await self.hf_search.search_huggingface_api(model_name, folder_type)
        return self._create_response(data={"results": results, "count": len(results)})

    async def handle_get_available_folders(self, _request):
        """Get list of available model folders from ComfyUI."""
        return self._create_response(data={"folders": available_folders()})

    async def cleanup(self):
        """Clean up resources on shutdown."""
        if self.session and not self.session.closed:
            await self.session.close()
            logging.info("[Download Missing Models] ClientSession closed")


extension = MissingModelsExtension()
