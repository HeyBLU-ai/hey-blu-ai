/**
 * Homepage pricing teaser — reads HEYBLU_PRICING from pricing-config.js.
 */
(function () {
    var cfg = window.HEYBLU_PRICING;
    if (!cfg) return;

    var line = document.getElementById('pricing-teaser-line');
    var badge = document.getElementById('pricing-teaser-badge');

    if (line) {
        line.textContent =
            'HeyBLU — ' + cfg.trialDays + '-day free trial, then ' +
            cfg.formatUSD(cfg.monthlyUSD) + '/mo or ' + cfg.formatUSD(cfg.annualUSD) + '/yr.';
    }
    if (badge && cfg.launchRateLabel) {
        badge.textContent = cfg.launchRateLabel;
    }
})();
