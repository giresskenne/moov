# Moov — Brand Colors

A dark UI with a signature three-stop diagonal gradient. This document is the
source of truth for anyone creating a logo, marketing asset, or design mockup.

## The signature gradient (brand identity)

The app's identity is a **cyan → indigo → purple** gradient, applied to the logo
mark itself.

| Stop | Role | Hex | RGB |
|------|------|-----|-----|
| 0%   | Cyan   | `#64D2FF` | `100, 210, 255` |
| 50%  | Indigo | `#5E5CE6` | `94, 92, 230` |
| 100% | Purple | `#BF5AF2` | `191, 90, 242` |

If the brand must be reduced to a **single color**, use the indigo `#5E5CE6`
(the primary accent).

## Backgrounds (dark theme)

| Role | Hex | RGB |
|------|-----|-----|
| Primary background | `#0B0D12` | `11, 13, 18` |
| Elevated surface   | `#141824` | `20, 24, 36` |
| Deepest black      | `#06070C` | `6, 7, 12` |

## Text

| Role | Hex | RGB |
|------|-----|-----|
| Foreground (near-white) | `#F4F6FB` | `244, 246, 251` |
| Muted text              | `#97A0B5` | `151, 160, 181` |

## Status / functional

| Role | Hex | RGB |
|------|-----|-----|
| Success (green) | `#30D158` | `48, 209, 88` |
| Danger (red)    | `#FF6B6B` | `255, 107, 107` |
| Border / ring   | `#2A3142` | `42, 49, 66` |

## Notes for the designer

- The logo should read on a **near-black background** (`#0B0D12`), not white.
- The gradient runs **diagonally** across the mark (cyan top-left → purple
  bottom-right feels most native to the app).
- Keep plenty of contrast: the near-white `#F4F6FB` is the intended color for
  any wordmark set alongside the mark.

---

*Source: theme tokens in [`src/styles.css`](src/styles.css) and the logo
gradient in [`index.html`](index.html).*
