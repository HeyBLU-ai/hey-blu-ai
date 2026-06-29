# HeyBLU — Best Practices (App + Web)

**Purpose:** Single authority for product, UX, and copy decisions. Agents and humans read this before changing user-facing surfaces.

**Repos:**
- **iOS app:** `BLU/BLU2` — capabilities, gates, and in-app copy are canonical there.
- **Web:** this repo — must match the app paywall and tier gates exactly.

**When docs conflict:** Live app paywall + shipped tier gates > this file > `HEYBLU_PRODUCT_AND_MESSAGING_BRIEF.md` > `HeyBLU_App_Store_Launch_Plan_v*.md` (launch plans are strategy drafts, not product spec).

---

## 0. Sports-tech category norm (read first)

HeyBLU sits next to **PitchLab**, **SwingVision**, **Pocket Radar**, and **GameChanger** streaming. Users in this category **already understand** that camera-based tools need a **stable mount** — tripod, fence clip, or stand. Those products lead with **what you get**, not lectures about hardware.

**User-facing copy must follow the same norm:**
- **Lead with outcomes:** ball/strike calls, pitch location, heatmaps, Command Center, session reports, speed readout.
- **Assume the user gets it.** One casual mention of mount/tripod on discovery pages is enough (e.g. in a “How it works” step). Do not repeat it on pricing, terms, FAQ pricing sections, or hero subheads.
- **Setup detail lives in one place:** `/field-guide`, in-app setup flow, and support troubleshooting — not sprinkled across the site.

**Internal context (for founders and support — NOT for marketing copy):**
- Failed setup drives bad reviews. Mitigate with **in-app calibration UX** and a **short App Store preview** that *shows* a working session (mount visible in the shot, no narration about tripods). That is ops, not copy to paste everywhere.

---

## 1. iOS app UX (baseball)

### The product moment
- Audible **ball/strike** on a taken pitch + dot on the zone. Free tier must deliver this.
- **Never interrupt live tracking** with paywalls, surveys, or account prompts.

### Two-device workflows
- **Primary iPhone:** Umpire / tracking only (not iPad as tracker).
- **Second device:** Follow Game (watch only, free) or Command Center (Pro on primary).
- **Wi‑Fi troubleshooting:** Android hotspot or travel router; iPhone hotspot needs Airplane Mode + Wi‑Fi on Umpire phone. **Only in FAQ/support/field-guide** — never homepage hero or pricing.

### Command Center layout
- **Command tab:** intent grid + Live/pitcher header + View Report bar.
- **Gear / session controls:** Pause, End Session, brightness, zone size, Adjust BLU. No debug grids or duplicate Share/Download in production.

### Monetization
- **Free:** live B/S calls, pitch speed (directional), on-screen location, shareable session heatmap, one pitcher, Follow Game.
- **Pro:** Session History, Command Center, unlimited pitchers, Every Pitch PDF, Command Report, CSV.
- **Paywall after value** — post-session or feature tap, never mid-pitch.
- App Store listing = paywall = website `/pricing`.

### Trust (youth baseball)
- No stored video of kids unless true in code.
- Speed is directional, not radar-grade — state once where speed is discussed, not on every page.

---

## 2. App Store & discovery copy

### Preview video
- ~20–30s: working session — pitch, **hear Strike**, dot on zone. Mount can appear naturally in frame; **no setup lecture**.

### What to lead with (every discovery surface)
- Calls, location, heatmap, Command Center, reports — **features and benefits**.
- Category peers do not open with warnings; neither does HeyBLU.

### What NOT to lead with
- Tripod mandates, ROI red lines, scan duration, hotspot workarounds, “#1 cause of bad calls” — those belong in **field-guide / support**, not pricing, homepage hero, or plan cards.

### Page-type discipline
- **Pricing:** H1 = `Pricing`. Plans + matrix + FAQ. No eyebrow kickers. No setup essays.
- **Audience pages:** one audience, benefits first; setup only if that page is explicitly about setup.
- **Don't tell users to market for you** in product docs.

---

## 3. Web page types

| Page type | Lead with | Setup / warnings |
|-----------|-----------|------------------|
| Homepage | Promise + benefits | One line in “How it works” max |
| `/pricing` | Plans + gates | None |
| `/coaches`, `/smart-field` | Job-to-be-done for that user | Minimal |
| `/field-guide`, `/support` | Steps / fixes | Full detail OK here |
| `/faq` | Answer the question | Only when question is setup |

**Banned patterns:**
- Eyebrow kickers above H1 on transactional pages (“Bullpen & practice”, “For coaches…”)
- Re-explaining mount/tripod on every page edit
- Warning blocks on pricing or plan comparison
- “Forever” in pricing unless legal approved

---

## 4. Agent rules

**Do not invent:** features, tier gates, or user homework (“post your heatmap…”).

**Do not warn-stack:** If your edit adds tripod, scan, ROI, hotspot, or “common mistakes” copy to homepage, pricing, terms, or coach pages — **stop**. Put it in field-guide or support only.

**Do not strip benefits** to make room for warnings. Features first; caveats only where the user asked for help.

**Before editing pricing or FAQ tiers:**
- Match paywall: heatmap share free; PDF/CSV/Command Report/History/Command Center Pro.

---

## 5. Pre-ship checklist (app)

- [ ] Paywall strings match `/pricing`
- [ ] Command tab: Live + pitcher + View Report without gear
- [ ] Preview video shows product working (not a setup tutorial)

## 6. Pre-ship checklist (web)

- [ ] `/pricing` is plans only — no setup warnings, no eyebrow kickers
- [ ] Tier gates match app
- [ ] Setup depth concentrated in `/field-guide` + support, not duplicated site-wide

---

*Last updated: June 2026.*
