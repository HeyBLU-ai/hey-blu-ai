# HeyBLU — App Store Launch Plan (Updated)
_Date: May 26, 2026_
_Prepared for: HeyBLU Team_
_Purpose: Comprehensive launch strategy, tailored to current beta realities and physics limits_

## Executive Summary
Do not launch quietly. The data is clear: high awareness, low conversion. You have a product that makes people's jaws drop when they see it, but that same "wow" effect requires seeing it. The correct strategy is a focused pre-launch priming campaign targeting a defined ICP, followed by a coordinated public launch designed to generate organic press coverage, App Store editorial consideration, and a wave of 5-star reviews from people who set up successfully.

The biggest risk is not obscurity. It is launching before users understand the operating envelope, letting low-ratings reviews accumulate in the first 72 hours, and having no monetization rails in place when the attention spike arrives. 

---

## 🚨 Top Priorities: Surface to the Top 🚨
*Based on the current state of the beta, these four items are the immediate, highest-leverage actions:*

1. **The 30-Second Preview Video (Mandatory):** This is the single highest-leverage asset for the App Store. A montage of: Mount the phone (5s), scan for 30 seconds to warm up the phone & place the blue zone on the plate (5s), slide zone back to correct shift (5s), three live pitches called (10s), session summary (5s). On-screen text only. *Nothing else in this plan matters as much as this video existing.*
2. **The 90-Second "How To" Video:** Nobody has documented all the necessary setup steps (outdoor, tripod, scan, zone shift, 25/75 framing) in a single 90-second video that ships alongside the invite. This must be created and linked everywhere.
3. **The 25/75 Framing Rule:** Your App Store description and onboarding must say this clearly:
    * **1st Base side:** The camera is to the right of the catcher. Frame home plate at the **far left edge (~25% mark)** of the AI window.
    * **3rd Base side:** The camera is to the left of the catcher. Frame home plate at the **far right edge (~75% mark)** of the AI window.
4. **Email the 35 Downloaders:** Send a personal email (not automated) to all 35 TestFlight downloaders. Subject: *"Quick favor before we go to the App Store — 20 minutes?"* Ask for a video call. You need one observation of someone setting up the app from scratch. Even two of these calls will surface exactly where users are getting stuck.

---

## Part 1 — Diagnostic: Why 125 Invites Yielded 2 Active Users
1. **The visual hook was missing.** "An iPhone app that calls balls and strikes" does not convey the magic. People bookmark it for "later." The fix: video-first outreach.
2. **TestFlight friction is real.** Downloading a secondary Apple developer app is a massive hurdle. This is a distribution channel problem that goes away with the App Store.
3. **Setup complexity self-selects out casual users.** The operating envelope requires specific conditions. Without the 90-second setup video, users fail in front of their team and churn.
4. **No consequence for not downloading.** The App Store creates urgency (reviews, charts, social proof) that a TestFlight link does not.
5. **The monetization gap.** Not charging sets no expectation of value. 

---

## Part 2 — The Three Decisions That Precede Everything Else

### Decision 1: The Freemium Boundary
*Note on StoreKit 2: "Implementing StoreKit 2" simply means adding Apple's modern billing code framework into your app so you can actually charge users subscriptions via the App Store.*

Recommended model (Pending final review):
| Tier | What You Get | Price |
| :--- | :--- | :--- |
| **Free — forever** | Live ball/strike audio calls, on-screen pitch location, pitch count, Pause/Warm-Up, Delete last pitch | $0 |
| **HeyBLU Pro** | Session reports, heatmaps, Baseball Card graphics, CSV/JSON export, Command Training | $10.99/month or $99/year |
*(Note: "Follow Game" has not been finalized as free. Discuss with team whether this goes to Pro).*

### Decision 2: The Target ICP for Launch Day (For CRO Discussion)
Trying to be the tool for everyone dilutes the message. **Open question for CRO: Who is the launch ICP?** *Leading Proposal:* The solo pitching coach or serious travel ball dad who runs bullpens. They already have a tripod, they operate in foul territory, and they share content on social media. 

### Decision 3: What "Supported" Means on Launch Day
The operating envelope is real and must be stated plainly to protect your ratings:

* **The Sweet Spot:** **10 to 15 feet** directly from home plate in foul territory, outdoor daylight, tripod or fence mount.
* **The Environment Limits:** Outdoor daylight only. Indoor use will not work and is a serious issue. Currently tested for baseballs and whiffle balls only (softballs and tennis balls are untested). 
* **The LiDAR "Walk-Phase" Drift Trap:** The only LiDAR-specific issue to focus on is walk-phase drift. iPhone Pro/LiDAR models will experience massive drift when walking from the plate to the tripod. Users must be warned: *"If using an iPhone Pro, the zone will shift when you mount the phone. This is normal. Use the on-screen 4-way arrows to slide it back."* Non-LiDAR phones might not drift at all, or will only require 1-inch tweaks using "Adjust Plate."
* **The 25/75 Framing Rule:** (Detailed in Top Priorities above). Crucial for AI runway.

