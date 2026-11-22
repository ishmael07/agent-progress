// The live demo on the landing page: a faithful replay of Agent Progress in a
// terminal. The progress and "time left" use the same math as the plugin.
(() => {
  const root = document.getElementById('demo');
  if (!root) return;

  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const $ = (sel) => root.querySelector(sel);
  const body = $('.term-body');
  const logEl = $('.log');
  const bandEl = $('.band');
  const paneCol = $('.pane-col');
  const paneEl = $('.pane');
  const toast = $('.toast');
  const cursor = $('.cursor');

  // ---- the story -------------------------------------------------------
  const ASK = 'build tic tac toe with an unbeatable computer, sounds and a dark mode';
  const AGENTS = [
    {
      id: 'ai', label: 'Agent 1', title: 'Build an unbeatable computer opponent', start: 3.0,
      purpose: 'Claude is teaching the computer to play perfectly, so it never loses a game.',
      steps: ['Read the game code', 'Write the computer player', 'Test every possible game'],
      durs: [5, 5.5, 6],
    },
    {
      id: 'snd', label: 'Agent 2', title: 'Add sound effects', start: 3.2,
      purpose: 'Claude is adding small sounds for moves and wins, so the game feels alive.',
      steps: ['Plan the sounds', 'Make the sounds', 'Add a mute button'],
      durs: [3.5, 4, 4],
    },
    {
      id: 'ui', label: 'Agent 3', title: 'Add animations and dark mode', start: 3.4,
      purpose: 'Claude is giving the board smooth animations and a dark theme you can switch on.',
      steps: ['Look at the current styles', 'Add the animations', 'Add dark mode', 'Check both themes'],
      durs: [3, 3.5, 3.5, 3.5],
    },
  ];
  const END = Math.max(...AGENTS.map(a => a.start + a.durs.reduce((s, d) => s + d, 0)));
  const LOOP = END + 7;
  // the demo opens a row by itself once, so people see that rows open
  const AUTO_OPEN = { at: 8.2, close: 13.6, id: 'ai' };

  const open = new Set();
  let userTouched = false;

  // ---- the plugin's math -------------------------------------------------
  function state(a, t) {
    const e = t - a.start;
    if (e < 0) return null;
    const total = a.steps.length;
    let acc = 0, done = 0;
    while (done < total && e >= acc + a.durs[done]) { acc += a.durs[done]; done++; }
    const finished = done >= total;
    const stepAt = acc;
    const perStep = done > 0 ? stepAt / done : undefined;
    const into = e - stepAt;
    let value = done / total;
    if (!finished) {
      const frac = perStep ? Math.min(0.9, into / perStep) : 0.85 * (1 - Math.exp(-into / 40));
      value = Math.min(0.99, value + frac / total);
    }
    const eta = !finished && perStep ? Math.max(0, (total - done) * perStep - into) : undefined;
    return { e, done, total, finished, value: finished ? 1 : value, eta, took: acc, current: Math.min(done, total - 1) };
  }

  const dur = (s) => {
    s = Math.max(0, Math.round(s));
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  };
  const left = (eta) => (eta === undefined ? '' : eta < 1.5 ? 'finishing up' : `~${dur(eta)} left`);
  const fit = (s, w) => (s.length <= w ? s.padEnd(w) : s.slice(0, Math.max(0, w - 1)) + '…');
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';

  // Drawn as solid shapes, not block characters: browser fonts leave hairline
  // gaps between blocks that a terminal doesn't.
  function bar(value, width, color, moving) {
    const pct = (Math.max(0, Math.min(1, value)) * 100).toFixed(2);
    return `<span class="pbar" style="width:${width}ch"><span class="pfill ${color}${moving && !reduced ? ' moving' : ''}" style="width:${pct}%"></span></span>`;
  }

  // ---- measuring the text grid -------------------------------------------
  let charW = 8.1;
  function measure() {
    const probe = document.createElement('span');
    probe.textContent = 'x'.repeat(50);
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre';
    logEl.appendChild(probe);
    charW = probe.getBoundingClientRect().width / 50 || 8.1;
    probe.remove();
    body.classList.toggle('split', root.clientWidth >= 860);
  }
  const colsOf = (el) => Math.max(30, Math.floor(el.clientWidth / charW));

  // ---- drawing -----------------------------------------------------------
  const LINES = [
    { at: 0.4, html: () => `<span class="c-dim">› </span><span class="you">${esc(typed)}</span>` },
    { at: 2.3, html: () => `<span class="dot">●</span> I'll split this into 3 agents that work at the same time.` },
    {
      at: 2.9, html: () => `<span class="dot">●</span> <b>3 background agents launched</b>\n` +
        AGENTS.map((a, i) => `<span class="tree">  ${i === AGENTS.length - 1 ? '└' : '├'} </span><b>${esc(a.title)}</b>`).join('\n'),
    },
    { at: END + 0.8, html: () => `<span class="dot">●</span> All 3 agents finished. Open <b>index.html</b> to play.` },
  ];
  let typed = '';
  const lineEls = LINES.map(() => {
    const d = document.createElement('div');
    d.className = 'ln';
    logEl.appendChild(d);
    return d;
  });

  function drawLog(t) {
    typed = ASK.slice(0, Math.max(0, Math.floor((t - 0.4) / 1.6 * ASK.length)));
    LINES.forEach((l, i) => {
      const on = t >= l.at;
      lineEls[i].classList.toggle('in', on);
      if (on) lineEls[i].innerHTML = l.html();
    });
  }

  function rightText(a, s) {
    if (s.finished) return `Done in ${dur(s.took)}`;
    const step = `Step ${s.current + 1} of ${s.total} · ${a.steps[s.current]}`;
    return `${step} · ${left(s.eta) || dur(s.e)}`;
  }

  function overall(t) {
    const ss = AGENTS.map(a => state(a, t)).filter(Boolean);
    if (!ss.length) return null;
    const running = ss.filter(s => !s.finished);
    const value = Math.min(running.length ? 0.99 : 1, ss.reduce((v, s) => v + s.value, 0) / ss.length);
    const etas = running.map(s => s.eta).filter(x => x !== undefined);
    return { value, running: running.length, total: ss.length, eta: running.length && etas.length ? Math.max(...etas) : undefined };
  }

  function drawBand(t, ms) {
    const cols = colsOf(bandEl);
    const all = overall(t);
    const visible = AGENTS.filter(a => { const s = state(a, t); return s && (!s.finished || t - (a.start + s.took) < 30); });
    if (!all || !visible.length || t > END + 4.5) { bandEl.innerHTML = ''; return; }
    const head = (all.running ? `${all.running} agents working · ${Math.round(all.value * 100)}%` : 'All done') +
      (all.eta !== undefined ? ` · ${left(all.eta)}` : '');
    const barW = cols >= 110 ? 22 : cols >= 80 ? 14 : 10;
    const titleW = Math.min(34, Math.max(12, Math.floor(cols * 0.27)));
    const restW = Math.max(0, cols - 4 - 9 - titleW - 2 - barW - 6 - 2);
    let html = `<div class="head" data-open-table>${esc(head)}</div>`;
    for (const a of visible) {
      const s = state(a, t);
      const isOpen = open.has(a.id);
      const g = s.finished ? '<span class="c-green">✔</span>' : `<span class="c-blue">${SPIN[Math.floor(ms / 100) % 10]}</span>`;
      const title = `<span class="${s.finished ? 'c-dim' : 'c-bold'}">${esc(fit(a.title, titleW))}</span>`;
      const pct = `<span class="${s.finished ? 'c-dim' : ''}">${String(Math.round(s.value * 100) + '%').padStart(5)}</span>`;
      html += `<div class="r${isOpen ? ' hot' : ''}" data-id="${a.id}">${g} <span class="c-dim">${a.label}</span>  ${title}  ${bar(s.value, barW, s.finished ? 'c-green' : 'c-blue', !s.finished, ms)}${pct}  <span class="c-dim">${esc(fit(rightText(a, s), restW))}</span></div>`;
      if (isOpen) {
        html += `<div class="sub"><i>${esc(a.purpose)}</i></div>`;
        html += `<div class="sub">${a.steps.map((st, i) => {
          const g2 = i < s.done || s.finished ? '<span class="c-green">✔</span>' : i === s.current ? '<span class="c-blue">›</span>' : '<span class="c-faint">○</span>';
          return `${g2} <span class="${i === s.current && !s.finished ? '' : 'c-dim'}">${esc(st)}</span>`;
        }).join('   ')}</div>`;
      }
    }
    bandEl.innerHTML = html;
  }

  function drawPane(t, ms) {
    if (!body.classList.contains('split')) return;
    const cols = colsOf(paneEl);
    const started = AGENTS.filter(a => state(a, t));
    const working = started.filter(a => !state(a, t).finished).length;
    const done = started.length - working;
    const counts = [working ? `${working} working` : '', done ? `${done} done` : ''].filter(Boolean).join(' · ') || 'idle';
    let html = `<div class="pane-h">Agents<span>${counts}</span></div><div class="rule"></div>`;
    if (!started.length) {
      html += `<div class="c-bold">No agents running</div><div class="c-dim">Each one shows up here the moment it starts.</div>`;
    }
    const barW = Math.max(10, Math.min(26, cols - 14));
    for (const a of started) {
      const s = state(a, t);
      const isOpen = open.has(a.id);
      const g = s.finished ? '<span class="c-green">✔</span>' : `<span class="c-blue">${SPIN[Math.floor(ms / 100) % 10]}</span>`;
      const time = s.finished ? dur(s.took) : left(s.eta) || dur(s.e);
      const now = s.finished ? `Done in ${dur(s.took)}` : `Step ${s.current + 1} of ${s.total} · ${a.steps[s.current]}`;
      html += `<div class="card"><div class="r${isOpen ? ' hot' : ''}" data-id="${a.id}"><span class="t"><span class="c-dim">${isOpen ? '▾' : '▸'}</span> ${g} <span class="c-dim">${a.label} · </span><span class="${s.finished ? 'c-dim' : 'c-bold'}">${esc(a.title)}</span></span><span class="c-dim">${time}</span></div>` +
        `<div class="line2">${bar(s.value, barW, s.finished ? 'c-green' : 'c-blue', !s.finished, ms)}<span class="${s.finished ? 'c-dim' : ''}">${String(Math.round(s.value * 100) + '%').padStart(5)}</span>  <span class="c-dim">${esc(now)}</span></div>`;
      if (isOpen) {
        html += `<div class="detail"><i>${esc(a.purpose)}</i></div>` + a.steps.map((st, i) => {
          const g2 = i < s.done || s.finished ? '<span class="c-green">✔</span>' : i === s.current ? '<span class="c-blue">›</span>' : '<span class="c-faint">○</span>';
          return `<div class="detail">${g2} <span class="${i === s.current && !s.finished ? 'c-bold' : 'c-dim'}">${esc(st)}</span></div>`;
        }).join('');
      }
      html += `</div>`;
    }
    const all = overall(t);
    if (all && started.length > 1) {
      html += `<div class="card" style="border:1px solid #3a3a40;border-radius:8px;padding:6px 10px;margin-top:6px;white-space:pre;overflow:hidden"><span class="c-bold">Overall </span>${bar(all.value, Math.max(8, Math.min(20, cols - 30)), 'c-green', all.running > 0, ms)}<span class="c-bold">${String(Math.round(all.value * 100) + '%').padStart(5)}</span><span class="c-dim">${all.eta !== undefined ? '  ' + left(all.eta) : ''}</span></div>`;
    }
    paneEl.innerHTML = html;
  }

  // ---- the automatic click ----------------------------------------------
  let autoState = 0;
  function rowEl(id) {
    const inPane = body.classList.contains('split') ? paneEl.querySelector(`[data-id="${id}"]`) : null;
    return inPane || bandEl.querySelector(`[data-id="${id}"]`);
  }
  function fakeClick(id) {
    const el = rowEl(id);
    if (!el) return;
    const wr = root.getBoundingClientRect(), r = el.getBoundingClientRect();
    const x = r.left - wr.left + Math.min(220, r.width * 0.35), y = r.top - wr.top + r.height / 2;
    cursor.classList.add('on');
    cursor.style.transform = `translate(${x}px, ${y}px)`;
    setTimeout(() => {
      const rip = document.createElement('div');
      rip.className = 'ripple';
      rip.style.left = `${x + 2}px`; rip.style.top = `${y + 2}px`;
      root.appendChild(rip);
      setTimeout(() => rip.remove(), 700);
      if (open.has(id)) open.delete(id); else open.add(id);
      setTimeout(() => cursor.classList.remove('on'), 700);
    }, 950);
  }
  function auto(t) {
    if (userTouched || reduced) return;
    if (autoState === 0 && t >= AUTO_OPEN.at) { autoState = 1; fakeClick(AUTO_OPEN.id); }
    if (autoState === 1 && t >= AUTO_OPEN.close) { autoState = 2; fakeClick(AUTO_OPEN.id); }
  }

  // ---- input -------------------------------------------------------------
  root.addEventListener('click', (e) => {
    const r = e.target.closest('[data-id]');
    if (!r) return;
    userTouched = true;
    cursor.classList.remove('on');
    const id = r.getAttribute('data-id');
    if (open.has(id)) open.delete(id); else open.add(id);
  });

  // ---- the loop ----------------------------------------------------------
  let t0 = performance.now();
  let visible = true;
  let toastShown = false;
  new IntersectionObserver(([e]) => {
    if (e.isIntersecting && !visible) t0 = performance.now(); // start the story when it comes into view
    visible = e.isIntersecting;
  }, { threshold: 0.25 }).observe(root);

  let last = 0;
  function frame(now) {
    requestAnimationFrame(frame);
    if (!visible || now - last < 90) return;
    last = now;
    let t = (now - t0) / 1000;
    if (t > LOOP) { t0 = now; t = 0; autoState = 0; toastShown = false; if (!userTouched) open.clear(); }
    drawLog(t);
    drawBand(t, now);
    drawPane(t, now);
    auto(t);
    const showToast = t > END + 0.3 && t < END + 5;
    if (showToast !== toastShown) {
      toastShown = showToast;
      toast.textContent = `3 agents done · ${dur(END - AGENTS[0].start)}`;
      toast.classList.toggle('on', showToast);
    }
  }

  measure();
  addEventListener('resize', measure);
  requestAnimationFrame(frame);
})();
