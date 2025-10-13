"""
ComfyUI Extension: Download Missing Models

This extension scans workflows for missing models and provides a UI to download them.
"""

import os
import asyncio
import aiohttp
import logging
from pathlib import Path
from typing import Dict, List, Optional, Tuple
from aiohttp import web
import folder_paths
from server import PromptServer

# Global state for download progress
download_progress = {}
download_tasks = {}

class MissingModelsExtension:
    """Extension to find and download missing models from workflows"""

    def __init__(self):
        self.routes = PromptServer.instance.routes
        self.setup_routes()
        logging.info("[Download Missing Models] Extension initialized")

    def setup_routes(self):
        """Register API routes"""

        @self.routes.post("/download-missing/scan")
        async def scan_workflow(request):
            """Scan workflow for missing models"""
            try:
                data = await request.json()
                workflow = data.get('workflow', {})

                missing_models = self.find_missing_models(workflow)

                return web.json_response({
                    'status': 'success',
                    'missing_models': missing_models,
                    'count': len(missing_models)
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
                model_folder = data.get('model_folder', 'checkpoints')

                if not model_name or not model_url:
                    return web.json_response({
                        'status': 'error',
                        'message': 'Missing model_name or model_url'
                    }, status=400)

                # Cancel existing download if running
                if model_name in download_tasks:
                    download_tasks[model_name].cancel()

                # Start download task
                task = asyncio.create_task(
                    self.download_model_async(model_name, model_url, model_folder)
                )
                download_tasks[model_name] = task

                return web.json_response({
                    'status': 'success',
                    'message': f'Download started for {model_name}'
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

    def find_missing_models(self, workflow: dict) -> List[dict]:
        """
        Scan workflow and find missing models

        Returns list of dicts with: name, url, folder, size, type
        """
        missing_models = []
        nodes = workflow.get('nodes', [])

        for node in nodes:
            # Check node properties for embedded model info
            properties = node.get('properties', {})

            if 'models' in properties and isinstance(properties['models'], list):
                for model_info in properties['models']:
                    model_name = model_info.get('name')
                    model_url = model_info.get('url')
                    # Try 'directory' first, then 'folder' as fallback
                    model_folder = model_info.get('directory') or model_info.get('folder', 'checkpoints')

                    # Only add if model has a URL and is not installed
                    if model_name and model_url and not self.is_model_installed(model_name, model_folder):
                        missing_models.append({
                            'name': model_name,
                            'url': model_url,
                            'folder': model_folder,
                            'directory': model_folder,  # Add directory field for UI
                            'node_id': node.get('id'),
                            'node_type': node.get('type')
                        })

            # Only check widgets_values if no models were found in properties
            # This prevents duplicates when a node has both properties.models and widgets_values
            if 'models' not in properties or not isinstance(properties.get('models'), list):
                widgets_values = node.get('widgets_values', [])
                node_type = node.get('type', '')

                # Map node types to model folders
                node_to_folder = {
                    'CheckpointLoaderSimple': 'checkpoints',
                    'CheckpointLoader': 'checkpoints',
                    'UNETLoader': 'unet',
                    'LoraLoader': 'loras',
                    'VAELoader': 'vae',
                    'ControlNetLoader': 'controlnet',
                    'CLIPLoader': 'clip',
                }

                if node_type in node_to_folder and widgets_values:
                    model_name = widgets_values[0] if isinstance(widgets_values[0], str) else None
                    if model_name and not self.is_model_installed(model_name, node_to_folder[node_type]):
                        # Try to find URL in node properties or workflow metadata
                        model_url = self.find_model_url(workflow, model_name, node)

                        # Only add if URL is available
                        if model_url:
                            model_folder = node_to_folder[node_type]
                            missing_models.append({
                                'name': model_name,
                                'url': model_url,
                                'folder': model_folder,
                                'directory': model_folder,  # Add directory field for UI
                                'node_id': node.get('id'),
                                'node_type': node_type
                            })

        # Check workflow-level metadata
        extra = workflow.get('extra', {})
        if 'model_urls' in extra:
            for model_name, model_data in extra['model_urls'].items():
                # Try 'directory' first, then 'folder' as fallback
                model_folder = model_data.get('directory') or model_data.get('folder', 'checkpoints')
                if not self.is_model_installed(model_name, model_folder):
                    missing_models.append({
                        'name': model_name,
                        'url': model_data.get('url'),
                        'folder': model_folder,
                        'directory': model_folder,  # Add directory field for UI
                        'node_id': None,
                        'node_type': 'metadata'
                    })

        # Remove duplicates
        seen = set()
        unique_models = []
        for model in missing_models:
            key = (model['name'], model['folder'])
            if key not in seen:
                seen.add(key)
                unique_models.append(model)

        return unique_models

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

    def is_model_installed(self, model_name: str, folder_type: str) -> bool:
        """Check if model exists in the specified folder"""
        try:
            # Map folder types to folder_paths keys
            folder_map = {
                'checkpoints': 'checkpoints',
                'loras': 'loras',
                'lora': 'loras',
                'vae': 'vae',
                'controlnet': 'controlnet',
                'clip': 'text_encoders',
                'clip_vision': 'clip_vision',
                'unet': 'diffusion_models',
                'diffusion_models': 'diffusion_models',
                'embeddings': 'embeddings',
                'hypernetworks': 'hypernetworks',
                'upscale_models': 'upscale_models',
            }

            folder_key = folder_map.get(folder_type.lower(), folder_type)

            if folder_key in folder_paths.folder_names_and_paths:
                file_list = folder_paths.get_filename_list(folder_key)

                # Check exact match and with path
                for filename in file_list:
                    if filename == model_name or filename.endswith('/' + model_name) or filename.endswith('\\' + model_name):
                        return True

            return False
        except Exception as e:
            logging.error(f"[Download Missing Models] Error checking model installation: {e}")
            return False

    def get_model_destination(self, folder_type: str) -> str:
        """Get the full path to the model folder"""
        folder_map = {
            'checkpoints': 'checkpoints',
            'loras': 'loras',
            'lora': 'loras',
            'vae': 'vae',
            'controlnet': 'controlnet',
            'clip': 'text_encoders',
            'clip_vision': 'clip_vision',
            'unet': 'diffusion_models',
            'diffusion_models': 'diffusion_models',
            'embeddings': 'embeddings',
            'hypernetworks': 'hypernetworks',
            'upscale_models': 'upscale_models',
        }

        folder_key = folder_map.get(folder_type.lower(), folder_type)

        if folder_key in folder_paths.folder_names_and_paths:
            folders = folder_paths.get_folder_paths(folder_key)
            if folders:
                return folders[0]  # Use first folder path

        # Fallback
        models_dir = os.path.join(os.path.dirname(os.path.realpath(__file__)), '..', '..', 'models')
        return os.path.join(models_dir, folder_type)

    async def download_model_async(self, model_name: str, model_url: str, model_folder: str):
        """Download model with progress tracking"""
        global download_progress

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

            # Download with progress
            timeout = aiohttp.ClientTimeout(total=None, connect=60, sock_read=60)
            async with aiohttp.ClientSession(timeout=timeout) as session:
                async with session.get(model_url) as response:
                    if response.status != 200:
                        raise Exception(f"HTTP {response.status}: {response.reason}")

                    total_size = int(response.headers.get('content-length', 0))
                    download_progress[model_name]['total'] = total_size

                    downloaded = 0
                    chunk_size = 1048576  # 1MB chunks (optimized for large files)
                    progress_update_threshold = 10  # Update progress every 10 chunks (every 10MB)
                    chunk_counter = 0

                    with open(temp_path, 'wb') as f:
                        async for chunk in response.content.iter_chunked(chunk_size):
                            if chunk:
                                f.write(chunk)
                                downloaded += len(chunk)
                                chunk_counter += 1

                                # Throttled progress updates (every 10MB or on last chunk)
                                if chunk_counter % progress_update_threshold == 0 or downloaded >= total_size:
                                    download_progress[model_name]['downloaded'] = downloaded
                                    if total_size > 0:
                                        progress = (downloaded / total_size) * 100
                                        download_progress[model_name]['progress'] = round(progress, 2)

                    # Move temp file to final location
                    if os.path.exists(dest_path):
                        os.remove(dest_path)
                    os.rename(temp_path, dest_path)

                    # Mark as complete
                    download_progress[model_name]['status'] = 'completed'
                    download_progress[model_name]['progress'] = 100

                    logging.info(f"[Download Missing Models] Successfully downloaded {model_name}")

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

# Initialize the extension
extension = MissingModelsExtension()

# Export for ComfyUI
WEB_DIRECTORY = "./web"
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
__all__ = ['NODE_CLASS_MAPPINGS', 'NODE_DISPLAY_NAME_MAPPINGS', 'WEB_DIRECTORY']
