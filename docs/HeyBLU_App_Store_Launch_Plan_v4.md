# HeyBLU — App Store Launch Plan v4
_Date: May 26, 2026_
_Prepared for: HeyBLU Team_
_Purpose: Comprehensive launch strategy, tailored to current beta realities and physics limits_
_Supersedes: v3 (May 26, 2026). When this plan conflicts with v3, v4 wins._

---

## Executive Summary

**Do not launch quietly.** The data is clear: high awareness, low conversion. You have a product that makes people's jaws drop when they see it, but that same "wow" effect requires seeing it. The correct strategy is a focused pre-launch priming campaign targeting a single defined ICP, followed by a coordinated public launch designed to generate organic press coverage, App Store editorial consideration, and a wave of 5-star reviews from people who set up successfully.

The biggest risk is not obscurity. It is launching before users understand the operating envelope, letting low-ratings reviews accumulate in the first 72 hours, and having no monetization rails in place when the attention spike arrives.

The plan is organized into four phases: **Stabilize → Prime → Launch → Sustain**.

---

## 🚨 Top Priorities: Do These First 🚨
_These are the highest-leverage actions before anything else moves forward._

1. **The 30-Second App Store Preview Video (Mandatory Blocker):** Nothing else in this plan matters as much as this video existing. A montage of: mount the phone on fence (5s) → quick scan and place blue zone on plate (5s) → zone shifts, slide it back (5s) → three live pitches called with dots appearing in zone (10s) → session summary (5s). On-screen text only. No narration needed. This video IS the product pitch.

2. **The 90-Second Setup Walkthrough Video:** Nobody has documented all the required setup steps — outdoor, tripod, scan, zone shift, ROI framing — in a single short video. This must be created and linked in the App Store description, the FAQ, and every outreach message. The zone shift explanation alone will prevent dozens of 1-star reviews.

3. **The ROI Framing Rule (Confirm Direction Before Publishing — See Note Below):** The position of the plate within the detection window is the single most common reason pitches do not get called. Your App Store description, onboarding copy, and the 90-second setup video must communicate the correct framing rule clearly. See Part 2, Decision 3 for the rule — and the critical note on direction verification.

4. **Email the 35 TestFlight Downloaders:** Send a personal email (not automated) to all 35 TestFlight downloaders. Subject: _"Quick favor before we go to the App Store — 20 minutes?"_ Ask for a video call. You need one live observation of someone setting up the app from scratch. Even two of these calls will surface the top three support issues before they become 1-star reviews.

---

## Part 1 — Diagnostic: Why 125 Invites Yielded 2 Active Users

1. **The visual hook was missing.** "An iPhone app that calls balls and strikes" does not convey the magic. People say "cool" and bookmark it for later. Later never comes. Fix: video-first outreach.
2. **TestFlight friction is real.** Requiring a second Apple app install plus an invite-accept step before seeing the product produces industry-standard ~30% open rates on cold invites. Your 28% (35/125) is normal — not a product signal, a distribution channel signal. It goes away with the App Store.
3. **Setup complexity self-selects out casual users.** The operating envelope requires specific conditions. Without the 90-second setup video, users fail publicly in front of their team and churn silently.
4. **No consequence for not downloading.** The App Store creates urgency — reviews, charts, social proof — that a TestFlight link does not.
5. **The monetization gap.** Not charging sets no expectation of value. Users assume the product is in flux and wait for "the real version."

---

## Part 2 — The Three Decisions That Precede Everything Else

### Decision 1: The Freemium Boundary

_Note on StoreKit 2: This is Apple's modern billing framework for subscriptions and one-time purchases inside an iOS app. Implementing it is what allows you to charge users via the App Store. Without it, you cannot collect payment._

**Recommended model** _(pending final team review)_:

| Tier | What You Get | Price |
| :--- | :--- | :--- |
| **Free — forever** | Live ball/strike audio calls, on-screen pitch location, pitch count, Pause/Warm-Up, Delete last pitch | $0 |
| **HeyBLU Pro** | Session reports, heatmaps, Baseball Card graphics, CSV/JSON export, Command Training | $14.99/month or $99.99/year |

