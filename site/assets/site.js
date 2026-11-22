// Reveal on scroll, the hero's word-by-word entrance, and copy buttons.
(() => {
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
  }, { threshold: 0.15, rootMargin: '0px 0px -40px 0px' });
  document.querySelectorAll('.reveal').forEach((el) => io.observe(el));

  const hero = document.querySelector('.hero');
  if (hero) {
    hero.querySelectorAll('[data-words]').forEach((el) => {
      let i = 0;
      el.innerHTML = el.innerHTML.replace(/(<[^>]+>)|([^\s<]+)/g, (m, tag, word) =>
        tag ? tag : `<span class="w" style="transition-delay:${(i++ * 0.06).toFixed(2)}s">${word}</span>`);
    });
    requestAnimationFrame(() => requestAnimationFrame(() => hero.classList.add('in')));
  }

  document.querySelectorAll('[data-copy]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const text = btn.getAttribute('data-copy') || btn.parentElement.querySelector('code').innerText;
      try { await navigator.clipboard.writeText(text.trim()); } catch (e) { return; }
      const was = btn.textContent;
      btn.textContent = 'Copied';
      btn.classList.add('done');
      setTimeout(() => { btn.textContent = was; btn.classList.remove('done'); }, 1600);
    });
  });
})();
