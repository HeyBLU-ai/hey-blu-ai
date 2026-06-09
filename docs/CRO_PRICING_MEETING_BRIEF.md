# HeyBLU — CRO / Pricing Meeting Brief
**Prepared for:** Pricing & offerings discussion  
**Context:** App Store launch in ~1–2 weeks; website at heyblu.ai is the primary pre- and post-launch marketing surface  
**Status on site:** `/pricing` live with TBD placeholders for three working tiers (deploy when ready)

---

## 1. Why this meeting matters now

Traffic will hit multiple pages — homepage, FAQ, Field Guide, Compare/SEO pages, and App Store — not a single funnel. Pricing decisions need to align with:

- What we **promise** on the website and App Store listing
- What **converts** coaches/parents at download vs. what drives **subscription** later
- What **leagues** expect when we talk ABS pilots (`info@heyblu.ai`)

The site is still in **beta positioning** (TestFlight form, “Join Beta” nav). That flips in `site-config.js` on launch day — pricing should be decided **before** that flip.

---

## 2. Working product tiers (website placeholders — all TBD)

These three options are now on **heyblu.ai/pricing**, homepage, and FAQ. **Nothing is priced; boundaries are not final.**

| Option | Working name | What it includes (marketing language) | Internal note |
|--------|----------------|--------------------------------------|---------------|
| **1** | **Live strike zone calls** | Real-time Ball/Strike audio + on-screen crossing dot; plate-anchored 3D tracking; on-device; outdoor daylight | **Under consideration as free/freemium entry — explicitly NOT decided** |
| **2** | **Pitch heatmaps & analysis** | Session heatmaps, pitch location history, pitch counts across sessions, session reports, exports | Likely paid; coach/parent development use case |
| **3** | **Command Training & zone tools** | Intent-vs-actual drills, Command Center remote, resizable strike zones, Calibrate + Adjust HeyBLU | Likely paid; “serious development” / instructor tier |

**Suggested phrasing for Option 3 (if we need a shorter label):**  
*“Command Training & zone tools”* — subtext: *Intent drills, Command Center, and calibration (Calibrate / Adjust HeyBLU).*

---

## 3. Decisions we need from this meeting

### A. Packaging & price

- [ ] **Option 1:** Free forever, freemium (e.g. N sessions/month), or bundled into a single subscription?
- [ ] **Options 2 + 3:** One subscription, two tiers, or à la carte?
- [ ] **Price points:** Household annual vs monthly? Team/coach license? League custom?
- [ ] **Comp anchor:** Ember ~$12.99/mo (analytics, no live B/S audio). PitchLab similar. HeyBLU’s live audio is differentiated — how do we price against “charting apps” vs “ABS narrative”?

### B. Who pays

- [ ] **Primary buyer:** Parent, head coach, private instructor, league admin?
- [ ] **Device model:** One iPhone mount per field — does subscription follow the **Apple ID** on the phone or a **team account**?
- [ ] **Command Center:** Second device (iPad/coach phone) — included in base or premium?

### C. Free tier strategy (Option 1)

- [ ] If live audio is free: what is the **upgrade trigger** (heatmaps after session? export? Command Training)?
- [ ] If live audio is paid: do we lose viral “coach tries it at bullpen” growth?
- [ ] **Umpire training angle:** Free audio for umps only? (Matches “umpire armor” positioning on `/compare/games-and-umpires`)

### D. League / B2B (parallel track)

- [ ] League pilots (`info@heyblu.ai`) — separate SKU or included in “team” tier?
- [ ] Multi-field tournaments — pricing per field vs per organization?

---

## 4. Website & go-to-market decisions (from site audit)

### Must align with pricing outcome

| Topic | Current state | Decision needed |
|-------|----------------|-----------------|
| **Launch CTA** | “Join Beta” / TestFlight form sitewide | Flip to “Download on App Store” via `site-config.js` — **when** and **remove or shrink** beta form? |
| **Pricing page** | TBD tiers live | Replace TBD with real prices + FAQ update same day as App Store |
| **App Store description** | Must match website tiers | No “free audio” claim unless decided |
| **FAQ** | Still beta-first; TestFlight install steps | Reorder for public users: Download → Field Guide → Quick Start |

### High priority (week of launch)

