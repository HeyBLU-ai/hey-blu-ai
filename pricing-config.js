/**
 * HeyBLU Pro — single source for public website pricing copy.
 * Keep in sync with App Store Connect / RevenueCat. App paywall shows live store prices.
 */
window.HEYBLU_PRICING = {
    trialDays: 14,
    monthlyUSD: 4.99,
    annualUSD: 49.99,
    launchRateLabel: 'Launch pricing',
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
    }
};
