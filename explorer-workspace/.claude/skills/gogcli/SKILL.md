---
name: gogcli
description: Interact with Google services (Gmail, Calendar, Drive, Contacts, Tasks, Sheets, Docs, etc.) via the gogcli CLI. Use when: reading/sending email, checking calendar events, managing drive files, creating/editing docs/sheets, managing contacts or tasks, or any Google Workspace operation from the terminal. Triggers on "check my email", "send an email", "calendar events", "google drive", "list tasks", "create a doc", "read my spreadsheet", or any Google service request.
---

# gogcli — Google Services CLI

Binary: `gog` (installed at `C:\tools\gogcli\gog.exe`, on PATH).

## Authentication

Account: `botmadge@gmail.com` — authenticated with full scopes (Gmail, Calendar, Drive, Contacts, Tasks, Sheets, Docs, Slides, Forms, Chat, Classroom, Apps Script, People).

OAuth client credentials stored in 1Password "Madge Google Credentials JSON" (Shared vault). Token auto-refreshes.

Set the active account before running commands:

```powershell
$env:GOG_ACCOUNT = "botmadge@gmail.com"
```

### Where things are stored

| What | Where |
|------|-------|
| OAuth client credentials | `%APPDATA%\gogcli\credentials.json` (auto-loaded by gog) |
| OAuth client credentials (backup) | 1Password "Madge Google Credentials JSON" (Shared vault) |
| OAuth refresh tokens | Windows Credential Manager (managed by gog, auto-refreshes) |

### Re-auth (if tokens expire or machine changes)

```powershell
# 1. Restore client credentials from 1Password if credentials.json is missing:
$env:OP_SESSION_my = (echo $env:OP_PASSWORD | op signin --account my.1password.com --raw)
$item = op item get "Madge Google Credentials JSON" --format json | ConvertFrom-Json
$json = ($item.fields | Where-Object { $_.label -eq "password" }).value
[System.IO.File]::WriteAllText("$env:TEMP\client_secret.json", $json)
gog auth credentials "$env:TEMP\client_secret.json"
Remove-Item "$env:TEMP\client_secret.json" -Force

# 2. Re-authorize (opens browser for consent):
gog auth add botmadge@gmail.com --listen-addr 127.0.0.1:50999
```

## Common Commands

### Gmail

```powershell
gog gmail labels list                          # List labels
gog gmail threads list --max 10                # Recent threads
gog gmail threads list --query "is:unread" --max 5  # Unread
gog gmail messages get <message-id>            # Read a message
gog gmail send --to user@example.com --subject "Hi" --body "Hello"
gog gmail drafts list                          # List drafts
```

### Calendar

```powershell
gog calendar events list --max 10              # Upcoming events
gog calendar events list --from today --to "+7d"  # Next 7 days
gog calendar events create --summary "Meeting" --start "2026-03-20T10:00:00" --end "2026-03-20T11:00:00"
gog calendar calendars list                    # List calendars
```

### Drive

```powershell
gog drive ls                                   # List root files
gog drive ls --query "mimeType='application/pdf'" --max 5
gog drive upload file.txt                      # Upload a file
gog drive download <file-id>                   # Download a file
```

### Contacts

```powershell
gog contacts list --max 20                     # List contacts
gog contacts search "John"                     # Search
gog contacts create --name "Jane Doe" --email "jane@example.com"
```

### Tasks

```powershell
gog tasks lists                                # List task lists
gog tasks list --tasklist <list-id>             # List tasks
gog tasks add --tasklist <list-id> --title "Buy milk"
gog tasks done --tasklist <list-id> --task <task-id>
```

### Sheets

```powershell
gog sheets read <spreadsheet-id>               # Read sheet
gog sheets read <spreadsheet-id> --range "Sheet1!A1:D10"
gog sheets write <spreadsheet-id> --range "A1" --values '[["a","b"],["c","d"]]'
```

### Docs

```powershell
gog docs create --title "New Doc"              # Create doc
gog docs export <doc-id> --format md           # Export as markdown
```

## Tips

- Add `--json` to any command for JSON output (scriptable).
- Add `--max N` to limit results.
- Use `gog <service> --help` for full subcommand list.
- `gog --help` for all available services.
- Multiple accounts: use `--account` flag or `GOG_ACCOUNT` env var.
