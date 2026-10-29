(() => {
  'use strict';
  const gallery = document.querySelector('.photo-gallery');
  if (!gallery) return;
  const stage = gallery.querySelector('.photo-stage');
  const slides = Array.from(gallery.querySelectorAll('.photo-slide'));
  const thumbs = Array.from(gallery.querySelectorAll('.gallery-thumb'));
  const toggle = gallery.querySelector('.gallery-toggle');
  const status = gallery.querySelector('.gallery-status');
  const globalMotion = document.querySelector('.motion-toggle');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const coarse = matchMedia('(pointer: coarse)');
  if (slides.length < 2) return;
  let current = 0, requested = 0, timer = 0, inView = false, hovering = false, focused = false, userPaused = false, touch = null;
  const pending = new Map();
  const normal = index => (index + slides.length) % slides.length;
  const motionStopped = () => reduced.matches || globalMotion?.getAttribute('aria-pressed') === 'true';
  function canPlay() { return inView && !document.hidden && !userPaused && !hovering && !focused && !motionStopped(); }
  function updateTimer() {
    clearTimeout(timer); timer = 0;
    const paused = userPaused || motionStopped();
    toggle.setAttribute('aria-pressed', String(paused));
    toggle.setAttribute('aria-label', paused ? '播放照片自动切换' : '暂停照片自动切换');
    toggle.firstElementChild.textContent = paused ? '▷' : 'Ⅱ';
    toggle.disabled = motionStopped();
    if (canPlay()) timer = setTimeout(() => { timer = 0; show(current + 1, false); }, 6500);
  }
  function load(index) {
    index = normal(index);
    if (pending.has(index)) return pending.get(index);
    const slide = slides[index], original = slide.querySelector('.photo-original');
    const source = original.dataset.src || original.getAttribute('src');
    const promise = new Promise((resolve, reject) => {
      const preload = new Image();
      preload.onload = async () => {
        try { if (preload.decode) await preload.decode(); } catch { /* A loaded image can still be displayed. */ }
        original.src = source; delete original.dataset.src;
        const atmosphere = slide.querySelector('.photo-atmosphere');
        if (atmosphere.dataset.src) { atmosphere.src = atmosphere.dataset.src; delete atmosphere.dataset.src; }
        resolve();
      };
      preload.onerror = () => { pending.delete(index); reject(new Error('照片暂时没有加载，请稍后再试。')); };
      preload.src = source;
    });
    pending.set(index, promise); return promise;
  }
  async function show(index, manual = true) {
    const next = normal(index), ticket = ++requested;
    clearTimeout(timer); timer = 0;
    try {
      await load(next);
      if (ticket !== requested) return;
      slides.forEach((slide, i) => { slide.classList.toggle('is-active', i === next); slide.setAttribute('aria-hidden', String(i !== next)); });
      thumbs.forEach((thumb, i) => { thumb.classList.toggle('is-current', i === next); thumb.setAttribute('aria-pressed', String(i === next)); });
      current = next; gallery.querySelector('.gallery-current').textContent = String(next + 1).padStart(2, '0');
      if (manual) status.textContent = `第 ${next + 1} 张，共 ${slides.length} 张：${slides[next].querySelector('.photo-original').alt}`;
      load(current + 1).catch(() => {});
    } catch (error) { if (ticket === requested) status.textContent = error.message; }
    finally { if (ticket === requested) updateTimer(); }
  }
  gallery.querySelector('.gallery-prev').addEventListener('click', () => show(current - 1));
  gallery.querySelector('.gallery-next').addEventListener('click', () => show(current + 1));
  thumbs.forEach((thumb, index) => thumb.addEventListener('click', () => show(index)));
  toggle.addEventListener('click', () => { userPaused = !userPaused; updateTimer(); });
  gallery.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    show(event.key === 'Home' ? 0 : event.key === 'End' ? slides.length - 1 : current + (event.key === 'ArrowLeft' ? -1 : 1));
  });
  stage.addEventListener('pointerenter', event => { if (event.pointerType !== 'touch' && !coarse.matches) { hovering = true; updateTimer(); } });
  stage.addEventListener('pointerleave', () => { hovering = false; updateTimer(); });
  gallery.addEventListener('focusin', () => { focused = true; updateTimer(); });
  gallery.addEventListener('focusout', event => { if (!gallery.contains(event.relatedTarget)) { focused = false; updateTimer(); } });
  stage.addEventListener('pointerdown', event => { if (event.pointerType === 'touch') touch = { x: event.clientX, y: event.clientY, id: event.pointerId }; }, { passive: true });
  stage.addEventListener('pointerup', event => {
    if (!touch || touch.id !== event.pointerId) return;
    const dx = event.clientX - touch.x, dy = event.clientY - touch.y; touch = null;
    if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.3) show(current + (dx < 0 ? 1 : -1));
  }, { passive: true });
  stage.addEventListener('pointercancel', () => { touch = null; }, { passive: true });
  document.addEventListener('visibilitychange', updateTimer);
  reduced.addEventListener('change', updateTimer);
  if (globalMotion) new MutationObserver(updateTimer).observe(globalMotion, { attributes: true, attributeFilter: ['aria-pressed'] });
  new IntersectionObserver(entries => {
    inView = entries[0].isIntersecting;
    if (inView) { load(current).catch(error => { status.textContent = error.message; }); load(current + 1).catch(() => {}); }
    updateTimer();
  }, { threshold: .2, rootMargin: '0px 0px 80px 0px' }).observe(stage);
  updateTimer();
})();
