// Quiet fade-ins, the reading bar along the top, and copy buttons.
(() => {
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
  }, { threshold: 0.12 });
  document.querySelectorAll('.fade').forEach((el) => io.observe(el));

  const bar = document.querySelector('.reading span');
  if (bar) {
    const paint = () => {
      const max = document.documentElement.scrollHeight - innerHeight;
      bar.style.width = (max > 0 ? Math.min(100, (scrollY / max) * 100) : 0) + '%';
    };
    addEventListener('scroll', paint, { passive: true });
    addEventListener('resize', paint);
    paint();
  }

  document.querySelectorAll('[data-copy]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const text = btn.getAttribute('data-copy') || btn.parentElement.querySelector('code').innerText;
      try { await navigator.clipboard.writeText(text.trim()); } catch (e) { return; }
      const was = btn.textContent;
      btn.textContent = 'Copied';
      btn.classList.add('done');
      setTimeout(() => { btn.textContent = was; btn.classList.remove('done'); }, 1500);
    });
  });
})();
