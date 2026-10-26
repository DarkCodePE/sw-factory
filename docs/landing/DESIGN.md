---
name: fab landing
description: Technical, austere surfaces built from commands, rules and the official teal brand accent.
colors:
  paper: "#F7FBFA"
  paper-2: "#EDF4F2"
  paper-3: "#DDEAE6"
  ink: "#0B0D12"
  ink-2: "#384B4E"
  control-edge: "#607774"
  rule: "#CBD9D5"
  rule-2: "#9DAFAA"
  brand: "#14B8A6"
  accent: "#14B8A6"
  accent-ink: "#0B0D12"
  focus: "#087C70"
  connector: "#087C70"
  action-edge: "#087C70"
  error: "oklch(43% .15 27)"
  dark-paper: "#0B0D12"
  dark-paper-2: "#131E20"
  dark-paper-3: "#1D2C2D"
  dark-ink: "#F4F8F8"
  dark-ink-2: "#B2C9C8"
  dark-control-edge: "#7D9B96"
  dark-rule: "#2A3B3B"
  dark-rule-2: "#536B68"
  dark-accent: "#14B8A6"
  dark-accent-ink: "#0B0D12"
  dark-focus: "#14B8A6"
  dark-connector: "#14B8A6"
  dark-action-edge: "#14B8A6"
  dark-error: "oklch(81% .12 27)"
typography:
  display:
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "clamp(3.125rem, 4.6vw, 4.5rem)"
    fontWeight: 700
    lineHeight: 1.05
    letterSpacing: "-0.028em"
  headline:
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "clamp(2rem, 2.5vw + 1rem, 3.5rem)"
    fontWeight: 700
    lineHeight: 1.05
    letterSpacing: "-0.028em"
  title:
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "clamp(1.25rem, 0.75vw + 0.875rem, 1.625rem)"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.028em"
  body:
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "1.125rem"
    lineHeight: 1.55
  label:
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "0.9375rem"
  lead:
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "clamp(1.25rem, .35vw + 1rem, 1.5rem)"
    lineHeight: 1.45
  terminal:
    fontFamily: 'ui-monospace, "SFMono-Regular", Consolas, monospace'
    fontSize: "1rem"
    lineHeight: 1.6
  command:
    fontFamily: 'ui-monospace, "SFMono-Regular", Consolas, monospace'
    fontSize: "clamp(1.1rem, 1.5vw, 1.375rem)"
    lineHeight: 1.65
rounded:
  card: "8px"
  control: "6px"
spacing:
  2xs: "4px"
  xs: "8px"
  sm: "12px"
  md: "16px"
  lg: "24px"
  xl: "40px"
  2xl: "64px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-ink}"
    rounded: "{rounded.control}"
    padding: "0 24px"
  button-quiet:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "0 12px"
  button-quiet-hover:
    backgroundColor: "{colors.paper-2}"
  install-tab:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink-2}"
    rounded: "{rounded.control}"
    padding: "0 16px"
  install-tab-selected:
    backgroundColor: "{colors.paper-3}"
    textColor: "{colors.ink}"
  terminal-well:
    backgroundColor: "{colors.paper-2}"
    rounded: "{rounded.card}"
    padding: "12px"
  terminal-screen:
    backgroundColor: "{colors.paper}"
    rounded: "{rounded.control}"
    padding: "24px"
    height: "400px"
  capability-card:
    rounded: "{rounded.card}"
    padding: "24px"
---

# Design System: fab landing

## Overview

**Creative North Star: "Graphite, cool paper and working commands"**

A technical, austere world uses system typography, ruled sections and commands as its material. The official fab teal is the functional signal in both light and dark modes. User-supplied SVG wordmarks define the identity. Hallmark Cobalt remains composition and control ancestry; the explicit official brand takes precedence.

**Key Characteristics:**

- System fonts with a distinct monospace command voice.
- Flat, bordered surfaces and restrained official teal emphasis.
- Working controls with visible keyboard focus and truthful state feedback.

## Colors

### Primary

Official teal fills primary controls and supplies the logo mark in both modes. Primary control labels use the official dark text color. Light-mode focus, workflow connectors and action edges use a deeper teal for contrast; dark mode uses the official teal for those roles. The exact official brand value is preserved, rather than replacing it with a theme approximation.

**The Functional Accent Rule.** Use teal to identify action, focus or a meaningful relationship. The user-requested official mark motif is a restrained brand exception.

### Neutral

Cool paper surfaces have a restrained green cast and become graphite in dark mode. Ink carries headings and commands; secondary ink carries explanations, labels and availability. Fine rules separate sections; stronger control edges define interactive boundaries. Error color identifies copy failure feedback and captured QA failures; deeper teal in light mode and official teal in dark mode identify captured passing results.

The frontmatter records light and dark counterparts explicitly. Runtime properties in `site/tokens.css` switch these roles together. The system preference applies until an explicit mode is saved under `fab-theme`.

## Typography

**Display and Body Font:** the local system sans stack in the frontmatter.
**Command Font:** the local UI monospace stack in the frontmatter.

Display is compact, bold and tightly tracked. Section headings use the headline role; feature and plan headings use title. Body paragraphs use a comfortable line height and generally cap at (65ch). Lead text uses the fluid lead role. Body is (18px), labels are (15px), and terminal transcription uses (16px) monospace with a line height of (1.6). Navigation, availability and captions use the label role. Numbered capability markers use tabular numerals.

At widths up to (48rem), display changes to `clamp(3rem, 9.8vw, 4.5rem)`. The installer script uses the body role so the longer command remains readable and wraps.

