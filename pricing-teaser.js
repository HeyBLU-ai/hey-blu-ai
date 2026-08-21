/**
 * Homepage pricing teaser — reads HEYBLU_PRICING from pricing-config.js.
 */
(function () {
    var cfg = window.HEYBLU_PRICING;
    if (!cfg) return;

    var line = document.getElementById('pricing-teaser-line');
    var badge = document.getElementById('pricing-teaser-badge');

    if (line) {
        if (cfg.showPublicAmounts) {
            line.textContent =
                'HeyBLU — ' + cfg.trialDays + '-day free trial, then ' +
                cfg.formatUSD(cfg.monthlyUSD) + '/mo or ' + cfg.formatUSD(cfg.annualUSD) + '/yr.';
        } else {
            line.textContent = cfg.softTrialLine
                ? cfg.softTrialLine()
                : ('HeyBLU — ' + cfg.trialDays + '-day free trial, then monthly or annual.');
        }
    }
    if (badge) {
        if (cfg.showPublicAmounts && cfg.launchRateLabel) {
            badge.textContent = cfg.launchRateLabel;
            badge.classList.remove('hidden');
        } else {
            badge.classList.add('hidden');
            badge.setAttribute('hidden', '');
        }
    }
})();