**Open items for team discussion:**
- **Follow Game (second-device live mirror):** Not yet finalized — discuss whether this is Free or Pro. Argument for Free: it extends the product's reach to parents and bench coaches at zero cost to you and makes the primary operator look like a hero. Argument for Pro: it is a clear "professional workflow" feature. Decide before submission.
- **Grandfather all 35 current TestFlight downloaders as Pro for 90 days.** This converts your existing users into champions at zero revenue cost and generates goodwill for reviews.

**Implementation note:** Gate `BaseballCardReportView`, CSV/JSON export, session heatmaps, and Command Training behind the Pro entitlement. Add a tasteful "You're on Free" upgrade prompt after session end — not a paywall that interrupts live play.

---

### Decision 2: The Launch ICP

_Open question for CRO discussion. Recommendation below._

Trying to be the tool for coaches, leagues, pitch count authorities, and parents simultaneously in the first launch message produces confusing copy and diluted outreach. Pick one.

**Leading Proposal: The solo pitching coach or serious travel ball dad who runs bullpens.**

Why this ICP:
- Single device, foul territory, tripod — no Multipeer, no iPad, no league admin complexity.
- Job-to-be-done is immediate and visceral: "Was that pitch a strike?"
- They already carry a phone. Many already have a tripod or fence mount from filming mechanics.
- They share content. Pitching content on Instagram and Twitter/X is a massive niche with active creators.
- They forgive setup complexity more than a casual parent in the stands.

**ICP one-page script** _(this script should drive every piece of marketing copy, every screenshot, every video)_:

> "Mount your phone on a fence mount or tripod on the first-base or third-base side, 10–15 feet from home plate. Open HeyBLU. Scan for 30 seconds while walking toward the plate. Place the blue zone on the plate. Walk back and mount the phone. Slide the zone back onto the plate. Hit Play Ball. Throw a pitch. Hear ball or strike."

Everything about launch messaging, App Store screenshots, PR pitches, and demo videos flows from that single script. If a screenshot or video does not serve that script, it is a distraction.

---

### Decision 3: What "Supported" Means on Launch Day

The operating envelope is real and must be stated plainly in the App Store listing and in the first screen of the app. A user who discovers a limitation before downloading gives you nothing. A user who discovers it after a failed session in front of their players leaves a 1-star review.

**The Sweet Spot (what works reliably):**
- **Distance:** 10–15 feet directly from home plate. Closer is almost always better. At 10–12 feet, the ball is large enough in frame for reliable tracking on any phone. At 20+ feet on a Pro/LiDAR phone, trajectories become sparse.
- **Angle:** 15–45 degree offset in foul territory, first-base or third-base side.
- **Device:** Non-Pro iPhone 11 or later. Standard, non-LiDAR phones are the most reliable.
- **Environment:** Outdoor daylight. This is the only supported environment. Indoor cages and dusk do not work — say this explicitly.
- **Mount:** Tripod or fence mount. Hand-held does not work.
- **Ball:** Regulation baseballs and wiffle balls. Softballs and tennis balls are untested.

**The LiDAR/Pro Phone Caveat:**
iPhone Pro models (14 Pro, 15 Pro, 16 Pro, etc.) will experience zone drift after the walk from plate to tripod. This is normal ARKit behavior on featureless dirt fields. Users must be warned before they walk. Required in-app warning before the walk step: _"iPhone Pro detected. The zone will shift when you mount the phone. That's normal — you'll use the slide arrows to fix it in the next step."_

Additionally: Pro users should enter their physical distance and lens height measurements in the Physical Measurements screen during mount. Without this, calls may be systematically off for Pro devices.

**The ROI Framing Rule (confirmed correct — matches codebase):**

This is the single most common reason pitches are not called. The app detects the ball within a detection window spanning the **center 50% of screen width** (25% to 75%). The ball needs to enter the window from one edge and travel all the way across to the plate — this is the "runway" that produces enough detections for a trajectory.

