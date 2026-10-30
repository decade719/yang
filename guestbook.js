// Keep network recovery independent of the page so it can be exercised directly.
function createGuestbookApi({ fetcher = fetch, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), timeoutMs = 10000 } = {}) {
  const validMessage = item => item && typeof item.id === 'string' && typeof item.nickname === 'string' && typeof item.content === 'string' && typeof item.createdAt === 'string' && Number.isFinite(Date.parse(item.createdAt));
  function validData(path, method, data) {
    if (!data || typeof data !== 'object') return false;
    const route = new URL(path, 'https://guestbook.invalid').pathname;
    if (route === '/api/session') return typeof data.token === 'string' && data.token.length > 0 && Number.isFinite(Date.parse(data.expiresAt)) && Number.isInteger(data.minimumWaitMs) && data.minimumWaitMs >= 0 && data.minimumWaitMs <= 10000;
    if (route === '/api/messages' && method === 'GET') return Array.isArray(data.messages) && data.messages.every(validMessage) && Number.isInteger(data.total) && data.total >= 0 && (data.nextCursor === null || typeof data.nextCursor === 'string');
    if (route === '/api/messages' && method === 'POST') return validMessage(data.message) && Number.isFinite(data.cooldownSeconds) && data.cooldownSeconds >= 0;
    return false;
  }
  return async function api(path, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    const attempts = method === 'GET' ? 3 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      let failure;
      try {
        const headers = new Headers(options.headers);
        headers.set('Accept', 'application/json');
        const response = await fetcher(path, { ...options, headers, signal: controller.signal, credentials: 'same-origin', cache: 'no-store' });
        const data = await response.json().catch(() => null);
        if (response.ok && validData(path, method, data)) return data;
        const applicationError = !response.ok && typeof data?.error === 'string';
        const blocked = !data && response.status === 403;
        const message = applicationError ? data.error : blocked ? '连接暂时受限，请刷新页面或在系统浏览器中重试。' : '连接暂时中断，请稍后重试，已填写的内容会保留。';
        failure = Object.assign(new Error(message), {
          code: applicationError ? data.code : blocked ? 'ACCESS_BLOCKED' : 'UNEXPECTED_RESPONSE',
          status: response.status, retryAfter: Number(response.headers.get('Retry-After')) || 0,
          retryable: !applicationError || response.status >= 500 || response.status === 408 || response.status === 429,
        });
      } catch (error) {
        const timedOut = error.name === 'AbortError';
        failure = Object.assign(new Error(timedOut ? '网络有点慢，请稍后重试，已填写的内容会保留。' : '暂时连接不上留言簿，请检查网络后重试。'), { code: timedOut ? 'TIMEOUT' : 'NETWORK_ERROR', retryable: true });
      } finally { clearTimeout(timeout); }
      if (!failure.retryable || attempt === attempts - 1) {
        console.warn('Guestbook request failed', { path: new URL(path, 'https://guestbook.invalid').pathname, status: failure.status || 0, code: failure.code });
        throw failure;
      }
      await wait(500 * (attempt + 1));
    }
  };
}

