#!/usr/bin/env bash
# Path-IQ WSI Viewer — Startup Script
set -e

echo ""
echo "╔══════════════════════════════════════╗"
echo "║  Path-IQ WSI Viewer                  ║"
echo "╚══════════════════════════════════════╝"
echo ""

# Check for openslide system library
if ! command -v openslide-show-properties &>/dev/null; then
  echo "📦 OpenSlide C library not found."
  echo ""
  echo "Install it with:"
  echo "  macOS:   brew install openslide"
  echo "  Ubuntu:  sudo apt-get install openslide-tools libopenslide-dev"
  echo ""
fi

# Create virtualenv if needed
if [ ! -d ".venv" ]; then
  echo "🐍 Creating virtual environment..."
  python3 -m venv .venv
fi

echo "📦 Installing dependencies..."
.venv/bin/pip install -q -r requirements.txt

echo ""
echo "🚀 Starting server on http://localhost:5050"
echo "   Press Ctrl+C to stop."
echo ""

.venv/bin/python app.py