**The confirmed rule:**
- **1st Base side:** Camera is to the RIGHT of the catcher → home plate appears on the **LEFT** side of the screen → frame home plate at the **far left edge (~25%)** of the detection window. The app's in-app tip confirms: "Plate on left line."
- **3rd Base side:** Camera is to the LEFT of the catcher → home plate appears on the **RIGHT** side of the screen → frame home plate at the **far right edge (~75%)** of the detection window. The app's in-app tip confirms: "Plate on right line."

The in-app cyan line guides and setup tips already implement this correctly. This rule must also appear clearly in:
1. The App Store description
2. The 90-second setup video
3. The App Store screenshot showing correct vs incorrect plate placement

---

## Part 3 — Phase 1: Stabilize
_The core code is largely done. Phase 1 is user education, support infrastructure, and App Store asset preparation. ~4–6 weeks before submission._

### 1.1 Close the Support Gap Via the 20-Minute Calls

Email all 35 TestFlight downloaders (including inactive ones). Subject: _"Quick favor before we go to the App Store — 20 minutes?"_ Ask for a video call. The goal is to observe one person setting up the app from scratch, cold, without your help. Even two sessions will surface the top failure modes. Use successful call participants to re-activate the private Slack as "Founding Power Users" who get Pro access for life.

**Known high-risk failure modes to probe for:**

| Failure Mode | Expected User Reaction | Risk to Ratings |
| :--- | :--- | :--- |
| Zone shifts after mounting | "It broke" — user gives up | Very High |
| ROI misalignment (plate at wrong edge or center) | No pitches called — "doesn't work" | Very High |
| LiDAR phone, no measurements entered | Systematic wrong calls | High |
| Phone too far (>20 ft) | Sparse or no calls | Medium |
| Indoor field or cage attempt | Nothing works | Medium |
| Notification interrupts session while in foreground | ARKit tracking lost mid-session | Medium |

For each failure mode, you need a short FAQ answer AND one line of in-app guidance.

### 1.2 Required In-App Copy Changes (Not New Features — Copy Only)

Three specific copy additions that will directly prevent the highest-risk 1-star reviews:

1. **Before the walk-to-tripod step:** Add one sentence: _"The zone will shift when you mount the phone. That's normal — you'll fix it in the next step."_ This single sentence will prevent dozens of "the app is broken" reviews.

2. **For Pro/LiDAR phones during mount phase:** Surface a banner: _"iPhone Pro detected. The zone will shift when you mount the phone. That's normal — use the slide arrows to fix it in the next step. Pro users: enter your distance and lens height in Physical Measurements for best accuracy."_

3. **For the mount phase ROI guidance:** After confirming the correct framing direction (see Decision 3 above), update the cyan-line guidance text to state the rule explicitly: which edge the plate should be near based on which side of the field the user is on.

### 1.3 Move the Support Link

Currently the support/email link is accessible from End Session → Summary. That is too buried. Users who are frustrated enough to contact support are usually frustrated during a session, not at summary review. **Move the "Email HeyBLU" link to be visible from the Play Ball / in-game view** — a small "?" or "Help" button that launches the support email. If they are frustrated, the button must be in front of them.

### 1.4 App Store Submission Asset Preparation

All of the following must be completed before submission. Apple reviews metadata alongside the app; complete assets produce faster approval and editorial consideration.

**App Name:** `HeyBLU — AI Strike Zone`
**Subtitle (30 chars max):** `Ball & Strike Calls, Live`
**Primary Category:** Sports
**Secondary Category:** Utilities
**Age Rating:** 4+ (no objectionable content, no stored video or biometric data)

**Keywords (100 chars total):**
`baseball,strike zone,pitch tracker,umpire,ball strike,pitching,bullpen,youth baseball,coach`

**App Store description — first 255 characters are visible without tapping "more" and must carry the entire pitch:**
> HeyBLU uses your iPhone camera and AR to track a pitch in 3D and call ball or strike — out loud — in real time. Mount your phone at the backstop, place the virtual strike zone on home plate, and hear every called pitch. Free forever for audio calls.

**Screenshots (6–10 required, all with on-screen text overlays):**

