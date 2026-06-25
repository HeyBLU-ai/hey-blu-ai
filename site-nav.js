(function () {
    var menuBtn = document.getElementById('menu-btn');
    var mobileMenu = document.getElementById('mobile-menu');
    if (!menuBtn || !mobileMenu) return;

    menuBtn.addEventListener('click', function () {
        var hidden = mobileMenu.classList.toggle('hidden');
        menuBtn.setAttribute('aria-expanded', hidden ? 'false' : 'true');
    });

    mobileMenu.querySelectorAll('a').forEach(function (anchor) {
        anchor.addEventListener('click', function () {
            mobileMenu.classList.add('hidden');
            menuBtn.setAttribute('aria-expanded', 'false');
        });
    });
})();
