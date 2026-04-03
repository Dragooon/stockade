---
name: seedbox
description: Manage Ultra.cc seedbox — media management, torrent operations, and *arr stack administration. Use when user asks to search/add/monitor movies or TV shows, check torrent status, manage downloads, check disk usage, interact with Sonarr/Radarr/Prowlarr/qBittorrent/Plex/Jellyfin/Jellyseerr, or anything related to the seedbox or media server. Triggers include "download", "torrent", "movie", "tv show", "seedbox", "plex", "jellyfin", "sonarr", "radarr", "qbittorrent", "disk space", "what's downloading".
---

# Ultra.cc Seedbox Management

## Connection Details

- **Server:** katong.usbx.me (79.127.235.177)
- **Username:** dragooon
- **SSH:** port 22 (credentials in 1Password "Ultra.cc Seedbox")
- **Base URL:** `https://dragooon.katong.usbx.me`
- **Plan:** Panzer — 5.6TB quota on shared 20TB disk, 15TB traffic/month

## Installed Apps

| App | Version | URL Path | Purpose |
|-----|---------|----------|---------|
| Plex Media Server | 1.43.0 | External (port-based) | Media streaming |
| Jellyfin | 10.11.6 | `/jellyfin` | Media streaming (alt) |
| Jellyseerr | — | `/jellyseerr` | Media request management |
| Sonarr | 4.0.16 | `/sonarr` | TV show management |
| Sonarr2 | 4.0.16 | `/sonarr2` | TV show management (2nd instance) |
| Radarr | 6.0.4 | `/radarr` | Movie management |
| Radarr2 | 6.0.4 | `/radarr2` | Movie management (2nd instance) |
| Prowlarr | 2.3.0 | `/prowlarr` | Indexer manager |
| qBittorrent | 4.6.3 | `/qbittorrent` | Torrent client |
| FlareSolverr | 3.4.6 | — | Cloudflare bypass proxy |
| MariaDB | 10.11.6 | — | Database |
| Unpackerr | 0.14.5 | — | Auto-extract downloads |

## API Access

All *arr apps and qBittorrent expose APIs via their web interfaces. Use these for automation.

### Getting API Keys

API keys for Sonarr/Radarr/Prowlarr are found in each app's Settings > General > API Key.
To retrieve them, use the browser or SSH + config files:

```bash
# Sonarr API key (from config.xml)
ssh dragooon@katong.usbx.me "grep '<ApiKey>' ~/.apps/sonarr/config.xml"

# Radarr API key
ssh dragooon@katong.usbx.me "grep '<ApiKey>' ~/.apps/radarr/config.xml"

# Prowlarr API key
ssh dragooon@katong.usbx.me "grep '<ApiKey>' ~/.apps/prowlarr/config.xml"
```

### Common API Operations

Base URL pattern: `https://dragooon.katong.usbx.me/{app}/api/v3`

**Sonarr — search/add TV shows:**
```bash
# Search for a show
curl -s "https://dragooon.katong.usbx.me/sonarr/api/v3/series/lookup?term=QUERY" -H "X-Api-Key: KEY"

# List monitored shows
curl -s "https://dragooon.katong.usbx.me/sonarr/api/v3/series" -H "X-Api-Key: KEY"

# Get download queue
curl -s "https://dragooon.katong.usbx.me/sonarr/api/v3/queue" -H "X-Api-Key: KEY"
```

**Radarr — search/add movies:**
```bash
# Search for a movie
curl -s "https://dragooon.katong.usbx.me/radarr/api/v3/movie/lookup?term=QUERY" -H "X-Api-Key: KEY"

# List monitored movies
curl -s "https://dragooon.katong.usbx.me/radarr/api/v3/movie" -H "X-Api-Key: KEY"

# Get download queue
curl -s "https://dragooon.katong.usbx.me/radarr/api/v3/queue" -H "X-Api-Key: KEY"
```

**qBittorrent — torrent status:**
```bash
# Login (get cookie)
curl -s -c cookies.txt "https://dragooon.katong.usbx.me/qbittorrent/api/v2/auth/login" -d "username=USER&password=PASS"

# List torrents
curl -s -b cookies.txt "https://dragooon.katong.usbx.me/qbittorrent/api/v2/torrents/info"

# Transfer info
curl -s -b cookies.txt "https://dragooon.katong.usbx.me/qbittorrent/api/v2/transfer/info"
```

## SSH Access

For direct shell access (file management, checking processes, logs):

```powershell
# On Windows, use plink or ssh with password from 1Password
$pass = op read "op://Shared/Ultra.cc Seedbox/password"
# Then use sshpass or expect-based approach
```

Key directories on the seedbox:
- `/home/dragooon/` — home directory
- `/home/dragooon/Downloads/` — torrent downloads
- `/home/dragooon/media/` — organized media library (likely)
- `/home/dragooon/.apps/` — app configs

## Workflow: Adding Media

1. User requests a movie/show
2. Search via Radarr/Sonarr API
3. Add to monitored list
4. Prowlarr finds indexers, qBittorrent downloads
5. Unpackerr extracts if needed
6. Sonarr/Radarr imports and renames
7. Available on Plex/Jellyfin

## Workflow: Checking Status

1. Query qBittorrent API for active downloads
2. Check Sonarr/Radarr queues for pending imports
3. Check disk usage via SSH or UCP dashboard

## Dual Instance Architecture

The seedbox runs **two quality tiers** for both movies and TV shows:

| | Primary (4K/High) | Secondary (Low) |
|---|---|---|
| **Movies** | Radarr → `/media/Movies` (4K, ~41 movies) | Radarr2 → `/media/Movies-Low` (~13 movies) |
| **TV Shows** | Sonarr → `/media/TV Shows` (4K, ~31 series) | Sonarr2 → `/media/TV Shows Low` (~6 series) |

In Jellyseerr, primary instances are `is4k=true` and secondary `is4k=false`.

## Port Mapping (Nginx Proxy)

| Port | Service |
|------|---------|
| 17202 | Jellyfin |
| 17203 | Sonarr2 |
| 17208 | Radarr2 |
| 17213 | Jellyseerr |
| 17224 | Prowlarr |
| 17225 | Plex (SSL direct) |
| 17226 | Sonarr |
| 17227 | Radarr |
| 17240 | Nginx (main) |
| 17241 | qBittorrent |

## Notes

- App credentials are separate from SSH credentials — each app has its own password set in UCP
- All API keys are stored in 1Password under "Ultra.cc Seedbox" → "API Keys" section
- SSH works with key-based auth from the main machine (no password prompt)
- Retrieve API keys: `op read "op://Shared/Ultra.cc Seedbox/API Keys/Sonarr (4K) API Key"`
- qBittorrent WebUI uses same credentials as SSH (user: dragooon)
- Indexers: The Pirate Bay, TheRARBG, TorrentLeech (private)
- Expiry date should be monitored — check via UCP dashboard