---

## Part 3 — Phase 1: Support & "How To" Readiness
*The core UI and code stabilization is largely done. Phase 1 is now entirely about user education and support pathways.*

**1. Revive the Slack via the 20-Minute Calls**
You have a dead private Slack channel. When you email the 35 TestFlight users for your 20-minute setup observation calls, use those successful 1-on-1s to invite them back into the Slack as "Founding Power Users."

**2. Make the "Email HeyBLU" Link Visible**
The app rarely crashes, so users don't get crash prompts. Currently, the support link is hidden behind "End Session" -> "Summary". 
* **Fix:** Move it to the main "Session Ended" screen, or show it directly on the "Play Ball" screen (since they have to return to the phone to end or pause anyway). If they are frustrated, the button must be staring them in the face.

**3. The Onboarding Warning**
Add the LiDAR drift warning explicitly: *"Pro iPhone detected. The zone will shift when you mount. That's normal — you'll use the slide arrows to fix it in the next step."*

---

## Part 4 — Phase 2: Prime (3–4 Weeks Before Launch)
*"Priming the pump" means creating organic spread before the App Store listing is live. This phase is critical.*

**1. Build the Video Library First**
* **The 90-Second Walkthrough:** Setup, scan, zone shift, 25/75 framing.
* **The 30-Second App Store Preview:** (Detailed in Top Priorities).
* **"First pitch call" vertical short (15–30 sec):** IG Reels, TikTok. The most viral asset. Pitch → dot → audio call.
* **Coach testimonial (60–90 sec):** Social proof.

**2. Identify and Seed 20 Target Advocates**
* Target pitching coaches with active IG/YouTube, travel ball directors, and baseball parent influencers.
* **Script:** *"We're launching HeyBLU on the App Store next month... I'd love to give you Pro access before launch to set it up at a bullpen. I can send our 90-second setup video too. Worth a field test?"*

**3. Prepare the PR Pitch**
* **The story:** "MLB teams spend millions on Hawk-Eye. A startup just shipped the same technology for free, on an iPhone."
* **Embargo strategy:** Offer 3–5 key journalists a pre-launch demo under embargo for 2 weeks before launch day.

---

## Part 5 — Phase 3: Launch

**1. The Launch Day Sequence (Hour by Hour)**
* **T-minus 1 week:** Send "launching next week" message to 20 advocates.
* **T-0 (Launch day, 9am ET):**
    * Post launch trailer on all social channels.
    * Send Product Hunt post live.
    * Send press embargo lift email.
    * Email TestFlight users: *"HeyBLU is live on the App Store. Download it now for 90 days of free Pro. Please leave a review."* Include 1-tap review link.
* **T+2 hours:** Reply to every comment and DM.
* **T+24 hours:** Check App Store Connect for reviews. Respond to every review. 

**2. The Review Strategy**
Your goal is 25+ reviews in the first 2 weeks.
* **In-app review prompt:** Trigger after a session ends with ≥5 pitches called, or after sharing a Baseball Card. Do NOT prompt during setup.
* **Explicit ask:** Personally ask your 20 advocates.

**3. The Product Hunt Launch**
* Post at 12:01am PT on launch day. Use a GIF thumbnail showing the pitch being called. Tagline: *"Ball and strike calls, live, from an iPhone."*

---

## Part 6 — Phase 4: Sustain (Days 7–90 Post-Launch)
* **Week 1:** Monitor reviews, diagnose failure modes, respond to every review.
* **Week 2:** Ship critical fixes surfaced by the newly visible support button.
* **Week 3:** Post first "user story" video content.
* **Weeks 5–8:** Outreach to 2nd tier of advocates.
* **Weeks 8–12:** Evaluate Pro conversion rate. If <2%, re-examine the paywall.

---

## Part 7 — What NOT to Do
* **Do not launch into a feature gap.** The product you have today is complete. Lock the scope.
* **Do not claim velocity parity with a radar gun.** * **Do not make setup look easier than it is.** Show the 90 seconds. Don't let them expect a 10-second setup.

---

## Part 8 — Pre-Launch Checklist

**Product / Technical**
- [ ] Implement StoreKit 2 IAP ($10.99/mo or $99/yr)
- [ ] Move "Email HeyBLU" support link to Session Ended / Play Ball view
- [ ] Add LiDAR walk-phase drift warning in onboarding
- [ ] Finalize "Follow Game" tier placement (Free vs Pro)

**Marketing Assets (The Video Library)**
- [ ] 30-second App Store preview video (Mandatory)
- [ ] 90-second complete setup walkthrough video
- [ ] "First pitch call" vertical shorts
- [ ] App Store screenshots with text overlays outlining 10-15ft and 25/75 rules

**Outreach**
- [ ] Email 35 TestFlight users for 20-min setup observation
- [ ] Identify and contact 20 target advocates
- [ ] Discuss and finalize Launch ICP with CRO
