# Use of Funds Adjustment Recommendations

## Current Situation
- **Total Tranche Amount:** $2,000,000
- **Estimated Total Allocation:** ~$2,805,000 (excluding infrastructure)
- **Estimated Overage:** ~$805,000

## Strategic Adjustment Recommendations

### 1. **Founder Compensation - Reduce Tranche C Allocation** (Save: ~$150k-200k)
**Current:** $500,000 for full 12 months at Stage 3 ($250k annual × 2 founders)
**Recommendation:** Phase in Stage 3 pay more gradually
- Option A: Start Stage 3 pay at month 6 of Tranche C (save ~$250k)
  - First 6 months: Continue Stage 2 pay ($120k annual × 2 = $240k for 6 months = $120k)
  - Last 6 months: Stage 3 pay ($250k annual × 2 = $500k for 6 months = $250k)
  - New total: $370k (vs $500k) → **Save $130k**

- Option B: Delay Stage 3 trigger to $50k MRR (currently triggers at Tranche C start)
  - Keep Stage 2 pay for first 3-4 months of Tranche C
  - **Save ~$100k-150k**

**Rationale:** Stage 3 pay should be tied to actual revenue milestone ($50k MRR), not just tranche receipt. This aligns incentives and preserves capital.

### 2. **Sales & Marketing - Reduce Tranche C Spend** (Save: ~$100k-150k)
**Current:** $310,000 in Tranche C ($100k Ambassador + $150k Social/Digital + $60k Org)
**Recommendation:**
- Reduce Ambassador CAC from $100k to $50k (save $50k)
- Reduce Social/Digital from $150k to $100k (save $50k)
- **Total savings: ~$100k**

**Rationale:** By Tranche C, you should have better unit economics and proven channels. Focus spending on highest-ROI channels.

### 3. **Engineer Hiring - Delay or Phase In** (Save: ~$50k-100k)
**Current:** 2 engineers for full 12 months in Tranche C = $264,000
**Recommendation:**
- Option A: Hire second engineer 3 months later (save ~$66k)
- Option B: Keep team at 2 engineers but delay Tranche C expansion
- **Save ~$50k-100k**

**Rationale:** If product-market fit is proven, you may need fewer engineers for scaling vs. building.

### 4. **Sales Team - Optimize Hiring Timeline** (Save: ~$40k-80k)
**Current:** 2 sales people for full 12 months in Tranche C = $176,000
**Recommendation:**
- Hire second sales person 3-4 months into Tranche C
- **Save ~$40k-60k**

**Rationale:** Validate first sales hire's productivity before doubling the team.

### 5. **R&D - Make More Variable** (Save: ~$20k-30k)
**Current:** $50,000 fixed in Tranche C
**Recommendation:**
- Reduce to $35,000-$40,000
- **Save ~$10k-15k**

**Rationale:** By Tranche C, core product should be built. Focus on optimization vs. new features.

### 6. **G&A - Optimize Office/Misc** (Save: ~$10k-20k)
**Current:** $70,000 in Tranche C ($40k Legal + $30k Office)
**Recommendation:**
- Reduce Office & Misc from $30k to $20k (save $10k)
- **Save ~$10k-20k**

**Rationale:** Remote-first approach can reduce office costs. Legal should scale with contracts, not tranche.

## Recommended Priority Adjustments

### **Conservative Plan (Target: ~$400k savings)**
1. Founder pay: Phase Stage 3 (save $130k)
2. S&M: Reduce Tranche C spend (save $100k)
3. Sales: Delay second hire 3 months (save $44k)
4. R&D: Reduce to $35k (save $15k)
5. G&A: Reduce office spend (save $10k)
6. Engineer: Delay 2nd engineer 2 months (save $44k)
**Total Estimated Savings: ~$343k**

### **Aggressive Plan (Target: ~$600k savings)**
1. Founder pay: Delay Stage 3 to month 6 (save $130k)
2. S&M: Reduce Tranche C spend more aggressively (save $150k)
3. Sales: Delay second hire 4 months (save $59k)
4. Engineer: Delay second engineer 4 months (save $88k)
5. R&D: Reduce to $30k (save $20k)
6. G&A: Reduce office spend (save $15k)
**Total Estimated Savings: ~$463k**

### **Most Realistic Plan (Target: ~$500k savings)**
1. Founder pay: Start Stage 3 at month 6 of Tranche C (save $130k)
2. S&M: Moderate reduction in Tranche C (save $100k)
3. Sales: Delay second hire 3 months (save $44k)
4. Engineer: Delay second engineer 3 months (save $66k)
5. R&D: Reduce to $40k (save $10k)
6. G&A: Reduce office spend (save $10k)
**Total Estimated Savings: ~$360k**

## Additional Considerations

### What NOT to Cut:
- **Legal & Admin:** You'll need this for contracts, compliance
- **Infrastructure:** Essential for scaling
- **Core team (Tranche A/B):** These are critical for product development

### What to Consider:
- **Revenue assumptions:** If revenue comes in faster, you may not need all the capital
- **Founder pay philosophy:** Some investors prefer lower founder pay to show capital efficiency
- **Milestone-based triggers:** Consider making more costs milestone-dependent vs. tranche-dependent

## Implementation in Excel

These adjustments can be made in the `generate_model.py` file by:
1. Modifying Tranche C founder formula to phase in Stage 3 pay
2. Reducing S&M values in the data array
3. Adjusting hiring timelines in formulas
4. Reducing fixed R&D and G&A amounts

