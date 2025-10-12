# ComfyUI Download Missing Models

A ComfyUI extension that automatically finds and downloads missing models from template workflows that include download URLs in their node properties.

## What It Does

When you load template workflows from template browsers, this extension scans for missing models with download URLs and provides one-click downloads. Entirely vibe coded, not heavily tested, and not officially supported. Use at your own risk!

## How It Works

- Scans workflow nodes for `properties.models` arrays with download URLs
- Checks if models are already installed
- Provides download buttons for missing models
- Uses ComfyUI Manager for actual downloads
