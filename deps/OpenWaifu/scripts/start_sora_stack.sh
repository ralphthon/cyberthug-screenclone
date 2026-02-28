#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="${REPO_ROOT}/logs"
mkdir -p "${LOG_DIR}"

if [[ ! -f "${REPO_ROOT}/.venv/bin/python3" ]]; then
  echo "Missing venv at ${REPO_ROOT}/.venv. Run: uv sync"
  exit 1
fi

if [[ ! -x "${HOME}/.local/share/uv/tools/qwen-tts/bin/python" ]]; then
  echo "Installing persistent qwen-tts runtime..."
  uv tool install qwen-tts
fi

echo "Ensuring flash-attn is installed in qwen-tts runtime..."
CUDA_HOME=/usr PATH="/usr/bin:${PATH}" LD_LIBRARY_PATH="/usr/lib/x86_64-linux-gnu:${LD_LIBRARY_PATH:-}" \
  uv pip install --python "${HOME}/.local/share/uv/tools/qwen-tts/bin/python" flash-attn --no-build-isolation

python3 "${REPO_ROOT}/scripts/setup_sora_conf.py"

pkill -f "run_qwen3_tts_bridge_server.py" || true
pkill -f "run_server.py --verbose" || true

nohup "${HOME}/.local/share/uv/tools/qwen-tts/bin/python" "${REPO_ROOT}/scripts/run_qwen3_tts_bridge_server.py" \
  --model "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice" \
  --host "127.0.0.1" \
  --port "18117" \
  --device "cuda:0" \
  --dtype "${QWEN_TTS_DTYPE:-bfloat16}" \
  --default-language "english" \
  --default-voice "sohee" \
  --enable-flash-attn \
  > "${LOG_DIR}/qwen3tts_bridge.log" 2>&1 &

nohup "${REPO_ROOT}/.venv/bin/python3" "${REPO_ROOT}/run_server.py" --verbose \
  > "${LOG_DIR}/olv_server.log" 2>&1 &

sleep 2

echo "Started services:"
echo "- OLV:  http://127.0.0.1:12393"
echo "- TTS:  http://127.0.0.1:18117/v1/audio/speech"
echo "Logs:"
echo "- ${LOG_DIR}/olv_server.log"
echo "- ${LOG_DIR}/qwen3tts_bridge.log"
