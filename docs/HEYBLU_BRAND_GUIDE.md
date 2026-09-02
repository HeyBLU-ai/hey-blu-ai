# HeyBLU — Brand Alignment & Single Source of Truth (SSOT)

> **Internal Marketing Team & AI Agent Directive**  
> This document is the authority for HeyBLU brand, messaging, and public marketing copy. All copy, creative assets, social campaigns, web marketing pages, and AI agent instructions must align with this guide.  
> **Legal / App Store listing / live iOS paywall gates override this file when they conflict.**

**Replaces:** `docs/HEYBLU_PRODUCT_AND_MESSAGING_BRIEF.md` (deprecated — do not use for new work).  
**Complements:** `docs/HEYBLU_BEST_PRACTICES.md` (web/app implementation: where setup copy lives, tier gates, page-type rules).

---

## 1. Brand Origin & Identity

Our name is born directly from the diamond. Because amateur players and coaches rarely know an umpire's actual name, they call out *"Blue"* to get attention, say hello, or ask a question. We took that universal baseball and softball behavior and modernized it into **HeyBLU**—where **BLU** stands for **Big League Umpire**.

### Corporate vs. public brand

| Use | Name |
| --- | --- |
| Corporate / legal | Big League Ballpark Inc. (internal/legal only) |
| Primary brand mark | **HeyBLU** |

- Never spell it **"Hey Blue"** in public-facing marketing.
- Never **"HeyBLU Pro"** on marketing pages — the product is simply **HeyBLU**.
- **Core positioning:** An outcome-oriented **"source of truth"** that builds confidence in the bullpen, on the field, and at home. Externally, always pair "source of truth" with assistive framing—**umpire aide** or **objective feedback**—especially for leagues, so we do not imply official league ABS certification.

---

## 2. Copywriting & Headline Hierarchy

### Headline hierarchy

| Role | Line |
| --- | --- |
| **Primary brand line** (H1 / homepage hero) | *Every bullpen deserves a Big League Umpire.* |
| **Campaign lead / punchline** (H2 / subheads / ad hooks) | *Stop guessing. Start seeing every pitch.* |
| **Core story message** | *Every pitch tells a story.* |

Ads and landing pages must not fight the live homepage: brand line leads; campaign punchline supports.

### Call-to-action (CTA) policy

- **Story / engagement CTAs:** *Track your next bullpen* or *Own the Zone*. Do **not** use generic story copy like *Track your pitches* or *Download our app*.
- **Conversion / App Store CTAs:** The official Apple App Store badge and *Download on the App Store* are **allowed and required** on conversion paths (site header/footer, download blocks, direct-to-install ads). The App Store badge must remain **unaltered**.

---

## 3. Visual Identity Foundations

*(Fill hex/fonts when design system is locked; until then treat site Tailwind usage as the working reference.)*

- **Brand name capitalization:** **HeyBLU** (“Hey” + uppercase “BLU”).
- **Working web colors (current site):**
  - Action blue: Tailwind `blue-600` ≈ `#2563EB`
  - Dark surfaces: Tailwind `slate-950` ≈ `#020617`
  - Body text: near `#111827` / gray-900
- **App Store badge:** Follow Apple Marketing Guidelines — unaltered artwork, proper clear space, one badge per layout.
- **Typography (web today):** Inter for marketing pages until a dedicated brand typeface is specified.

---

## 4. Voice, Tone & Grammar Rules

1. **Diamond language** — bullpen, the zone, command, the bucket, innings, at-bats.
2. **No app-speak enums** on public marketing — not “Track Pitches,” “Session History,” or “low-latency pitch tracking.” Prefer: *See where the ball crossed.*
3. **No synonymous stacking** — not “live, real-time” or “instant immediate.” Pick one word.
4. **Short beats thorough** — a 10-second strike-call visual beats a paragraph on computer vision.
5. **Never drop “iPhone”** when describing the product — iPhone-only.

---

## 5. Ideal Customer Profiles (ICPs)

Messaging spans **baseball and fast-pitch softball** youth. Keep copy inclusive of both.

### 1. Travel parents (“Diamond Dads” & moms)

