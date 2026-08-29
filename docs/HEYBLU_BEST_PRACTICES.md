# HeyBLU — Best Practices (App + Web)

**Purpose:** Web/app implementation guide — where copy lives, tier gates, and page-type rules. Agents and humans read this before changing user-facing surfaces.

**Brand & messaging SSOT:** `docs/HEYBLU_BRAND_GUIDE.md` (tone, ICPs, headlines, campaigns). This file complements it; it does not replace it.

**Repos:**
- **iOS app:** `BLU/BLU2` — capabilities, gates, and in-app copy are canonical there.
- **Web:** this repo — must match the app paywall and tier gates exactly.

**When docs conflict:** Live app paywall + shipped tier gates > `HEYBLU_BRAND_GUIDE.md` > this file > deprecated `HEYBLU_PRODUCT_AND_MESSAGING_BRIEF.md` > `heyblu-hq/docs/archive/HeyBLU_App_Store_Launch_Plan_v*.md` (launch plans are strategy drafts, not product spec; moved to the `heyblu-hq` repo 2026-08-29 as historical — the launch they describe already happened).

---

## 0. Sports-tech category norm (read first)

HeyBLU sits next to **PitchLab**, **SwingVision**, **Pocket Radar**, and **GameChanger** streaming. Users in this category **already understand** that camera-based tools need a **stable mount** — tripod, fence clip, or stand. Those products lead with **what you get**, not lectures about hardware.

**User-facing copy must follow the same norm:**
- **Lead with outcomes** — not hardware lectures on every page.
- **Assume the user gets it.** Do not repeat tripod/setup warnings on pricing, terms, or every feature card. **Homepage hero:** one line with **iPhone** (+ tripod link) is fine—that is product truth, not fear-mongering.
- **Setup detail lives in one place:** `/field-guide`, in-app setup flow, and support troubleshooting — not sprinkled site-wide.

### Copy edits — do not “improve” working sentences

When trimming duplication, **delete** repeated warnings elsewhere; **do not rewrite** the hero or subhead into a longer AI sentence.

- **Subhead carries what H1 does not.** If H1 says umpire/calls, subhead adds **iPhone**, mount, zone/sport—not another list of the same benefits.
- **Never drop “iPhone.”** Product is iPhone-only.
- **No synonymous stacking** in one line (e.g. hear + audio, live + real-time, calls + umpire).
- **Short beats thorough.** If the old line was “pretty good,” leave it or shorten—never expand.
- **Minimal diff.** User asked to remove X on page Y → change page Y only unless they ask for a sweep.

**Internal context (for founders and support — NOT for marketing copy):**
- Failed setup drives bad reviews. Mitigate with **in-app calibration UX** and a **short App Store preview** that *shows* a working session (mount visible in the shot, no narration about tripods). That is ops, not copy to paste everywhere.

---

## 1. iOS app UX (baseball)

### The product moment
- Audible **ball/strike** on a taken pitch — requires **HeyBLU subscription** on the tracking phone (14-day trial available).
- **Never interrupt live tracking** with paywalls, surveys, or account prompts mid-pitch. Pro gate is before Track Pitches setup.

### Two-device workflows
- **Primary iPhone:** Umpire / tracking only (not iPad as tracker).
- **Second device:** Follow Game (watch only, free) or Command Center (Pro on primary).
- **Wi‑Fi troubleshooting:** Android hotspot or travel router; iPhone hotspot needs Airplane Mode + Wi‑Fi on Umpire phone. **Only in FAQ/support/field-guide** — never homepage hero or pricing.

### Command Center layout
- **Command tab:** intent grid + Live/pitcher header + View Report bar.
- **Gear / session controls:** Pause, End Session, brightness, zone size, Adjust BLU. No debug grids or duplicate Share/Download in production.

### Monetization
- **HeyBLU subscription** (14-day trial): live ball/strike calls, saved sessions, Command Center, unlimited pitchers, session reports, CSV.
- **Follow Game:** subscriber shares live feed; others use HeyBLU on their own iPhone—no subscription on that phone.
- **Marketing copy:** baseball people, not app enums (no “Track Pitches,” “Session History” on public pages unless quoting UI).
- **Paywall before Track Pitches** on primary phone — never mid-pitch.
- App Store listing = paywall = website `/pricing`. Homepage `#pricing` is a teaser + link only.

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
- **Pricing:** H1 = `Pricing`. One subscription card + included list. No FAQ block unless several non-duplicative questions. No Free vs Pro comparison table. No eyebrow kickers.
- **Audience pages:** one audience, benefits first; setup only if that page is explicitly about setup.
- **Don't tell users to market for you** in product docs.

### Live games (marketing copy)

**Primary positioning:** bullpens, practice, coaching, development.

**Never write** that HeyBLU is “not for live games,” “not for league ABS,” or “not a replacement for…” on pricing, homepage, or conversion pages. Users may use HeyBLU in scrimmages and games; we do not gate them with negative copy.

**When games or leagues are relevant** (FAQ, field-guide, support — not pricing cards):
- Encourage **practice first**, then games when setup is dialed in.
- Invite questions: **info@heyblu.ai** for leagues, tournaments, or game-day setup.
- OK: “Built to start in the bullpen” / “Most coaches validate in practice before game day.”
- Not OK: “Not for live games,” “Not league ABS,” “Do not use in games.”

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
- **Negative live-game framing** (“not for live games,” “not league ABS,” “don’t use in games”)

---

## 4. Agent rules

**Do not invent:** features, tier gates, or user homework (“post your heatmap…”).

**Do not warn-stack:** If your edit adds tripod, scan, ROI, hotspot, or “common mistakes” copy to homepage, pricing, terms, or coach pages — **stop**. Put it in field-guide or support only.

**Do not strip benefits** to make room for warnings. Features first; caveats only where the user asked for help.

**Before editing pricing or FAQ tiers:**
- Match paywall: Track Pitches Pro-only; Follow Game free; trial + launch prices in `pricing-config.js`.

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
