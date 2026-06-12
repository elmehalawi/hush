#!/bin/bash
# Download whisper tokenizer assets needed by mlx-whisper-rs
# These files are sourced from the openai/whisper and mlx-whisper packages

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "Downloading whisper tokenizer assets..."

# multilingual.tiktoken - from openai/whisper
if [ ! -f "multilingual.tiktoken" ]; then
    echo "  Downloading multilingual.tiktoken..."
    curl -sL "https://raw.githubusercontent.com/openai/whisper/main/whisper/assets/multilingual.tiktoken" -o multilingual.tiktoken
fi

# gpt2.tiktoken - from openai/whisper
if [ ! -f "gpt2.tiktoken" ]; then
    echo "  Downloading gpt2.tiktoken..."
    curl -sL "https://raw.githubusercontent.com/openai/whisper/main/whisper/assets/gpt2.tiktoken" -o gpt2.tiktoken
fi

# mel_filters_128.npy - from openai/whisper (large-v3 uses 128 mel bins)
if [ ! -f "mel_filters_128.npy" ]; then
    echo "  Downloading mel_filters_128.npy..."
    curl -sL "https://raw.githubusercontent.com/openai/whisper/main/whisper/assets/mel_filters.npz" -o mel_filters.npz
    python3 -c "
import numpy as np
data = np.load('mel_filters.npz')
np.save('mel_filters_128.npy', data['mel_128'])
np.save('mel_filters_80.npy', data['mel_80'])
"
    rm -f mel_filters.npz
fi

echo "Done! Assets in: $SCRIPT_DIR"
ls -la "$SCRIPT_DIR"/*.tiktoken "$SCRIPT_DIR"/*.npy 2>/dev/null || echo "  (some files may be missing)"
