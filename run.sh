#!/bin/bash
cd "$(dirname "$0")"
exec bash deps/ralph-image-analysis/ralph.sh --tool omx --images-dir designs "${@:-50}"
