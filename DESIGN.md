---
name: PSIndex
description: One search field over 43k Microsoft PowerShell cmdlets and error codes, set over a live ASCII contour field.
colors:
  ground-night: "#090c13"
  surface-night: "#0d111a"
  surface-night-2: "#151b28"
  surface-night-3: "#1b2232"
  code-night: "#0a0e16"
  text-night: "#e8ebf2"
  muted-night: "#a2abbf"
  faint-night: "#7f89a3"
  ground-day: "#eef0f5"
  surface-day: "#ffffff"
  surface-day-2: "#f2f4f8"
  code-day: "#f6f7fa"
  text-day: "#121725"
  muted-day: "#4d566a"
  faint-day: "#5f6880"
  source-graph: "#9b8cff"
  source-az: "#4cb3ff"
  source-entra: "#2fd0b5"
  source-exchange: "#f2b33d"
  source-mecm: "#7fd45a"
  source-errors: "#ff7a6b"
  source-all: "#b9c3d6"
  danger-night: "#ff8b7d"
  danger-day: "#b3261e"
typography:
  headline:
    fontFamily: "Geist Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "28px"
    fontWeight: 600
    lineHeight: 1.15
    letterSpacing: "-0.025em"
  title-code:
    fontFamily: "Geist Mono Variable, ui-monospace, Cascadia Code, Consolas, monospace"
    fontSize: "26px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.02em"
  search:
    fontFamily: "Geist Mono Variable, ui-monospace, monospace"
    fontSize: "18px"
    fontWeight: 500
    letterSpacing: "-0.01em"
  body:
    fontFamily: "Geist Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.5
  code:
    fontFamily: "Geist Mono Variable, ui-monospace, monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.65
  label:
    fontFamily: "Geist Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 500
  caption:
    fontFamily: "Geist Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 500
  body-sm:
    fontFamily: "Geist Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
  input-mobile:
    fontFamily: "Geist Mono Variable, ui-monospace, monospace"
    fontSize: "16px"
    fontWeight: 500
  title-code-mobile:
    fontFamily: "Geist Mono Variable, ui-monospace, monospace"
    fontSize: "21px"
    fontWeight: 600
  wordmark:
    fontFamily: "Geist Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "22px"
    fontWeight: 650
    letterSpacing: "-0.02em"
rounded:
  marker: "2px"
  highlight: "3px"
  skeleton: "4px"
  tag: "6px"
  control: "8px"
  badge: "9px"
  button: "10px"
  pane: "12px"
  pill: "999px"
spacing:
  xs: "6px"
  sm: "10px"
  md: "16px"
  lg: "32px"
components:
  pane:
    backgroundColor: "{colors.surface-night}"
    rounded: "{rounded.pane}"
  search-input:
    backgroundColor: "{colors.surface-night}"
    textColor: "{colors.text-night}"
    typography: "{typography.search}"
    rounded: "{rounded.pane}"
    height: "58px"
  source-tab:
    textColor: "{colors.muted-night}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    height: "34px"
    padding: "0 12px"
  result-row:
    typography: "{typography.code}"
    height: "64px"
    padding: "10px 16px"
  button:
    textColor: "{colors.text-night}"
    typography: "{typography.label}"
    rounded: "{rounded.button}"
    height: "34px"
    padding: "0 14px"
  tag:
    backgroundColor: "{colors.surface-night-2}"
    textColor: "{colors.muted-night}"
    rounded: "{rounded.tag}"
    height: "24px"
    padding: "0 9px"
  code-block:
    backgroundColor: "{colors.code-night}"
    typography: "{typography.code}"
    rounded: "{rounded.button}"
    padding: "14px 48px 14px 16px"
---

# Design System: PSIndex

## Overview

**Creative North Star: "The Contour Console"**

A working lookup tool laid over a moving topographic map drawn in ASCII. The map is the only expressive surface: it flows behind the header band at full strength, fades to a quiet floor behind the work panes, takes the colour of the selected source, and ripples outward from the search box as the user types. Everything in front of it is a disciplined product UI: one search field, source tabs, a dense result list and a detail pane.

Density is high and familiar on purpose. Admins arrive mid-task; the interface must read as a standard search tool within a second, with the atmosphere earning its place only in the band and gutters.

**Key Characteristics:**
- Search-first band; the field is strongest there and steps back around text (quiet zones).
- Six source hues do real work: tab state, row markers, field tint, focus and caret colour.
- Mono for things you type or copy (names, syntax, search input); sans for everything else.
- Hairline-bordered panes on a tinted ground; no decorative chrome.

## Colors

Restrained neutrals tinted blue-black (night) or cool grey (day), carrying a six-hue source palette that is used for state and identity, never for decoration.

