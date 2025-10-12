"""
ComfyUI Download Missing Models Extension

This extension adds functionality to find and download missing models from template workflows
that include download URLs in their node properties.
"""

import os
import json
import folder_paths
from server import PromptServer
from aiohttp import web
import logging
from datetime import datetime
import sys
import asyncio

# Add ComfyUI Manager to path to use its download functionality
manager_path = os.path.join(os.path.dirname(__file__), '..', 'ComfyUI-Manager')
if os.path.exists(manager_path):
    # Add the glob subdirectory to sys.path
    manager_glob_path = os.path.join(manager_path, 'glob')
    if os.path.exists(manager_glob_path):
        sys.path.append(manager_glob_path)
        try:
            import manager_downloader
            import manager_core
            MANAGER_AVAILABLE = True
            print("[MissingModelsFinder] ComfyUI Manager modules imported successfully")
        except ImportError as e:
            print(f"[MissingModelsFinder] Failed to import ComfyUI Manager modules: {e}")
            MANAGER_AVAILABLE = False
        except Exception as e:
            print(f"[MissingModelsFinder] Error importing ComfyUI Manager modules: {e}")
            MANAGER_AVAILABLE = False
    else:
        print(f"[MissingModelsFinder] ComfyUI Manager glob path not found: {manager_glob_path}")
        MANAGER_AVAILABLE = False
else:
    print(f"[MissingModelsFinder] ComfyUI Manager path not found: {manager_path}")
    MANAGER_AVAILABLE = False

# Set up logging
logger = logging.getLogger(__name__)

# Enable detailed logging for debugging (can be disabled later)
DEBUG_LOGGING = False

def debug_log(message):
    """Helper function for debug logging that can be easily disabled"""
    if DEBUG_LOGGING:
        logger.info(f"[MissingModelsFinder] {message}")

# Log extension loading
print("[MissingModelsFinder] Extension loading...")

