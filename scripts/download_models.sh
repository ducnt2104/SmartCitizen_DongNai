#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODELS_DIR="$REPO_ROOT/models"
mkdir -p "$MODELS_DIR"

echo "[models] Local ONNX directory: $MODELS_DIR"

if command -v cargo >/dev/null 2>&1; then
  echo "[models] Building Rust High-Speed CV Engine (release)..."
  (cd "$REPO_ROOT/engine" && cargo build --release)
  echo "[models] Built binary: engine/target/release/smartcitizen-cv-engine"
fi

if [[ "${1:-}" == "--download-external" ]]; then
  DEST="$MODELS_DIR/yolov8n.onnx"
  if [[ ! -f "$DEST" ]]; then
    echo "[models] Downloading yolov8n.onnx from HuggingFace..."
    curl -fL "https://huggingface.co/SpotLab/YOLOv8Detection/resolve/main/yolov8n.onnx" -o "$DEST"
    echo "[models] Saved $DEST"
  fi
else
  echo "[models] Pass --download-external to also fetch yolov8n.onnx (~12MB) from HuggingFace."
fi
