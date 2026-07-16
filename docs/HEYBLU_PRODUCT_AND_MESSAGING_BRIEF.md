# HeyBLU — Product & Messaging Brief (for external LLMs)

> **DEPRECATED — do not use for new work.**  
> Brand and marketing SSOT is now **`docs/HEYBLU_BRAND_GUIDE.md`**.  
> Web/app implementation rules remain in **`docs/HEYBLU_BEST_PRACTICES.md`**.  
> This file is kept only for historical context.

**Codebase truth:** For repo-grounded app capabilities, limits, modes, and external-LLM positioning, use the sibling **BLU-App** repository: `docs/EXTERNAL_LLM_MESSAGING_AND_POSITIONING.md` (this file is a web/marketing companion, not the canonical app brief).

**Purpose:** Give any language model instant, accurate context for pitch decks, ads, email/DM campaigns, web copy, and coach-facing outreach—without access to this repo.  
**Last aligned to repo:** Field guide, marketing homepage (`index.html`), FAQ (`/faq` → `betablu/index.html`).  
**Brand:** **HeyBLU** (render as Hey**BLU** in stylized copy if needed).

**Official site:** https://heyblu.ai  
**FAQ / beta quick start:** https://heyblu.ai/faq (same content as `/betablu`)  
**Printable field setup:** https://heyblu.ai/field-guide  
**Founder writing (economy, product, zone philosophy):** https://heyblu.substack.com  

---

## 1. What HeyBLU is (one sentence)

HeyBLU is an **iPhone-only** app that uses the phone’s **camera + AR (ARKit)** and on-device computer vision to **track baseball pitches in 3D**, map where the ball crosses the **front edge of the plate** relative to a **virtual strike zone**, and deliver **ball/strike calls** (audible and on-screen) for pitches **not swung at**—with **session analytics**, **heatmaps**, and a **Command Center** on a second device for coaches/operators.

It is positioned as **assistive** (training, bullpens, scrimmages, leagues that want objective zone feedback)—not a wholesale replacement for human judgment on every play.

---

## 2. What the app can do (capabilities)

- **Ball/strike on taken pitches:** Measures crossing vs. zone; gives call when confident; stays **silent** rather than guessing when tracking is poor.
- **3D strike zone on real plate:** User places virtual zone; **locks** to physical plate; supports **age group** and **mound distance** settings (e.g. Pro, 14U, 12U, 10U; 45 ft vs 60.5 ft, etc.) so zone dimensions match the situation.
- **Resizable / tunable zone:** Coaches can **resize the zone** for development or mismatch vs. human zone (product narrative: development and “train to the zone you care about”).
- **Intent + logging (Command Center):** A **secondary iPhone or iPad** opens **Command Center** to **track intent**, **resize the zone for different batters**, and **log pitch locations**. Primary **tracking session runs on one iPhone**.
- **Audio calls:** Marketing and FAQ reference **Bluetooth** for delivering calls to the field (e.g. speaker/earpiece—FAQ stresses **loud enough for the mound**).
- **Offset camera / “Adjust HeyBLU”:** Phone is often **not** perfectly behind the plate; app has **inside/outside adjustment** (“Adjust HeyBLU” / plate adjust / nudge) to correct bias from camera angle.
- **Session wrap-up:** After **End Session**, **Summary** supports **share** (e.g. image + **CSV** mentioned in FAQ).
- **No video storage of kids:** FAQ states **video is not recorded or stored** for training the product narrative; **session/call/pitch data** is used to improve the app.
- **Beta distribution:** **TestFlight** on **iOS**; applicants acknowledge **iPhone-only**, **tripod**, **outdoor** use on the homepage form.

---

## 2A. Pricing (launch — sync with `/pricing` and `pricing-config.js`)

| | |
|--|--|
| **HeyBLU subscription** | **14-day free trial**, then **$4.99/mo** or **$49.99/yr** (launch / introductory rate) |
| **Includes** | Live ball/strike calls, saved sessions, Command Center, unlimited pitchers, session reports, CSV |
| **Follow Game** | If a subscriber shares their live pitch location feed, non-subscribers with the same HeyBLU app can “Follow Game” with their own iPhones |

- **Track Pitches requires an active subscription** on the primary phone — paywall before setup (not mid-pitch).
- **Marketing copy:** baseball language, not app enums (say “live ball/strike calls,” not “Track Pitches”; say “saved sessions,” not “Session History” on public pages unless the UI label is essential).
- App paywall shows **live App Store prices** via RevenueCat; website uses `pricing-config.js` — update both when App Store Connect changes.
- **Do not** use "HeyBLU Pro" or a separate "Free tier" on marketing pages. The product is **HeyBLU**; Follow Game is the only no-subscription mode.
- **Do not** publish planned post-launch price increases or subscriber caps on marketing pages.

---

## 3. What the app does not do (hard limits & beta honesty)

