"""
ComfyUI Extension: Download Missing Models

This extension scans workflows for missing models and provides a UI to download them.
"""

import os
import re
import json
import asyncio
import aiohttp
import aiofiles
import logging
from pathlib import Path
from typing import Dict, List, Optional, Tuple
from aiohttp import web
import folder_paths
from server import PromptServer

try:
    from huggingface_hub import HfApi
    HF_API_AVAILABLE = True
except ImportError:
    HF_API_AVAILABLE = False
    logging.warning("[Download Missing Models] huggingface_hub not installed. Install with: pip install huggingface_hub")

# Global state for download progress
download_progress = {}
download_tasks = {}

# Global state for scanning progress
scan_progress = {}

# Popular HuggingFace users/repos to search for missing models
# Can specify either:
#   - A username (e.g., "Kijai") - searches all models for that user
#   - A specific repo (e.g., "Kijai/WanVideo_comfy") - searches only that repo
POPULAR_HF_USERS = [
    "Kijai",
    "city96",
    "Comfy-Org",
    "comfyanonymous",
    "lightx2v",
]

# Node type to folder mapping
# Users can extend this dictionary with their specific node types
NODE_TYPE_TO_FOLDER = {
    # Example mappings (user should customize):
    # 'CheckpointLoaderSimple': 'checkpoints',
    # 'LoraLoader': 'loras',
    # 'VAELoader': 'vae',
    # 'ControlNetLoader': 'controlnet',
    'WanVideoModelLoader': 'diffusion_models',
    'LoadWanVideoT5TextEncoder': 'text_encoders',
}

