# Runs on the USER's machine. Collects secrets with hidden input, verifies each
# live, and writes them to the VM's ~/.maquila/env over ssh stdin only.
# Usage: bash secrets.sh <VM> <OWNER/REPO> [openrouter|anthropic|openai]
#        bash secrets.sh --links <VM> <OWNER/REPO> [provider]
# --links prints "NAME<TAB>URL<TAB>hint" per secret and exits (no prompt, no TTY needed).
set -euo pipefail

LINKS=0; [ "${1:-}" = --links ] && { LINKS=1; shift; }
U="usage: secrets.sh [--links] <VM> <OWNER/REPO> [provider]"
VM="${1:?$U}"
REPO="${2:?$U}"
PROVIDER="${3:-openrouter}"
OWNER=${REPO%%/*}

case "$PROVIDER" in
  anthropic) AI_NAME=ANTHROPIC_API_KEY; AI_URL=https://console.anthropic.com/settings/keys ;;
  openai) AI_NAME=OPENAI_API_KEY; AI_URL=https://platform.openai.com/api-keys ;;
  openrouter) AI_NAME=OPENROUTER_API_KEY; AI_URL=https://openrouter.ai/settings/keys ;;
  *) echo "Unknown provider: $PROVIDER" >&2; exit 1 ;;
esac
AI_HINT="Create an API key"
GH_URL="https://github.com/settings/personal-access-tokens/new?name=maquila-$VM&description=Maquila+factory+for+$OWNER%2F${REPO#*/}&target_name=$OWNER&expires_in=90&contents=write&pull_requests=write&metadata=read"
GH_HINT="Repository access → Only select repositories → ${REPO#*/}"
LN_URL=https://linear.app/settings/account/security
LN_HINT="Personal API keys → New key"

if [ "$LINKS" = 1 ]; then
  printf '%s\t%s\t%s\n' "$AI_NAME" "$AI_URL" "$AI_HINT"
  printf '%s\t%s\t%s\n' GH_TOKEN "$GH_URL" "$GH_HINT"
  printf '%s\t%s\t%s\n' LINEAR_API_KEY "$LN_URL" "$LN_HINT"
  exit 0
fi

if [ ! -t 0 ]; then
  echo "Run this in a real terminal (a separate tab, or a multiplexer pane your agent opens): it reads secrets with hidden input." >&2
  exit 1
fi

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

wrap() { fold -s -w 68 | sed 's/^/  /; s/ *$//'; } # 2-space indent, <= 72 cols

lines=""; names=(); N=0; TOTAL=3
ask() { # NAME LABEL URL HINT
  local name=$1 v; N=$((N+1))
  echo; echo "[$N/$TOTAL] $name — $2"
  { echo "Create: $3"; [ -z "$4" ] || echo "$4"; } | while IFS= read -r l; do
    case "$l" in Create:*) printf '  %s\n' "$l" ;; *) printf '%s\n' "$l" | wrap ;; esac
  done
  while :; do
    read -rsp "› " v; echo
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

echo "Maquila secrets for $VM (input is hidden; Enter skips)"
ask "$AI_NAME" "AI provider" "$AI_URL" ""
ask GH_TOKEN "GitHub token (lets the agent open PRs)" "$GH_URL" "$GH_HINT"
ask LINEAR_API_KEY "Linear (issues labelled maquila become jobs)" "$LN_URL" "$LN_HINT"

if [ ${#names[@]} -eq 0 ]; then echo; echo "Nothing saved"; exit 0; fi

# Merge into the remote env file (replace same names, keep others); values travel on stdin only.
printf '%s' "$lines" | ssh "$VM.exe.xyz" 'umask 077; mkdir -p ~/.maquila; f=~/.maquila/env; touch "$f"; t=$(mktemp); cat > "$t"
{ awk -F= "NR==FNR{n[\$1];next} !(\$1 in n)" "$t" "$f"; cat "$t"; } > "$f.new"; mv "$f.new" "$f"; chmod 600 "$f"; rm -f "$t"
sudo systemctl restart maquila 2>/dev/null || true'

echo; echo "Saved to $VM: ${names[*]}"
