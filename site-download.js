(function () {
    var cfg = window.HEYBLU_SITE;
    if (!cfg) return;

    // Every page using this script shares one DOWNLOAD_URL_LIVE, which hardcodes
    // ct=Home%20Page. Without this override, App Store Connect's own campaign
    // attribution reports installs from every page (including ad landing pages
    // like /home2) as "Home Page" traffic. Set window.HEYBLU_DOWNLOAD_CT on a
    // page (before this script loads) to give that page its own token.
    function withCampaignToken(baseUrl) {
        var ct = window.HEYBLU_DOWNLOAD_CT;
        if (!ct) return baseUrl;
        if (/[?&]ct=/.test(baseUrl)) {
            return baseUrl.replace(/([?&]ct=)[^&]*/, '$1' + encodeURIComponent(ct));
        }
        return baseUrl + (baseUrl.indexOf('?') >= 0 ? '&' : '?') + 'ct=' + encodeURIComponent(ct);
    }

    function appendUtm(baseUrl) {
        var utm = window.HEYBLU_DOWNLOAD_UTM;
        if (!utm) return baseUrl;
        var q = String(utm).replace(/^\?/, '');
        if (!q) return baseUrl;
        return baseUrl + (baseUrl.indexOf('?') >= 0 ? '&' : '?') + q;
    }

    var links = document.querySelectorAll('#app-store-download-link, a.app-store-download-link');
    var note = document.getElementById('app-download-beta-note');
    var url = appendUtm(withCampaignToken(cfg.APP_STORE_LIVE ? cfg.DOWNLOAD_URL_LIVE : cfg.DOWNLOAD_URL_BETA));

    links.forEach(function (link) {
        link.href = url;
        if (/^https?:\/\//i.test(url)) {
            link.setAttribute('target', '_blank');
            link.setAttribute('rel', 'noopener noreferrer');
        } else {
            link.removeAttribute('target');
            link.removeAttribute('rel');
        }
    });

    if (note) {
        if (cfg.APP_STORE_LIVE) {
            note.classList.add('hidden');
        } else {
            note.textContent = cfg.BETA_SUBTEXT || '';
            note.classList.remove('hidden');
        }
    }

    var tfInvite = document.getElementById('testflight-invite-link');
    if (tfInvite && cfg.DOWNLOAD_URL_BETA && /^https?:\/\//i.test(cfg.DOWNLOAD_URL_BETA)) {
        tfInvite.href = appendUtm(cfg.DOWNLOAD_URL_BETA);
    }
})();
