# OpenWaifu

**OpenWaifu** — A fully customized emotion voice system using Qwen3 TTS + WaifuClaw (Changli) Live2D model pack for Open-LLM-VTuber.

Install this pack on any Open-LLM-VTuber instance to get the same character setup immediately.

## What's Included

### TTS Voice Customization (`qwen3_tts.py`)
- **Per-emotion voices**: Unique voice characteristics for joy, sadness, surprise, anger, fear, disgust, smirk, neutral
- **Pitch dynamics**: Extreme pitch variation per emotion (max expressiveness)
- **Speaking speed**: Base 1.5x pace with per-emotion speed tuning
- **Interjections**: Auto-inserted Korean interjections per emotion (e.g. wow!, gasp, hmm~)
- **Filler elongation**: Automatic conversion of short fillers to drawn-out forms (음→으음~, 흠→흐음~, 아→아아~)
- **Breathing patterns**: Emotion-specific breath sounds (laughing breath, trembling breath, hyperventilation, etc.)
- **Question intonation**: Auto rising pitch for sentences ending with `?`
- **Exclamation intonation**: Auto rising pitch for sentences ending with `!`
- **Instruction length optimization**: All instructions compressed to fit Qwen3 TTS API's ~2000 char limit

### Persona (`conf.yaml`)
- Soft-spoken casual female speech style (Korean)
- Emotion tags in LLM output ([joy], [sadness], etc.)
- LLM: OpenAI-compatible API (user-configured)

### Live2D Model (`WaifuClaw`)
- Changli model with 16 expressions (EXP3)
- Emotion-to-expression mapping (model_dict.json)

## Requirements

- [Open-LLM-VTuber](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber) v1.2.0+
- `DASHSCOPE_API_KEY` environment variable (for Qwen3 TTS — get one from [Alibaba Cloud Model Studio](https://www.alibabacloud.com/product/model-studio))
- An OpenAI-compatible LLM API endpoint (OpenAI, Gemini, Claude, Ollama, LM Studio, etc.)

## Installation

```bash
# 1. Clone this repo
git clone https://github.com/HaD0Yun/OpenWaifu.git

# 2. OLV must already be installed
# (If not: git clone https://github.com/Open-LLM-VTuber/Open-LLM-VTuber.git)

# 3. Run the install script
cd OpenWaifu
./install.sh /path/to/Open-LLM-VTuber

# 4. Set environment variable
export DASHSCOPE_API_KEY="your-dashscope-api-key"

# 5. Edit conf.yaml (REQUIRED — see 'Post-Install Configuration' below)

# 6. Start the server
cd /path/to/Open-LLM-VTuber
uv run run_server.py
```

## File Structure

```
OpenWaifu/
├── install.sh                          # Auto-install script with backup
├── config/
│   └── conf.yaml                       # Persona + LLM + TTS settings
├── src/open_llm_vtuber/
│   ├── tts/
│   │   ├── qwen3_tts.py                # Core: emotion voice engine
│   │   └── tts_factory.py              # TTS factory (qwen3 registration)
│   ├── agent/
│   │   └── transformers.py             # Prosody marker extraction
│   ├── config_manager/
│   │   └── tts.py                      # Qwen3TTS config schema
│   ├── conversations/
│   │   ├── tts_manager.py              # TTS streaming / chunk synthesis
│   │   └── conversation_utils.py       # Conversation utilities
│   ├── utils/
│   │   └── stream_audio.py             # Audio streaming
│   ├── live2d_model.py                 # Live2D encoding handler
│   ├── server.py                       # Server modifications
│   └── asr/
│       └── faster_whisper_asr.py       # ASR modifications
├── live2d-models/
│   └── WaifuClaw/runtime/              # Live2D model assets
├── model_dict.json                     # Emotion-to-expression mapping
├── scripts/
│   └── start_sora_stack.sh             # Stack start script
└── doc/
    └── SORA_QWEN3TTS_QUICKSTART.md     # Quickstart guide
```

## Post-Install Configuration

After running `install.sh`, you **must** edit `conf.yaml` to match your environment:

```yaml
# conf.yaml location: <OLV-directory>/conf.yaml

# === LLM Settings (MUST CHANGE) ===
# Set these to your own LLM API
openai_compatible_llm:
  base_url: 'https://api.openai.com/v1'   # Your LLM API URL
  llm_api_key: 'sk-your-api-key'          # Your API key
  model: 'gpt-4o'                          # Model to use

# === Examples for various LLM backends ===
# OpenAI:     base_url: 'https://api.openai.com/v1'
# Gemini:     base_url: 'https://generativelanguage.googleapis.com/v1beta/openai'
# Claude:     Use the claude_llm section instead
# Ollama:     base_url: 'http://localhost:11434/v1'
# LM Studio:  base_url: 'http://localhost:1234/v1'
```

### Configuration Reference

| Setting | Location in conf.yaml | Description | Must Change |
|---------|----------------------|-------------|:-----------:|
| LLM API URL | `openai_compatible_llm.base_url` | LLM endpoint | Yes |
| LLM API Key | `openai_compatible_llm.llm_api_key` | API auth key | Yes |
| LLM Model | `openai_compatible_llm.model` | Model name | Yes |
| TTS Voice | `qwen3_tts.voice` | Qwen3 TTS voice ID | Optional |
| Persona | `persona_prompt` | Character personality / speech style | Optional |

## Backup & Restore

`install.sh` automatically backs up existing files (`.sohee-backup.YYYYMMDDHHMMSS` suffix).

To restore:
```bash
# Example: restore qwen3_tts.py
cd /path/to/Open-LLM-VTuber
mv src/open_llm_vtuber/tts/qwen3_tts.py.sohee-backup.* \
   src/open_llm_vtuber/tts/qwen3_tts.py
```

## Base Version

- Open-LLM-VTuber: v1.2.0 (commit `e51dcbb`)
- This pack is tested against that version. Compatibility with other versions is not guaranteed.

## License

Source code modifications in this character pack follow Open-LLM-VTuber's license.
The WaifuClaw (Changli) Live2D model follows the original creator's license.
