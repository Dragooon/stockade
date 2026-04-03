---
name: accommodation-search
description: Search for real-time accommodation prices, ratings, and availability using browser automation. Covers hotels, serviced apartments, private rooms, and vacation rentals. Use when user asks to find hotels, apartments, places to stay, accommodation deals, or Airbnb listings for specific dates and locations. Triggers include "find hotels", "search accommodation", "where to stay", "hotel near", "serviced apartment", "airbnb", "places to stay", "cheapest hotel", "hotel prices".

---

# Accommodation Search

## Source Selection

| Intent | Source | Why |
|--------|--------|-----|
| Hotels, serviced apartments | Google Hotels | Broad hotel inventory with ratings |
| Private apartments, vacation rentals | Airbnb | Direct URL, zero interaction, 1 snapshot |
| Both (recommended for full picture) | Run sequentially — Airbnb first, then Google Hotels | Single session, one page at a time |

> ⚠️ All browser commands run in a single persistent session. Tasks are sequential — complete one search before opening another.

---

## Airbnb (preferred for apartments — 1 intervention)

Construct URL with all params. Results load without any interaction.

```powershell
mcp__claude-in-chrome open "https://www.airbnb.com.au/s/LOCATION/homes?checkin=CHECKIN&checkout=CHECKOUT&adults=GUESTS"
mcp__claude-in-chrome wait --load networkidle
mcp__claude-in-chrome snapshot -i
# ── INTERVENTION: Read map pin buttons for prices, listing links for type/name ──
```

Prices are in map pin button labels — most efficient:
```
button "Apartment in Haymarket, $556 AUD"   ← 2-night total
```

**Airbnb URL location format:**

| Location | URL segment |
|----------|-------------|
| Sydney CBD | `Sydney-CBD--NSW` |
| Prahran | `Prahran--VIC` |
| Melbourne CBD | `Melbourne-City--VIC` |
| Surry Hills | `Surry-Hills--NSW` |
| Near landmark | Use nearest suburb |

**Adding filters via URL** (avoids extra interaction):
- Price max: `&price_max=200` (per night in local currency)
- Property type: `&l2_property_type_ids=1` (apartment) or `=2` (house)
- Rooms: `&min_bedrooms=1`

---

## Google Hotels (hotels & serviced apartments — 2 interventions)

**Critical:** Navigate to Google Hotels cleanly — if the session is on another page, refs will be wrong. Use `open` to navigate directly rather than closing and reopening.

```powershell
# Navigate directly — no need to close, just load the page fresh
mcp__claude-in-chrome open "https://www.google.com/travel/hotels"
mcp__claude-in-chrome wait --load networkidle
# (Remove the 'mcp__claude-in-chrome close 2>&1' line below — kept for reference only)
mcp__claude-in-chrome close 2>&1  # only needed before --headed mode, not between navigations

# Open base URL — never use ?q= parameter, it crashes Chrome
mcp__claude-in-chrome open "https://www.google.com/travel/hotels"
mcp__claude-in-chrome wait --load networkidle

# Set location — combobox is e73 (with existing value) or e1 (empty)
# Clear button is e74 when a value exists — ignore error if absent
mcp__claude-in-chrome click "e74" 2>&1 | Out-Null
Start-Sleep -Milliseconds 300
mcp__claude-in-chrome click "e1"
Start-Sleep -Milliseconds 300
mcp__claude-in-chrome type "e2" "LOCATION_QUERY"
# Query options:
#   "sydney cbd hotels"  → hotels and serviced apartments
#   "sydney cbd rentals" → private rooms and vacation rentals (Airbnb-style)
Start-Sleep -Milliseconds 2500
mcp__claude-in-chrome snapshot -i
# ── INTERVENTION 1: Find autocomplete listbox, pick best suggestion ref, then run: ──
# mcp__claude-in-chrome click "SUGGESTION_REF"
# mcp__claude-in-chrome wait --load networkidle

# Set dates — ALL future dates render as a flat list, no month navigation needed
# Find Check-in textbox, click it, then find date buttons by label
mcp__claude-in-chrome snapshot -i | Out-Null
mcp__claude-in-chrome click "CHECKIN_TEXTBOX_REF"
Start-Sleep -Milliseconds 800
mcp__claude-in-chrome snapshot -i | Out-Null
# Date button labels are exact: "Tuesday, March 17, 2026"
mcp__claude-in-chrome click "CHECKIN_DATE_REF"
Start-Sleep -Milliseconds 300
mcp__claude-in-chrome click "CHECKOUT_DATE_REF"
Start-Sleep -Milliseconds 300
mcp__claude-in-chrome click "DONE_REF"  # "Done" button — only enabled after both dates selected
mcp__claude-in-chrome wait --load networkidle

# Results
mcp__claude-in-chrome snapshot -i
# ── INTERVENTION 2: Read results snapshot ──
mcp__claude-in-chrome close
```

**Result structure in snapshot:**
```
link "Meriton Suites Kent Street, Sydney"
link "Prices starting from $412, Meriton Suites Kent Street, Sydney"  ← full stay total
link "4.2 out of 5 stars from 2,786 reviews, Meriton Suites Kent Street, Sydney"
```
⚠️ Divide total by nights for nightly rate.

---

## Running Both Sources

Since all commands share the same session, run sequentially — Airbnb first (faster, 1 intervention), then Google Hotels.

```powershell
# 1. Airbnb first
mcp__claude-in-chrome open "https://www.airbnb.com.au/s/LOCATION/homes?checkin=CHECKIN&checkout=CHECKOUT&adults=1"
mcp__claude-in-chrome wait --load networkidle
mcp__claude-in-chrome snapshot -i
# ── Extract Airbnb results ──

# 2. Then Google Hotels
mcp__claude-in-chrome open "https://www.google.com/travel/hotels"
mcp__claude-in-chrome wait --load networkidle
# ... continue Google Hotels flow ...
```

---

## Known Issues & Fixes

| Problem | Root cause | Fix |
|---------|-----------|-----|
| Combobox refs wrong after first page load | Session was previously on a different page — refs are page-specific | Always `mcp__claude-in-chrome close` and reopen before Google Hotels searches |
| `?q=` URL crashes Chrome on Google Hotels | Chrome-specific crash with that URL format | Use base URL only, set location interactively |
| `fill` on combobox doesn't trigger autocomplete | `fill` clears and types but doesn't fire input events | Use `type` not `fill` |
| `&&` chaining fails on PowerShell | PowerShell parses `&&` differently | Use `Start-Sleep` between separate calls, or `;` separator |
| Clear button (e74) absent | Field is already empty | Ignore error with `2>&1 \| Out-Null` |
| Location change resets dates | Expected Google Hotels behaviour | Always set dates AFTER confirming location |
| Autocomplete snapshot only shows 2 combobox refs | Autocomplete API hasn't responded yet | Add `Start-Sleep -Milliseconds 2500` before snapshotting |
| Airbnb map pins show total not nightly | Airbnb displays total by default | Divide by nights to get nightly rate |
| Combobox refs wrong after navigating from another page | Refs are page-specific, DOM has changed | Use `mcp__claude-in-chrome open` to navigate to Google Hotels fresh before interacting |