- **Analytics:** No tracking today — need App Store badge clicks by page (UTMs already wired in `site-download.js`)
- **Social sharing:** Homepage missing `og:image` / canonical — weak link previews when coaches share
- **Copy consistency:** Compare/FAQ now aligned; homepage still says “monocular depth” / premium analytics — OK but review after pricing is set

### Medium priority (weeks 2–4)

- Unified footer/nav (Field Guide + Pricing on every page — in progress)
- Social proof on homepage (testimonials, pilot leagues) — none today
- SEO compare pages — strong; optional competitor spokes later
- `robots.txt` disallow investor URLs (`/market`, pitchdecks) — optional

---

## 5. Product positioning constraints (don’t break in pricing copy)

These are **fixed** in current marketing — pricing pages should not contradict them:

1. **One iPhone + tripod** in **foul territory** (on-deck circle) — not behind the pitcher (PitchLab/Ember require in-play mount)
2. **Outdoor daylight** primary; indoor/night on roadmap
3. **Youth envelope:** within 20 ft of plate, sub-70 MPH most validated
4. **No AR/ARKit** in public copy — “real-time 3D ball tracking,” plate-anchored zone
5. **Human umpire owns the game** — HeyBLU is assist/training, not replacement (runners, balks, checked swings)
6. **Accuracy story:** ~1.5 in avg vs AccuracyCore ground truth (internal); MLB ABS stats on compare page for context only

---

## 6. Audience segments (who the site speaks to)

| Segment | Primary page | What they likely buy |
|---------|----------------|----------------------|
| **Coach / parent — bullpen** | Homepage Playbook, Field Guide | Option 2 (heatmaps) or bundle |
| **Private instructor** | Command Training playbook entries | Option 3 |
| **Teen/parent/volunteer ump** | `/compare/games-and-umpires` | Option 1 (if free → acquisition); earbuds “umpire armor” |
| **League admin** | Homepage league CTA, games page | Custom pilot — not self-serve App Store |
| **SEO researcher** | `/compare/*` | Download → discover tiers |

---

## 7. Competitive reference (for pricing conversation)

| Product | Price signal | Live B/S audio | Mount for live AB |
|---------|--------------|----------------|-----------------|
| **HeyBLU** | TBD | Yes (real time) | Foul territory — game-safe |
| **PitchLab / Ember** | ~$13/mo | No (charts/overlays) | Behind pitcher — in play |
| **MLB ABS** | League infrastructure | Yes | Stadium cameras |
| **Umpire clickers** | Free–$5 | N/A (human counts) | Pocket |

**Pricing wedge:** Only phone app with **live plate-anchored B/S audio** + **game-safe mount**. Analytics apps are cheaper but don’t call the zone in real time.

---

## 8. Recommended meeting agenda (60 min)

1. **Confirm three tiers** — keep, merge, or rename Option 3  
2. **Decide Option 1** — free vs paid (biggest GTM lever)  
3. **Set list prices** — household annual first; team/league later  
4. **Define paywall moments** in app (what’s locked at download vs day 7)  
5. **Assign owners** — App Store copy, website `/pricing`, in-app purchase SKUs  
6. **Launch checklist** — flip `APP_STORE_LIVE`, kill “Join Beta” primary CTA, analytics on  

---

## 9. Launch-day website checklist (after pricing is decided)

- [ ] Update `/pricing` with real prices and tier names  
- [ ] Update FAQ “How much does HeyBLU cost?”  
- [ ] Set `APP_STORE_LIVE: true` + real App Store URL in `site-config.js`  
- [ ] Nav: “Join Beta” → “Download” (home, about, support, terms, privacy)  
- [ ] Homepage: demote TestFlight form or replace with “Get started” + Field Guide  
- [ ] App Store Connect description matches three tiers  
- [ ] Submit updated sitemap to Google Search Console  

---

## 10. Open questions for CRO

1. Do we lead App Store with **“free live calls”** or **“pro analytics”** if we can’t say both are free?  
2. Annual-only vs monthly — what reduces churn for seasonal baseball?  
3. Should **Command Training** be the premium hero (coaches pay) vs **heatmaps** (parents pay)?  
4. Trial length for paid tiers?  
5. Refund policy alignment with Apple subscriptions — stated on `/terms`?  

---

*Website changes in repo: `/pricing` page, homepage pricing section, FAQ pricing accordion, phrasing sync across compare pages. Not yet committed — deploy after review.*