- **Internal shorthand:** “Diamond Dads” is OK internally.
- **Public copy:** *travel parents*, *parents*, or *softball/baseball parents* — never exclude moms/families.
- **Pain:** Heavy spend on travel, gear, and lessons without objective proof of improvement.
- **Message:** Stop guessing on the bucket. Get clean, shareable post-session summaries of your kid’s bullpens.

### 2. Coaches & trainers

- **Pain:** Need proof of who is putting in the work and who has the command to start.
- **Message:** Establish command. Use the second-device **Command Center** for live calls, location, and **estimated MPH**. Use heatmaps and summaries to analyze and share progress.

### 3. Players

- **Motivation:** Earn innings; prove they belong on the hill.
- **Message:** Prove your command, level up your practice, and own the zone. Market the feel of owning the zone and light Command Training — do **not** oversell full-scale gamified product mechanics.

---

## 6. Product Truths (Guardrails to Protect Reviews)

- **iPhone / iOS only.**
- **Outdoor daylight first.** Dusk can work occasionally; do **not** market for indoor cages or poorly lit night games. Do not invent a hard “8:00 AM–8:00 PM” clock rule — say outdoor daylight.
- **Estimated MPH** — never radar-gun equivalent.
- **Follow Game** is live second-device viewing when a subscriber shares — **not** a second subscription.
- **Practice / scrimmage first** for game-day framing (warmups, practices, informal scrimmages). Do **not** imply set-and-forget ABS for competitive league games. Never lead with “not for live games” on conversion pages — see `HEYBLU_BEST_PRACTICES.md` § Live games.
- **Setup belongs in Help / Field Guide.** Ads sell the outcome. Camera-to-plate ~10–15 ft, mound side/angle, and zone placement stay in documentation.
- **UI naming:** Instruct users to press **Play Ball** to start logging. Never call it the “Start” button in marketing or tutorials.

---

## 7. Content Pillars & Campaign Framework

| Pillar | Concept | Execution |
| --- | --- | --- |
| **1. Own the Zone** | Age-specific meaning of owning the zone | Different bars for 8U vs 15U; command over raw velo |
| **2. Bullpen Friday** | Pre-weekend activity challenge | “25-pitch challenge” as **community/social only** — not an in-app mode |
| **3. Game Day Saturday** | Warmups / bullpen prep context | “Who is pitching today?” Feeling → knowing |
| **4. Sunday Recap** | Travel-parent Sunday traffic | Real session stories: parent photos + HeyBLU heatmaps |
| **5. Coach’s Corner** | Credibility / teaching | Partner coaches with mechanics tips |

---

## 8. Marketing Channels & Stack Honesty

| Channel | Tool | Status |
| --- | --- | --- |
| Paid/organic social | Meta Business Suite (Reels/Stories first) | Live |
| Creative | Canva, CapCut | Live |
| In-app analytics | PostHog | Live |
| Subscriptions | RevenueCat + Apple | Live |
| Install attribution | App Store Connect campaign links | Live |
| Website traffic | Vercel Web Analytics (+ custom events in `site-analytics.js`) | Live |
| Google Ads conversion tag | `google-ads-tag.js`, account 534-835-4776 (`AW-18414770701`) — `/` and `/home2` only | Live |
| Inbound UTM/click-ID capture | `utm-capture.js` → PostHog super properties (last-touch, 30-day window) | Live |
| Website analytics (planned) | Google Analytics (GA4 property) | Planned — not yet on site. Distinct from the Google Ads conversion tag above, which is live. |
| Email / lead capture (planned) | Brevo | Planned |

---

## 9. File Relationships

| File | Role |
| --- | --- |
| **`docs/HEYBLU_BRAND_GUIDE.md`** (this file) | Brand, messaging, ICPs, campaigns, public copy SSOT |
| **`docs/HEYBLU_BEST_PRACTICES.md`** | Web/app implementation: page types, setup placement, tier gates |
| **`docs/HEYBLU_PRODUCT_AND_MESSAGING_BRIEF.md`** | **Deprecated** — archived for history; do not use for new work |

When docs conflict: **live App Store paywall + shipped app gates** > this brand guide > `HEYBLU_BEST_PRACTICES.md` > deprecated briefs / launch plans.

---

*Last updated: July 2026.*
