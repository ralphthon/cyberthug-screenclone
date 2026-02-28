#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────
# Sohee Character Pack Installer
# For Open-LLM-VTuber (base: v1.2.0+)
# ─────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_SUFFIX=".sohee-backup.$(date +%Y%m%d%H%M%S)"

usage() {
    echo "Usage: $0 <path-to-Open-LLM-VTuber>"
    echo ""
    echo "Example:"
    echo "  $0 ~/Open-LLM-VTuber"
    echo "  $0 /home/user/Desktop/AI_V/Open-LLM-VTuber"
    exit 1
}

if [[ $# -lt 1 ]]; then
    usage
fi

OLV_DIR="$(cd "$1" && pwd)"

# ── Validate OLV directory ──
if [[ ! -f "$OLV_DIR/run_server.py" ]]; then
    echo "❌ Error: '$OLV_DIR' does not look like an Open-LLM-VTuber installation."
    echo "   Missing run_server.py"
    exit 1
fi

if [[ ! -d "$OLV_DIR/src/open_llm_vtuber" ]]; then
    echo "❌ Error: '$OLV_DIR/src/open_llm_vtuber' not found."
    exit 1
fi

pkill -f "run_server.py" 2>/dev/null || true

FRONTEND_CACHE_DIR="$HOME/.config/open-llm-vtuber"
if [[ -d "$FRONTEND_CACHE_DIR" ]]; then
    rm -rf "$FRONTEND_CACHE_DIR/Cache"
    rm -rf "$FRONTEND_CACHE_DIR/Code Cache"
    rm -rf "$FRONTEND_CACHE_DIR/GPUCache"
    rm -rf "$FRONTEND_CACHE_DIR/blob_storage"
    rm -rf "$FRONTEND_CACHE_DIR/Session Storage"
    rm -rf "$FRONTEND_CACHE_DIR/Local Storage"
    rm -rf "$FRONTEND_CACHE_DIR/Service Worker"
fi

echo "╔══════════════════════════════════════════╗"
echo "║   Sohee Character Pack Installer         ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "Target: $OLV_DIR"
echo ""

# ── Backup + Copy function ──
install_file() {
    local src="$1"
    local dst="$2"

    if [[ -f "$dst" ]]; then
        cp "$dst" "${dst}${BACKUP_SUFFIX}"
        echo "  📦 Backed up: $(basename "$dst")"
    fi

    mkdir -p "$(dirname "$dst")"
    cp "$src" "$dst"
    echo "  ✅ Installed: $(basename "$dst")"
}

# ── 1. Source files ──
echo "── Installing source files ──"

install_file "$SCRIPT_DIR/src/open_llm_vtuber/tts/qwen3_tts.py" \
             "$OLV_DIR/src/open_llm_vtuber/tts/qwen3_tts.py"

install_file "$SCRIPT_DIR/src/open_llm_vtuber/tts/tts_factory.py" \
             "$OLV_DIR/src/open_llm_vtuber/tts/tts_factory.py"

install_file "$SCRIPT_DIR/src/open_llm_vtuber/agent/transformers.py" \
             "$OLV_DIR/src/open_llm_vtuber/agent/transformers.py"

install_file "$SCRIPT_DIR/src/open_llm_vtuber/config_manager/tts.py" \
             "$OLV_DIR/src/open_llm_vtuber/config_manager/tts.py"

install_file "$SCRIPT_DIR/src/open_llm_vtuber/conversations/tts_manager.py" \
             "$OLV_DIR/src/open_llm_vtuber/conversations/tts_manager.py"

install_file "$SCRIPT_DIR/src/open_llm_vtuber/conversations/conversation_utils.py" \
             "$OLV_DIR/src/open_llm_vtuber/conversations/conversation_utils.py"

install_file "$SCRIPT_DIR/src/open_llm_vtuber/utils/stream_audio.py" \
             "$OLV_DIR/src/open_llm_vtuber/utils/stream_audio.py"

install_file "$SCRIPT_DIR/src/open_llm_vtuber/live2d_model.py" \
             "$OLV_DIR/src/open_llm_vtuber/live2d_model.py"

install_file "$SCRIPT_DIR/src/open_llm_vtuber/server.py" \
             "$OLV_DIR/src/open_llm_vtuber/server.py"

install_file "$SCRIPT_DIR/src/open_llm_vtuber/websocket_handler.py" \
             "$OLV_DIR/src/open_llm_vtuber/websocket_handler.py"

install_file "$SCRIPT_DIR/src/open_llm_vtuber/asr/faster_whisper_asr.py" \
             "$OLV_DIR/src/open_llm_vtuber/asr/faster_whisper_asr.py"

# ── 2. Configuration ──
echo ""
echo "── Installing configuration ──"

install_file "$SCRIPT_DIR/config/conf.yaml" \
             "$OLV_DIR/conf.yaml"

install_file "$SCRIPT_DIR/model_dict.json" \
             "$OLV_DIR/model_dict.json"

# ── 3. Live2D Model ──
echo ""
echo "── Installing Live2D model (WaifuClaw) ──"

if [[ -d "$OLV_DIR/live2d-models/WaifuClaw" ]]; then
    cp -r "$OLV_DIR/live2d-models/WaifuClaw" \
          "$OLV_DIR/live2d-models/WaifuClaw${BACKUP_SUFFIX}"
    echo "  📦 Backed up existing WaifuClaw directory"
    rm -rf "$OLV_DIR/live2d-models/WaifuClaw"
    echo "  🗑️  Removed old WaifuClaw (clean install)"
fi

mkdir -p "$OLV_DIR/live2d-models/WaifuClaw"
cp -r "$SCRIPT_DIR/live2d-models/WaifuClaw/"* "$OLV_DIR/live2d-models/WaifuClaw/"
echo "  ✅ Installed WaifuClaw Live2D model (clean)"

echo ""
echo "── Applying frontend Live2D breath patch ──"

FRONTEND_ASSETS_DIR="$OLV_DIR/frontend/assets"
if [[ -d "$FRONTEND_ASSETS_DIR" ]]; then
    python3 - "$FRONTEND_ASSETS_DIR" <<'PY'
import sys
from pathlib import Path
import re

assets_dir = Path(sys.argv[1])
pattern = re.compile(
    r'(?:indexOf\(\"Breath\"\)|includes\(\"Breath\"\))\s*>=?\s*0?\s*&&\s*this\._model\.setParameterValueByIndex\(\$,\s*0(?:\.0)?\)',
    re.DOTALL,
)
replacement = 'indexOf("Breath")>=0&&this._model.setParameterValueByIndex($,1)'
part53_bad = re.compile(
    r'getId\("Part53"\)(?P<m>[\s\S]{0,240}?)setPartOpacityByIndex\(\$,\s*1(?:\.0)?\)',
    re.DOTALL,
)
part53_ok = re.compile(
    r'getId\("Part53"\)[\s\S]{0,240}?setPartOpacityByIndex\(\$,\s*0(?:\.0)?\)',
    re.DOTALL,
)
camera_video_bad = re.compile(
    r'video:\{position:"absolute",top:"0",left:"0",width:"100%",height:"100%",objectFit:"cover",zIndex:1,transform:"scaleX\(-1\)"\}'
)
camera_video_ok = re.compile(
    r'video:\{position:"absolute",top:"0",left:"0",width:"100%",height:"100%",objectFit:"cover",zIndex:1,pointerEvents:"none",transform:"scaleX\(-1\)"\}'
)
camera_video_replacement = (
    'video:{position:"absolute",top:"0",left:"0",width:"100%",height:"100%",'
    'objectFit:"cover",zIndex:1,pointerEvents:"none",transform:"scaleX(-1)"}'
)
proactive_timeout_pattern = re.compile(
    r'const defaultSettings\$1=\{allowProactiveSpeak:!1,idleSecondsToSpeak:5,allowButtonTrigger:!1\},ProactiveSpeakContext=reactExports\.createContext\(null\);function ProactiveSpeakProvider\(\{children:i\}\)\{const\[o,s\]=useLocalStorage\("proactiveSpeakSettings",defaultSettings\$1\),\{aiState:a\}=useAiState\(\),\{sendTriggerSignal:_\}=useTriggerSpeak\(\),\$=reactExports\.useRef\(null\),_e=reactExports\.useRef\(null\),tt=reactExports\.useCallback\(\(\)=>\{\$\.current&&\(clearTimeout\(\$\.current\),\$\.current=null\),_e\.current=null\},\[\]\),nt=reactExports\.useCallback\(\(\)=>\{tt\(\),o\.allowProactiveSpeak&&\(_e\.current=Date\.now\(\),\$\.current=setTimeout\(\(\)=>\{const et=\(Date\.now\(\)-_e\.current\)\/1e3;_\(et\)\},o\.idleSecondsToSpeak\*1e3\)\)\},\[o\.allowProactiveSpeak,o\.idleSecondsToSpeak,_,tt\]\);'
)
proactive_periodic_replacement = (
    'const defaultSettings$1={allowProactiveSpeak:!1,idleSecondsToSpeak:5,allowButtonTrigger:!1},'
    'ProactiveSpeakContext=reactExports.createContext(null);function ProactiveSpeakProvider({children:i}){'
    'const[o,s]=useLocalStorage("proactiveSpeakSettings",defaultSettings$1),{aiState:a}=useAiState(),'
    '{sendTriggerSignal:_}=useTriggerSpeak(),$=reactExports.useRef(null),_e=reactExports.useRef(null),'
    'tt=reactExports.useCallback(()=>{$.current&&(clearInterval($.current),$.current=null),_e.current=null},[]),'
    'nt=reactExports.useCallback(()=>{tt();if(!o.allowProactiveSpeak)return;const et=Math.max(1,Number(o.idleSecondsToSpeak)||0);'
    '_e.current=Date.now(),$.current=setInterval(()=>{if(_e.current===null)return;const j=(Date.now()-_e.current)/1e3;_(j)},et*1e3)},'
    '[o.allowProactiveSpeak,o.idleSecondsToSpeak,_,tt]);'
)
proactive_already_periodic = re.compile(
    r'ProactiveSpeakProvider\(\{children:i\}\)[\s\S]{0,900}?clearInterval\(\$\.current\)[\s\S]{0,600}?setInterval\('
)

patched = 0
already_one = 0
part53_patched = 0
part53_already_zero = 0
camera_video_patched = 0
camera_video_already_safe = 0
proactive_patched = 0
proactive_already = 0
for file_path in assets_dir.glob('*.js'):
    text = file_path.read_text(encoding='utf-8', errors='ignore')
    updated, count = pattern.subn(replacement, text)
    if 'Part53' in updated:
        updated2, count2 = part53_bad.subn(r'getId("Part53")\g<m>setPartOpacityByIndex($,0)', updated)
        if count2 > 0:
            updated = updated2
            part53_patched += 1
        elif part53_ok.search(updated):
            part53_already_zero += 1
    if 'useCameraBackground' in updated and 'video:{position:"absolute"' in updated:
        updated3, count3 = camera_video_bad.subn(camera_video_replacement, updated)
        if count3 > 0:
            updated = updated3
            camera_video_patched += 1
        elif camera_video_ok.search(updated):
            camera_video_already_safe += 1
    updated4, count4 = proactive_timeout_pattern.subn(proactive_periodic_replacement, updated)
    if count4 > 0:
        updated = updated4
        proactive_patched += 1
    elif proactive_already_periodic.search(updated):
        proactive_already += 1
    if count > 0:
        file_path.write_text(updated, encoding='utf-8')
        patched += 1
    elif updated != text:
        file_path.write_text(updated, encoding='utf-8')
    elif replacement in text:
        already_one += 1

print(f"patched_js_files={patched}")
print(f"already_one_js_files={already_one}")
print(f"part53_patched_js_files={part53_patched}")
print(f"part53_already_zero_js_files={part53_already_zero}")
print(f"camera_video_patched_js_files={camera_video_patched}")
print(f"camera_video_already_safe_js_files={camera_video_already_safe}")
print(f"proactive_periodic_patched_js_files={proactive_patched}")
print(f"proactive_periodic_already_js_files={proactive_already}")
if patched == 0 and already_one == 0:
    raise SystemExit("frontend_breath_patch_failed")
if part53_patched == 0 and part53_already_zero == 0:
    raise SystemExit("frontend_part53_patch_failed")
if proactive_patched == 0 and proactive_already == 0:
    raise SystemExit("frontend_proactive_periodic_patch_failed")
PY
    
else
    echo "  ⚠️  Skipped frontend patch: $FRONTEND_ASSETS_DIR not found"
fi

WEBSOCKET_HANDLER_PATH="$OLV_DIR/src/open_llm_vtuber/websocket_handler.py"
if [[ -f "$WEBSOCKET_HANDLER_PATH" ]]; then
    python3 - "$WEBSOCKET_HANDLER_PATH" <<'PY'
import sys
from pathlib import Path

path = Path(sys.argv[1])
text = path.read_text(encoding='utf-8')

if 'from .agent.output_types import Actions' not in text:
    anchor = 'from .conversations.conversation_handler import (\n    handle_conversation_trigger,\n    handle_group_interrupt,\n    handle_individual_interrupt,\n)\n'
    text = text.replace(anchor, anchor + 'from .agent.output_types import Actions\n')

neutral_block = '''\n        emotion_map = session_service_context.live2d_model.model_info.get(\n            "emotionMap", {}\n        )\n        neutral_expression: Optional[int] = None\n        for emotion_name, mapped_value in emotion_map.items():\n            if str(emotion_name).lower() != "neutral":\n                continue\n            if isinstance(mapped_value, list) and mapped_value:\n                first_value = mapped_value[0]\n                if isinstance(first_value, int):\n                    neutral_expression = first_value\n            elif isinstance(mapped_value, int):\n                neutral_expression = mapped_value\n            break\n\n        if neutral_expression is not None:\n            neutral_payload = prepare_audio_payload(\n                audio_path=None,\n                actions=Actions(expressions=[neutral_expression]),\n            )\n            await websocket.send_text(json.dumps(neutral_payload))\n\n'''

if 'actions=Actions(expressions=[neutral_expression])' not in text:
    anchor = '        # Send initial group status\n'
    if anchor in text:
        text = text.replace(anchor, neutral_block + anchor, 1)
    else:
        marker = '"type": "set-model-and-conf"'
        marker_idx = text.find(marker)
        call = '        await self.send_group_update(websocket, client_uid)\n'
        call_idx = text.find(call, marker_idx if marker_idx >= 0 else 0)
        if call_idx >= 0:
            text = text[:call_idx] + neutral_block + text[call_idx:]

path.write_text(text, encoding='utf-8')
print('patched_websocket_handler=1')
PY
    echo "  ✅ Patched websocket handler neutral-expression bootstrap"
else
    echo "  ⚠️  Skipped websocket patch: $WEBSOCKET_HANDLER_PATH not found"
fi

# ── 4. Scripts & Docs ──
echo ""
echo "── Installing scripts & docs ──"

install_file "$SCRIPT_DIR/scripts/start_sora_stack.sh" \
             "$OLV_DIR/scripts/start_sora_stack.sh"
chmod +x "$OLV_DIR/scripts/start_sora_stack.sh"

install_file "$SCRIPT_DIR/doc/SORA_QWEN3TTS_QUICKSTART.md" \
             "$OLV_DIR/doc/SORA_QWEN3TTS_QUICKSTART.md"

# ── Done ──
echo ""
echo "╔══════════════════════════════════════════╗"
echo "║   ✅ Installation Complete!               ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "Next steps:"
echo "  1. Set DASHSCOPE_API_KEY environment variable"
echo "  2. Update conf.yaml if your LLM proxy URL differs"
echo "     (default: http://localhost:8317/v1)"
echo "  3. Start the server:"
echo "     cd $OLV_DIR && uv run run_server.py"
echo ""
echo "Backups saved with suffix: $BACKUP_SUFFIX"
echo "To restore: rename files removing the backup suffix"
