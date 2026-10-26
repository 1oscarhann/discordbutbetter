// Server picker. Plain JS on purpose: no build step, nothing to update.
(() => {
  const KEY_LAST = 'server.last';
  const KEY_RECENT = 'server.recent';
  const $ = (id) => document.getElementById(id);

  const read = (k, fallback) => {
    try {
      return JSON.parse(localStorage.getItem(k)) ?? fallback;
    } catch {
      return fallback;
    }
  };
  const write = (k, v) => {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {
      /* storage unavailable: just don't remember */
    }
  };

  /** "chat.example.com" -> "https://chat.example.com". Only http(s), no paths, no credentials. */
  function normalise(input) {
    let s = input.trim();
    if (!s) return null;
    // no scheme: https, except for localhost / LAN addresses, which rarely have certificates
    if (!/^[a-z]+:\/\//i.test(s)) s = (isLocalHost(s.split(/[/:]/)[0]) ? 'http://' : 'https://') + s;
    let u;
    try {
      u = new URL(s);
    } catch {
      return null;
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (u.username || u.password) return null;
    return u.origin;
  }

  function isLocalHost(h) {
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || /^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(h) || h.endsWith('.local');
  }
  const isLocal = (origin) => isLocalHost(new URL(origin).hostname);

  function open(origin) {
    write(KEY_LAST, origin);
    write(KEY_RECENT, [origin, ...read(KEY_RECENT, []).filter((x) => x !== origin)].slice(0, 6));
    location.replace(origin + '/app');
  }

  async function connect(origin) {
    $('error').hidden = true;
    // http (LAN / localhost): a probe from this secure page would be blocked as mixed content,
    // so just go there and let the page load or fail.
    if (origin.startsWith('http:')) return open(origin);
    $('go').disabled = true;
    $('go').textContent = 'Connecting…';
    try {
      // Opaque request: we only learn whether something answers. The real check is the page loading.
      await fetch(origin + '/api/instance', { mode: 'no-cors', cache: 'no-store', signal: AbortSignal.timeout(8000) });
      open(origin);
    } catch {
      $('error').textContent = `Couldn't reach ${origin}. Check the address and your connection.`;
      $('error').hidden = false;
      $('go').disabled = false;
      $('go').textContent = 'Connect';
    }
  }

  function renderRecent() {
    const list = read(KEY_RECENT, []);
    $('recent-wrap').hidden = list.length === 0;
    const ul = $('recent');
    ul.replaceChildren();
    for (const origin of list) {
      const li = document.createElement('li');
      const go = document.createElement('button');
      go.type = 'button';
      go.textContent = origin.replace(/^https:\/\//, '');
      go.onclick = () => connect(origin);
      const forget = document.createElement('button');
      forget.type = 'button';
      forget.className = 'forget';
      forget.title = 'Forget';
      forget.textContent = '✕';
      forget.onclick = () => {
        write(KEY_RECENT, read(KEY_RECENT, []).filter((x) => x !== origin));
        if (read(KEY_LAST, null) === origin) write(KEY_LAST, null);
        renderRecent();
      };
      li.append(go, forget);
      ul.append(li);
    }
  }

  $('url').addEventListener('input', () => {
    const origin = normalise($('url').value);
    const warn = $('warn');
    if (origin && origin.startsWith('http:') && !isLocal(origin)) {
      warn.textContent = 'Plain http: your password and messages would travel unencrypted. Use https unless this is your own network.';
      warn.hidden = false;
    } else warn.hidden = true;
  });

  $('form').addEventListener('submit', (e) => {
    e.preventDefault();
    const origin = normalise($('url').value);
    if (!origin) {
      $('error').textContent = "That doesn't look like a server address.";
      $('error').hidden = false;
      return;
    }
    void connect(origin);
  });

  // Go straight to the last server unless the user asked to change it.
  const last = read(KEY_LAST, null);
  if (last && !new URLSearchParams(location.search).has('change')) {
    location.replace(last + '/app');
    return;
  }
  if (last) $('url').value = last.replace(/^https:\/\//, '');
  renderRecent();
  $('url').focus();
})();
