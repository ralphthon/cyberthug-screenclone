#!/usr/bin/env bash
# hackathon-init.sh — Push this project to a hackathon repo as initial commit
# Usage: ./hackathon-init.sh <hackathon-repo-url>
set -euo pipefail

REPO_URL="${1:-}"
if [[ -z "$REPO_URL" ]]; then
  echo "Usage: $0 <hackathon-repo-url>"
  echo "Example: $0 https://github.com/hackathon-org/team-repo.git"
  exit 1
fi

echo "🦞 Pushing to hackathon repo: $REPO_URL"

# Update remote
git remote remove origin 2>/dev/null || true
git remote add origin "$REPO_URL"

# Update watchdog config
python3 -c "
import json
with open('watchdog-config.json','r') as f: d=json.load(f)
d['repoUrl']='$REPO_URL'
with open('watchdog-config.json','w') as f: json.dump(d,f,indent=2)
print('  ✅ watchdog-config.json updated')
"

# Push
git push -u origin main 2>/dev/null || git push -u origin master 2>/dev/null || {
  echo "⚠️  Push failed. Check branch name and permissions."
  exit 1
}

echo "✅ Done! Hackathon repo ready."
