/**
 * HeyBLU subscription — single source for public website pricing copy.
 * Keep in sync with App Store Connect / RevenueCat when showPublicAmounts is true.
 * App paywall shows live store prices (may differ during App Store price tests).
 *
 * App Store A/B test settled Sep 2026 — winner: $12.99/mo, $79.99/yr.
 */
window.HEYBLU_PRICING = {
    trialDays: 14,
    /** Set false again if a future App Store price test needs $ hidden site-wide. */
    showPublicAmounts: true,
    monthlyUSD: 12.99,
    annualUSD: 79.99,
    /** Empty hides the "Launch pricing" badges. */
    launchRateLabel: 'Launch pricing',
    currencySymbol: '$',

    /**
     * Annual savings badge. In-app paywall messaging says "Save 50%" — use that
     * exact figure for consistency instead of the raw computed ~49% (rounding).
     */
    annualSavingsPercent: function () {
        return 50;
    },

    formatUSD: function (amount) {
        return this.currencySymbol + amount.toFixed(2);
    },

    annualPerMonthUSD: function () {
        return this.annualUSD / 12;
    },

    /** Teaser / soft public line when dollar amounts must stay off the site. */
    softTrialLine: function () {
        return 'HeyBLU — ' + this.trialDays + '-day free trial, then monthly or annual.';
    }
};