**The Local Type Rule.** Use installed system fonts; load no external font resources.

## Layout

The page container caps at (1440px) with side gutters of (64px), falling to (24px) at (60rem) and (16px) at (40rem). Shared column gaps are (32px), falling to (16px) at (40rem).

The hero pairs an introduction and installer with the captured CLI terminal in columns with proportions (.86fr / 1.14fr) and a (40px) gap. Above (64rem), its minimum content height follows the viewport less navigation and hero padding. At (64rem), the terminal moves below a two-column introduction and installer; at (48rem), those stack too. Hero padding is (32px) vertically. Local detail, model and plan sections stack at (48rem). Capability cards run three columns, two at (64rem), then one at (48rem).

The local section uses (40px) vertical padding. Flow, model and plan sections use (80px), and capabilities use (96px), reducing to (56px) and (72px) respectively at (40rem). Controls and navigation links retain a minimum hit height of (48px). Long commands wrap within their available width.

## Elevation & Depth

Tonal alternation and one-pixel rules provide depth. Cards and sections are flat. The copy button alone uses a (3px) deep-teal key edge as an intentional Hallmark Cobalt control exception requested in the hero review. This narrow tactile affordance does not establish a shadow scale for cards or sections.

## Shapes

Cards, the terminal well, embedded diagram boundary and installer tab group have gently rounded corners using the card radius. Individual controls and the inner terminal screen use the smaller control radius. Borders are thin and structural; the site does not use floating pill navigation.

## Components

### Brand identity

Header and footer use the supplied light and dark SVG wordmarks unchanged, at a rendered width of (126px) with intrinsic aspect ratio. The light variant has dark lettering; the dark variant has white lettering. CSS selects the appropriate variant for the explicit or system mode. The hero also uses the supplied mark-only SVG unchanged as an empty-alt, noninteractive motif at opacity (.045). Home links supply the accessible name; the paired images have empty alt text. The favicon is a local supplied SVG. Preserve the official paths, proportions and colors.

### Buttons

Primary copy buttons use official teal with the dark brand foreground, a minimum width of (132px), and semibold text. Quiet theme controls use paper with an ink label and a visible control edge. Quiet hover shifts to the second surface; primary hover lifts by (1px), and pressing either shifts down by (1px). Disabled controls use reduced opacity and dashed borders; busy copying changes the cursor. Focus uses a (2px) accent outline offset by (4px).

### Installation selector and command

Two real installation methods are tabs, with a neutral selected surface and stronger border. Selection controls one panel and supports arrow, Home and End keys. Commands are selectable monospace text; copy success and failure use a polite live region. Without JavaScript, both commands and their method labels remain readable.

### Navigation

Header and footer navigation use text links with generous hit height. Header hover underlines in the accent. On small screens header links form their own row; footer links wrap. The theme control names the mode it will activate.

### Cards and ruled containers

Capability cards use one-pixel borders, the card radius and large internal spacing. Number, heading, availability and description form a consistent hierarchy. Plans use a ruled top edge rather than elevated pricing cards.

### Captured CLI terminal

A bordered outer well uses the second surface and the user-requested (24px) grid, limited to this product region. Its inner screen uses paper, selectable monospace commands and wrapped output, with independent vertical scrolling. The screen is (400px) high with (24px) padding; at (48rem) it becomes (620px) high with (16px) padding. The rolling view retains the current and immediately previous frames.

This is a replay of actual hermetic CLI capture with Jira and worker fixtures, labelled as simulated in the caption. It makes one finite autoplay pass when visible, suspends advancement outside the viewport or while the document is hidden, and offers pause/resume/repeat and final-result controls. Frame arrival uses a brief opacity change (220ms). Reduced motion presents the final two frames, disables playback and removes animation. The transcript remains available without JavaScript, and the adjacent transcript link exposes the complete captured session. The terminal region keeps `aria-live="off"`; a separate polite status reports playback state.

### Workflow embed

The workflow is a separately compiled Archify HTML document embedded within a full-width bordered frame, (700px) high or (620px) at (48rem). Adjacent links open the interactive workflow and architecture directly. The parent forwards its current light/dark mode to the embedded document. The frame has a descriptive title, lazy loading and a visible outer focus boundary while its controls own keyboard focus. The embedded document owns its internal diagram styles; those are not landing-page tokens.

## Do's and Don'ts

### Do:

- **Do** preserve paired foreground and background roles in both modes.
- **Do** keep keyboard focus, readable command wrapping and reduced-motion behavior.
- **Do** use real commands and explicit availability labels.
- **Do** preserve official SVG geometry, colors and mode variants.

### Don't:

- **Don't** load external fonts or visual resources.
- **Don't** invent product output, adoption evidence or testimonials.
- **Don't** extend the copy button’s narrow key edge to cards or section containers.

Source scope: `site/index.html`, `site/styles.css`, `site/tokens.css`, `site/base.css`, `site/app.js` and `site/assets/brand/*.svg`; direction from `PRODUCT.md` and `surface-brief.md`. Read-only source verification; no matching indexed graph project was available. Second-pass computed roles and behavior were checked against `docs/landing/browser-checks.json`; capture provenance is `docs/landing/terminal-session.json`. Generated Archify documents are separate embedded components and were excluded from token extraction. Unused inherited theme tokens are intentionally omitted.

Replay advances only while visible, with no hover or keyboard focus inside. Temporary
reading pauses preserve the explicit play/pause choice. Reduced motion shows the final
merge state; the plain transcript supplies the complete excerpt history.