### Primary
- **Source hues**: Graph violet (#9b8cff), Az azure (#4cb3ff), Entra teal (#2fd0b5), Exchange amber (#f2b33d), MECM green (#7fd45a), Errors coral (#ff7a6b), All steel (#b9c3d6). Exposed as `--src` on the app root and on each row, tab and detail pane. Text-weight uses mix the hue toward white (night) or black (day) via `color-mix(in oklab, var(--src) 70–80%, var(--ink-mix))` so it stays legible.

### Neutral
- **Night ground** (#090c13), **night surfaces** (#0d111a at 93% alpha, #151b28, #1b2232), **code well** (#0a0e16).
- **Night text** (#e8ebf2), **muted** (#a2abbf), **faint** (#7f89a3, meta only).
- **Day ground** (#eef0f5), **day surfaces** (#ffffff at 94%, #f2f4f8), **day text** (#121725), **muted** (#4d566a), **faint** (#5f6880).
- **Lines**: rgb(168 182 214 / 0.13) night, rgb(22 32 60 / 0.11) day; strong variants at ~0.2–0.24.

### Named Rules
**The Source Owns The Hue Rule.** Colour on screen always means "which product this belongs to" or "this is selected". A hue is never used for emphasis alone.

**The Tinted Selection Rule.** Selected/open states are a full tint of the source hue (13–16% mix into the surface), never a bar down one side.

## Typography

**UI Font:** Geist Variable (system sans fallback)
**Code Font:** Geist Mono Variable (ui-monospace, Cascadia Code, Consolas fallback)

**Character:** One quiet sans for interface and prose; one mono for anything a user would type into PowerShell.

### Hierarchy
- **Headline** (600, 28px, 1.15, -0.025em): idle-pane heading only.
- **Title-code** (600 mono, 26px; 21px mobile): the open cmdlet or error code. Wraps anywhere; Graph names run long.
- **Search** (500 mono, 18px; 16px mobile): the search input value. Placeholder falls back to the sans.
- **Body** (400, 15px, 1.5–1.6): descriptions, max 72ch.
- **Code** (400 mono, 13px, 1.65): syntax, examples, parameter names, result names (14px, 500).
- **Label** (500, 13px): tabs, buttons, block headings (13px/600). **Caption** (500, 12px): tags, counts, table headers. **Body-sm** (14px): buttons, detail prose in errors, result names.
- **Scale:** 12 / 13 / 14 / 15 / 16 (mobile input) / 18 / 21 (mobile title) / 22 (wordmark) / 26 / 28. Nothing between steps.

### Named Rules
**The Copyable Is Mono Rule.** Mono marks text that can be pasted into a shell. Never use it for labels or decoration.

## Layout

Full-viewport app (`100dvh`, max-width 1560px). Two rows: the band (wordmark/tagline/actions, search input up to 880px wide, source tabs) and the work area. Work is a two-column grid, `minmax(340px, 5fr) | 7fr`, 14px gap, 32px side gutters. Each pane scrolls independently; the result list is virtualised at a fixed 64px row.

At ≤900px: 16px gutters, tabs become a single horizontally scrolling row, the list fills the screen, and the detail pane becomes a full-screen sheet that slides up (260ms) with a back button. The tagline hides at ≤1100px.

Spacing rhythm: 6 / 10 / 16 / 32px; detail blocks are separated by 30px, headings sit 10px above their content.

## Elevation & Depth

Flat, with tonal layering: panes and the search box are near-opaque surfaces on the tinted ground, each declared once by a hairline border and no shadow. Focus adds a 4px source-tinted ring around the search box. The ASCII field is the only depth cue.

## Shapes

Radii: 6px tags and kbd, 8px selects and small copy buttons, 10px buttons and code wells, 12px panes and the search box, full pill for source tabs and chips (small controls only). Source markers are 8px squares with 2px radius.

## Components

- **Source tab**: pill, dot + label + tabular count. On: source-tinted fill and border. `aria-pressed`.
- **Result row**: dot, mono name with query fragments highlighted by a 26% source tint, right-aligned meta (beta / product), one-line description. Hover/keyboard cursor: surface-2. Open: source tint.
- **Detail**: mono title with copy, then a tag row led by the source tag (dot + short name), module, verb, category, API version and permission count; primary "Microsoft Learn" button (source-tinted) and quiet "Copy link"; then Syntax (one code well per parameter set), Parameters table (required/positional tags; pipeline and proxy params collapsed), Permissions (Graph), Examples, and Same-noun / Nearby-code links.
- **Code well**: tokenised PowerShell (cmdlet, -Param, <Type>, $var, strings, comments), copy button pinned top-right.
- **States**: skeleton shimmer rows while the index loads; skeleton blocks while detail loads; inline error notice with recovery copy; empty state that teaches (noun-only, fewer words, drop 0x) with a "search every source" reset.

## Do's and Don'ts

**Do**
- Keep the ASCII field behind the band and gutters; register any text placed over it as a quiet zone (`data-quiet`).
- Pause the field when the tab is hidden and render one static frame under `prefers-reduced-motion`.
- Theme browser surfaces from the palette: selection, caret, focus ring, scrollbars, tabular numerals.

**Don't**
- Don't put the field behind panes at full strength, or let it reduce text contrast below AA.
- Don't add a second accent or decorative colour outside the six source hues.
- Don't use glass/blur, gradient text, side-bar selection markers, or an eyebrow line above a heading.
- Don't introduce a modal for detail on desktop; the detail pane is always in place.
