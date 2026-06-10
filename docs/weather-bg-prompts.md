# Weather background — generation prompts (nano banana 2), v2

Nine images, one per condition, saved into `public/bg/` with the **exact filename**
shown (any of `.jpg` / `.png` / `.webp`).

v2 design: each condition gets a **different scene type and a different dominant
color** so the set is instantly distinguishable — sky-scape, astro shot, macro
window glass, bokeh snow, seascape… Only a short shared suffix keeps them
app-friendly.

**Append this short suffix to every prompt:**

> Cinematic photograph, 16:9 landscape. Dark and dim overall — this is a dashboard
> background image; the bottom third fades to near-black. No text, no people, no
> logos, no watermarks.

| File | Scene prompt (prepend to the suffix) |
|------|--------------------------------------|
| `clear-day` | Low golden sun blazing above a wheat field at sunset, a huge warm lens flare, amber and honey tones flooding the whole frame, long soft shadows. Dominant color: warm gold. |
| `clear-night` | The Milky Way arching over a row of silhouetted pine trees, thousands of crisp stars, astrophotography style. Dominant color: deep indigo-violet. |
| `partly-day` | Towering white cumulus clouds seen from below against a vivid blue sky, sharp sunbeams bursting around one cloud edge. Dominant colors: sky blue and bright white. |
| `partly-night` | A bright full moon emerging between slow-moving dark clouds, silver rim-light tracing the cloud edges. Dominant color: silver-blue. |
| `overcast` | An endless flat deck of heavy stratus clouds over distant rolling hills, completely diffuse shadowless light, minimalist and brooding. Dominant color: slate grey. |
| `fog` | Layers of a pine forest dissolving into thick morning fog, trees fading from dark to pale with distance, quiet and ethereal. Dominant color: pale teal-grey. |
| `rain` | Macro shot of heavy raindrops running down dark window glass at night, blurred cool bokeh lights behind the wet pane, shallow depth of field. Dominant color: cold cyan. |
| `snow` | Large soft snowflakes falling in front of dark fir branches, bokeh flakes glowing in cold light, hushed winter night. Dominant color: ice blue-white. |
| `storm` | A massive supercell thundercloud over a dark open sea, one forked lightning bolt splitting the sky, dramatic storm light. Dominant color: electric purple-magenta. |

Anti-sameness tips:
- Generate **each image in a fresh chat/session** — within one conversation the
  model style-matches its previous outputs, which is exactly the "all similar" problem.
- If two still feel alike, re-roll with: "completely different composition and
  color palette from a typical dark landscape".
- Keep the dominant-color line — it's what makes the set readable at a glance.
- 1920×1080 is plenty. If a result is too bright: "much darker, exposure −2 stops".

Note: the UI dims the image ~70 % behind a scrim, which also flattens differences.
If the variety still doesn't show through in the app, the scrim opacity can be
lowered in `applyWeatherBg()` (`public/app.js`).
