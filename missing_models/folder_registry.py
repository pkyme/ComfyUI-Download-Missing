"""Folder resolution helpers for the Download Missing extension."""

from __future__ import annotations

import logging
import os
from typing import Dict, Iterable, List, Optional, Tuple

import folder_paths


NODE_TYPE_TO_FOLDER = {
    "WanVideoModelLoader": "diffusion_models",
    "LoadWanVideoT5TextEncoder": "text_encoders",
}

NODE_TYPE_KEYWORDS = [
    (["clip_vision", "clipvision"], "clip_vision"),
    (["checkpoint"], "checkpoints"),
    (["lora"], "loras"),
    (["vae"], "vae"),
    (["controlnet"], "controlnet"),
    (["clip"], "text_encoders"),
    (["unet", "diffusion"], "diffusion_models"),
    (["upscale", "upscaler"], "upscale_models"),
    (["embedding"], "embeddings"),
    (["hypernetwork"], "hypernetworks"),
]


class FolderRegistry:
    """Centralizes folder lookups and path utilities."""

    def __init__(self, extension_dir: str):
        self.extension_dir = extension_dir

    def resolve_folder_key(self, folder_type: str) -> str:
        """Resolve a folder type to the actual ComfyUI key."""
        folder_map = {
            "checkpoints": ["checkpoints"],
            "loras": ["loras"],
            "lora": ["loras"],
            "vae": ["vae"],
            "controlnet": ["controlnet"],
            "clip": ["text_encoders", "clip"],
            "clip_vision": ["clip_vision"],
            "unet": ["unet", "diffusion_models"],
            "diffusion_models": ["diffusion_models", "unet"],
            "embeddings": ["embeddings"],
            "hypernetworks": ["hypernetworks"],
            "upscale_models": ["upscale_models"],
        }

        potential_keys = folder_map.get(folder_type.lower(), [folder_type])
        for key in potential_keys:
            if key in folder_paths.folder_names_and_paths:
                return key
        return potential_keys[0] if potential_keys else folder_type

    def get_folder_from_node_type(self, node_type: str) -> Optional[str]:
        """Infer the folder from the node type."""
        if not node_type:
            return None

        node_type_normalized = node_type.strip().lower()
        for mapped_type, folder in NODE_TYPE_TO_FOLDER.items():
            if mapped_type.strip().lower() == node_type_normalized:
                return folder

        for keywords, folder in NODE_TYPE_KEYWORDS:
            if any(keyword in node_type_normalized for keyword in keywords):
                return folder

        return None

    def is_model_installed(self, model_name: str, folder_type: str) -> bool:
        """Check if model exists at the exact specified path."""
        try:
            folder_key = self.resolve_folder_key(folder_type)
            if folder_key in folder_paths.folder_names_and_paths:
                file_list = folder_paths.get_filename_list(folder_key)
                normalized_model_name = model_name.replace("\\", "/")
                return any(
                    filename.replace("\\", "/") == normalized_model_name
                    for filename in file_list
                )
            return False
        except Exception as exc:
            logging.error(
                "[Download Missing Models] Error checking model installation: %s", exc
            )
            return False

    def find_actual_model_path(
        self, model_name: str, folder_type: str
    ) -> Optional[str]:
        """Find the actual path of a model if it exists with a different subdirectory."""
        try:
            folder_key = self.resolve_folder_key(folder_type)
            if folder_key not in folder_paths.folder_names_and_paths:
                return None

            filename_only = os.path.basename(model_name.replace("\\", "/"))
            file_list = folder_paths.get_filename_list(folder_key)
            for available_path in file_list:
                available_filename = os.path.basename(available_path.replace("\\", "/"))
                if available_filename == filename_only:
                    return available_path
            return None
        except Exception as exc:
            logging.error(
                "[Download Missing Models] Error finding model path: %s", exc
            )
            return None

    def find_model_in_all_folders(
        self, model_name: str, folder_types: Optional[Iterable[str]] = None
    ) -> Optional[Tuple[str, str]]:
        """Search for a model across all folder types."""
        try:
            filename_only = os.path.basename(model_name.replace("\\", "/"))
            all_registered = list(folder_paths.folder_names_and_paths.keys())

            folder_types = list(folder_types or []) or [
                "checkpoints",
                "loras",
                "vae",
                "controlnet",
                "clip",
                "unet",
                "diffusion_models",
                "embeddings",
                "hypernetworks",
                "upscale_models",
            ]

            for folder_key in all_registered:
                if folder_key not in folder_types:
                    folder_types.append(folder_key)

            search_order = self._prioritize_by_name(folder_types, model_name.lower())
            normalized_model = model_name.replace("\\", "/")

            for folder_type in search_order:
                resolved_key = self.resolve_folder_key(folder_type)
                if resolved_key not in folder_paths.folder_names_and_paths:
                    continue

                file_list = folder_paths.get_filename_list(resolved_key)
                for available_path in file_list:
                    normalized_available = available_path.replace("\\", "/")
                    if normalized_available == normalized_model:
                        return available_path, folder_type

                for available_path in file_list:
                    available_filename = os.path.basename(
                        available_path.replace("\\", "/")
                    )
                    if available_filename == filename_only:
                        return available_path, folder_type

            return None
        except Exception as exc:
            logging.error(
                "[Download Missing Models] Error searching all folders: %s", exc
            )
            return None

    def get_model_destination(self, folder_type: str) -> str:
        """Get the full path to the model folder."""
        folder_key = self.resolve_folder_key(folder_type)
        if folder_key in folder_paths.folder_names_and_paths:
            folders = folder_paths.get_folder_paths(folder_key)
            if folders:
                for folder in folders:
                    if folder.rstrip(os.sep).endswith(folder_type):
                        return folder
                return folders[0]

        models_dir = os.path.join(self.extension_dir, "..", "..", "models")
        return os.path.join(models_dir, folder_type)

    @staticmethod
    def _prioritize_by_name(
        folder_types: List[str], model_name_lower: str
    ) -> List[str]:
        """Heuristic for search order."""
        priority_map = [
            ("lora", "loras"),
            ("vae", "vae"),
            (("checkpoint", "ckpt"), "checkpoints"),
            ("controlnet", "controlnet"),
            (("clip", "text_encoder"), "clip"),
            (("unet", "diffusion"), "unet"),
        ]

        ordered = folder_types[:]
        for keywords, target in priority_map:
            if isinstance(keywords, tuple):
                match = any(keyword in model_name_lower for keyword in keywords)
            else:
                match = keywords in model_name_lower

            if match and target in ordered:
                ordered = [target] + [item for item in ordered if item != target]
                break

        return ordered


def available_folders() -> List[str]:
    """Return available folder keys from ComfyUI."""
    return sorted(folder_paths.folder_names_and_paths.keys())
