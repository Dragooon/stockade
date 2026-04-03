---
name: goplaces
description: Find and recommend real-world places (cafes, restaurants, shops, etc.) using Google Places API via the goplaces CLI. Use when a user asks for place recommendations, nearby venues, or local business info. The skill handles fetching a broad set of results, filtering for relevance and place type, and presenting only the best matches. Triggers on requests like "recommend a cafe near X", "find breakfast spots in Y", "what's a good restaurant near Z", "places to eat near me".
---

# goplaces — Google Places Recommendations

Binary: `C:\Users\mail\AppData\Local\bin\goplaces.exe`
API key setup (required before every exec call — env vars don't persist between calls):
```powershell
$env:GOOGLE_PLACES_API_KEY = (op read "op://Employee/Google Places API Key/credential")
```

## Core Workflow

1. **Fetch broad results** — 10–15 results, generous radius, `--min-rating 4.0`
2. **Filter by type** — keep only types matching intent, exclude hard mismatches
3. **Re-rank by score** — `rating * log(user_rating_count + 1)` balances quality + popularity
4. **Present top 3–5** with name, rating, review count, address

## Key Commands

```powershell
# Text search — ALWAYS use --json and join lines before ConvertFrom-Json
$places = (& "C:\Users\mail\AppData\Local\bin\goplaces.exe" search "cafe breakfast Prahran" --open-now --min-rating 4.0 --limit 15 --json) -join "`n" | ConvertFrom-Json

# Coordinate-biased search
$places = (& "C:\Users\mail\AppData\Local\bin\goplaces.exe" search "coffee" --lat -37.848 --lng 144.995 --radius-m 800 --limit 15 --json) -join "`n" | ConvertFrom-Json

# Place details
& "C:\Users\mail\AppData\Local\bin\goplaces.exe" details <place_id> --reviews
```

**Important:** Field names are snake_case: `user_rating_count`, `place_id`, `open_now`.

## Type Filtering (Critical)

Google Places returns irrelevant types. Use **positive match + hard exclude** — don't exclude `bar` alone as many cafes have it alongside `breakfast_restaurant`.

⚠️ **General rule: filters should be inclusive, not exclusive.** When searching by intent (e.g. "barber", "hair", "cafe"), Google assigns types inconsistently — the same kind of business may appear under different type labels. Always include the full family of related types, not just the most obvious one. If results seem thin, check if relevant places were filtered out by overly strict type matching.

Full type taxonomy: see [references/place-types.md](references/place-types.md) for complete intent→type mapping.

Quick reference:

| Intent | Good types (need ≥1) | Hard exclude (any = skip) |
|--------|---------------------|--------------------------|
| Cafe/breakfast | `cafe`, `coffee_shop`, `breakfast_restaurant`, `bakery`, `diner`, `bistro`, `brunch_restaurant` | `pub`, `night_club`, `live_music_venue`, `event_venue`, `sports_bar` |
| Restaurant | `restaurant` + any cuisine type | `night_club`, `live_music_venue` |
| Bar/drinks | `bar`, `pub`, `cocktail_bar`, `wine_bar` | — |
| Barber/hair | `barber_shop`, `hair_salon`, `hair_care` — **include all three** | — |

⚠️ **Barber-specific note:** "Hair Guy Barbershop Melbourne" (367 Flinders St, ⭐4.9/458) is classified as `hair_salon` not `barber_shop` by Google. Searching only for `barber_shop` will miss it. Always include `hair_salon` and `hair_care` in barber searches.

Also exclude `catering_service` when intent is walk-in dining.

```powershell
$cafeTypes   = @("cafe","coffee_shop","breakfast_restaurant","bakery","brunch_restaurant","diner","bistro","tea_house")
$hardExclude = @("pub","night_club","live_music_venue","event_venue","sports_bar","catering_service")

$filtered = $places | Where-Object {
    $t = $_.types
    ($t | Where-Object { $cafeTypes -contains $_ }).Count -gt 0 -and
    ($t | Where-Object { $hardExclude -contains $_ }).Count -eq 0
}
# If 0 results, relax to restaurant/food types while still applying hard excludes
```

## Scoring & Ranking

```powershell
$ranked = $filtered | Select-Object *, @{
    N="score"; E={ $_.rating * [Math]::Log($_.user_rating_count + 1) }
} | Sort-Object score -Descending | Select-Object -First 5
```

## Output Format

Present top 3–5:
- **Name** — ⭐ rating (N reviews) — address
- Note open/closed if relevant

### Link format (Discord, mobile-compatible)

Always use the `api=1&query_place_id` format — the bare `?q=place_id:` format breaks on mobile Google Maps:

```
[Maps](<https://www.google.com/maps/search/?api=1&query=BUSINESS+NAME+CITY&query_place_id=PLACE_ID>)
```

Example: `[Maps](<https://www.google.com/maps/search/?api=1&query=Hair+Guy+Barbershop+Melbourne&query_place_id=ChIJpxsEJ7NC1moRW5gYFRuTXCU>)`

## Notes

- Infer location from context (timezone, prior conversation) but state the assumption
- `--open-now` for immediate recs; omit for planning ahead
- Must re-set `$env:GOOGLE_PLACES_API_KEY` in every exec call
