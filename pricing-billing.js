/**
 * Monthly / annual billing toggle for /pricing — reads HEYBLU_PRICING from pricing-config.js.
 */
(function () {
    var cfg = window.HEYBLU_PRICING;
    if (!cfg) return;

    var toggle = document.getElementById('pricing-billing-toggle');
    var knob = document.getElementById('pricing-toggle-knob');
    var labelMonthly = document.getElementById('pricing-label-monthly');
    var labelAnnual = document.getElementById('pricing-label-annual');
    var priceDisplay = document.getElementById('pro-price-display');
    var priceNote = document.getElementById('pro-price-note');
    var savingsBadge = document.getElementById('pricing-annual-savings');
    if (!toggle || !priceDisplay) return;

    var isAnnual = false;
    var savingsPct = cfg.annualSavingsPercent();

    if (savingsBadge && savingsPct > 0) {
        savingsBadge.textContent = 'Save ' + savingsPct + '%';
    }

    function setBilling(annual) {
        isAnnual = annual;
        toggle.setAttribute('aria-checked', annual ? 'true' : 'false');
        toggle.classList.toggle('bg-blue-600', annual);
        toggle.classList.toggle('bg-gray-200', !annual);
        if (knob) {
            knob.style.transform = annual ? 'translateX(1.5rem)' : 'translateX(0)';
        }
        if (labelMonthly) {
            labelMonthly.classList.toggle('text-gray-900', !annual);
            labelMonthly.classList.toggle('text-gray-500', annual);
        }
        if (labelAnnual) {
            labelAnnual.classList.toggle('text-gray-900', annual);
            labelAnnual.classList.toggle('text-gray-500', !annual);
        }
        if (annual) {
            var perMo = cfg.formatUSD(cfg.annualPerMonthUSD());
            priceDisplay.innerHTML = perMo + '<span class="text-lg font-semibold text-gray-600">/mo</span>';
            if (priceNote) {
                priceNote.textContent = 'Billed annually at ' + cfg.formatUSD(cfg.annualUSD);
            }
        } else {
            priceDisplay.innerHTML = cfg.formatUSD(cfg.monthlyUSD) + '<span class="text-lg font-semibold text-gray-600">/mo</span>';
            if (priceNote) priceNote.textContent = '';
        }
    }

    toggle.addEventListener('click', function () {
        setBilling(!isAnnual);
    });

    setBilling(false);
})();
