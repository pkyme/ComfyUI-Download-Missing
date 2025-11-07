"""Workflow scanning and resolution logic."""

from __future__ import annotations

import asyncio
import logging
import os
import re
from typing import Dict, List, Optional, Tuple

import aiohttp

from .folder_registry import FolderRegistry
from .hf_search import HuggingFaceSearch
from .models import Correction, MissingModel, ScanResult, ScanStatus


class WorkflowScanner:
    """Encapsulates workflow analysis and HuggingFace resolution."""

    CURRENT_SCAN_ID = "current"
    MODEL_FILE_EXTENSIONS = {
        ".safetensors",
        ".ckpt",
        ".pt",
        ".pth",
        ".bin",
        ".sft",
        ".gguf",
    }

    def __init__(
        self,
        folder_registry: FolderRegistry,
        hf_search: HuggingFaceSearch,
        session: aiohttp.ClientSession,
        scan_progress: Dict[str, ScanStatus],
    ):
        self.folder_registry = folder_registry
        self.hf_search = hf_search
        self.session = session
        self.scan_progress = scan_progress

    async def find_missing_models(self, workflow: dict) -> ScanResult:
        """Scan workflow and find missing models, auto-correcting when possible."""
        scan_id = self.CURRENT_SCAN_ID
        self.scan_progress[scan_id] = ScanStatus(
            status="scanning",
            stage="nodes",
            progress=0,
            message="Scanning workflow nodes...",
        )

        missing_models: List[MissingModel] = []
        missing_no_url: List[MissingModel] = []
        corrected_models: List[Correction] = []
        nodes = workflow.get("nodes", [])
        total_nodes = len(nodes)

        for node_idx, node in enumerate(nodes):
            prop_missing, prop_corrected = self._scan_node_properties(node)
            missing_models.extend(prop_missing)
            corrected_models.extend(prop_corrected)

            widget_missing, widget_no_url, widget_corrected = self._scan_node_widgets(
                node, workflow
            )
            missing_models.extend(widget_missing)
            missing_no_url.extend(widget_no_url)
            corrected_models.extend(widget_corrected)

            if total_nodes > 0:
                node_progress = int(((node_idx + 1) / total_nodes) * 33)
                self._update_scan_progress(
                    scan_id,
                    progress=node_progress,
                    stage="nodes",
                    message=f"Scanning workflow nodes ({node_idx + 1}/{total_nodes})...",
                )

        self._update_scan_progress(
            scan_id, progress=33, stage="metadata", message="Checking workflow metadata..."
        )

        meta_missing, meta_corrected = self._scan_workflow_metadata(workflow)
        missing_models.extend(meta_missing)
        corrected_models.extend(meta_corrected)

        unique_missing, unique_corrected, unique_no_url = self._deduplicate_models(
            missing_models, corrected_models, missing_no_url
        )

        self._update_scan_progress(
            scan_id, progress=66, stage="resolving", message="Resolving model URLs..."
        )

        resolved_models, not_found_models = await self.resolve_missing_model_urls(
            workflow, unique_no_url
        )

        all_ready_to_download = unique_missing + resolved_models

        if all_ready_to_download:
            self._update_scan_progress(
                scan_id, progress=87, stage="validating", message="Validating model URLs..."
            )
            validated_models: List[MissingModel] = []
            additional_not_found: List[MissingModel] = []

            for model in all_ready_to_download:
                validated_model = await self.validate_and_resolve_model(model)
                if validated_model.url and getattr(validated_model, "url_valid", True):
                    validated_models.append(validated_model)
                else:
                    additional_not_found.append(
                        MissingModel(
                            name=validated_model.name,
                            folder=validated_model.folder,
                            directory=validated_model.directory,
                            node_id=validated_model.node_id,
                            node_type=validated_model.node_type,
                            metadata={
                                "reason": "URL validation failed and HF search found nothing"
                            },
                        )
                    )

            all_ready_to_download = validated_models
            not_found_models.extend(additional_not_found)

        self.scan_progress[scan_id].status = "complete"
        self._update_scan_progress(
            scan_id, progress=100, stage="complete", message="Scan complete"
        )

        return ScanResult(
            missing_models=all_ready_to_download,
            not_found_models=not_found_models,
            corrected_models=unique_corrected,
        )

    async def validate_and_resolve_model(self, model: MissingModel) -> MissingModel:
        """Validate model URL and auto-search HF if invalid."""
        if not model.url:
            return await self.auto_search_hf(model)

        is_valid = await self.validate_url(model.url)
        if is_valid:
            setattr(model, "url_valid", True)
            return model

        logging.info(
            "[Download Missing Models] URL invalid (404): %s", model.url
        )
        model.original_url = model.url
        return await self.auto_search_hf(model)

    async def auto_search_hf(self, model: MissingModel) -> MissingModel:
        """Search HuggingFace and update model URL if found."""
        filename = os.path.basename(model.name)
        results = await self.hf_search.search_popular_repos(filename)

        if results:
            first_result = results[0]
            model.url = first_result["download_url"]
            model.url_source = "hf_auto_search"
            model.expected_filename = first_result.get("expected_filename", filename)
            model.actual_filename = first_result.get("actual_filename", filename)
            setattr(model, "url_valid", True)
            logging.info(
                "[Download Missing Models] Auto-found on HF: %s", model.url
            )
        else:
            model.url = None
            setattr(model, "url_valid", False)
            model.metadata["not_found"] = True
            logging.info(
                "[Download Missing Models] Could not find %s on HuggingFace", model.name
            )

        return model

    async def resolve_missing_model_urls(
        self, workflow: dict, missing_no_url: List[MissingModel]
    ) -> Tuple[List[MissingModel], List[MissingModel]]:
        """Resolve URLs for models using notes and HuggingFace search."""
        if not missing_no_url:
            return [], []

        logging.info(
            "[Download Missing Models] Attempting to resolve URLs for %d models",
            len(missing_no_url),
        )

        note_urls = self.extract_urls_from_notes(workflow)
        if note_urls:
            self.match_note_urls_to_models(missing_no_url, note_urls)

        still_missing = [m for m in missing_no_url if not m.url]
        logging.info(
            "[Download Missing Models] After note matching: %d models still need URLs",
            len(still_missing),
        )

        total_missing = len(still_missing)
        for model_idx, model in enumerate(still_missing):
            if total_missing > 0:
                url_progress = 66 + int((model_idx / total_missing) * 34)
                scan_status = self.scan_progress.get(self.CURRENT_SCAN_ID)
                if scan_status:
                    scan_status.update(
                        progress=url_progress,
                        message=f"Resolving model URLs ({model_idx + 1}/{total_missing})...",
                    )

            try:
                model_filename = os.path.basename(model.name.replace("\\", "/"))
                results = await self.hf_search.search_popular_repos(model_filename)

                if results:
                    result = results[0]
                    model.url = result["download_url"]
                    model.url_source = "hf_search"
                    model.expected_filename = result.get(
                        "expected_filename", model_filename
                    )
                    model.actual_filename = result.get(
                        "actual_filename", model_filename
                    )
                    repo_id = result.get("repo_id", "unknown")
                    match_type = (
                        "exact" if result.get("score", 1.0) == 1.0 else "flexible"
                    )
                    actual = result.get("actual_filename", model_filename)
                    expected = result.get("expected_filename", model_filename)
                    if actual != expected:
                        logging.info(
                            "[Download Missing Models] ✓ Found %s → %s in %s (%s match, will rename)",
                            expected,
                            actual,
                            repo_id,
                            match_type,
                        )
                    else:
                        logging.info(
                            "[Download Missing Models] ✓ Found %s in %s (%s match)",
                            model_filename,
                            repo_id,
                            match_type,
                        )
                else:
                    logging.info(
                        "[Download Missing Models] ✗ Not found: %s", model_filename
                    )
            except Exception as exc:
                logging.error(
                    "[Download Missing Models] Error searching for %s: %s",
                    model.name,
                    exc,
                )

        resolved = [m for m in missing_no_url if m.url]
        not_found = [m for m in missing_no_url if not m.url]
        logging.info(
            "[Download Missing Models] Resolution complete: %d resolved, %d not found",
            len(resolved),
            len(not_found),
        )
        return resolved, not_found

    async def validate_url(self, url: str) -> bool:
        """Validate a URL by sending a HEAD request."""
        try:
            async with self.session.head(
                url, allow_redirects=True, timeout=aiohttp.ClientTimeout(total=10)
            ) as response:
                return response.status < 400
        except Exception as exc:
            logging.warning(
                "[Download Missing Models] URL validation failed for %s: %s", url, exc
            )
            return False

    def _scan_node_properties(self, node: dict) -> Tuple[List[MissingModel], List[Correction]]:
        missing: List[MissingModel] = []
        corrected: List[Correction] = []

        properties = node.get("properties", {})
        if "models" in properties and isinstance(properties["models"], list):
            for property_idx, model_info in enumerate(properties["models"]):
                model_name = model_info.get("name")
                model_url = model_info.get("url")
                model_folder = model_info.get("directory") or model_info.get(
                    "folder", "checkpoints"
                )

                if model_name:
                    if not self.folder_registry.is_model_installed(
                        model_name, model_folder
                    ):
                        actual_path = self.folder_registry.find_actual_model_path(
                            model_name, model_folder
                        )
                        if actual_path:
                            model_info["name"] = actual_path
                            corrected.append(
                                Correction(
                                    name=os.path.basename(model_name),
                                    old_path=model_name,
                                    new_path=actual_path,
                                    folder=model_folder,
                                    directory=model_folder,
                                    node_id=node.get("id"),
                                    node_type=node.get("type"),
                                    correction_type="property",
                                    property_index=property_idx,
                                )
                            )
                        elif model_url:
                            missing.append(
                                MissingModel(
                                    name=model_name,
                                    folder=model_folder,
                                    directory=model_folder,
                                    node_id=node.get("id"),
                                    node_type=node.get("type"),
                                    correction_type="property",
                                    property_index=property_idx,
                                    url=model_url,
                                )
                            )
        return missing, corrected

    def _scan_node_widgets(
        self, node: dict, workflow: dict
    ) -> Tuple[List[MissingModel], List[MissingModel], List[Correction]]:
        missing: List[MissingModel] = []
        missing_no_url: List[MissingModel] = []
        corrected: List[Correction] = []

        properties = node.get("properties", {})
        if "models" in properties and isinstance(properties.get("models"), list):
            return missing, missing_no_url, corrected

        widgets_values = node.get("widgets_values", [])
        node_type = node.get("type", "")

        for widget_idx, widget_value in enumerate(widgets_values):
            if not self.detect_model_file(widget_value):
                continue

            model_name = widget_value
            result = self.folder_registry.find_model_in_all_folders(model_name)

            if result:
                actual_path, folder_type = result
                if actual_path.replace("\\", "/") == model_name.replace("\\", "/"):
                    logging.info(
                        "[Download Missing Models] ✓ Model already at correct path, skipping: %s",
                        actual_path,
                    )
                    continue

                widgets_values[widget_idx] = actual_path
                corrected.append(
                    Correction(
                        name=os.path.basename(model_name),
                        old_path=model_name,
                        new_path=actual_path,
                        folder=folder_type,
                        directory=folder_type,
                        node_id=node.get("id"),
                        node_type=node_type,
                        correction_type="widget",
                        widget_index=widget_idx,
                    )
                )
                logging.info(
                    "[Download Missing Models] Corrected path: %s -> %s (node %s, widget %s)",
                    model_name,
                    actual_path,
                    node.get("id"),
                    widget_idx,
                )
            else:
                model_url = self.find_model_url(workflow, model_name, node)
                folder_type = self.folder_registry.get_folder_from_node_type(node_type)
                needs_manual = folder_type is None
                folder_value = folder_type or "MANUAL_SELECTION_REQUIRED"

                target_list = missing if model_url else missing_no_url
                target_list.append(
                    MissingModel(
                        name=model_name,
                        folder=folder_value,
                        directory=folder_value,
                        node_id=node.get("id"),
                        node_type=node_type,
                        correction_type="widget",
                        widget_index=widget_idx,
                        url=model_url,
                        needs_folder_selection=needs_manual,
                    )
                )

        return missing, missing_no_url, corrected

    def _scan_workflow_metadata(
        self, workflow: dict
    ) -> Tuple[List[MissingModel], List[Correction]]:
        missing: List[MissingModel] = []
        corrected: List[Correction] = []
        extra = workflow.get("extra", {})

        if "model_urls" in extra:
            for model_name, model_data in extra["model_urls"].items():
                model_folder = model_data.get("directory") or model_data.get(
                    "folder", "checkpoints"
                )
                if not self.folder_registry.is_model_installed(model_name, model_folder):
                    actual_path = self.folder_registry.find_actual_model_path(
                        model_name, model_folder
                    )
                    if actual_path:
                        corrected.append(
                            Correction(
                                name=os.path.basename(model_name.replace("\\", "/")),
                                old_path=model_name,
                                new_path=actual_path,
                                folder=model_folder,
                                directory=model_folder,
                                node_id=None,
                                node_type=None,
                                correction_type="metadata",
                            )
                        )
                    else:
                        url = model_data.get("url")
                        missing.append(
                            MissingModel(
                                name=model_name,
                                folder=model_folder,
                                directory=model_folder,
                                node_id=None,
                                node_type=None,
                                url=url,
                            )
                        )

        return missing, corrected

    def _deduplicate_models(
        self,
        missing_models: List[MissingModel],
        corrected_models: List[Correction],
        missing_no_url: List[MissingModel],
    ) -> Tuple[List[MissingModel], List[Correction], List[MissingModel]]:
        def _missing_key(model: MissingModel) -> Tuple[str, str]:
            folder = (model.directory or model.folder or "").replace("\\", "/").lower()
            name = (model.name or "").replace("\\", "/").lower()
            return name, folder

        seen_missing: Dict[Tuple[str, str], MissingModel] = {}
        unique_missing: List[MissingModel] = []
        for model in missing_models:
            key = _missing_key(model)
            if key not in seen_missing:
                model.related_usages = [self._usage_metadata(model)]
                seen_missing[key] = model
                unique_missing.append(model)
            else:
                seen_missing[key].related_usages.append(self._usage_metadata(model))

        seen_corrected = set()
        unique_corrected: List[Correction] = []
        for correction in corrected_models:
            key = (
                correction.node_id,
                correction.correction_type,
                correction.widget_index,
                correction.property_index,
            )
            if key not in seen_corrected:
                seen_corrected.add(key)
                unique_corrected.append(correction)

        seen_no_url: Dict[Tuple[str, str], MissingModel] = {}
        unique_no_url: List[MissingModel] = []
        for model in missing_no_url:
            key = _missing_key(model)
            if key not in seen_no_url:
                model.related_usages = [self._usage_metadata(model)]
                seen_no_url[key] = model
                unique_no_url.append(model)
            else:
                seen_no_url[key].related_usages.append(self._usage_metadata(model))

        return unique_missing, unique_corrected, unique_no_url

    def find_model_url(self, workflow: dict, model_name: str, node: dict) -> Optional[str]:
        properties = node.get("properties", {})
        if "model_url" in properties:
            return properties["model_url"]

        extra = workflow.get("extra", {})
        if "model_urls" in extra:
            model_urls = extra["model_urls"]
            if model_name in model_urls:
                return model_urls[model_name].get("url")
        return None

    @staticmethod
    def _usage_metadata(model: MissingModel) -> Dict[str, Any]:
        return {
            "node_id": getattr(model, "node_id", None),
            "node_type": getattr(model, "node_type", None),
            "correction_type": getattr(model, "correction_type", None),
            "widget_index": getattr(model, "widget_index", None),
            "property_index": getattr(model, "property_index", None),
        }

    def detect_model_file(self, value) -> bool:
        if not isinstance(value, str):
            return False
        if len(value) < 5:
            return False

        value_lower = value.lower()
        return any(value_lower.endswith(ext) for ext in self.MODEL_FILE_EXTENSIONS)

    def extract_urls_from_notes(self, workflow: dict) -> List[dict]:
        extracted_urls: List[dict] = []
        nodes = workflow.get("nodes", [])

        for node in nodes:
            node_type = node.get("type", "")
            if node_type not in ["MarkdownNote", "Note"]:
                continue

            widgets_values = node.get("widgets_values", [])
            if not widgets_values or not isinstance(widgets_values[0], str):
                continue

            note_text = widgets_values[0]
            markdown_links = re.findall(r"\[([^\]]+)\]\(([^)]+)\)", note_text)
            for _, url in markdown_links:
                url = url.strip()
                if any(host in url for host in ("huggingface.co", "hf.co", "civitai.com")):
                    extracted_urls.append({"url": url, "source": "note"})

            plain_urls = re.findall(
                r"https?://(?:huggingface\.co|hf\.co|civitai\.com)/[^\s\)\]]+", note_text
            )
            for url in plain_urls:
                url = url.strip()
                if not any(u["url"] == url for u in extracted_urls):
                    extracted_urls.append({"url": url, "source": "note"})

        logging.info(
            "[Download Missing Models] Extracted %d URLs from notes", len(extracted_urls)
        )

        parsed_urls: List[dict] = []
        for url_info in extracted_urls:
            url = url_info["url"]
            hf_parsed = self.parse_hf_url(url)
            if hf_parsed:
                parsed_urls.append(
                    {
                        "url": url,
                        "filename": hf_parsed["filename"],
                        "file_path": hf_parsed["file_path"],
                        "download_url": hf_parsed["download_url"],
                        "source": "note",
                        "platform": "huggingface",
                        "repo_id": hf_parsed.get("repo_id"),
                    }
                )
                continue

            civitai_parsed = self.parse_civitai_url(url)
            if civitai_parsed and civitai_parsed.get("download_url"):
                parsed_urls.append(
                    {
                        "url": url,
                        "filename": civitai_parsed.get("filename"),
                        "download_url": civitai_parsed["download_url"],
                        "source": "note",
                        "platform": "civitai",
                    }
                )

        logging.info(
            "[Download Missing Models] Successfully parsed %d URLs", len(parsed_urls)
        )
        return parsed_urls

    def match_note_urls_to_models(
        self, missing_models: List[MissingModel], note_urls: List[dict]
    ) -> int:
        matched_count = 0
        for model in list(missing_models):
            model_filename = os.path.basename(model.name.replace("\\", "/"))
            for url_info in note_urls:
                url_filename = url_info.get("filename")
                if not url_filename:
                    continue
                if url_filename.lower() == model_filename.lower():
                    logging.info(
                        "[Download Missing Models] ✓ Matched '%s' to note URL: %s",
                        model_filename,
                        url_info["download_url"],
                    )
                    model.url = url_info["download_url"]
                    model.url_source = "note"
                    if url_info.get("repo_id"):
                        model.metadata["repo_id"] = url_info["repo_id"]
                    matched_count += 1
                    break
        logging.info(
            "[Download Missing Models] Matched %d models from note URLs", matched_count
        )
        return matched_count

    def parse_hf_url(self, url: str) -> Optional[dict]:
        if "huggingface.co" not in url:
            return None

        match = re.search(
            r"huggingface\.co/([^/]+/[^/]+)/(blob|resolve|tree)/([^/]+)/(.+)", url
        )
        if match:
            repo_id = match.group(1)
            branch = match.group(3)
            file_path = match.group(4).split("?")[0].split("#")[0]
            download_url = f"https://huggingface.co/{repo_id}/resolve/{branch}/{file_path}"
            return {
                "repo_id": repo_id,
                "file_path": file_path,
                "filename": os.path.basename(file_path),
                "download_url": download_url,
                "branch": branch,
            }
        return None

    @staticmethod
    def parse_civitai_url(url: str) -> Optional[dict]:
        if "civitai.com" not in url:
            return None

        direct_match = re.search(r"civitai\.com/api/download/models/(\d+)", url)
        if direct_match:
            return {
                "version_id": direct_match.group(1),
                "download_url": url,
                "filename": None,
            }

        model_match = re.search(r"civitai\.com/models/(\d+)", url)
        if model_match:
            return {"model_id": model_match.group(1), "download_url": None, "filename": None}

        return None

    def _update_scan_progress(self, scan_id: str, **kwargs) -> None:
        status = self.scan_progress.get(scan_id)
        if status:
            status.update(**kwargs)


__all__ = ["WorkflowScanner"]