class MissingModelsFinder:
    """
    Handles finding missing models in workflows and managing downloads
    """
    
    def __init__(self):
        self.routes = PromptServer.instance.routes
        self.websocket_connections = set()
        self.active_downloads = {}  # Track active downloads by model name
        self.download_queue = []  # Track queued downloads
        self.max_concurrent_downloads = 3  # Maximum concurrent downloads
        self.setup_routes()
        self.setup_websockets()
    
    def setup_websockets(self):
        """Set up WebSocket routes for real-time progress updates"""
        
        @self.routes.get('/missing-models/ws')
        async def websocket_handler(request):
            """Handle WebSocket connections for progress updates"""
            
            ws = web.WebSocketResponse()
            await ws.prepare(request)
            
            # Add to active connections
            self.websocket_connections.add(ws)
            
            try:
                async for msg in ws:
                    if msg.type == web.WSMsgType.TEXT:
                        data = json.loads(msg.data)
                        
                        # Handle different message types
                        if data.get('type') == 'ping':
                            await ws.send_json({'type': 'pong'})
                            
            except Exception as e:
                debug_log(f"WebSocket error: {e}")
            finally:
                # Remove from active connections
                self.websocket_connections.discard(ws)
            
            return ws
    
    def setup_routes(self):
        """Set up API routes for the extension"""
        
        @self.routes.get("/missing-models/test")
        async def test_endpoint(request):
            """
            Test endpoint to verify the extension is working
            """
            return web.json_response({
                "status": "working",
                "message": "Missing Models Finder extension is running",
                "timestamp": str(datetime.now())
            })
        
        @self.routes.post("/missing-models/analyze")
        async def analyze_missing_models(request):
            """
            Analyze the current workflow for missing models with download URLs
            """
            try:
                data = await request.json()
                workflow = data.get('workflow', {})
                nodes = workflow.get('nodes', [])
                
                if not workflow or not nodes:
                    return web.json_response({
                        "error": "No workflow data provided in request",
                        "missing_models": [],
                        "total_missing": 0
                    }, status=400)
                
                missing_models = self.find_missing_models(workflow)
                
                return web.json_response({
                    "missing_models": missing_models,
                    "total_missing": len(missing_models)
                })
                
            except Exception as e:
                logger.error(f"Error analyzing missing models: {e}")
                return web.json_response({
                    "error": f"Failed to analyze workflow: {str(e)}"
                }, status=500)
        
        @self.routes.post("/missing-models/download")
        async def download_missing_model(request):
            """
            Download a specific missing model
            """
            try:
                data = await request.json()
                model_name = data.get('name')
                model_url = data.get('url')
                target_directory = data.get('directory', 'checkpoints')
                
                if not model_name or not model_url:
                    return web.json_response({
                        "error": "Missing required parameters: name and url"
                    }, status=400)
                
                # Get the actual model directory path
                model_dir = self.get_model_directory_path(target_directory)
                
                if MANAGER_AVAILABLE:
                    # Use ComfyUI Manager's download functionality
                    try:
                        # Check if we can start this download immediately
                        if len(self.active_downloads) >= self.max_concurrent_downloads:
                            # Send queued status
                            progress_data = {
                                'model_name': model_name,
                                'progress': 0,
                                'downloaded': 0,
                                'total': 0,
                                'status': 'queued'
                            }
                            await self.broadcast_progress(progress_data)
                            
                            # Add to queue
                            self.download_queue.append({
                                'name': model_name,
                                'url': model_url,
                                'directory': target_directory
                            })
                            
                            # Return queued response
                            return web.json_response({
                                "status": "queued",
                                "message": f"Download queued for {model_name}"
                            })
                        
                        # Start the download immediately
                        return await self.start_download(model_name, model_url, model_dir)
                        
                    except Exception as e:
                        # Remove from active downloads on error
                        if model_name in self.active_downloads:
                            del self.active_downloads[model_name]
                        
                        # Send error message
                        progress_data = {
                            'model_name': model_name,
                            'progress': 0,
                            'downloaded': 0,
                            'total': 0,
                            'status': 'error',
                            'error': str(e)
                        }
                        await self.broadcast_progress(progress_data)
                        
                        return web.json_response({
                            "error": f"Failed to download model: {str(e)}"
                        }, status=500)
                else:
                    # ComfyUI Manager not available
                    return web.json_response({
                        "error": "ComfyUI Manager not available for downloads"
                    }, status=500)
                
            except Exception as e:
                logger.error(f"Error downloading model: {e}")
                return web.json_response({
                    "error": f"Failed to download model: {str(e)}"
                }, status=500)
        
        @self.routes.get("/missing-models/check-installed")
        async def check_installed_models(request):
            """
            Check which models from a list are already installed
            """
            try:
                # Get list of models to check from query parameters
                models_to_check = request.rel_url.query.get('models', '').split(',')
                
                installed_models = {}
                for model_name in models_to_check:
                    if model_name:
                        is_installed = self.is_model_installed(model_name)
                        installed_models[model_name] = is_installed
                
                return web.json_response({
                    "installed_models": installed_models
                })
                
            except Exception as e:
                logger.error(f"Error checking installed models: {e}")
                return web.json_response({
                    "error": f"Failed to check installed models: {str(e)}"
                }, status=500)
    
    def find_missing_models(self, workflow):
        """
        Find missing models in the workflow that have download URLs
        
        Args:
            workflow: The workflow JSON object
            
        Returns:
            List of missing model objects with name, url, and directory
        """
        missing_models = []
        
        # Get nodes from workflow - it can be a list or dict
        nodes = workflow.get('nodes', [])
        
        # Iterate through all nodes in the workflow
        for i, node_data in enumerate(nodes):
            # Handle both list and dict formats
            if isinstance(node_data, dict):
                node_id = node_data.get('id', str(i))
                node_type = node_data.get('type', 'Unknown')
                
                # Check if node has properties with models array
                properties = node_data.get('properties', {})
                
                if 'models' in properties and isinstance(properties['models'], list):
                    for model_info in properties['models']:
                        if isinstance(model_info, dict):
                            model_name = model_info.get('name')
                            model_url = model_info.get('url')
                            model_directory = model_info.get('directory', 'checkpoints')
                            
                            # Only process models that have both name and URL
                            if model_name and model_url:
                                # Check if model is already installed
                                is_installed = self.is_model_installed_in_directory(model_name, model_directory)
                                
                                if not is_installed:
                                    missing_models.append({
                                        'name': model_name,
                                        'url': model_url,
                                        'directory': model_directory,
                                        'source_node': node_id,
                                        'node_type': node_type
                                    })
        
        return missing_models
    
    def is_model_installed_in_directory(self, model_name, directory):
        """
        Check if a model is already installed in the specified directory
        
        Args:
            model_name: Name of the model file
            directory: Target directory (e.g., 'checkpoints', 'loras', 'vae')
            
        Returns:
            bool: True if model is installed, False otherwise
        """
        try:
            # Map directory names to folder_paths folder names
            directory_map = {
                'checkpoints': 'checkpoints',
                'checkpoint': 'checkpoints',
                'loras': 'loras',
                'lora': 'loras',
                'vae': 'vae',
                'controlnet': 'controlnet',
                'clip_vision': 'clip_vision',
                'embeddings': 'embeddings',
                'upscale_models': 'upscale_models',
                'diffusion_models': 'diffusion_models'
            }
            
            folder_name = directory_map.get(directory.lower(), directory)
            
            # Get list of files in the target directory
            if folder_name in folder_paths.folder_names_and_paths:
                folder_paths_list = folder_paths.get_filename_list(folder_name)
                return model_name in folder_paths_list
            
            return False
            
        except Exception as e:
            logger.error(f"Error checking if model {model_name} is installed in {directory}: {e}")
            return False
    
    def is_model_installed(self, model_name):
        """
        Check if a model is installed in any directory
        
        Args:
            model_name: Name of the model file
            
        Returns:
            bool: True if model is installed anywhere, False otherwise
        """
        try:
            # Check all model directories
            for folder_name in folder_paths.folder_names_and_paths:
                folder_paths_list = folder_paths.get_filename_list(folder_name)
                if model_name in folder_paths_list:
                    return True
            return False
            
        except Exception as e:
            logger.error(f"Error checking if model {model_name} is installed: {e}")
            return False
    
    def get_model_directory_path(self, directory_name):
        """
        Get the actual filesystem path for a model directory
        
        Args:
            directory_name: Directory name (e.g., 'checkpoints', 'loras', 'vae')
            
        Returns:
            str: Full filesystem path to the directory
        """
        # Map directory names to folder_paths folder names
        directory_map = {
            'checkpoints': 'checkpoints',
            'checkpoint': 'checkpoints',
            'loras': 'loras',
            'lora': 'loras',
            'vae': 'vae',
            'controlnet': 'controlnet',
            'clip_vision': 'clip_vision',
            'embeddings': 'embeddings',
            'upscale_models': 'upscale_models',
            'diffusion_models': 'diffusion_models',
            'text_encoders': 'text_encoders'
        }
        
        folder_name = directory_map.get(directory_name.lower(), directory_name)
        
        if folder_name in folder_paths.folder_names_and_paths:
            # Get the first path from the folder_paths (it returns a tuple of (paths, extensions))
            folder_paths_data = folder_paths.folder_names_and_paths[folder_name]
            if folder_paths_data and len(folder_paths_data) > 0:
                # The first element is the list of paths
                paths_list = folder_paths_data[0]
                if paths_list and len(paths_list) > 0:
                    return paths_list[0]
        
        # Fallback: create a directory in the ComfyUI models folder
        comfyui_path = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
        fallback_path = os.path.join(comfyui_path, 'models', folder_name)
        return fallback_path
    
    async def start_download(self, model_name, model_url, model_dir):
        """
        Start a download and track it in active_downloads
        
        Args:
            model_name: Name of the model
            model_url: URL to download from
            model_dir: Directory to save to
            
        Returns:
            web.Response: JSON response with download status
        """
        # Add to active downloads
        self.active_downloads[model_name] = {
            'status': 'downloading',
            'start_time': datetime.now()
        }
        
        # Send downloading message
        progress_data = {
            'model_name': model_name,
            'progress': 0,
            'downloaded': 0,
            'total': 0,
            'status': 'downloading'
        }
        await self.broadcast_progress(progress_data)
        
        try:
            # Start the download
            manager_downloader.download_url(model_url, model_dir, model_name)
            
            # Remove from active downloads
            if model_name in self.active_downloads:
                del self.active_downloads[model_name]
            
            # Send completion message
            progress_data = {
                'model_name': model_name,
                'progress': 100,
                'downloaded': 0,
                'total': 0,
                'status': 'completed'
            }
            await self.broadcast_progress(progress_data)
            
            # Process next download in queue if any
            await self.process_next_download()
            
            return web.json_response({
                "status": "download_completed",
                "message": f"Download completed for {model_name}"
            })
            
        except Exception as e:
            # Remove from active downloads on error
            if model_name in self.active_downloads:
                del self.active_downloads[model_name]
            
            # Send error message
            progress_data = {
                'model_name': model_name,
                'progress': 0,
                'downloaded': 0,
                'total': 0,
                'status': 'error',
                'error': str(e)
            }
            await self.broadcast_progress(progress_data)
            
            # Process next download in queue if any
            await self.process_next_download()
            
            return web.json_response({
                "error": f"Failed to download model: {str(e)}"
            }, status=500)
    
    async def process_next_download(self):
        """
        Process the next download in the queue if there are available slots
        """
        if self.download_queue and len(self.active_downloads) < self.max_concurrent_downloads:
            next_download = self.download_queue.pop(0)
            
            # Get the model directory path
            model_dir = self.get_model_directory_path(next_download['directory'])
            
            # Start the download using the appropriate method
            if MANAGER_AVAILABLE:
                await self.start_download(next_download['name'], next_download['url'], model_dir)
            else:
                await self.start_basic_download(next_download['name'], next_download['url'], model_dir)
    
    async def basic_download_model(self, model_url, model_dir, model_name):
        """
        Basic download functionality using requests (fallback)
        
        Args:
            model_url: URL to download from
            model_dir: Directory to save to
            model_name: Name of the model file
            
        Returns:
            web.Response: JSON response with download status
        """
        # Check if we can start this download immediately
        if len(self.active_downloads) >= self.max_concurrent_downloads:
            # Send queued status
            progress_data = {
                'model_name': model_name,
                'progress': 0,
                'downloaded': 0,
                'total': 0,
                'status': 'queued'
            }
            await self.broadcast_progress(progress_data)
            
            # Add to queue
            self.download_queue.append({
                'name': model_name,
                'url': model_url,
                'directory': os.path.basename(model_dir)  # Extract directory name from path
            })
            
            # Return queued response
            return web.json_response({
                "status": "queued",
                "message": f"Download queued for {model_name}"
            })
        
        # Start the download immediately
        return await self.start_basic_download(model_name, model_url, model_dir)
    
    async def start_basic_download(self, model_name, model_url, model_dir):
        """
        Start a basic download using requests
        
        Args:
            model_name: Name of the model
            model_url: URL to download from
            model_dir: Directory to save to
            
        Returns:
            web.Response: JSON response with download status
        """
        try:
            import requests
            
            # Add to active downloads
            self.active_downloads[model_name] = {
                'status': 'downloading',
                'start_time': datetime.now()
            }
            
            # Ensure the directory exists
            if not os.path.exists(model_dir):
                os.makedirs(model_dir)
            
            # Full path to save the file
            dest_path = os.path.join(model_dir, model_name)
            
            # Send downloading message
            progress_data = {
                'model_name': model_name,
                'progress': 0,
                'downloaded': 0,
                'total': 0,
                'status': 'downloading'
            }
            await self.broadcast_progress(progress_data)
            
            # Download the file
            response = requests.get(model_url, stream=True)
            
            if response.status_code == 200:
                with open(dest_path, 'wb') as file:
                    for chunk in response.iter_content(chunk_size=8192):
                        if chunk:
                            file.write(chunk)
                
                # Remove from active downloads
                if model_name in self.active_downloads:
                    del self.active_downloads[model_name]
                
                # Send completion message
                progress_data = {
                    'model_name': model_name,
                    'progress': 100,
                    'downloaded': 0,
                    'total': 0,
                    'status': 'completed'
                }
                await self.broadcast_progress(progress_data)
                
                # Process next download in queue if any
                await self.process_next_download()
                
                return web.json_response({
                    "status": "download_completed",
                    "message": f"Download completed for {model_name}",
                    "path": dest_path
                })
            else:
                error_msg = f"Failed to download file from {model_url}: HTTP {response.status_code}"
                
                # Remove from active downloads on error
                if model_name in self.active_downloads:
                    del self.active_downloads[model_name]
                
                # Send error message
                progress_data = {
                    'model_name': model_name,
                    'progress': 0,
                    'downloaded': 0,
                    'total': 0,
                    'status': 'error',
                    'error': error_msg
                }
                await self.broadcast_progress(progress_data)
                
                # Process next download in queue if any
                await self.process_next_download()
                
                return web.json_response({
                    "error": error_msg
                }, status=500)
                
        except Exception as e:
            error_msg = f"Download failed: {str(e)}"
            
            # Remove from active downloads on error
            if model_name in self.active_downloads:
                del self.active_downloads[model_name]
            
            # Send error message
            progress_data = {
                'model_name': model_name,
                'progress': 0,
                'downloaded': 0,
                'total': 0,
                'status': 'error',
                'error': error_msg
            }
            await self.broadcast_progress(progress_data)
            
            # Process next download in queue if any
            await self.process_next_download()
            
            return web.json_response({
                "error": error_msg
            }, status=500)

# Web directory for frontend files
WEB_DIRECTORY = "./js"

# Initialize the extension
missing_models_finder = MissingModelsFinder()

# Add WebSocket broadcast method to the instance
async def broadcast_progress(progress_data):
    """Broadcast progress updates to all connected WebSocket clients"""
    if not missing_models_finder.websocket_connections:
        return
        
    message = json.dumps({
        'type': 'download_progress',
        'data': progress_data
    })
    
    disconnected = set()
    for ws in missing_models_finder.websocket_connections:
        try:
            await ws.send_str(message)
        except Exception:
            disconnected.add(ws)
    
    # Remove disconnected clients
    for ws in disconnected:
        missing_models_finder.websocket_connections.discard(ws)

# Make broadcast function available to the instance
missing_models_finder.broadcast_progress = broadcast_progress

# Export for ComfyUI
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

__all__ = ['NODE_CLASS_MAPPINGS', 'NODE_DISPLAY_NAME_MAPPINGS']

print("[MissingModelsFinder] Extension loaded successfully")