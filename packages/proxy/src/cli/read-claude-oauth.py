"""
Read the Claude OAuth access token, refreshing if expired.

Called by the proxy credential provider to get a valid access token for
API key injection. Handles automatic refresh via the platform OAuth endpoint.
"""

import json, os, sys, time, urllib.request, urllib.error

CREDS_PATH = os.path.expanduser("~/.claude/.credentials.json")
TOKEN_URL = "https://platform.claude.com/v1/oauth/token"
CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
DEFAULT_SCOPES = "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload"
# Refresh if token expires within 5 minutes
REFRESH_THRESHOLD_MS = 5 * 60 * 1000

def read_creds():
    with open(CREDS_PATH) as f:
        return json.load(f)

def write_creds(data):
    with open(CREDS_PATH, "w") as f:
        json.dump(data, f, indent=2)

def lock_file(path):
    """Cross-platform file lock. Returns a handle to unlock later."""
    fd = open(path, "w")
    if sys.platform == "win32":
        import msvcrt
        msvcrt.locking(fd.fileno(), msvcrt.LK_NBLCK, 1)
    else:
        import fcntl
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    return fd

def unlock_file(fd):
    """Release the file lock."""
    if sys.platform == "win32":
        import msvcrt
        try:
            msvcrt.locking(fd.fileno(), msvcrt.LK_UNLCK, 1)
        except Exception:
            pass
    else:
        import fcntl
        fcntl.flock(fd, fcntl.LOCK_UN)
    fd.close()

def refresh_token(oauth):
    """Refresh the OAuth token and update credentials file."""
    body = json.dumps({
        "grant_type": "refresh_token",
        "refresh_token": oauth["refreshToken"],
        "client_id": CLIENT_ID,
        "scope": " ".join(oauth.get("scopes", DEFAULT_SCOPES.split())),
    }).encode()

    # Clear proxy env vars — this script runs on the host, not through the MITM proxy
    env_backup = {}
    for var in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
        if var in os.environ:
            env_backup[var] = os.environ.pop(var)

    try:
        req = urllib.request.Request(
            TOKEN_URL,
            data=body,
            headers={
                "Content-Type": "application/json",
                "User-Agent": "claude-code/1.0",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            if resp.status != 200:
                raise Exception(f"Token refresh failed: HTTP {resp.status}")
            result = json.loads(resp.read())
    finally:
        # Restore proxy env vars
        os.environ.update(env_backup)

    access_token = result["access_token"]
    new_refresh = result.get("refresh_token", oauth["refreshToken"])
    expires_in = result.get("expires_in", 3600)
    expires_at = int(time.time() * 1000) + expires_in * 1000

    # Update credentials file
    creds = read_creds()
    creds["claudeAiOauth"] = {
        **creds.get("claudeAiOauth", {}),
        "accessToken": access_token,
        "refreshToken": new_refresh,
        "expiresAt": expires_at,
    }
    write_creds(creds)

    return access_token

def main():
    try:
        creds = read_creds()
        oauth = creds["claudeAiOauth"]
        access_token = oauth["accessToken"]
        expires_at = oauth.get("expiresAt")

        # Check if token needs refresh
        now_ms = int(time.time() * 1000)
        needs_refresh = expires_at is not None and (now_ms + REFRESH_THRESHOLD_MS) >= expires_at

        if needs_refresh and oauth.get("refreshToken"):
            lock_path = CREDS_PATH + ".lock"
            try:
                lock_fd = lock_file(lock_path)
                try:
                    # Re-read in case another process refreshed while we waited
                    creds = read_creds()
                    oauth = creds["claudeAiOauth"]
                    now_ms = int(time.time() * 1000)
                    if oauth.get("expiresAt") and (now_ms + REFRESH_THRESHOLD_MS) >= oauth["expiresAt"]:
                        access_token = refresh_token(oauth)
                        print(f"Token refreshed, new expiry in {(oauth['expiresAt'] - now_ms) // 60000}m", file=sys.stderr)
                    else:
                        # Another process already refreshed
                        access_token = oauth["accessToken"]
                finally:
                    unlock_file(lock_fd)
            except (IOError, OSError):
                # Lock contention — another process is refreshing, just re-read
                time.sleep(0.5)
                creds = read_creds()
                access_token = creds["claudeAiOauth"]["accessToken"]

        print(access_token, end="")
    except Exception as e:
        print(f"Error reading credentials: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
