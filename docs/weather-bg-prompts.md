# Weather background — generation prompts (nano banana 2)

Nine images, one per condition. Save each into `public/bg/` with the **exact filename**
shown (any of `.jpg` / `.png` / `.webp`).

**Append this style block to every prompt** (keeps the set consistent):

> Background image for a dark-mode energy dashboard app. Cinematic, photorealistic,
> 16:9 landscape. Sky fills the top two thirds; a minimal rural horizon with faint
> rooftop solar-panel silhouettes sits low in the frame. The bottom third fades
> smoothly into near-black (#0a0c10) so UI text stays readable. Very dark, muted,
> low-contrast ambient mood. Soft gradients, subtle vignette. No people, no text,
> no logos, no watermarks.

| File | Prompt (prepend to the style block) |
|------|--------------------------------------|
| `clear-day` | A flawless deep-blue summer sky at golden hour, low warm sun glowing just above the horizon, a few thin wisps of haze catching amber light. |
| `clear-night` | A pristine starry night sky, deep navy to black, faint Milky Way band, no moon, stars crisp but subtle. |
| `partly-day` | Scattered soft cumulus clouds drifting in a late-afternoon sky, warm sunbeams breaking through the gaps, gentle god-rays. |
| `partly-night` | A moonlit night with scattered slow clouds, a soft halo around a bright gibbous moon, silver-blue tones. |
| `overcast` | A heavy, uniform grey cloud deck, flat diffuse light, melancholic but calm, almost monochrome blue-grey. |
| `fog` | Dense low fog rolling over the landscape, milky diffusion swallowing the horizon, silhouettes barely visible, cold pale tones. |
| `rain` | Dark rain-laden nimbus clouds, fine visible rain streaks backlit by weak grey light, wet sheen on the rooftops. |
| `snow` | Quiet snowfall against a cold blue-grey sky, snow-dusted rooftops and horizon, soft bokeh snowflakes in the foreground. |
| `storm` | A dramatic towering thundercloud at dusk, one single forked lightning bolt striking far on the horizon, deep purple-grey palette. |

Tips:
- Generate at 1920×1080 (or any 16:9); bigger is unnecessary — the UI dims the image ~70 %.
- If a result comes out bright, ask for "much darker, exposure −2 stops, night-mode UI backdrop".
- Re-roll until the bottom third is genuinely dark; that's where the cards and chart sit.
