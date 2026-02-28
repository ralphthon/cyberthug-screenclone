# Sora + Qwen3-TTS Quickstart

This guide sets up a ready-to-run stack:
- Open-LLM-VTuber web server
- cliproxy LLM backend (OpenAI-compatible)
- local Qwen3-TTS bridge (0.6B, GPU bf16)

## 1) Clone and install

```bash
git clone <your-private-repo-url>
cd Open-LLM-VTuber
uv sync
```

## 2) (Optional) Import March7 Live2D model

The repository does not include third-party Live2D assets.

If you have an extracted March7 model folder, import it:

```bash
python3 scripts/import_march7_model.py "/absolute/path/to/March 7th"
```

If March7 is not imported, the setup still works with available model defaults.

## 3) Set runtime environment values

```bash
export CLIPROXY_BASE_URL="http://localhost:8317/v1"
export CLIPROXY_API_KEY="YOUR_CLIPROXY_API_KEY"
export CLIPROXY_MODEL="gpt-5.1-codex-mini"

export QWEN_TTS_BASE_URL="http://127.0.0.1:18117"
export QWEN_TTS_LANGUAGE="english"
export QWEN_TTS_VOICE="sohee"
export QWEN_TTS_DTYPE="bfloat16"

# Optional speed test (may be unstable on some GPUs):
# export QWEN_TTS_DTYPE="float16"
```

## 4) Start everything

```bash
bash scripts/start_sora_stack.sh
```

`start_sora_stack.sh` will automatically:
- install a persistent `qwen-tts` runtime via `uv tool install qwen-tts` (first run only)
- install `flash-attn` into that runtime
- start Qwen3-TTS bridge with `--enable-flash-attn`
- start Open-LLM-VTuber server

Open:

`http://127.0.0.1:12393`

## 5) Stop everything

```bash
bash scripts/stop_sora_stack.sh
```

## Notes

- `conf.yaml` is local-only and ignored by git in this project.
- TTS bridge default model: `Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice`.
- Recommended GPU mode in this setup is bf16 for stability.
- If no audio is heard, first check:
  - `logs/olv_server.log`
  - `logs/qwen3tts_bridge.log`