| Topic | Fact |
|--------|------|
| **Swings** | Does **not** call swings, check swings, or contact. Human umpire/coach owns that. |
| **Android** | **Not supported** (current product). |
| **iPad as primary tracker** | **No.** iPad is for **Command Center** (second screen), not the main AR tracking phone. |
| **Softball** | **Regulation baseballs** for now; **softballs planned** (per FAQ). Wiffle/non-regulation may not track. |
| **Indoor / cage** | **Poor results** called out explicitly in FAQ. |
| **Dusk / low light** | **Does not work well yet** (FAQ). |
| **Hand-held phone** | **Not supported** for tracking—**tripod or fence mount** required. |
| **Pitch speed (MPH)** | **Directional indicator, not a calibrated measurement.** The app outputs `release_speed_mph` (drag-corrected from RANSAC Z-velocity) when the trajectory fit is strong. Live field validation (Gate 2) was inconclusive at **±5 mph vs. physical radar** — this is a physics ceiling of monocular vision, not a software/beta issue. **Do not** use "within 1–2 mph of Stalker / Pocket Radar" in any channel — that claim is not field-validated. **App Store / press copy:** _"Estimated pitch speed is included in session reports when the trajectory fit is strong enough to trust it. Speed is a useful directional indicator, not a calibrated measurement."_ Drop speed as independent investor proof; the ball/strike accuracy table stands on its own. |
| **Overall accuracy** | FAQ invites users to judge and report; product is **iterating**—avoid “MLB Hawk-Eye certified” style claims unless you have a dated, sourced stat sheet. |
| **Guaranteed call every pitch** | App may **stay silent** if confidence/visibility is low (design choice vs. hallucinating a call). |

---

## 4. Hardware & environment (facts for copywriters)

**Must-have**

- **iPhone 11 or later** minimum (60 fps ARKit + CV); **iPhone 12+ strongly recommended** for performance (FAQ).
- **Outdoor field, daylight** is the stated “works best” environment.
- **Stable mount:** tripod **or** fence mount (no hand-holding).

**Distance / angle (use consistent numbers in new copy)**

- **FAQ, field guide, homepage “How it works”:** outdoor **bullpen/practice**, tripod **10–15 ft inside the fence**, thick **red ROI lines** (pitch path between them—zone on one line, mound on the other), post-mount **Calibrate**, Pro iPhone needs **distance + lens height**. Tested ≤**60 MPH**; do not market 65–70+ or indoor yet.

**Glare / sun**

- Avoid pointing the camera into the **setting sun** or **bright white sponsor signs** in the pitch path; **move tripod to the other side of the plate** if needed (FAQ).

**Scan / calibration**

- **Environmental scan** around home plate builds a **3D map**; **rushed scan** is called out as the **#1 cause** of drifting zone / bad calls even in good light.
- **Plate + mound** should both be in frame along the pitch path (whole path matters, not plate-only).

**Ops hygiene (FAQ)**

- **iPhone prep:** Clean lens, volume/Bluetooth audio, **Local Network** on for HeyBLU when using a second device; charge before you go. App keeps screen awake while open (no Auto-Lock change required). Low Power Mode and Do Not Disturb optional. **Single phone:** tracking works offline—airplane mode optional. **Two devices:** use Android hotspot or travel router (recommended); iPhone hotspot requires Airplane Mode + Wi‑Fi on Umpire phone first. Umpire phone cannot host its own hotspot. Calls/alerts can interrupt audio, not tracking.

---

## 5. User journey (short—deck or onboarding slides)

1. Install via **TestFlight** (invite email).  
2. **Scan** the area around plate (slow, deliberate).  
3. **Place / lock** virtual strike zone on real plate.  
4. **Mount** iPhone on tripod/fence; **frame** plate + mound; optional **Adjust Plate** if misaligned.  
5. **Play Ball**—app listens; calls when it detects a pitch and doesn’t see a swing.  
6. **Command Center** on second **iPhone/iPad** for intent, zone per batter, logging.  
7. **End Session** → **Summary**, share/export as documented.

---

## 6. Positioning vs. radar / lab systems (TrackMan, Rapsodo, etc.)

Use **honest contrast**, not trash talk.

| Dimension | Typical radar / multi-cam stack (e.g. TrackMan, Rapsodo class) | HeyBLU |
|-----------|------------------------------------------------------------------|--------|
| **Hardware** | Dedicated sensors / multiple cameras / permanent or semi-permanent installs; often **five-figure+** and infrastructure. | **One iPhone** + **tripod or fence mount**. |
| **Venue** | Built for **stadium / facility / cage** workflows and controlled geometry. | Built for **local fields**: chainlink, offset angles, sun, **no IT crew**. |
| **Velocity precision** | Radar-class velo is a core strength of those products. | **MPH is not reliable in beta**; emphasize **zone + calls + session flow**, not gun readings. |
| **Use case** | Pro/college development, showcases, facilities. | **Bullpens, practice mounds, rec/tournament fields**, coach development, **rapid ABS-style zone** where **$50k arrays** are impossible. |

**Elevator line (safe):** *“Same job to be done as the big stacks—where did this pitch cross the zone?—on the hardware you already carry, for the fields those tools ignore.”*

---

