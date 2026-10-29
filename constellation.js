(() => {
  'use strict';
  const canvas = document.querySelector('#constellation-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) return;
  const motionButton = document.querySelector('.motion-toggle');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const coarse = matchMedia('(pointer: coarse)');
  const cache = document.createElement('canvas');
  const cacheCtx = cache.getContext('2d');
  if (!cacheCtx) return;
  let width = 0, height = 0, dpr = 1, stars = [], positions = [], frame = 0;
  let lastTick = 0, lastDraw = 0, elapsed = 0, resizePending = false;
  const pointer = { x: -1000, y: -1000, active: false, offsetX: 0, offsetY: 0 };
  const ice = '179, 211, 244', blue = '119, 173, 218';
  const clusters = [
    [[.09,.20],[.14,.14],[.21,.18],[.24,.27],[.31,.24]],
    [[.72,.17],[.78,.12],[.84,.21],[.89,.18],[.93,.27]],
    [[.12,.65],[.18,.71],[.24,.65],[.29,.76],[.35,.72]],
    [[.72,.68],[.79,.62],[.83,.72],[.90,.69],[.94,.79]],
  ];
  function paused() { return reduce.matches || motionButton?.getAttribute('aria-pressed') === 'true'; }
  function allowed() { return !document.hidden && !paused(); }
  // All particles are allocated at resize, never spawned in the animation loop.
  function resize() {
    const oldWidth = width, oldHeight = height;
    width = window.innerWidth; height = window.innerHeight;
    dpr = Math.min(window.devicePixelRatio || 1, coarse.matches ? 1.4 : 1.75);
    canvas.width = cache.width = Math.round(width * dpr);
    canvas.height = cache.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cacheCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cacheCtx.clearRect(0, 0, width, height);
    const farCount = coarse.matches ? 75 : Math.min(180, Math.round(width * height / 6500));
    for (let i = 0; i < farCount; i++) {
      const x = Math.random() * width, y = Math.random() * height;
      const r = .25 + Math.random() * .6;
      cacheCtx.beginPath(); cacheCtx.arc(x, y, r, 0, Math.PI * 2);
      cacheCtx.fillStyle = `rgba(${ice},${.12 + Math.random() * .32})`; cacheCtx.fill();
    }
    const count = coarse.matches ? Math.min(50, Math.max(30, Math.round(width * height / 11000))) : Math.min(132, Math.max(55, Math.round(width * height / 12500)));
    stars = [];
    for (const cluster of clusters) for (const [x, y] of cluster) {
      stars.push({ x, y, r: .8 + Math.random() * .5, depth: .35 + Math.random() * .45, phase: Math.random() * Math.PI * 2, speed: .22 + Math.random() * .38, anchor: true });
    }
    while (stars.length < count) stars.push({ x: Math.random(), y: Math.random(), r: .45 + Math.random() * 1.1, depth: .2 + Math.random() * .8, phase: Math.random() * Math.PI * 2, speed: .2 + Math.random() * .6, anchor: false });
    positions = stars.map(() => ({ x: 0, y: 0, distance: Infinity }));
    if (oldWidth && oldHeight && pointer.active) { pointer.x *= width / oldWidth; pointer.y *= height / oldHeight; }
    resizePending = false;
    draw();
  }
  function segment(a, b, alpha, lineWidth = .65) {
    if (alpha <= .005) return;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    ctx.strokeStyle = `rgba(${blue},${alpha})`; ctx.lineWidth = lineWidth; ctx.stroke();
  }
  function glow(x, y, radius, alpha) {
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
    gradient.addColorStop(0, `rgba(${ice},${alpha})`);
    gradient.addColorStop(.23, `rgba(${blue},${alpha * .28})`);
    gradient.addColorStop(1, `rgba(${blue},0)`);
    ctx.fillStyle = gradient; ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
  }
  function draw() {
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(cache, 0, 0, width, height);
    const interactive = pointer.active && !coarse.matches && !paused();
    const targetX = interactive ? (pointer.x / width - .5) * 24 : 0;
    const targetY = interactive ? (pointer.y / height - .5) * 18 : 0;
    pointer.offsetX += (targetX - pointer.offsetX) * .045;
    pointer.offsetY += (targetY - pointer.offsetY) * .045;
    if (interactive) glow(pointer.x, pointer.y, 210, .055);
    for (let i = 0; i < stars.length; i++) {
      const star = stars[i], position = positions[i];
      const drift = reduce.matches ? 0 : 2.2;
      position.x = star.x * width + Math.sin(elapsed * .06 + star.phase) * drift * star.depth + pointer.offsetX * star.depth;
      position.y = star.y * height + Math.cos(elapsed * .045 + star.phase) * drift * star.depth + pointer.offsetY * star.depth;
      position.distance = interactive ? Math.hypot(position.x - pointer.x, position.y - pointer.y) : Infinity;
      if (position.distance < 170 && position.distance > 1) {
        const attraction = (1 - position.distance / 170) * .045;
        position.x += (pointer.x - position.x) * attraction;
        position.y += (pointer.y - position.y) * attraction;
      }
    }
    // Four restrained, permanent constellations keep the sky composed at rest.
    for (let group = 0; group < clusters.length; group++) {
      const start = group * 5;
      for (let i = 0; i < 4; i++) {
        const a = positions[start + i], b = positions[start + i + 1];
        const near = interactive ? Math.max(0, 1 - Math.min(a.distance, b.distance) / 220) : 0;
        segment(a, b, .09 + near * .30, .65 + near * .2);
      }
    }
    if (interactive) {
      // Only nearby nodes connect: two short neighbours per node, never a web.
      const local = positions.map((p, index) => ({ p, index })).filter(({p}) => p.distance < 190).sort((a, b) => a.p.distance - b.p.distance).slice(0, 12);
      let edges = 0;
      for (let i = 0; i < local.length && edges < 14; i++) {
        let neighbours = 0;
        for (let j = i + 1; j < local.length && neighbours < 2 && edges < 14; j++) {
          const a = local[i].p, b = local[j].p, distance = Math.hypot(a.x - b.x, a.y - b.y);
          if (distance > 125) continue;
          segment(a, b, (1 - distance / 125) * (1 - Math.min(a.distance, b.distance) / 210) * .50, .75);
          neighbours++; edges++;
        }
      }
      for (const { p } of local.slice(0, 4)) if (p.distance < 125) {
        segment(pointer, p, (1 - p.distance / 125) * .22, .55);
      }
    }
    for (let i = 0; i < stars.length; i++) {
      const star = stars[i], position = positions[i];
      const twinkle = reduce.matches ? .8 : .70 + Math.sin(elapsed * star.speed + star.phase) * .20;
      const near = Math.max(0, 1 - position.distance / 155);
      const alpha = Math.min(.98, twinkle * (.42 + star.depth * .3) + near * .40);
      if (star.anchor || near > .28) glow(position.x, position.y, (5 + star.r * 3) * (1 + near * .4), .10 + near * .17);
      ctx.beginPath(); ctx.arc(position.x, position.y, star.r + near * .35, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${ice},${alpha})`; ctx.fill();
      if (star.anchor && star.r > 1.08) {
        ctx.strokeStyle = `rgba(${ice},${alpha * .30})`; ctx.lineWidth = .55;
        ctx.beginPath(); ctx.moveTo(position.x - 3, position.y); ctx.lineTo(position.x + 3, position.y);
        ctx.moveTo(position.x, position.y - 3); ctx.lineTo(position.x, position.y + 3); ctx.stroke();
      }
    }
  }
  function tick(now) {
    frame = 0;
    if (!allowed()) { lastTick = lastDraw = 0; return; }
    const interval = coarse.matches ? 1000 / 30 : 1000 / 60;
    if (!lastDraw || now - lastDraw >= interval - .5) {
      const dt = lastTick ? Math.min((now - lastTick) / 1000, .05) : 0;
      elapsed += dt; lastTick = lastDraw = now; draw();
    }
    frame = requestAnimationFrame(tick);
  }
  function sync() {
    if (frame) { cancelAnimationFrame(frame); frame = 0; }
    lastTick = lastDraw = 0;
    if (document.hidden) return;
    if (allowed()) frame = requestAnimationFrame(tick);
    else draw();
  }
  window.addEventListener('pointermove', event => {
    if (event.pointerType === 'touch' || coarse.matches) return;
    pointer.x = event.clientX; pointer.y = event.clientY; pointer.active = true;
  }, { passive: true });
  window.addEventListener('pointerout', event => { if (!event.relatedTarget) pointer.active = false; }, { passive: true });
  window.addEventListener('blur', () => { pointer.active = false; }, { passive: true });
  window.addEventListener('resize', () => {
    if (resizePending) return;
    resizePending = true;
    // Resize is finite work and also updates the static reduced-motion scene.
    requestAnimationFrame(resize);
  }, { passive: true });
  document.addEventListener('visibilitychange', sync);
  reduce.addEventListener('change', sync);
  coarse.addEventListener('change', () => { pointer.active = false; resize(); sync(); });
  if (motionButton) new MutationObserver(sync).observe(motionButton, { attributes: true, attributeFilter: ['aria-pressed'] });
  resize(); sync();
})();
