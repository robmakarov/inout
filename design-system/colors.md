# Colors

Color tokens. Code should use these variables (e.g. var(--bg)) so themes and changes stay consistent.

## Tokens (:root)

- **--bg** — Page/app background
- **--bg2** — Panels, hover background
- **--line** — Borders
- **--line2** — Secondary borders
- **--dim** — Muted UI
- **--muted** — Softer muted
- **--soft** — Secondary text
- **--text** — Primary text
- **--bright** — Emphasized text
- **--acc** — Accent (primary)
- **--acc2** — Accent secondary
- **--mono** — Font: DM Mono
- **--sans** — Font: Syne

## Current values (reference)

- --bg: #0a0a09
- --bg2: #111110
- --line: #1e1e1c
- --line2: #2a2a27
- --dim: #3a3a36
- --muted: #666660
- --soft: #999990
- --text: #e2ddd4
- --bright: #f0ece3
- --acc: #e8d5a0
- --acc2: #b8a060

## Usage

- Backgrounds: --bg, --bg2
- Borders: --line, --line2
- Text: --text (primary), --soft (secondary), --dim (muted), --bright (emphasis)
- Buttons/links/accents: --acc, --acc2
- Do not hardcode hex in components; use tokens.