| # | What to Show | Text Overlay | Pro Badge? |
| :--- | :--- | :--- | :--- |
| 1 | In-game: "Strike" call + pitch dot in zone | "Live ball & strike calls" | No |
| 2 | Setup showing 10–15 ft distance with fence mount | "Mount at the fence, 10–15 feet away" | No |
| 3 | Overhead PiP (Adjust Plate view) | "Align your zone in seconds" | No |
| 4 | Follow Game on second device | "Coaches and parents follow live" | No |
| 5 | Session heatmap | "See where every pitch went" | Yes |
| 6 | Baseball Card share graphic | "Share the session" | Yes |
| 7 | Command Training intent screen | "Set intent. Measure execution." | Yes |
| 8 | ROI framing diagram: plate at left edge (1st base) and right edge (3rd base) vs incorrect centered placement | "Frame the plate at the edge, not the center" | No |

**App Store preview video (30 seconds, required — this is the #1 asset):**
See Top Priorities above for the exact edit structure. Export at 1080×1920 (vertical, iPhone format) at 30fps. No narration — on-screen text only. End card: "HeyBLU. Free on the App Store."

### 1.5 Privacy and Legal

Before submitting to Apple:
- Confirm the privacy policy at heyblu.ai explicitly states no video is stored, no biometric data is retained, no data linked to minors.
- In App Store Connect → App Privacy: mark data not collected, or accurately disclose any session analytics. This is visible to users before download and Apple editorial teams review it. Clean privacy disclosure is a trust signal.
- A support email address must appear on the App Store listing (`support@heyblu.ai`).
- Terms of use must be linked from the App Store listing.

---

## Part 4 — Phase 2: Prime
_"Priming the pump" = creating organic spread conditions before the App Store listing is live. ~3–4 weeks before launch, concurrent with late Stabilize work._

### 4.1 Build the Video Library First

All outreach below fails without these videos. Minimum before any outreach:

| Video | Length | Platform | Purpose |
| :--- | :--- | :--- | :--- |
| App Store preview (montage) | 30 sec | App Store Connect | Required for listing |
| Setup walkthrough | 90 sec | YouTube, FAQ link, every outreach message | Support deflection + trust |
| "First pitch call" vertical short | 15–30 sec | Instagram Reels, TikTok, YouTube Shorts | Most viral asset — pitch → dot → audio call |
| Coach testimonial | 60–90 sec | All platforms | Social proof |

The "first pitch call" vertical short is the single most viral asset in this category. The moment a ball or strike is called out loud with the dot appearing in the zone, framed vertically in a phone recording — that moment is built for Reels and Shorts. If you have 10 seconds of that footage, you have your marketing engine.

### 4.2 Identify and Seed 20 Target Advocates

These are not paid influencers. They are credible baseball people with active social audiences who will understand the product immediately and have an incentive to share it.

**Priority targets by type:**

| Type | Why | Where to Find |
| :--- | :--- | :--- |
| Pitching coaches with active Instagram/YouTube | Bullpen content is their content — HeyBLU IS their content | Search "youth baseball pitching coach" on Instagram and YouTube |
| Travel ball directors / team admins | Run 3–5 sessions per week, have active parent audiences | USSSA, PBR, Perfect Game regional social accounts |
| Head of umpires at regional associations | Will share a tool that supports umpire education | State and regional umpire association websites and Facebook pages |
| Baseball parent influencers | Youth sports parent content is massive on TikTok | Search "youth baseball dad" or "travel ball mom" on TikTok |
| High school or college pitching coordinators | Credibility multiplier for the coaching community | Twitter/X baseball coaching community is very active |

**Outreach message (personalize for each):**
> "We're launching HeyBLU on the App Store next month — it's the first iPhone app that calls balls and strikes out loud in real time, from the camera at the backstop fence. I'd love to give you Pro access before launch to set it up at a bullpen. I can send our 90-second setup video so you're not flying blind. If you find it useful and want to share it, great. No pressure either way. Worth a field test?"

The ask is Pro access for life (cost: $0) in exchange for an honest field test. You are not asking for a post or a review — you are asking for a trial. People who find it useful will share it voluntarily.

### 4.3 Prepare the PR Pitch

**The story in one paragraph (journalist-ready):**
> For the last 15 years, MLB teams have spent millions on systems like Hawk-Eye and TrackMan to objectively call the strike zone. A startup just shipped the same technology for free, on an iPhone, at any Little League field. HeyBLU uses ARKit and on-device computer vision to track a pitch in 3D, map it against a virtual strike zone anchored to home plate, and call ball or strike out loud — in real time. No cameras in the fence. No subscriptions to hear calls. Just a phone on a tripod.

**Target publications:**

| Outlet | Angle | Contact Method |
| :--- | :--- | :--- |
| The Athletic | Technology in grassroots baseball, democratizing pitch data | Direct DM to baseball beat writers on Twitter/X |
| Baseball America | Youth baseball tool for coaches and leagues | Contact form or LinkedIn |
| Perfect Game media | Travel ball parent and coach audience | Direct relationship outreach |
| TechCrunch / VentureBeat | "AI app calls balls and strikes on an iPhone" | Standard press contact / Pressable |
| Local TV news (any market) | Human interest: "Dad builds real-time umpire app for Little League" | Local TV assignment desks love this story; pitch to 2–3 markets |
| ESPN Digital | Democratization of sports technology narrative | Editorial pitch via PR contact |

**Embargo strategy:** Offer 3–5 key journalists a pre-launch video call demo under a 2-week embargo before launch day. They write their piece and publish on launch day or within 24 hours. This is standard tech launch practice. Include the App Store link and a promotional code for Pro in the embargo briefing.

### 4.4 Award Targets

Submit to as many as are open. Being nominated or shortlisted generates significant App Store editorial attention even without winning.

| Award | Category | Action Required |
| :--- | :--- | :--- |
| **Apple Design Awards** | Innovation / AR / Sports | Self-nomination opens annually around Apple's WWDC (typically May–June). Research current window. This is the highest-value award in iOS — winning generates substantial App Store editorial placement. |
| **Sports Technology Awards** | Best Innovation in Grassroots / Amateur Sport | Annual awards — check sportstech.awards for submission window |
| **SXSW Interactive Innovation Awards** | Cutting Edge / AI | Opens ~September for following year's conference |
| **Product Hunt** | Launch of the Day | Day-of launch execution (see Phase 3 below) |
| **GeekWire Sports Tech** | General tech innovation | Annual — check geekwire.com for current cycle |

---

## Part 5 — Phase 3: Launch

### 5.1 Launch Day Timing

**Best days to launch on the App Store:** Tuesday or Wednesday.
App Store editorial refreshes happen Monday. Being new and indexed by Tuesday gives you a full week of visibility in the "New Apps We Love" editorial consideration window. Friday launches disappear over the weekend. Do not launch on a Monday or Friday.

**Best calendar windows:**
- **February (Target):** Aligns with spring baseball season startup. This is the highest-leverage window for the ICP. Coaches and leagues are actively looking for tools in February.
- **Fall alternative:** August–September for fall ball season.
- Do not rush to launch in summer (May–August) — summer is peak App Store competition volume and you would miss the spring season narrative entirely.

### 5.2 The Launch Day Sequence

**T-minus 7 days:** Send "launching next week" message to all 20 seeded advocates. Give them the App Store link and ask them to download on launch day and leave a review if they have used it.

**T-0: Launch day, 9am ET**
- Post the launch trailer video simultaneously on all social channels.
- Send Product Hunt post live (see 5.3 below — the Product Hunt post should go up at 12:01am PT, not 9am ET, to maximize the 24-hour voting window).
- Send the press embargo lift email to all journalists who received pre-briefings.
- Post the coach testimonial video on Instagram and Twitter/X.
- Send a personal email to every TestFlight user (all 35 downloaders, including inactive): _"HeyBLU is live on the App Store today. Download the real thing and leave a quick review if you like it — your feedback helps us a lot. You're getting Pro free for 90 days as a thank-you for being early."_ Include the direct App Store link and a one-tap App Store review link.

**T+2 hours:** Reply to every comment and DM within the first 2 hours. Engagement velocity in the first 2 hours affects algorithmic distribution.

**T+24 hours:**
- Check App Store Connect for first reviews. Respond to every single review — positive and negative — within 24 hours. This response is visible to every future user who reads the review. For 1–2 star reviews, respond specifically: _"Thank you for the feedback. [Specific fix]. If you try again with [fix], please consider updating your review — we want to earn the stars."_

### 5.3 The Review Strategy

The App Store algorithm weights review volume and velocity in the first 30 days heavily. Goal: 25+ reviews in the first 2 weeks with a 4.5+ average.

**In-app review prompt placement** (use `SKStoreReviewController.requestReview()` — Apple's native prompt):
- After a session ends with ≥5 pitches called (user experienced the core product)
- After a user shares a Baseball Card (they liked it enough to share)
- Do **not** prompt on first launch, during a session, or during setup — this produces reflex dismissal

**Direct asks:**
- Personally ask all 20 seeded advocates on launch day: _"Would you mind leaving a quick App Store review today?"_ A personal ask converts at 30–40%. A broadcast ask converts at 2–5%.
- Send a dedicated email to the 35 TestFlight downloaders with the direct review link (not just the App Store page — the direct deep link to the review tab).

### 5.4 The Product Hunt Launch

Product Hunt "Launch of the Day" delivers tech-adjacent press coverage, backlinks, and a permanent credibility badge. To have a real chance at winning:

- **Post at 12:01am PT on launch day.** The 24-hour voting window starts then. Later posts compete for fewer hours of votes.
- **Thumbnail:** A GIF showing the pitch being called (the "wow" moment in 3 seconds flat).
- **Tagline:** _"Ball and strike calls, live, from an iPhone at the backstop fence."_
- **First comment in your own thread** (post immediately after): Include the founder story, the one thing you want feedback on, and a link to the App Store and the 90-second setup video.
- **Engagement:** Reply to every comment that day. This signals active developer presence and the algorithm rewards it.
- **Pre-seeded upvotes:** Ask your 20 advocates and Slack members to upvote at launch. Organic community support, not manufactured.

---

## Part 6 — Phase 4: Sustain (Days 7–90 Post-Launch)

### 6.1 Weekly Cadence

| Week | Focus |
| :--- | :--- |
| 1 | Monitor reviews daily, respond to every review within 24 hours, track top support email themes |
| 2 | Ship critical fixes surfaced by the newly visible support button and week-1 reviews |
| 3 | Post the first "user story" content — a short video from an advocate who used it at a real game or bullpen |
| 4 | First App Store Connect analytics review: device breakdown, iOS version breakdown, where users drop off in the session flow |
| 5–8 | Outreach to 2nd tier of advocates (coaches who commented on week 1–2 social content) |
| 8–12 | Evaluate Pro conversion rate. If <2%, re-examine paywall content or pricing. If >5%, invest in deeper feature development. |

### 6.2 Metrics to Track

**App Store Connect (set week 1 baseline):**
- Downloads per day (track daily for first 30 days)
- Product page views → downloads conversion rate. Goal: >15% cold traffic, >50% warm/seeded traffic
- First-session completion rate (what % reach "Play Ball"?)
- Review count and average rating (alert if it falls below 4.2 at any point)

**Support signals:**
- Email volume and the top 3 recurring questions each week
- FAQ page visit counts by section (which questions are most read?)
- Slack/community activity

**Monetization:**
- Free → Pro conversion rate. Goal: 5–10% within 90 days
- Which paywalled features are viewed most by free users before converting (this tells you which feature to emphasize in upgrade prompts)

### 6.3 Seasonal Calendar

Baseball has seasons. HeyBLU's growth follows them. Build this into the product and marketing calendar.

| Window | Action |
| :--- | :--- |
| **February (primary)** | Target launch. Spring ball coaches are actively searching for tools. Highest-value acquisition window. |
| **March–May** | Content push: user stories, testimonials, Baseball Cards being shared from spring sessions |
| **August–September** | Fall ball secondary acquisition push. App Store Connect "Special Event" promotional submission for seasonal relevance. |
| **November–January** | Indoor training academies are active — if cage support improves, this becomes a third window. In the meantime, maintain via organic and Substack content. |

Apple allows "Special Event" promotions in App Store Connect that surface apps in editorial for seasonal relevance. Submit these for spring and fall ball season starts.

---

## Part 7 — What NOT to Do

- **Do not launch into a feature gap.** The product you have today — calls + session reports + Baseball Card + Command Training + Follow Game — is a complete, reviewable product. Every feature added after the decision to launch is a stability risk and a delay. Lock the scope.
- **Do not claim velocity parity with a radar gun.** Field data shows pitch speed is inconsistent. "Estimated pitch speed" or "approximate MPH" in all copy. The FAQ handles this correctly already. Do not let any social post or press contact go further.
- **Do not target all personas simultaneously.** BLU is four different stories at once (consumer audio gadget, league ops tool, coach lab, two-device system). Pick one for launch (solo pitching coach / travel ball dad). Add the pitch count authority and umpire assist stories in subsequent App Store "What's New" releases.
- **Do not make setup look easier than it is.** The 90-second setup video should show 90 seconds of real setup. Users who are surprised by a 2-minute setup will forgive it. Users who expected a 10-second setup will resent it.
- **Do not chase visual plate alignment on Pro/LiDAR phones after entering physical measurements.** After entering distance and lens height, the AR plate may appear visually offset from the real plate by a few inches. This is correct behavior — the math knows where the plate is. Chasing that gap visually moves the math plate to the wrong position and produces wrong calls. If the setup video shows a Pro phone, include this explanation explicitly.
- **Do not treat a soft launch as a fallback for unresolved issues.** A soft launch in a small market only adds value if you have an active feedback loop from that market. Given a small team, a soft launch without monitoring adds delay without adding safety. Fix the known issues in Phase 1 first.

---

## Part 8 — Complete Pre-Launch Checklist

Copy this to your project management tool. Check every item before submitting to App Store Connect.

### ⚙️ Technical / Product
- [ ] StoreKit 2 IAP implemented and sandbox-tested ($14.99/mo and $99.99/yr)
- [ ] Pro feature gates confirmed working: session reports, CSV/JSON export, heatmaps, Baseball Card, Command Training
- [ ] "Zone will shift after mounting" warning added in app before walk phase (all users)
- [ ] "LiDAR/Pro iPhone detected" banner added in mount phase with Physical Measurements prompt
- [ ] "Email HeyBLU" support link moved to be visible from in-game / Play Ball view
- [ ] TestFlight Pro entitlement grandfathered for 90 days for existing users
- [ ] Upgrade prompt added at session-end for free users (tasteful, not a paywall interruption)
- [ ] In-app review prompt added: triggers after session with ≥5 pitches called
- [ ] In-app "Get Help" link confirmed accessible from settings (links to heyblu.ai/faq)
- [ ] Crash reporting confirmed active and alerts monitored
- [ ] In-app cyan-line guidance text confirmed: 1st base → "Plate on left line" (25%), 3rd base → "Plate on right line" (75%)
- [ ] Follow Game tier placement decided (Free vs Pro) and implemented

### 🔒 Privacy & Legal
- [ ] Privacy policy at heyblu.ai updated: no video stored, no biometric data retained, no minor data linked to user identity
- [ ] App Privacy section in App Store Connect accurately completed
- [ ] Support email (`support@heyblu.ai`) confirmed monitored and auto-reply configured with FAQ link
- [ ] Terms of use URL added to App Store listing
- [ ] App Store privacy policy URL confirmed valid

### 🎬 Marketing Assets
- [ ] 30-second App Store preview video exported at 1080×1920, 30fps (mandatory)
- [ ] 90-second complete setup walkthrough video produced and hosted on YouTube
- [ ] "First pitch call" vertical short (15–30 sec) produced for Reels/Shorts/TikTok
- [ ] Coach testimonial video produced (at least 1)
- [ ] 6–8 App Store screenshots with text overlays completed
- [ ] Screenshot 8: ROI framing diagram (1st base = plate at left/25%, 3rd base = plate at right/75%)
- [ ] App Store description written and first 255 characters confirmed compelling
- [ ] App Store keywords finalized (100 char limit)
- [ ] App name finalized: `HeyBLU — AI Strike Zone`
- [ ] Product Hunt post draft written; GIF thumbnail produced
- [ ] Launch trailer (60–90 sec extended cut) scheduled for all social platforms on launch day

### 📣 Outreach
- [ ] Personal email sent to all 35 TestFlight downloaders requesting 20-minute setup call
- [ ] At least 2 setup observation video calls completed and failure modes documented
- [ ] Slack re-activated with "Founding Power Users" from video call participants
- [ ] 20 target advocates identified, contacted, and field tests scheduled
- [ ] 3–5 journalists pre-briefed under embargo with App Store link and promo code
- [ ] Personal emails drafted to 35 TestFlight users for launch day send
- [ ] "Launching next week" advocate message scheduled for T-7 days
- [ ] Product Hunt post scheduled for 12:01am PT on launch day

### 📋 Business & Strategy
- [ ] Pricing finalized ($14.99/mo or $99.99/yr) — team sign-off
- [ ] Follow Game tier finalized — team sign-off
- [ ] ICP confirmed with CRO — team sign-off
- [ ] Launch date selected (Tuesday or Wednesday, ideally February for spring ball season)
- [ ] Review response responsibility assigned: who checks App Store Connect daily for first 30 days?
- [ ] Apple Design Award nomination window researched; submission date on calendar
- [ ] Sports Technology Awards submission window researched; deadline noted
- [ ] SXSW Interactive Innovation Awards deadline researched
- [ ] App Store Connect "Special Event" submissions planned for February and August

---

## Appendix A — PR One-Pager for Journalist Briefings

**What it is:** HeyBLU is an iPhone app that uses AR and on-device computer vision to track a regulation baseball pitch in 3D, map where it crosses the strike zone, and announce ball or strike out loud — in real time.

**What makes it different:** A single phone on a tripod. No permanent installation. No extra hardware. No subscription to hear calls. Available free on the App Store.

**Who it's for:** Youth baseball coaches, travel ball programs, Little League organizations, bullpen training sessions. The market MLB teams have never served because the price was $50,000+.

**How it works (one paragraph for non-technical audiences):** The phone mounts at the backstop fence behind home plate. The app scans the field to build a 3D map, and the user places a virtual blue strike zone directly on top of the physical plate. From that moment, the app watches every pitch with the camera, estimates where the ball crosses the zone in three dimensions, and announces the call. The math runs on the phone. No internet required. No cloud processing.

**What it doesn't do:** It does not call swings or check swings (human umpires own those). It does not work in indoor cages or at dusk. It does not replace the home plate umpire in any official context.

**Quote (founder):** [Rob to supply a 1–2 sentence founder quote for press use]

**Assets available:** 30-second preview video, App Store screenshots, field session footage. Contact: [Rob's preferred press contact email]

---

## Appendix B — The Freemium Conversation Guide

When coaches or league admins ask "What's free and what costs money?":

> "Hearing ball or strike on every pitch is free forever — we never charge for that. If you want the full picture after a session — a report showing where every pitch went, heatmaps, a shareable Baseball Card graphic for the pitcher — that's HeyBLU Pro at $14.99/month or $99.99 for the whole year. A lot of coaches use the free version for games and upgrade when they want the coaching data."

This positions the paywall correctly: you are charging for the artifact (the report), not the experience (the call).

---

_v4 incorporates all content from v3 (which governs on conflicts), fills gaps from the original AI-generated plan (App Store metadata, privacy/legal, award targets, PR targets, failure mode table, ICP script, Product Hunt execution, launch day timing, weekly sustain cadence, seasons calendar, and complete checklist), and flags the 25/75 framing rule direction conflict for field confirmation before publishing._
