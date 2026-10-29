(() => {
  'use strict';
  const field = document.querySelector('.marquee-field');
  const button = document.querySelector('.motion-toggle');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let paused = reducedMotion.matches;
  let stageVisible = true;
  function updatePause() {
    field.classList.toggle('is-paused', paused);
    button.setAttribute('aria-pressed', String(paused));
    button.disabled = reducedMotion.matches;
    const title = paused ? '播放弹幕' : '暂停弹幕';
    button.setAttribute('aria-label', title); button.title = title;
    button.firstElementChild.textContent = paused ? '▷' : 'Ⅱ';
  }
  button.addEventListener('click', () => { paused = !paused; updatePause(); });
  reducedMotion.addEventListener('change', event => { paused = event.matches; updatePause(); });
  updatePause();
  function updateVisibility() { field.classList.toggle('is-outside', document.hidden || !stageVisible); }
  const observer = new IntersectionObserver(entries => {
    stageVisible = entries[0].isIntersecting; updateVisibility();
  }, { threshold: 0 });
  observer.observe(document.querySelector('.name-stage'));
  document.addEventListener('visibilitychange', updateVisibility);
  const fallback = [
    { language: '中文', code: 'zh', name: '杨若璇', text: '我爱你' },
    { language: 'English', code: 'en', name: 'Yang Ruoxuan', text: 'I love you' },
    { language: 'Français', code: 'fr', name: 'Yang Ruoxuan', text: 'Je t’aime' },
    { language: '日本語', code: 'ja', name: 'ヤン・ルオシュエン', text: '愛してる' },
    { language: '한국어', code: 'ko', name: '양뤄쉬안', text: '사랑해' },
    { language: 'Italiano', code: 'it', name: 'Yang Ruoxuan', text: 'Ti amo' },
  ];
  function render(languages) {
    const rows = Array.from({ length: 6 }, () => []);
    // Distribute each language once, then duplicate the same row for a seamless loop.
    languages.forEach((entry, index) => rows[index % rows.length].push(entry));
    for (const entries of rows) {
      const row = document.createElement('div'); row.className = 'marquee-row';
      const group = document.createElement('div'); group.className = 'marquee-group';
      for (const entry of entries) {
        const item = document.createElement('span'); item.className = 'marquee-item';
        const name = document.createElement('bdi'); name.className = 'marquee-name'; name.lang = entry.code || 'und'; name.dir = entry.nameDirection || 'auto'; name.textContent = entry.name || 'Yang Ruoxuan';
        const separator = document.createElement('span'); separator.className = 'marquee-separator'; separator.textContent = '·';
        const phrase = document.createElement('bdi'); phrase.className = 'marquee-phrase'; phrase.lang = entry.code || 'und'; phrase.dir = entry.direction || 'auto'; phrase.textContent = entry.text;
        item.title = entry.language; item.append(name, separator, phrase); group.append(item);
      }
      row.append(group, group.cloneNode(true)); field.append(row);
    }
  }
  fetch('/languages.json', { signal: AbortSignal.timeout(8000) })
    .then(response => { if (!response.ok) throw new Error('Languages unavailable'); return response.json(); })
    .then(entries => { if (!Array.isArray(entries) || entries.length < 6) throw new Error('Invalid languages'); render(entries); })
    .catch(() => render(fallback));
})();