## 7. pitchlab.app (and similar phone competitors)

Do **not** invent feature parity. In general:

- HeyBLU’s story is **iPhone + AR + on-device CV**, **outdoor-first**, **tripod-gated**, **Command Center** second screen, **no stored video of kids**, **beta/TestFlight** distribution.
- Any competitor comparison should be **high-level** unless you have a current competitive matrix from the founder.

---

## 8. Separate product on the same domain (do not conflate)

**https://heyblu.ai/rulebook** — **AI rulebook assistant** (league rules, Q&A). It is **not** the pitch-tracking app. Do not describe rulebook answers as coming from the same “camera session” as HeyBLU on the field.

---

## 9. Audience-specific hooks (DMs / email / ads)

**Pitching coaches & facilities**

- Most pitches happen **outside games**; Tuesday bullpen → Saturday execution.  
- **Intent**, **heatmaps**, **zone resize** for development—not just a novelty strike string.

**Head coaches / program directors**

- One **objective zone** narrative for practice consistency; **CSV/summary** for post-session review (verify exact export claims against latest app release if copy is legal-sensitive).

**Travel / tournament / league operators**

- **Deploy in ~minutes**: hand an iPhone to an operator behind the backstop; **resizable zone**; reduce **subjective zone arguments** (word carefully: “reduce tension” vs. “eliminate all disputes”).

**Dad / parent helping son practice**

- **Outdoor + tripod** expectations up front avoids bad reviews.  
- **No video of your kid stored** (per FAQ) is a strong trust line.

**Umpire-adjacent (careful)**

- Marketing can mention **confidence** and **training**; FAQ still positions **human** for swings. Avoid “replace the ump” unless legal/comms explicitly approves.

---

## 10. Messaging guardrails (checklist for any LLM)

**Do say**

- iPhone (iOS) + TestFlight beta reality.  
- Outdoor, daylight, tripod/fence mount.  
- Ball/strike on **taken** pitches; **silent** when unsure.  
- Command Center on **second** iPhone/iPad.  
- Zone by **age + distance**; adjustable / resizable for development.  
- **Purpose-built for messy local fields** (offset angles, no wiring, no permanent install).  
- **ABS / objective zone** narrative at **youth/amateur** level vs. **MLB stadium economics** (marketing homepage themes).

**Do not say (without proof)**

- Android support.  
- Reliable MPH vs. radar guns.  
- Great indoor/dusk performance “today.”  
- Automatic swing or check-swing calls.  
- That every pitch always gets a call.  
- That video of players is saved for replay (contradicts FAQ).

**Web page copy — do not repeat positioning on every page**

- **Homepage / compare / coaches / smart-field:** OK to explain what HeyBLU is and who it is for.
- **Transactional pages (`/pricing`, `/terms`, `/privacy`, `/support`):** Title matches the page (`Pricing`, `Terms`, etc.). No eyebrow labels (“Bullpen & practice”, “For coaches…”) above the H1. The visitor already knows the product; these pages answer one question only (how much, legal, help).
- **Do not** prepend category tags or use-case reminders on pricing. The plan cards carry the detail.
- Audience eyebrows belong only on **dedicated audience landings** (`/coaches`, `/smart-field`), not on pricing, FAQ, or field guide.

---

## 11. Beta & community (for “join us” CTAs)

- **Homepage:** “Apply for Beta / Request TestFlight” form (Formspree-backed in repo).  
- **FAQ page:** **Slack** community for beta testers (invite link lives on `/faq` in production HTML—refresh from live page if the link rotates).  
- Tone: **early beta**, feedback welcomed, **scan quality** and **mount stability** are repeated themes.

---

## 12. One-paragraph “paste into any LLM system prompt”

```
You are helping with marketing for HeyBLU (heyblu.ai): an iPhone-only, outdoor-first baseball app in TestFlight beta. It uses the phone camera + ARKit to build a 3D map of the field, lock a virtual strike zone to home plate, and call balls/strikes on pitches that are NOT swung at, with audio and on-screen feedback. It does not call swings. Android is not supported. A tripod or fence mount is required; hand-held use is not. Best results: outdoor daylight bullpen, tripod 10–15 ft inside fence, red-line pitch-path framing, post-mount Calibrate, ≤60 MPH tested; field guide at heyblu.ai/field-guide. Secondary iPhone/iPad runs “Command Center” for intent, per-batter zone resize, and pitch logging. MPH is unreliable in beta. No video of kids is stored per FAQ. Position against TrackMan/Rapsodo as pocket-sized, no-infrastructure zone tracking for local fields and bullpens—not as a radar replacement. heyblu.ai/faq is the canonical FAQ; heyblu.ai/field-guide is the printable setup guide.
```

---

## 13. Changelog note for humans maintaining this file

When product facts change (distance bands, Android, MPH, Command Center features), update **this doc** and the **live FAQ / field guide / homepage** together so external LLMs stay aligned.

---

*This document is derived from the HeyBLU web repo (marketing page, FAQ, field guide). It is not a legal warranty or pricing sheet.*
