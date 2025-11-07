"""Shared dataclasses for the Download Missing extension."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Dict, List, Optional


@dataclass
class Correction:
    """Represents an automatic path correction for a workflow node."""

    name: str
    old_path: str
    new_path: str
    folder: str
    directory: str
    node_id: Optional[int]
    node_type: Optional[str]
    correction_type: str
    widget_index: Optional[int] = None
    property_index: Optional[int] = None

    def to_payload(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class MissingModel:
    """Model reference that may need downloading or lookup."""

    name: str
    folder: str
    directory: str
    node_id: Optional[int]
    node_type: Optional[str]
    correction_type: Optional[str] = None
    widget_index: Optional[int] = None
    property_index: Optional[int] = None
    url: Optional[str] = None
    url_source: Optional[str] = None
    expected_filename: Optional[str] = None
    actual_filename: Optional[str] = None
    original_url: Optional[str] = None
    needs_folder_selection: bool = False
    metadata: Dict[str, Any] = field(default_factory=dict)
    related_usages: List[Dict[str, Any]] = field(default_factory=list)

    def to_payload(self) -> Dict[str, Any]:
        payload = asdict(self)
        # Avoid sending empty metadata to clients.
        if not self.metadata:
            payload.pop("metadata", None)
        return payload


@dataclass
class DownloadJob:
    """Represents a model download request."""

    expected_filename: str
    download_url: str
    folder: str
    actual_filename: Optional[str] = None


@dataclass
class DownloadStatus:
    """Tracks the state of a download task."""

    status: str
    progress: float
    downloaded: int
    total: int
    error: Optional[str] = None

    def to_payload(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class ScanStatus:
    """Represents scan progress for the workflow."""

    status: str
    stage: str
    progress: int
    message: str

    def update(self, **kwargs: Any) -> None:
        for key, value in kwargs.items():
            setattr(self, key, value)

    def to_payload(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class ScanResult:
    """Final result of a workflow scan."""

    missing_models: List[MissingModel]
    not_found_models: List[MissingModel]
    corrected_models: List[Correction]

    def to_payload(self) -> Dict[str, Any]:
        return {
            "missing_models": [model.to_payload() for model in self.missing_models],
            "not_found_models": [model.to_payload() for model in self.not_found_models],
            "corrected_models": [corr.to_payload() for corr in self.corrected_models],
        }
