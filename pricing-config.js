/**
 * HeyBLU subscription — single source for public website pricing copy.
 * Keep in sync with App Store Connect / RevenueCat when showPublicAmounts is true.
 * App paywall shows live store prices (may differ during App Store price tests).
 */
window.HEYBLU_PRICING = {
    trialDays: 14,
    /** Set true again after the App Store price A/B ends and you pick a winner. */
    showPublicAmounts: false,
    monthlyUSD: 4.99,
    annualUSD: 49.99,
    /** Empty when showPublicAmounts is false — hides “Launch pricing” badges. */
    launchRateLabel: '',
    currencySymbol: '$',

    /** Rounded whole-number annual savings vs paying monthly for 12 months. */
    annualSavingsPercent: function () {
        var monthly = this.monthlyUSD * 12;
        if (monthly <= 0) return 0;
        return Math.round((1 - this.annualUSD / monthly) * 100);
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
