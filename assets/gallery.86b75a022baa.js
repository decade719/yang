(() => {
  'use strict';
  const gallery = document.querySelector('.photo-gallery');
  if (!gallery) return;
  const stage = gallery.querySelector('.photo-stage');
  const slides = Array.from(gallery.querySelectorAll('.photo-slide'));
  const toggle = gallery.querySelector('.gallery-toggle');
  const status = gallery.querySelector('.gallery-status');
  const globalMotion = document.querySelector('.motion-toggle');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const coarse = matchMedia('(pointer: coarse)');
  if (slides.length < 2) return;

  function shuffle(items) {
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [items[i], items[j]] = [items[j], items[i]];
    }
    return items;
  }
  // Keep a complete shuffled deck so every photo appears before the next cycle.
  const deck = [0, ...shuffle(slides.slice(1).map((_, i) => i + 1))];
  let timer = 0, inView = false, hovering = false, focused = false;
  let userPaused = false, busy = false, touch = null, turns = 0, ignoreClicksUntil = 0;
  const pending = new Map();
  const motionStopped = () => reduced.matches || globalMotion?.getAttribute('aria-pressed') === 'true';
  function canPlay() { return inView && !document.hidden && !userPaused && !hovering && !focused && !busy && !motionStopped(); }

  function updateTimer() {
    clearTimeout(timer); timer = 0;
    const paused = userPaused || motionStopped();
    toggle.setAttribute('aria-pressed', String(paused));
    toggle.setAttribute('aria-label', paused ? '播放照片自动切换' : '暂停照片自动切换');
    toggle.firstElementChild.textContent = paused ? '▷' : 'Ⅱ';
    toggle.disabled = motionStopped();
    gallery.classList.toggle('motion-still', motionStopped() || document.hidden || !inView);
    if (canPlay()) timer = setTimeout(() => { timer = 0; turn(1, false); }, 5600 + Math.random() * 2200);
  }

  function load(index) {
    if (pending.has(index)) return pending.get(index);
    const slide = slides[index], original = slide.querySelector('.photo-original');
    const source = original.dataset.src || original.getAttribute('src');
    const promise = new Promise((resolve, reject) => {
      const preload = new Image();
      preload.onload = async () => {
        try { if (preload.decode) await preload.decode(); } catch { /* Display the loaded image even if decode is unavailable. */ }
        original.src = source; delete original.dataset.src;
        resolve();
      };
      preload.onerror = () => { pending.delete(index); reject(new Error('照片暂时没有加载，请稍后再试。')); };
      preload.src = source;
    });
    pending.set(index, promise); return promise;
  }

  function arrange() {
    deck.forEach((index, slot) => {
      const slide = slides[index];
      slide.dataset.slot = String(slot);
      slide.classList.toggle('is-active', slot === 0);
      slide.querySelector('.photo-pick').setAttribute('aria-pressed', String(slot === 0));
    });
    gallery.dataset.layout = String(Math.floor(Math.abs(turns) / 2) % 2);
    gallery.querySelector('.gallery-current').textContent = String(deck[0] + 1).padStart(2, '0');
  }
  function warmDeck() {
    deck.forEach(index => load(index).catch(() => {}));
  }

  async function turn(direction = 1, manual = true, target = null) {
    if (busy) return;
    const next = target ?? (direction > 0 ? deck[1] : deck[deck.length - 1]);
    if (next === deck[0]) return;
    busy = true;
    clearTimeout(timer); timer = 0;
    try {
      await load(next);
      // A slow image load must not restart motion after the user pauses.
      if (!manual && (!inView || document.hidden || userPaused || hovering || focused || motionStopped())) return;
      const offset = deck.indexOf(next);
      deck.push(...deck.splice(0, offset));
      turns += direction;
      if (target === null && direction > 0 && turns > 0 && turns % slides.length === 0) {
        deck.splice(1, deck.length - 1, ...shuffle(deck.slice(1)));
      }
      arrange();
      if (manual) status.textContent = `第 ${next + 1} 张，共 ${slides.length} 张：${slides[next].querySelector('.photo-original').alt}`;
      warmDeck();
    } catch (error) { status.textContent = error.message; }
    finally { busy = false; updateTimer(); }
  }

  gallery.querySelector('.gallery-prev').addEventListener('click', () => turn(-1));
  gallery.querySelector('.gallery-next').addEventListener('click', () => turn(1));
  slides.forEach((slide, index) => slide.querySelector('.photo-pick').addEventListener('click', () => {
    if (Date.now() >= ignoreClicksUntil) turn(1, true, index);
  }));
  toggle.addEventListener('click', () => { userPaused = !userPaused; if (!userPaused) focused = false; updateTimer(); });
  gallery.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    turn(event.key === 'ArrowLeft' ? -1 : 1, true, event.key === 'Home' ? 0 : event.key === 'End' ? slides.length - 1 : null);
  });
  stage.addEventListener('pointerenter', event => { if (event.pointerType !== 'touch' && !coarse.matches) { hovering = true; updateTimer(); } });
  stage.addEventListener('pointerleave', () => { hovering = false; updateTimer(); });
  gallery.addEventListener('focusin', () => { focused = true; updateTimer(); });
  gallery.addEventListener('focusout', event => { if (!gallery.contains(event.relatedTarget)) { focused = false; updateTimer(); } });
  stage.addEventListener('pointerdown', event => { if (event.pointerType === 'touch') touch = { x: event.clientX, y: event.clientY, id: event.pointerId }; }, { passive: true });
  stage.addEventListener('pointerup', event => {
    if (!touch || touch.id !== event.pointerId) return;
    const dx = event.clientX - touch.x, dy = event.clientY - touch.y; touch = null;
    if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.3) { ignoreClicksUntil = Date.now() + 450; turn(dx < 0 ? 1 : -1); }
  }, { passive: true });
  stage.addEventListener('pointercancel', () => { touch = null; }, { passive: true });
  document.addEventListener('visibilitychange', updateTimer);
  reduced.addEventListener('change', updateTimer);
  if (globalMotion) new MutationObserver(updateTimer).observe(globalMotion, { attributes: true, attributeFilter: ['aria-pressed'] });
  new IntersectionObserver(entries => {
    inView = entries[0].isIntersecting;
    if (inView) { load(deck[0]).catch(error => { status.textContent = error.message; }); warmDeck(); }
    updateTimer();
  }, { threshold: .2, rootMargin: '0px 0px 80px 0px' }).observe(stage);
  arrange();
  updateTimer();
})();
