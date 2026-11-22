// Copy buttons, and the small live status line above the headline.
(() => {
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

  // The same line the plugin draws above the prompt, counting up on a loop.
  const live = document.querySelector('.live');
  if (!live) return;
  const who = live.querySelector('.live-who');
  const fill = live.querySelector('.live-bar i');
  const pct = live.querySelector('.live-pct');
  const left = live.querySelector('.live-left');
  const RUN = 24; // seconds the pretend batch takes

  const paint = (t) => {
    const p = Math.min(1, t / RUN);
    const working = p < 0.45 ? 3 : p < 0.7 ? 2 : p < 1 ? 1 : 0;
    who.textContent = working ? `Claude + ${working} agent${working > 1 ? 's' : ''} working` : 'All done';
    fill.style.width = (p * 100).toFixed(1) + '%';
    live.classList.toggle('is-done', p >= 1);
    pct.textContent = Math.floor(p * 100) + '%';
    left.textContent = p >= 1 ? `took ${RUN}s` : `~${Math.max(1, Math.ceil(RUN - t))}s left`;
  };

  if (matchMedia('(prefers-reduced-motion: reduce)').matches) { paint(RUN * 0.67); return; }
  let t = 0;
  // runs at 3x speed so a whole batch fits in about 8 seconds, then rests on "All done"
  setInterval(() => { t += 0.3; if (t > RUN + 9) t = 0; paint(Math.min(t, RUN)); }, 100);
  paint(0);
})();