class MissingModelsExtension:
    """Extension to find and download missing models from workflows"""

    def __init__(self):
        self.routes = PromptServer.instance.routes
        # Create shared ClientSession for connection pooling
        connector = aiohttp.TCPConnector(
            limit=10,  # Maximum number of connections
            limit_per_host=5,  # Maximum connections per host
            ttl_dns_cache=300,  # DNS cache TTL in seconds
            enable_cleanup_closed=True
        )
        timeout = aiohttp.ClientTimeout(
            total=None,  # No total timeout (handled per-download)
            connect=60,  # Connection timeout
            sock_read=120  # Socket read timeout (increased for large files)
        )
        self.session = aiohttp.ClientSession(
            connector=connector,
            timeout=timeout,
            raise_for_status=False
        )
        # Cache for HuggingFace repo file lists (repo_id -> list of file paths)
        self.repo_files_cache = {}

        # Setup single disk cache file
        extension_dir = os.path.dirname(os.path.realpath(__file__))
        self.cache_file = os.path.join(extension_dir, 'repo_cache.json')

        # In-memory cache loaded from disk
        self.cache_data = {}

        self.setup_routes()
        logging.info("[Download Missing Models] Extension initialized with connection pooling")

    def setup_routes(self):
        """Register API routes"""

        @self.routes.post("/download-missing/scan")
        async def scan_workflow(request):
            """Scan workflow for missing models"""
            try:
                data = await request.json()
                workflow = data.get('workflow', {})

                result = await self.find_missing_models(workflow)

                return web.json_response({
                    'status': 'success',
                    'missing_models': result['missing_models'],
                    'not_found_models': result['not_found_models'],
                    'corrected_models': result['corrected_models'],
                    'missing_count': len(result['missing_models']),
                    'not_found_count': len(result['not_found_models']),
                    'corrected_count': len(result['corrected_models'])
                })
            except Exception as e:
                logging.error(f"[Download Missing Models] Error scanning workflow: {e}")
                return web.json_response({
                    'status': 'error',
                    'message': str(e)
                }, status=500)

        @self.routes.post("/download-missing/download")
        async def download_model(request):
            """Start downloading a model"""
            try:
                data = await request.json()
                model_name = data.get('model_name')
                model_url = data.get('model_url')
                model_folder = data.get('model_folder')
                expected_filename = data.get('expected_filename')  # What the workflow needs
                actual_filename = data.get('actual_filename')  # What HuggingFace has (if different)
                node_id = data.get('node_id')
                node_type = data.get('node_type')
                correction_type = data.get('correction_type')
                widget_index = data.get('widget_index')
                property_index = data.get('property_index')

                if not model_name or not model_url:
                    return web.json_response({
                        'status': 'error',
                        'message': 'Missing model_name or model_url'
                    }, status=400)

                if not model_folder or model_folder == 'MANUAL_SELECTION_REQUIRED':
                    return web.json_response({
                        'status': 'error',
                        'message': 'Folder must be specified for this model. Please select a folder from the dropdown.'
                    }, status=400)

                # If expected_filename not provided, use model_name
                if not expected_filename:
                    expected_filename = model_name

                # If actual_filename not provided, it's the same as expected
                if not actual_filename:
                    actual_filename = expected_filename

                # Cancel existing download if running
                if expected_filename in download_tasks:
                    download_tasks[expected_filename].cancel()

                # Start download task
                task = asyncio.create_task(
                    self.download_model_async(expected_filename, model_url, model_folder, actual_filename)
                )
                download_tasks[expected_filename] = task

                # Generate correction for node reference
                correction = None
                if node_id is not None and correction_type:
                    correction = {
                        'name': os.path.basename(model_name.replace('\\', '/')),
                        'old_path': model_name,
                        'new_path': expected_filename,
                        'folder': model_folder,
                        'directory': model_folder,
                        'node_id': node_id,
                        'node_type': node_type,
                        'correction_type': correction_type
                    }
                    if correction_type == 'widget' and widget_index is not None:
                        correction['widget_index'] = widget_index
                    elif correction_type == 'property' and property_index is not None:
                        correction['property_index'] = property_index

                return web.json_response({
                    'status': 'success',
                    'message': f'Download started for {expected_filename}',
                    'correction': correction
                })
            except Exception as e:
                logging.error(f"[Download Missing Models] Error starting download: {e}")
                return web.json_response({
                    'status': 'error',
                    'message': str(e)
                }, status=500)

        @self.routes.get("/download-missing/status")
        async def get_status(request):
            """Get download progress for all models"""
            return web.json_response({
                'status': 'success',
                'downloads': download_progress
            })

        @self.routes.get("/download-missing/status/{model_name}")
        async def get_model_status(request):
            """Get download progress for a specific model"""
            model_name = request.match_info.get("model_name")

            if model_name in download_progress:
                return web.json_response({
                    'status': 'success',
                    'progress': download_progress[model_name]
                })
            else:
                return web.json_response({
                    'status': 'error',
                    'message': 'Model not found in download queue'
                }, status=404)

        @self.routes.get("/download-missing/scan-progress")
        async def get_scan_progress(request):
            """Get scanning progress"""
            return web.json_response({
                'status': 'success',
                'progress': scan_progress
            })

        @self.routes.post("/download-missing/cancel")
        async def cancel_download(request):
            """Cancel a running download"""
            try:
                data = await request.json()
                model_name = data.get('model_name')

                if model_name in download_tasks:
                    download_tasks[model_name].cancel()
                    if model_name in download_progress:
                        download_progress[model_name]['status'] = 'cancelled'

                    return web.json_response({
                        'status': 'success',
                        'message': f'Download cancelled for {model_name}'
                    })
                else:
                    return web.json_response({
                        'status': 'error',
                        'message': 'No active download found'
                    }, status=404)
            except Exception as e:
                logging.error(f"[Download Missing Models] Error cancelling download: {e}")
                return web.json_response({
                    'status': 'error',
                    'message': str(e)
                }, status=500)

        @self.routes.post("/download-missing/search-hf")
        async def search_huggingface(request):
            """Search HuggingFace for a model"""
            try:
                data = await request.json()
                model_name = data.get('model_name')
                folder_type = data.get('folder_type')

                if not model_name:
                    return web.json_response({
                        'status': 'error',
                        'message': 'Missing model_name parameter'
                    }, status=400)

                # Search HuggingFace
                results = await self.search_huggingface_api(model_name, folder_type)

                return web.json_response({
                    'status': 'success',
                    'results': results,
                    'count': len(results)
                })
            except Exception as e:
                logging.error(f"[Download Missing Models] Error searching HuggingFace: {e}")
                return web.json_response({
                    'status': 'error',
                    'message': str(e)
                }, status=500)

        @self.routes.get("/download-missing/folders")
        async def get_available_folders(request):
            """Get list of available model folders from ComfyUI"""
            try:
                available_folders = []
                for folder_name in folder_paths.folder_names_and_paths.keys():
                    available_folders.append(folder_name)

                return web.json_response({
                    'status': 'success',
                    'folders': sorted(available_folders)
                })
            except Exception as e:
                logging.error(f"[Download Missing Models] Error getting folders: {e}")
                return web.json_response({
                    'status': 'error',
                    'message': str(e)
                }, status=500)

    async def find_missing_models(self, workflow: dict) -> dict:
        """
        Scan workflow and find missing models, also auto-correct paths if model exists

        Returns dict with:
            - missing_models: list of models ready to download (have URLs)
            - not_found_models: list of models that couldn't be resolved
            - corrected_models: list of models that were found at different paths
        """
        # Initialize progress tracking
        scan_id = 'current'
        scan_progress[scan_id] = {
            'status': 'scanning',
            'stage': 'nodes',
            'progress': 0,
            'message': 'Scanning workflow nodes...'
        }

        missing_models = []
        missing_no_url = []
        corrected_models = []
        nodes = workflow.get('nodes', [])
        total_nodes = len(nodes)

        for node_idx, node in enumerate(nodes):
            # Check node properties for embedded model info
            properties = node.get('properties', {})

            if 'models' in properties and isinstance(properties['models'], list):
                for property_idx, model_info in enumerate(properties['models']):
                    model_name = model_info.get('name')
                    model_url = model_info.get('url')
                    # Try 'directory' first, then 'folder' as fallback
                    model_folder = model_info.get('directory') or model_info.get('folder', 'checkpoints')

                    if model_name:
                        if not self.is_model_installed(model_name, model_folder):
                            # Try to find model at different path
                            actual_path = self.find_actual_model_path(model_name, model_folder)
                            if actual_path:
                                # Model exists at different path - update and record correction
                                model_info['name'] = actual_path
                                corrected_models.append({
                                    'name': os.path.basename(model_name.replace('\\', '/')),
                                    'old_path': model_name,
                                    'new_path': actual_path,
                                    'folder': model_folder,
                                    'directory': model_folder,
                                    'node_id': node.get('id'),
                                    'node_type': node.get('type'),
                                    'correction_type': 'property',
                                    'property_index': property_idx
                                })
                            elif model_url:
                                # Model truly missing and has URL
                                missing_models.append({
                                    'name': model_name,
                                    'url': model_url,
                                    'folder': model_folder,
                                    'directory': model_folder,  # Add directory field for UI
                                    'node_id': node.get('id'),
                                    'node_type': node.get('type'),
                                    'correction_type': 'property',
                                    'property_index': property_idx
                                })

            # Only check widgets_values if no models were found in properties
            # This prevents duplicates when a node has both properties.models and widgets_values
            if 'models' not in properties or not isinstance(properties.get('models'), list):
                widgets_values = node.get('widgets_values', [])
                node_type = node.get('type', '')

                logging.debug(f"[Download Missing Models] Scanning node {node.get('id')} ({node_type}), widgets_values: {widgets_values}")

                # Generic scanning: check all widget values for model files
                for widget_idx, widget_value in enumerate(widgets_values):
                    if not self.detect_model_file(widget_value):
                        continue

                    model_name = widget_value

                    # Try to find the model in all folders
                    result = self.find_model_in_all_folders(model_name)

                    if result:
                        actual_path, folder_type = result
                        # Check if it's at the exact path specified
                        if actual_path.replace('\\', '/') == model_name.replace('\\', '/'):
                            # Model is already at correct path, skip
                            logging.info(f"[Download Missing Models] ✓ Model already at correct path, skipping: {actual_path}")
                            continue
                        else:
                            # Model exists but at different path - update widget and record correction
                            widgets_values[widget_idx] = actual_path
                            corrected_models.append({
                                'name': os.path.basename(model_name.replace('\\', '/')),
                                'old_path': model_name,
                                'new_path': actual_path,
                                'folder': folder_type,
                                'directory': folder_type,
                                'node_id': node.get('id'),
                                'node_type': node_type,
                                'correction_type': 'widget',
                                'widget_index': widget_idx
                            })
                            logging.info(f"[Download Missing Models] Corrected path: {model_name} -> {actual_path} (node {node.get('id')}, widget {widget_idx})")
                    else:
                        # Model not found anywhere - try to find URL
                        logging.debug(f"[Download Missing Models] Model not found: {model_name}")
                        model_url = self.find_model_url(workflow, model_name, node)

                        # Determine folder type from node type
                        folder_type = self.get_folder_from_node_type(node_type)
                        if folder_type is None:
                            folder_type = 'MANUAL_SELECTION_REQUIRED'

                        if model_url:
                            # Has URL - can download
                            missing_models.append({
                                'name': model_name,
                                'url': model_url,
                                'folder': folder_type,
                                'directory': folder_type,
                                'needs_folder_selection': folder_type == 'MANUAL_SELECTION_REQUIRED',
                                'node_id': node.get('id'),
                                'node_type': node_type,
                                'correction_type': 'widget',
                                'widget_index': widget_idx
                            })
                        else:
                            # No URL - needs HF search
                            missing_no_url.append({
                                'name': model_name,
                                'folder': folder_type,
                                'directory': folder_type,
                                'needs_folder_selection': folder_type == 'MANUAL_SELECTION_REQUIRED',
                                'node_id': node.get('id'),
                                'node_type': node_type,
                                'correction_type': 'widget',
                                'widget_index': widget_idx
                            })

            # Update progress for each node
            if total_nodes > 0:
                node_progress = int((node_idx + 1) / total_nodes * 33)
                scan_progress[scan_id].update({
                    'progress': node_progress,
                    'message': f'Scanning workflow nodes ({node_idx + 1}/{total_nodes})...'
                })

        # Update progress: nodes scanned
        scan_progress[scan_id].update({
            'progress': 33,
            'stage': 'metadata',
            'message': 'Checking workflow metadata...'
        })

        # Check workflow-level metadata
        extra = workflow.get('extra', {})
        if 'model_urls' in extra:
            for model_name, model_data in extra['model_urls'].items():
                # Try 'directory' first, then 'folder' as fallback
                model_folder = model_data.get('directory') or model_data.get('folder', 'checkpoints')
                if not self.is_model_installed(model_name, model_folder):
                    # Try to find model at different path
                    actual_path = self.find_actual_model_path(model_name, model_folder)
                    if actual_path:
                        # Model exists at different path - record correction
                        # Note: Can't update workflow metadata directly as it's not linked to nodes
                        corrected_models.append({
                            'name': os.path.basename(model_name.replace('\\', '/')),
                            'old_path': model_name,
                            'new_path': actual_path,
                            'folder': model_folder,
                            'directory': model_folder,
                            'node_id': None,
                            'node_type': 'metadata'
                        })
                    else:
                        # Model truly missing
                        missing_models.append({
                            'name': model_name,
                            'url': model_data.get('url'),
                            'folder': model_folder,
                            'directory': model_folder,  # Add directory field for UI
                            'node_id': None,
                            'node_type': 'metadata'
                        })

        # Remove duplicates from both lists
        seen_missing = set()
        unique_missing = []
        for model in missing_models:
            key = (model['name'], model['folder'])
            if key not in seen_missing:
                seen_missing.add(key)
                unique_missing.append(model)

        # For corrections, deduplicate by node location, not by model file
        # This ensures all nodes get corrected even if they reference the same model
        seen_corrected = set()
        unique_corrected = []
        for model in corrected_models:
            # Use node_id + correction location as key
            key = (
                model['node_id'],
                model.get('correction_type'),
                model.get('widget_index'),
                model.get('property_index')
            )
            if key not in seen_corrected:
                seen_corrected.add(key)
                unique_corrected.append(model)

        # For missing_no_url, also deduplicate by node location
        seen_no_url = set()
        unique_no_url = []
        for model in missing_no_url:
            key = (model['node_id'], model['name'])
            if key not in seen_no_url:
                seen_no_url.add(key)
                unique_no_url.append(model)

        # Update progress: resolving URLs
        scan_progress[scan_id].update({
            'progress': 66,
            'stage': 'resolving',
            'message': 'Resolving model URLs...'
        })

        # Attempt to resolve URLs for models without them using unified resolution strategy
        # This includes: workflow notes, HuggingFace search, etc.
        resolved_models, not_found_models = await self.resolve_missing_model_urls(workflow, unique_no_url)

        # Combine models that already had URLs with newly resolved ones
        all_ready_to_download = unique_missing + resolved_models

        # Update progress: complete
        scan_progress[scan_id].update({
            'progress': 100,
            'stage': 'complete',
            'status': 'complete',
            'message': 'Scan complete'
        })

        return {
            'missing_models': all_ready_to_download,
            'not_found_models': not_found_models,
            'corrected_models': unique_corrected
        }

    def find_model_url(self, workflow: dict, model_name: str, node: dict) -> Optional[str]:
        """Try to find model URL from workflow metadata or node properties"""
        # Check node properties first
        properties = node.get('properties', {})
        if 'model_url' in properties:
            return properties['model_url']

        # Check workflow extra data
        extra = workflow.get('extra', {})
        if 'model_urls' in extra:
            model_urls = extra['model_urls']
            if model_name in model_urls:
                return model_urls[model_name].get('url')

        return None

    def resolve_folder_key(self, folder_type: str) -> str:
        """
        Resolve a folder type to the actual ComfyUI folder key.

        This handles cases where the extension uses user-friendly names
        (like 'diffusion_models') but ComfyUI has registered the folder
        with a different key (like 'unet').

        Args:
            folder_type: The folder type to resolve

        Returns:
            The actual ComfyUI folder key to use
        """
        # Map of user-friendly names to potential ComfyUI keys (in priority order)
        folder_map = {
            'checkpoints': ['checkpoints'],
            'loras': ['loras'],
            'lora': ['loras'],
            'vae': ['vae'],
            'controlnet': ['controlnet'],
            'clip': ['text_encoders', 'clip'],
            'clip_vision': ['clip_vision'],
            'unet': ['unet', 'diffusion_models'],
            'diffusion_models': ['diffusion_models', 'unet'],
            'embeddings': ['embeddings'],
            'hypernetworks': ['hypernetworks'],
            'upscale_models': ['upscale_models'],
        }

        # Get list of potential keys to try
        potential_keys = folder_map.get(folder_type.lower(), [folder_type])

        # Check which key ComfyUI actually has registered
        for key in potential_keys:
            if key in folder_paths.folder_names_and_paths:
                return key

        # If none found, return the first potential key (fallback)
        return potential_keys[0] if potential_keys else folder_type

    def is_model_installed(self, model_name: str, folder_type: str) -> bool:
        """Check if model exists at the exact specified path"""
        try:
            # Resolve folder type to actual ComfyUI key
            folder_key = self.resolve_folder_key(folder_type)

            if folder_key in folder_paths.folder_names_and_paths:
                file_list = folder_paths.get_filename_list(folder_key)

                # Normalize model_name path separators
                normalized_model_name = model_name.replace('\\', '/')

                # Check for exact match only (including subdirectory path if specified)
                for filename in file_list:
                    normalized_filename = filename.replace('\\', '/')
                    if normalized_filename == normalized_model_name:
                        return True

            return False
        except Exception as e:
            logging.error(f"[Download Missing Models] Error checking model installation: {e}")
            return False

    def find_actual_model_path(self, model_name: str, folder_type: str) -> Optional[str]:
        """
        Find the actual path of a model if it exists with a different subdirectory.

        Args:
            model_name: The model name/path to search for
            folder_type: The folder type (checkpoints, loras, etc.)

        Returns:
            The actual path of the model if found, None otherwise
        """
        try:
            # Resolve folder type to actual ComfyUI key
            folder_key = self.resolve_folder_key(folder_type)

            if folder_key not in folder_paths.folder_names_and_paths:
                return None

            # Extract just the filename (remove any subdirectory)
            filename_only = os.path.basename(model_name.replace('\\', '/'))

            # Get all available models
            file_list = folder_paths.get_filename_list(folder_key)

            # Search for matches by filename
            for available_path in file_list:
                available_filename = os.path.basename(available_path.replace('\\', '/'))
                if available_filename == filename_only:
                    return available_path

            return None
        except Exception as e:
            logging.error(f"[Download Missing Models] Error finding model path: {e}")
            return None

    def detect_model_file(self, value) -> bool:
        """
        Check if a value looks like a model file.

        Args:
            value: The value to check (usually from widgets_values)

        Returns:
            True if it appears to be a model file, False otherwise
        """
        if not isinstance(value, str):
            return False

        if len(value) < 5:  # Too short to be a valid filename
            return False

        # Check for common model file extensions
        model_extensions = [
            '.safetensors',
            '.ckpt',
            '.pt',
            '.pth',
            '.bin',
            '.sft',
            '.gguf'
        ]

        value_lower = value.lower()
        return any(value_lower.endswith(ext) for ext in model_extensions)

    def find_model_in_all_folders(self, model_name: str) -> Optional[Tuple[str, str]]:
        """
        Search for a model across all folder types.

        Args:
            model_name: The model name/path to search for

        Returns:
            Tuple of (actual_path, folder_type) if found, None otherwise
        """
        try:
            # Extract just the filename
            filename_only = os.path.basename(model_name.replace('\\', '/'))

            # Get all registered folders from ComfyUI
            all_registered_folders = list(folder_paths.folder_names_and_paths.keys())
            logging.debug(f"[Download Missing Models] All registered ComfyUI folders: {all_registered_folders}")

            # Folder types to search (we'll resolve these to actual keys)
            folder_types = [
                'checkpoints',
                'loras',
                'vae',
                'controlnet',
                'clip',
                'unet',
                'diffusion_models',
                'embeddings',
                'hypernetworks',
                'upscale_models',
            ]

            # Add all other registered folders
            for folder_key in all_registered_folders:
                if folder_key not in folder_types:
                    folder_types.append(folder_key)

            # Use path heuristics to prioritize search order
            search_order = folder_types
            model_name_lower = model_name.lower()

            # Prioritize based on path hints
            if 'lora' in model_name_lower:
                search_order = ['loras'] + [x for x in search_order if x != 'loras']
            elif 'vae' in model_name_lower:
                search_order = ['vae'] + [x for x in search_order if x != 'vae']
            elif 'checkpoint' in model_name_lower or 'ckpt' in model_name_lower:
                search_order = ['checkpoints'] + [x for x in search_order if x != 'checkpoints']
            elif 'controlnet' in model_name_lower:
                search_order = ['controlnet'] + [x for x in search_order if x != 'controlnet']
            elif 'clip' in model_name_lower or 'text_encoder' in model_name_lower:
                search_order = ['clip'] + [x for x in search_order if x != 'clip']
            elif 'unet' in model_name_lower or 'diffusion' in model_name_lower:
                search_order = ['unet'] + [x for x in search_order if x != 'unet']

            # Search each folder type
            for folder_type in search_order:
                # Resolve to actual ComfyUI key
                folder_key = self.resolve_folder_key(folder_type)

                if folder_key not in folder_paths.folder_names_and_paths:
                    continue

                file_list = folder_paths.get_filename_list(folder_key)

                # First try exact match with full path
                normalized_model = model_name.replace('\\', '/')
                for available_path in file_list:
                    normalized_available = available_path.replace('\\', '/')
                    if normalized_available == normalized_model:
                        return (available_path, folder_type)

                # Then try matching by filename only
                for available_path in file_list:
                    available_filename = os.path.basename(available_path.replace('\\', '/'))
                    if available_filename == filename_only:
                        return (available_path, folder_type)

            return None
        except Exception as e:
            logging.error(f"[Download Missing Models] Error searching all folders: {e}")
            return None

    def get_folder_from_node_type(self, node_type: str) -> Optional[str]:
        """
        Determine model folder based on node type.

        Args:
            node_type: The type of the ComfyUI node

        Returns:
            Folder name if determined, None if manual selection needed
        """
        if not node_type:
            return None

        # 1. Check direct mapping (case-insensitive, whitespace-tolerant)
        node_type_normalized = node_type.strip().lower()
        for mapped_type, folder in NODE_TYPE_TO_FOLDER.items():
            if mapped_type.strip().lower() == node_type_normalized:
                return folder

        # 2. Check node type name for keywords (heuristic)
        node_lower = node_type.lower()

        if 'checkpoint' in node_lower:
            return 'checkpoints'
        elif 'lora' in node_lower:
            return 'loras'
        elif 'vae' in node_lower:
            return 'vae'
        elif 'controlnet' in node_lower:
            return 'controlnet'
        elif 'clip' in node_lower and 'vision' not in node_lower:
            return 'text_encoders'
        elif 'clip_vision' in node_lower or 'clipvision' in node_lower:
            return 'clip_vision'
        elif 'unet' in node_lower or 'diffusion' in node_lower:
            return 'diffusion_models'
        elif 'upscale' in node_lower or 'upscaler' in node_lower:
            return 'upscale_models'
        elif 'embedding' in node_lower:
            return 'embeddings'
        elif 'hypernetwork' in node_lower:
            return 'hypernetworks'

        # Unknown node type - needs manual selection
        return None

    def get_model_destination(self, folder_type: str) -> str:
        """Get the full path to the model folder"""
        # Resolve folder type to actual ComfyUI key
        folder_key = self.resolve_folder_key(folder_type)

        if folder_key in folder_paths.folder_names_and_paths:
            folders = folder_paths.get_folder_paths(folder_key)
            if folders:
                # Prefer the folder path that matches the folder_type name
                # (e.g., if folder_type is "diffusion_models", prefer models/diffusion_models/ over models/unet/)
                for folder in folders:
                    if folder.rstrip(os.sep).endswith(folder_type):
                        return folder

                # If no match, use first folder path (convention)
                return folders[0]

        # Fallback
        models_dir = os.path.join(os.path.dirname(os.path.realpath(__file__)), '..', '..', 'models')
        return os.path.join(models_dir, folder_type)

    async def download_model_async(self, model_name: str, model_url: str, model_folder: str, actual_filename: str = None):
        """
        Download model with progress tracking.

        Args:
            model_name: The expected filename (what the workflow needs)
            model_url: URL to download from
            model_folder: Destination folder type
            actual_filename: The actual filename in HuggingFace (if different from expected)
        """
        global download_progress

        # If no actual_filename provided, it's the same as model_name
        if not actual_filename:
            actual_filename = model_name

        # Log if we're doing a rename
        if actual_filename != model_name:
            logging.info(f"[Download Missing Models] Renaming '{actual_filename}' to '{model_name}'")

        # Initialize progress
        download_progress[model_name] = {
            'status': 'downloading',
            'progress': 0,
            'downloaded': 0,
            'total': 0,
            'error': None
        }

        try:
            # Get destination folder
            dest_folder = self.get_model_destination(model_folder)
            os.makedirs(dest_folder, exist_ok=True)

            dest_path = os.path.join(dest_folder, model_name)
            temp_path = dest_path + '.tmp'

            # Download with progress using shared session
            async with self.session.get(model_url) as response:
                if response.status != 200:
                    raise Exception(f"HTTP {response.status}: {response.reason}")

                total_size = int(response.headers.get('content-length', 0))
                download_progress[model_name]['total'] = total_size

                downloaded = 0
                last_update_bytes = 0
                chunk_size = 4194304  # 4MB chunks (optimized for large files)
                update_interval_bytes = 20 * 1024 * 1024  # Update every 20MB

                # Use async file I/O to avoid blocking the event loop
                async with aiofiles.open(temp_path, 'wb') as f:
                    async for chunk in response.content.iter_chunked(chunk_size):
                        if chunk:
                            await f.write(chunk)
                            downloaded += len(chunk)

                            # Byte-based throttled progress updates (every 20MB or on last chunk)
                            if downloaded - last_update_bytes >= update_interval_bytes or downloaded >= total_size:
                                download_progress[model_name]['downloaded'] = downloaded
                                if total_size > 0:
                                    progress = (downloaded / total_size) * 100
                                    download_progress[model_name]['progress'] = round(progress, 2)
                                last_update_bytes = downloaded

                    # Move temp file to final location
                    if os.path.exists(dest_path):
                        os.remove(dest_path)
                    os.rename(temp_path, dest_path)

                    # Mark as complete
                    download_progress[model_name]['status'] = 'completed'
                    download_progress[model_name]['progress'] = 100
                    download_progress[model_name]['downloaded'] = downloaded

                    logging.info(f"[Download Missing Models] Successfully downloaded {model_name} ({downloaded / 1024 / 1024:.2f} MB)")

        except asyncio.CancelledError:
            # Clean up temp file
            if os.path.exists(temp_path):
                os.remove(temp_path)
            download_progress[model_name]['status'] = 'cancelled'
            logging.info(f"[Download Missing Models] Download cancelled for {model_name}")

        except Exception as e:
            # Clean up temp file
            if os.path.exists(temp_path):
                os.remove(temp_path)

            error_msg = str(e)
            download_progress[model_name]['status'] = 'error'
            download_progress[model_name]['error'] = error_msg
            logging.error(f"[Download Missing Models] Error downloading {model_name}: {error_msg}")

        finally:
            # Clean up task reference
            if model_name in download_tasks:
                del download_tasks[model_name]

    def parse_hf_url(self, url: str) -> Optional[dict]:
        """
        Parse a HuggingFace URL to extract repo ID and file path.

        Args:
            url: HuggingFace URL (blob or resolve format)

        Returns:
            Dict with repo_id, file_path, and download_url, or None if invalid
        """
        if 'huggingface.co' not in url:
            return None

        # Match HF URL patterns:
        # - https://huggingface.co/username/repo/blob/main/path/to/file.safetensors
        # - https://huggingface.co/username/repo/resolve/main/path/to/file.safetensors
        match = re.search(
            r'huggingface\.co/([^/]+/[^/]+)/(blob|resolve|tree)/([^/]+)/(.+)',
            url
        )

        if match:
            repo_id = match.group(1)
            branch = match.group(3)  # usually 'main'
            file_path = match.group(4)

            # Remove any URL parameters or fragments
            file_path = file_path.split('?')[0].split('#')[0]

            # Create download URL (always use 'resolve' for direct download)
            download_url = f"https://huggingface.co/{repo_id}/resolve/{branch}/{file_path}"

            return {
                'repo_id': repo_id,
                'file_path': file_path,
                'filename': os.path.basename(file_path),
                'download_url': download_url,
                'branch': branch
            }

        return None

    def parse_civitai_url(self, url: str) -> Optional[dict]:
        """
        Parse a CivitAI URL to extract model information.

        Args:
            url: CivitAI URL

        Returns:
            Dict with model info and download URL, or None if invalid
        """
        if 'civitai.com' not in url:
            return None

        # CivitAI direct download pattern: https://civitai.com/api/download/models/{versionId}
        direct_match = re.search(r'civitai\.com/api/download/models/(\d+)', url)
        if direct_match:
            return {
                'version_id': direct_match.group(1),
                'download_url': url,
                'filename': None  # Will be determined from response headers
            }

        # CivitAI model page pattern: https://civitai.com/models/{modelId}
        # Note: This doesn't give us a direct download URL without API call
        model_match = re.search(r'civitai\.com/models/(\d+)', url)
        if model_match:
            return {
                'model_id': model_match.group(1),
                'download_url': None,  # Would need API call to get version
                'filename': None
            }

        return None

    def extract_urls_from_notes(self, workflow: dict) -> List[dict]:
        """
        Extract HuggingFace and CivitAI URLs from workflow notes.

        Args:
            workflow: The workflow dictionary

        Returns:
            List of dicts with 'url', 'filename', 'download_url', and 'source'
        """
        extracted_urls = []
        nodes = workflow.get('nodes', [])

        for node in nodes:
            # Check if this is a note node
            node_type = node.get('type', '')
            if node_type not in ['MarkdownNote', 'Note']:
                continue

            # Get note text from widgets_values
            widgets_values = node.get('widgets_values', [])
            if not widgets_values or not isinstance(widgets_values[0], str):
                continue

            note_text = widgets_values[0]
            logging.debug(f"[Download Missing Models] Found note node {node.get('id')}, extracting URLs...")

            # Extract markdown-style links: [text](url)
            markdown_links = re.findall(r'\[([^\]]+)\]\(([^\)]+)\)', note_text)
            for link_text, url in markdown_links:
                url = url.strip()
                if 'huggingface.co' in url or 'hf.co' in url or 'civitai.com' in url:
                    extracted_urls.append({
                        'url': url,
                        'link_text': link_text,
                        'source': 'note'
                    })

            # Extract plain URLs
            plain_urls = re.findall(r'https?://(?:huggingface\.co|hf\.co|civitai\.com)/[^\s\)\]]+', note_text)
            for url in plain_urls:
                url = url.strip()
                # Avoid duplicates from markdown links
                if not any(u['url'] == url for u in extracted_urls):
                    extracted_urls.append({
                        'url': url,
                        'link_text': None,
                        'source': 'note'
                    })

        logging.info(f"[Download Missing Models] Extracted {len(extracted_urls)} URLs from notes")

        # Parse URLs to get download info
        parsed_urls = []
        for url_info in extracted_urls:
            url = url_info['url']

            # Try parsing as HuggingFace URL
            hf_parsed = self.parse_hf_url(url)
            if hf_parsed:
                parsed_urls.append({
                    'url': url,
                    'filename': hf_parsed['filename'],
                    'file_path': hf_parsed['file_path'],
                    'download_url': hf_parsed['download_url'],
                    'source': 'note',
                    'platform': 'huggingface',
                    'repo_id': hf_parsed.get('repo_id')
                })
                continue

            # Try parsing as CivitAI URL
            civitai_parsed = self.parse_civitai_url(url)
            if civitai_parsed and civitai_parsed.get('download_url'):
                parsed_urls.append({
                    'url': url,
                    'filename': civitai_parsed.get('filename'),
                    'download_url': civitai_parsed['download_url'],
                    'source': 'note',
                    'platform': 'civitai'
                })

        logging.info(f"[Download Missing Models] Successfully parsed {len(parsed_urls)} URLs")
        return parsed_urls

    def match_note_urls_to_models(self, missing_models: List[dict], note_urls: List[dict]) -> int:
        """
        Match URLs from notes to missing models by filename.

        Args:
            missing_models: List of models missing URLs
            note_urls: List of parsed URLs from notes

        Returns:
            Number of models matched
        """
        matched_count = 0

        for model in missing_models[:]:  # Iterate over copy
            model_filename = os.path.basename(model['name'].replace('\\', '/'))

            for url_info in note_urls:
                url_filename = url_info.get('filename')
                if not url_filename:
                    continue

                # Exact filename match
                if url_filename.lower() == model_filename.lower():
                    logging.info(f"[Download Missing Models] ✓ Matched '{model_filename}' to note URL: {url_info['download_url']}")
                    model['url'] = url_info['download_url']
                    model['url_source'] = 'note'
                    if url_info.get('repo_id'):
                        model['repo_id'] = url_info['repo_id']
                    matched_count += 1
                    break

        logging.info(f"[Download Missing Models] Matched {matched_count} models from note URLs")
        return matched_count

    async def resolve_missing_model_urls(self, workflow: dict, missing_no_url: List[dict]) -> Tuple[List[dict], List[dict]]:
        """
        Attempt to resolve URLs for models without them using all available strategies.

        Strategy order:
        1. Check workflow notes for matching URLs
        2. Search popular HuggingFace repositories
        3. Mark as not found if no match

        Args:
            workflow: The workflow dictionary
            missing_no_url: List of models without URLs

        Returns:
            Tuple of (models_with_urls, models_not_found)
        """
        if not missing_no_url:
            return [], []

        logging.info(f"[Download Missing Models] Attempting to resolve URLs for {len(missing_no_url)} models")

        # Strategy 1: Check workflow notes for matching URLs
        note_urls = self.extract_urls_from_notes(workflow)
        if note_urls:
            self.match_note_urls_to_models(missing_no_url, note_urls)

        # Strategy 2: Search popular HuggingFace repositories for remaining models without URLs
        still_missing = [m for m in missing_no_url if not m.get('url')]
        logging.info(f"[Download Missing Models] After note matching: {len(still_missing)} models still need URLs")

        total_missing = len(still_missing)
        for model_idx, model in enumerate(still_missing):
            # Update progress for URL resolution
            if total_missing > 0:
                url_progress = 66 + int((model_idx) / total_missing * 34)
                scan_progress['current'].update({
                    'progress': url_progress,
                    'message': f'Resolving model URLs ({model_idx + 1}/{total_missing})...'
                })

            try:
                model_filename = os.path.basename(model['name'].replace('\\', '/'))
                results = await self.search_popular_repos(model_filename)

                if len(results) >= 1:
                    # Use first result (auto-select if only one, or best match if multiple)
                    result = results[0]
                    model['url'] = result['download_url']
                    model['url_source'] = 'hf_search'
                    model['expected_filename'] = result.get('expected_filename', model_filename)
                    model['actual_filename'] = result.get('actual_filename', model_filename)

                    # Build comprehensive log message
                    repo_id = result.get('repo_id', 'unknown')
                    match_type = "exact" if result.get('score', 1.0) == 1.0 else "flexible"

                    # Check if renaming will occur
                    actual = result.get('actual_filename', model_filename)
                    expected = result.get('expected_filename', model_filename)

                    if actual != expected:
                        logging.info(f"[Download Missing Models] ✓ Found {expected} → {actual} in {repo_id} ({match_type} match, will rename)")
                    else:
                        logging.info(f"[Download Missing Models] ✓ Found {model_filename} in {repo_id} ({match_type} match)")
                else:
                    logging.info(f"[Download Missing Models] ✗ Not found: {model_filename}")

            except Exception as e:
                logging.error(f"[Download Missing Models] Error searching for {model['name']}: {e}")

        # Strategy 3: Separate resolved vs not found
        resolved = [m for m in missing_no_url if m.get('url')]
        not_found = [m for m in missing_no_url if not m.get('url')]

        logging.info(f"[Download Missing Models] Resolution complete: {len(resolved)} resolved, {len(not_found)} not found")
        return resolved, not_found

    def flexible_filename_match(self, filename1: str, filename2: str) -> bool:
        """
        Compare two filenames ignoring all whitespace and separator characters.
        Useful for finding models with minor naming variations.

        Args:
            filename1: First filename to compare
            filename2: Second filename to compare

        Returns:
            True if filenames match when ignoring separators (hyphens, underscores, spaces)
        """
        # Normalize both filenames by removing all separators and whitespace
        # Then compare case-insensitively
        normalized1 = filename1.replace('-', '').replace('_', '').replace(' ', '').lower()
        normalized2 = filename2.replace('-', '').replace('_', '').replace(' ', '').lower()
        return normalized1 == normalized2

    def load_cache(self) -> dict:
        """
        Load entire cache from disk.

        Returns:
            Dict with structure: {repo_id: {last_modified: ..., files: [...]}, ...}
        """
        try:
            if not os.path.exists(self.cache_file):
                return {}

            with open(self.cache_file, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception as e:
            logging.warning(f"[Download Missing Models] Error loading cache: {e}")
            return {}

    def save_cache(self, cache_data: dict) -> None:
        """
        Save entire cache to disk atomically.

        Args:
            cache_data: Dict with structure: {repo_id: {last_modified: ..., files: [...]}, ...}
        """
        try:
            # Atomic write: write to temp file, then rename
            temp_file = self.cache_file + '.tmp'
            with open(temp_file, 'w', encoding='utf-8') as f:
                json.dump(cache_data, f, indent=2)

            # Atomic rename
            os.replace(temp_file, self.cache_file)
        except Exception as e:
            logging.warning(f"[Download Missing Models] Error saving cache: {e}")

    def get_repo_from_cache(self, repo_id: str) -> Optional[dict]:
        """
        Get specific repository data from in-memory cache.

        Args:
            repo_id: HuggingFace repository ID

        Returns:
            Dict with 'last_modified' and 'files' keys, or None if not cached
        """
        return self.cache_data.get(repo_id)

    def update_repo_in_cache(self, repo_id: str, files: List[str], last_modified: str) -> None:
        """
        Update specific repository in cache and persist to disk.

        Args:
            repo_id: HuggingFace repository ID
            files: List of file paths in the repository
            last_modified: ISO timestamp of last repo modification
        """
        self.cache_data[repo_id] = {
            'last_modified': last_modified,
            'files': files
        }
        self.save_cache(self.cache_data)

    async def list_user_repos(self, username: str) -> List[Tuple[str, Optional[str]]]:
        """
        List all model repositories for a HuggingFace user with lastModified timestamps.

        Args:
            username: HuggingFace username

        Returns:
            List of tuples: [(repo_id, last_modified_iso_string), ...]
        """
        try:
            if not HF_API_AVAILABLE:
                return []

            api = HfApi()
            loop = asyncio.get_event_loop()
            models = await loop.run_in_executor(None, lambda: api.list_models(author=username, expand=["lastModified"]))

            # Extract both repo_id and lastModified from each model
            repo_data = []
            for model in models:
                repo_id = model.id
                last_modified = None
                if hasattr(model, 'lastModified') and model.lastModified:
                    last_modified = model.lastModified.isoformat()
                repo_data.append((repo_id, last_modified))

            return repo_data
        except Exception as e:
            logging.warning(f"[Download Missing Models] Error listing repos for {username}: {e}")
            return []

    async def search_popular_repos(self, filename: str) -> List[dict]:
        """
        Search through HuggingFace repositories from popular users for a specific model file.
        Uses disk caching with smart cache invalidation based on repo modification dates.

        Args:
            filename: The model filename to search for

        Returns:
            List of matching files with repo info and download URLs
        """
        try:
            # Check if HfApi is available
            if not HF_API_AVAILABLE:
                logging.warning(f"[Download Missing Models] huggingface_hub not available - skipping search")
                return []

            # Clean filename for search
            search_filename = os.path.basename(filename.replace('\\', '/'))
            logging.info(f"[Download Missing Models] Searching for: {search_filename}")

            results = []
            api = HfApi()

            # Load cache from disk once at start
            self.cache_data = self.load_cache()

            # Search through each user's repositories
            for entry in POPULAR_HF_USERS:
                try:
                    # Check if entry is a specific repo (contains "/") or a username
                    if "/" in entry:
                        # Specific repo format (e.g., "Kijai/WanVideo_comfy")
                        repo_data = [(entry, None)]  # Will fetch lastModified when needed
                    else:
                        # Username format (e.g., "Kijai") - list all their repos
                        repo_data = await self.list_user_repos(entry)

                    for repo_id, repo_last_modified in repo_data:
                        try:
                            # If repo_last_modified is None (specific repo), fetch it for cache validation
                            if repo_last_modified is None:
                                try:
                                    loop = asyncio.get_event_loop()
                                    repo_info = await loop.run_in_executor(None, api.repo_info, repo_id, repo_type="model")
                                    if hasattr(repo_info, 'lastModified') and repo_info.lastModified:
                                        repo_last_modified = repo_info.lastModified.isoformat()
                                except Exception as e:
                                    logging.warning(f"[Download Missing Models] Could not fetch lastModified for {repo_id}: {e}")

                            # Check if we need to update cache
                            cache_data = self.get_repo_from_cache(repo_id)

                            file_list = None

                            # Use cache if valid (exists and repo not modified since cache)
                            if cache_data and repo_last_modified:
                                cached_last_modified = cache_data.get('last_modified')
                                if cached_last_modified == repo_last_modified:
                                    # Cache is up to date
                                    file_list = cache_data.get('files', [])

                            # Fetch from API if cache invalid or missing
                            if file_list is None:
                                loop = asyncio.get_event_loop()
                                file_list = await loop.run_in_executor(None, api.list_repo_files, repo_id)

                                # Save to disk cache
                                if repo_last_modified:
                                    self.update_repo_in_cache(repo_id, file_list, repo_last_modified)
                                else:
                                    logging.warning(f"[Download Missing Models]   ⚠ No last_modified available, not caching")

                            # Also cache in memory for this session
                            self.repo_files_cache[repo_id] = file_list

                            # Search through file list
                            matches_found = 0

                            # Pass 1: Try exact match first
                            for file_path in file_list:
                                file_basename = os.path.basename(file_path)

                                # Check for exact filename match
                                if file_basename.lower() == search_filename.lower():
                                    results.append({
                                        'repo_id': repo_id,
                                        'filename': file_path,
                                        'actual_filename': file_basename,
                                        'expected_filename': search_filename,
                                        'file_size': 0,
                                        'downloads': 0,
                                        'likes': 0,
                                        'score': 1.0,  # Exact match
                                        'download_url': f"https://huggingface.co/{repo_id}/resolve/main/{file_path}",
                                        'source': 'popular_repos'
                                    })
                                    matches_found += 1

                            # Pass 2: If no exact match, try flexible matching
                            if matches_found == 0:
                                for file_path in file_list:
                                    file_basename = os.path.basename(file_path)

                                    # Check for flexible match
                                    if self.flexible_filename_match(file_basename, search_filename):
                                        results.append({
                                            'repo_id': repo_id,
                                            'filename': file_path,
                                            'actual_filename': file_basename,
                                            'expected_filename': search_filename,
                                            'file_size': 0,
                                            'downloads': 0,
                                            'likes': 0,
                                            'score': 0.9,  # Slightly lower score for flexible match
                                            'download_url': f"https://huggingface.co/{repo_id}/resolve/main/{file_path}",
                                            'source': 'popular_repos'
                                        })
                                        matches_found += 1

                        except Exception as e:
                            logging.warning(f"[Download Missing Models] Error checking repo {repo_id}: {e}")
                            continue

                except Exception as e:
                    logging.warning(f"[Download Missing Models] Error processing {entry}: {e}")
                    continue

            return results

        except Exception as e:
            logging.error(f"[Download Missing Models] Error searching popular repos: {e}")
            return []

    async def search_huggingface_api(self, model_name: str, folder_type: Optional[str] = None) -> List[dict]:
        """
        Search HuggingFace for models by checking popular repositories.

        Args:
            model_name: The model name/path to search for
            folder_type: Optional folder type to help filter results

        Returns:
            List of search results with repo info and download URLs
        """
        try:
            # Extract just the filename
            filename = os.path.basename(model_name.replace('\\', '/'))
            filename_no_ext = filename.rsplit('.', 1)[0]

            logging.info(f"[Download Missing Models] Searching HuggingFace for: {filename}")

            # Search through popular repos for exact filename match
            results = await self.search_popular_repos(filename)

            if results:
                logging.info(f"[Download Missing Models] ✓ Found {len(results)} matches in popular repos")
                return results
            else:
                logging.info(f"[Download Missing Models] No matches found in popular repos")
                return []

        except Exception as e:
            logging.error(f"[Download Missing Models] Error searching HuggingFace: {e}")
            return []

    async def cleanup(self):
        """Clean up resources on shutdown"""
        if self.session and not self.session.closed:
            await self.session.close()
            logging.info("[Download Missing Models] ClientSession closed")

# Initialize the extension
extension = MissingModelsExtension()

# Export for ComfyUI
WEB_DIRECTORY = "./web"
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
__all__ = ['NODE_CLASS_MAPPINGS', 'NODE_DISPLAY_NAME_MAPPINGS', 'WEB_DIRECTORY']
