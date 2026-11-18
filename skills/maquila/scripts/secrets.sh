#!/usr/bin/env bash
# Runs on the USER's machine. Collects secrets with hidden input, verifies each
# live, and writes them to the VM's ~/.maquila/env over ssh stdin only.
# Usage: bash secrets.sh <VM> <OWNER/REPO> [anthropic|openai|openrouter]
set -euo pipefail

VM="${1:?usage: secrets.sh <VM> <OWNER/REPO> [provider]}"
REPO="${2:?usage: secrets.sh <VM> <OWNER/REPO> [provider]}"
PROVIDER="${3:-anthropic}"

if [ ! -t 0 ]; then
  echo "Run this in your own terminal: it reads secrets with hidden input." >&2
  exit 1
fi

case "$PROVIDER" in
  anthropic) AI_NAME=ANTHROPIC_API_KEY; AI_HELP="Create a key at https://console.anthropic.com/settings/keys" ;;
  openai) AI_NAME=OPENAI_API_KEY; AI_HELP="Create a key at https://platform.openai.com/api-keys" ;;
  openrouter) AI_NAME=OPENROUTER_API_KEY; AI_HELP="Create a key at https://openrouter.ai/keys" ;;
  *) echo "Unknown provider: $PROVIDER" >&2; exit 1 ;;
esac

# Prints "<body>\n<http code>". The secret reaches curl via a config on stdin, never argv.
call() { # NAME VALUE
  local name=$1 v=$2 hdr url extra=""
  case "$name" in
    ANTHROPIC_API_KEY) url=https://api.anthropic.com/v1/models
      hdr="header = \"x-api-key: $v\"
header = \"anthropic-version: 2023-06-01\"" ;;
    OPENAI_API_KEY) url=https://api.openai.com/v1/models; hdr="header = \"Authorization: Bearer $v\"" ;;
    OPENROUTER_API_KEY) url=https://openrouter.ai/api/v1/key; hdr="header = \"Authorization: Bearer $v\"" ;;
    GH_TOKEN) url="https://api.github.com/repos/$REPO"; hdr="header = \"Authorization: Bearer $v\"" ;; # confirms repo access, not write scopes
    LINEAR_API_KEY) url=https://api.linear.app/graphql
      hdr="header = \"Authorization: $v\"
header = \"content-type: application/json\""
      extra='data = "{\"query\":\"{ viewer { id } }\"}"' ;;
  esac
  printf 'url = "%s"\n%s\n%s\n' "$url" "$hdr" "$extra" | curl -s -w '\n%{http_code}' -K -
}

verify() { # NAME VALUE
  local out code body
  out=$(call "$1" "$2") || out=$'\n000'
  code=${out##*$'\n'}; body=${out%$'\n'*}
  [ "$code" = 200 ] || { CODE=$code; return 1; }
  if [ "$1" = LINEAR_API_KEY ] && [[ "$body" == *'"errors"'* ]]; then CODE="$code, API errors"; return 1; fi
}

lines=""; names=()
ask() { # NAME GUIDANCE
  local name=$1 v
  echo; echo "$2"
  while :; do
    read -rsp "$name (Enter to skip): " v; echo
    [ -z "$v" ] && return 0
    if [[ "$v" == *[\"\'\\]* || "$v" == *$'\n'* || "$v" != "${v#[[:space:]]}" || "$v" != "${v%[[:space:]]}" ]]; then
      echo "✗ $name must not contain quotes, backslashes, or leading/trailing spaces"; continue
    fi
    if verify "$name" "$v"; then
      echo "✓ $name verified"; lines+="$name=$v"$'\n'; names+=("$name"); return 0
    fi
    echo "✗ $name was rejected (HTTP $CODE)"
  done
}

ask "$AI_NAME" "$AI_HELP"
ask GH_TOKEN "Fine-grained token at https://github.com/settings/personal-access-tokens/new: Repository access → only $REPO; Permissions → Contents and Pull requests: Read and write. Lets the agent open PRs."
ask LINEAR_API_KEY 'Linear → Settings → Security & access → Personal API keys. Issues labelled `maquila` become jobs (create that label).'

if [ ${#names[@]} -eq 0 ]; then echo; echo "Nothing saved"; exit 0; fi

# Merge into the remote env file (replace same names, keep others); values travel on stdin only.
printf '%s' "$lines" | ssh "$VM.exe.xyz" 'umask 077; mkdir -p ~/.maquila; f=~/.maquila/env; touch "$f"; t=$(mktemp); cat > "$t"
{ awk -F= "NR==FNR{n[\$1];next} !(\$1 in n)" "$t" "$f"; cat "$t"; } > "$f.new"; mv "$f.new" "$f"; chmod 600 "$f"; rm -f "$t"
sudo systemctl restart maquila 2>/dev/null || true'

echo; echo "Saved to $VM: ${names[*]}"
