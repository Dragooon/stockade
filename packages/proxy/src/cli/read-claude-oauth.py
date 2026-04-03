import json, os, sys

creds_path = os.path.expanduser("~/.claude/.credentials.json")
try:
    with open(creds_path) as f:
        d = json.load(f)
    print(d["claudeAiOauth"]["accessToken"], end="")
except Exception as e:
    print(f"Error reading credentials: {e}", file=sys.stderr)
    sys.exit(1)