(() => {
  'use strict';
  const $ = selector => document.querySelector(selector);
  const form = $('#message-form'), nickname = $('#nickname'), content = $('#message');
  if (!form) return;
  const api = createGuestbookApi();
  const list = $('#message-list'), notice = $('#list-notice'), more = $('.load-more');
  const submit = $('.submit-button'), label = $('.submit-label'), refresh = $('.refresh-button');
  let session = null, sessionPromise = null, nextCursor = null, loading = false, total = 0, cooldown = 0, toastTimer, listFailed = false, recoveryTimer;
  const seen = new Set();
  let initialMessages = null;
  try {
    const node = $('#guestbook-bootstrap');
    const data = node ? JSON.parse(node.textContent) : null;
    if (data && Array.isArray(data.messages) && Number.isInteger(data.total) && (data.nextCursor === null || typeof data.nextCursor === 'string')) initialMessages = data;
  } catch { /* API loading remains available when the page has no initial data. */ }
  const size = value => Array.from(value.normalize('NFC').trim()).length;
  const themeButton = $('.theme-toggle');
  function setTheme(dark) {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    themeButton.setAttribute('aria-pressed', String(dark));
    themeButton.setAttribute('aria-label', dark ? '切换到深空星夜' : '切换到蓝调星空');
    $('meta[name="theme-color"]').content = dark ? '#0a1221' : '#050912';
  }
  try { setTheme(localStorage.getItem('guestbook-sky-theme') === 'blue'); } catch { setTheme(false); }
  themeButton.addEventListener('click', () => {
    const dark = document.documentElement.dataset.theme !== 'dark';
    setTheme(dark);
    try { localStorage.setItem('guestbook-sky-theme', dark ? 'blue' : 'deep'); } catch { /* Preferences are optional. */ }
  });
  function status(text, success = false) {
    const node = $('#form-status'); node.textContent = text; node.hidden = !text;
    node.classList.toggle('success', success);
  }
  function fieldError(field, text) {
    field.setAttribute('aria-invalid', String(Boolean(text)));
    const node = $('#' + field.id + '-error'); node.textContent = text; node.hidden = !text;
  }
  const draftKey = 'yang-guestbook-draft';
  function saveDraft() {
    try { sessionStorage.setItem(draftKey, JSON.stringify({ nickname: nickname.value, content: content.value })); } catch { /* Storage is optional. */ }
  }
  try {
    const draft = JSON.parse(sessionStorage.getItem(draftKey) || 'null');
    if (draft && typeof draft.nickname === 'string' && typeof draft.content === 'string') {
      if (!nickname.value) nickname.value = draft.nickname.slice(0, 48);
      if (!content.value) content.value = draft.content.slice(0, 1000);
    }
  } catch { /* Ignore unavailable storage or an invalid saved draft. */ }
  function getSession() {
    if (sessionPromise) return sessionPromise;
    sessionPromise = api('/api/session').then(data => {
      session = { ...data, readyAt: Date.now() + data.minimumWaitMs };
      return session;
    }).finally(() => { sessionPromise = null; });
    return sessionPromise;
  }
  function emptyState(unavailable = false) {
    const card = document.createElement('div'); card.className = 'empty-card';
    const mark = document.createElement('span'); mark.className = 'empty-symbol'; mark.textContent = unavailable ? '…' : '—'; mark.setAttribute('aria-hidden', 'true');
    const heading = document.createElement('h3'); heading.textContent = unavailable ? '暂时无法读取，请刷新重试。' : '还没有留言';
    card.append(mark, heading);
    if (!unavailable) { const link = document.createElement('a'); link.href = '#compose'; link.textContent = '写 ↗'; card.append(link); }
    return card;
  }
  function messageCard(message, fresh = false) {
    const card = document.createElement('article'); card.className = 'message-card' + (fresh ? ' new-message' : '');
    const meta = document.createElement('div'); meta.className = 'message-meta';
    const avatar = document.createElement('span'); avatar.className = 'avatar'; avatar.textContent = Array.from(message.nickname)[0]; avatar.setAttribute('aria-hidden', 'true');
    const author = document.createElement('span'); author.className = 'message-author'; author.textContent = message.nickname;
    const number = document.createElement('span'); number.className = 'message-number'; number.textContent = 'NOTE / ' + message.id.slice(0, 4).toUpperCase();
    meta.append(avatar, author, number);
    const text = document.createElement('p'); text.className = 'message-content'; text.textContent = message.content;
    const time = document.createElement('time'); time.className = 'message-time'; time.dateTime = message.createdAt;
    time.textContent = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(message.createdAt));
    card.append(meta, text, time); return card;
  }
  async function loadMessages(append = false) {
    if (loading) return;
    loading = true; list.setAttribute('aria-busy', 'true'); refresh.setAttribute('aria-busy', 'true'); refresh.disabled = true; more.disabled = true;
    notice.hidden = true; $('.list-status').textContent = '正在翻页';
    try {
      let data;
      if (!append && initialMessages) { data = initialMessages; initialMessages = null; }
      else data = await api('/api/messages' + (append && nextCursor ? '?cursor=' + encodeURIComponent(nextCursor) : ''));
      if (!append) { list.replaceChildren(); seen.clear(); }
      for (const message of data.messages) if (!seen.has(message.id)) { seen.add(message.id); list.append(messageCard(message)); }
      total = data.total; $('.message-count').textContent = String(total); nextCursor = data.nextCursor; listFailed = false;
      more.hidden = !nextCursor;
      if (seen.size === 0) list.replaceChildren(emptyState());
      $('.list-status').textContent = total ? '已收好 ' + total + ' 条' : '等待第一句话';
    } catch (error) {
      listFailed = true;
      notice.textContent = error.message; notice.hidden = false; $('.list-status').textContent = '稍后再试';
      if (seen.size === 0) list.replaceChildren(emptyState(true));
    } finally { loading = false; list.setAttribute('aria-busy', 'false'); refresh.setAttribute('aria-busy', 'false'); refresh.disabled = false; more.disabled = false; }
  }
  function updateCounter() {
    const count = Array.from(content.value.normalize('NFC')).length;
    $('#character-count').textContent = count + ' / 500'; $('#character-count').classList.toggle('over-limit', count > 500);
  }
  function updateCooldown() {
    const remaining = Math.ceil((cooldown - Date.now()) / 1000);
    if (remaining > 0) { submit.disabled = true; label.textContent = remaining + ' 秒后，可以再写一条'; }
    else { submit.disabled = false; label.textContent = '留下'; clearInterval(cooldownTimer); }
  }
  let cooldownTimer;
  content.addEventListener('input', () => { updateCounter(); saveDraft(); if (content.hasAttribute('aria-invalid')) fieldError(content, ''); });
  nickname.addEventListener('input', () => { saveDraft(); fieldError(nickname, ''); });
  refresh.addEventListener('click', () => loadMessages()); more.addEventListener('click', () => loadMessages(true));
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (submit.disabled) return;
    const nick = nickname.value.normalize('NFC').trim(), text = content.value.normalize('NFC').trim();
    const nickError = size(nick) < 1 || size(nick) > 24 || /[\n\r\t]/u.test(nick) ? '昵称请填写 1～24 个字。' : '';
    const textError = size(text) < 2 || size(text) > 500 ? '留言请填写 2～500 个字。' : '';
    fieldError(nickname, nickError); fieldError(content, textError); status('');
    if (nickError || textError) { (nickError ? nickname : content).focus(); return; }
    saveDraft();
    submit.disabled = true; label.textContent = '发布中…';
    try {
      if (!session || Date.parse(session.expiresAt) - Date.now() < 3000) await getSession();
      const wait = session.readyAt - Date.now(); if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait + 50));
      const data = await api('/api/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nickname: nick, content: text, website: $('#website').value, token: session.token }) });
      // Only a server-confirmed write clears the draft and shows success.
      content.value = ''; saveDraft(); updateCounter(); status('已发布。', true);
      if (seen.size === 0) list.replaceChildren();
      if (!seen.has(data.message.id)) { seen.add(data.message.id); list.prepend(messageCard(data.message, true)); total += 1; $('.message-count').textContent = String(total); }
      notice.hidden = true; $('.list-status').textContent = '刚刚收到新留言';
      $('.toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('.toast').hidden = true; }, 5000);
      session = null; getSession().catch(() => {});
      cooldown = Date.now() + data.cooldownSeconds * 1000; updateCooldown(); cooldownTimer = setInterval(updateCooldown, 1000);
    } catch (error) {
      status(error.message);
      if (error.code === 'INVALID_SESSION') { session = null; getSession().catch(() => {}); }
      submit.disabled = false; label.textContent = '再试一次';
    }
  });
  function recoverConnection() {
    clearTimeout(recoveryTimer);
    if (document.hidden || navigator.onLine === false) return;
    recoveryTimer = setTimeout(() => {
      if (listFailed) loadMessages();
      if (!session || Date.parse(session.expiresAt) < Date.now()) getSession().catch(() => {});
    }, 300);
  }
  window.addEventListener('online', recoverConnection);
  window.addEventListener('focus', recoverConnection);
  document.addEventListener('visibilitychange', recoverConnection);
  updateCounter(); getSession().catch(() => {}); loadMessages();
})();
