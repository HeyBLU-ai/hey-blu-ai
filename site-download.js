(function () {
    var cfg = window.HEYBLU_SITE;
    if (!cfg) return;

    var link = document.getElementById('app-store-download-link');
    var note = document.getElementById('app-download-beta-note');
    var url = cfg.APP_STORE_LIVE ? cfg.DOWNLOAD_URL_LIVE : cfg.DOWNLOAD_URL_BETA;

    if (link) {
        link.href = url;
        if (/^https?:\/\//i.test(url)) {
            link.setAttribute('target', '_blank');
            link.setAttribute('rel', 'noopener noreferrer');
        } else {
            link.removeAttribute('target');
            link.removeAttribute('rel');
        }
    }

    if (note) {
        if (cfg.APP_STORE_LIVE) {
            note.classList.add('hidden');
        } else {
            note.textContent = cfg.BETA_SUBTEXT || '';
            note.classList.remove('hidden');
        }
    }
})();
