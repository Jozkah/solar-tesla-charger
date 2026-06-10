# Weather backgrounds

Drop one image per weather condition in this folder. The dashboard picks the file
matching the live weather (Open-Meteo WMO code + day/night) and fades it in behind
the UI. Missing files are fine — the page keeps its plain dark background.

**Exact filenames** (extension `.jpg`, `.png` or `.webp` — tried in that order):

| File | Shown for |
|------|-----------|
| `clear-day` | WMO 0, daytime |
| `clear-night` | WMO 0, night |
| `partly-day` | WMO 1–2, daytime |
| `partly-night` | WMO 1–2, night |
| `overcast` | WMO 3 (and unknown codes) |
| `fog` | WMO 45/48 |
| `rain` | WMO 51–67, 80–82 |
| `snow` | WMO 71–77, 85/86 |
| `storm` | WMO ≥ 95 |

Specs: 16:9 landscape, ~1920×1080 is plenty (it's dimmed ~70 % behind a scrim).
Keep them dark and low-contrast — white text sits on top. Generation prompts:
[docs/weather-bg-prompts.md](../../docs/weather-bg-prompts.md).
