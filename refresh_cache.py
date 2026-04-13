#!/usr/bin/env python3
"""Update the HuggingFace repo cache for all popular users."""

import asyncio
import logging
import os
import sys

import importlib.util

_root = os.path.dirname(os.path.realpath(__file__))
_spec = importlib.util.spec_from_file_location(
    "hf_search", os.path.join(_root, "missing_models", "hf_search.py")
)
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)
HuggingFaceSearch = _mod.HuggingFaceSearch

logging.basicConfig(level=logging.INFO, format="%(message)s")


async def main():
    cache_file = os.path.join(os.path.dirname(os.path.realpath(__file__)), "repo_cache.json")
    hf_token = os.environ.get("HF_TOKEN")

    print(f"Cache file: {cache_file}")
    if hf_token:
        print("HF_TOKEN detected.")

    searcher = HuggingFaceSearch(cache_file, hf_token=hf_token)
    print("Updating cache...")
    result = await searcher.refresh_cache()
    print(f"Done. {result['repos_refreshed']} repos processed.")


if __name__ == "__main__":
    asyncio.run(main())
