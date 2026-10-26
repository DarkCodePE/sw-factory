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
    fontSize: "clamp(3.25rem, 5.6vw, 5rem)"
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
    fontSize: "1rem"
    lineHeight: 1.55
  label:
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "0.875rem"
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

**The Functional Accent Rule.** Use teal to identify action, focus or a meaningful relationship.

### Neutral

Cool paper surfaces have a restrained green cast and become graphite in dark mode. Ink carries headings and commands; secondary ink carries explanations, labels and availability. Fine rules separate sections; stronger control edges define interactive boundaries. Error color is reserved for copy failure feedback.

The frontmatter records light and dark counterparts explicitly. Runtime properties in `site/tokens.css` switch these roles together. The system preference applies until an explicit mode is saved under `fab-theme`.

## Typography

**Display and Body Font:** the local system sans stack in the frontmatter.
**Command Font:** the local UI monospace stack in the frontmatter.

Display is compact, bold and tightly tracked. Section headings use the headline role; feature and plan headings use title. Body paragraphs use a comfortable line height and generally cap at (65ch). Lead text is fluid (`clamp(1.125rem, 0.35vw + 1rem, 1.375rem)`) with a line height of (1.45). Navigation, availability and captions use the label role. Numbered capability markers use tabular numerals.

At widths up to (48rem), display changes to `clamp(3.25rem, 11vw, 4.5rem)`. The installer script stays at (1rem) to accommodate its longer command.

**The Local Type Rule.** Use installed system fonts; load no external font resources.

## Layout

The page container caps at (1440px) with side gutters of (64px), falling to (24px) at (60rem) and (16px) at (40rem). Shared column gaps are (32px), falling to (16px) at (40rem).

The hero pairs copy and installer in two columns, with a (64px) gap and a (400px) minimum content height. Below (48rem) it becomes a single column. Local detail, model and plan sections also stack at that threshold. Capability cards run three columns, two at (64rem), then one at (48rem). The workflow changes from horizontal to vertical at (64rem).

The local section uses (64px) vertical padding. Other section padding uses (120px) and (144px), reducing through the (60rem) and (40rem) breakpoints. Controls and navigation links retain a minimum hit height of (48px). Long commands wrap within their available width.

## Elevation & Depth

Tonal alternation and one-pixel rules provide depth. Cards and sections are flat. The copy button alone uses a (3px) deep-teal key edge as an intentional Hallmark Cobalt control exception requested in the hero review. This narrow tactile affordance does not establish a shadow scale for cards or sections.

## Shapes

Cards and the installer tab group have gently rounded corners using the card radius. Individual controls and workflow nodes use the smaller control radius. Borders are thin and structural; the site does not use floating pill navigation.

## Components

### Brand identity

Header and footer use the supplied light and dark SVG wordmarks unchanged, at a rendered width of (126px) with intrinsic aspect ratio. The light variant has dark lettering; the dark variant has white lettering. CSS selects the appropriate variant for the explicit or system mode. Home links supply the accessible name; the paired images have empty alt text. The favicon is a local supplied SVG. Preserve the official paths, proportions and colors.

### Buttons

Primary copy buttons use official teal with the dark brand foreground, a minimum width of (132px), and semibold text. Quiet theme controls use paper with an ink label and a visible control edge. Quiet hover shifts to the second surface; primary hover lifts by (1px), and pressing either shifts down by (1px). Disabled controls use reduced opacity and dashed borders; busy copying changes the cursor. Focus uses a (2px) accent outline offset by (4px).

### Installation selector and command

Two real installation methods are tabs, with a neutral selected surface and stronger border. Selection controls one panel and supports arrow, Home and End keys. Commands are selectable monospace text; copy success and failure use a polite live region. Without JavaScript, both commands and their method labels remain readable.

### Navigation

Header and footer navigation use text links with generous hit height. Header hover underlines in the accent. On small screens header links form their own row; footer links wrap. The theme control names the mode it will activate.

### Cards and ruled containers

Capability cards use one-pixel borders, the card radius and large internal spacing. Number, heading, availability and description form a consistent hierarchy. Plans use a ruled top edge rather than elevated pricing cards.

### Workflow

The diagram uses neutral outlined nodes, ink labels and mode-appropriate teal connectors. Desktop and mobile variants expose accessible titles and descriptions. It depicts the real validation-before-merge sequence.

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

Source scope: `site/index.html`, `site/styles.css`, `site/tokens.css`, `site/base.css`, `site/app.js` and `site/assets/brand/*.svg`; direction from `PRODUCT.md` and `surface-brief.md`. Read-only source verification; no matching indexed graph project was available. Unused inherited theme tokens are intentionally omitted.
