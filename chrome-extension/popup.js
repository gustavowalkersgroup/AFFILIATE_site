const $ = (id) => document.getElementById(id);

function fmtAge(ts) {
  if (!ts) return '';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s atrás`;
  if (s < 3600) return `${Math.round(s / 60)}min atrás`;
  return `${Math.round(s / 3600)}h atrás`;
}

function renderStatus() {
  chrome.storage.local.get(['captured'], ({ captured }) => {
    const c = captured || {};
    const cookieOk = c.cookie ? `<span class="ok">✅</span>` : `<span class="no">❌</span>`;
    const csrfOk = c.csrf ? `<span class="ok">✅</span>` : `<span class="no">❌</span>`;
    $('status').innerHTML =
      `Cookie ${cookieOk} &nbsp; x-csrf-token ${csrfOk}` +
      (c.at ? `<br><span class="muted">capturado ${fmtAge(c.at)}</span>` : '<br><span class="muted">nada capturado ainda — gere 1 link no portal</span>');
  });
}

function loadConfig() {
  chrome.storage.local.get(['cfg'], ({ cfg }) => {
    const c = cfg || {};
    $('panel').value = c.panel || 'https://mantra-grain-tinkling.ngrok-free.dev';
    $('token').value = c.token || '';
    $('tag').value = c.tag || '';
  });
}

function saveConfig() {
  const cfg = { panel: $('panel').value.trim().replace(/\/$/, ''), token: $('token').value.trim(), tag: $('tag').value.trim() };
  chrome.storage.local.set({ cfg });
  return cfg;
}

// Fallback: reconstrói o header Cookie a partir do chrome.cookies (pega HttpOnly).
$('recapture').addEventListener('click', () => {
  chrome.cookies.getAll({ domain: 'mercadolivre.com.br' }, (cookies) => {
    const cookie = (cookies || []).map((k) => `${k.name}=${k.value}`).join('; ');
    chrome.storage.local.get(['captured'], ({ captured }) => {
      const prev = captured || {};
      chrome.storage.local.set({ captured: { ...prev, cookie: cookie || prev.cookie, at: Date.now() } }, () => {
        $('msg').textContent = `Cookie reconstruído (${cookies ? cookies.length : 0} cookies). Se o x-csrf-token estiver faltando, gere 1 link no portal e tente de novo.`;
        renderStatus();
      });
    });
  });
});

$('send').addEventListener('click', () => {
  const cfg = saveConfig();
  if (!cfg.panel || !cfg.token) {
    $('msg').textContent = 'Preencha a URL do painel e o admin token.';
    return;
  }
  chrome.storage.local.get(['captured'], async ({ captured }) => {
    const c = captured || {};
    if (!c.cookie) {
      $('msg').textContent = 'Sem cookie capturado. Logue no portal, gere 1 link (ou use "Recapturar cookie") e tente de novo.';
      return;
    }
    $('send').disabled = true;
    $('msg').textContent = 'Enviando…';
    try {
      const res = await fetch(`${cfg.panel}/api/config/meli/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-token': cfg.token },
        body: JSON.stringify({ cookie: c.cookie, csrf: c.csrf || '', tag: cfg.tag || '' }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        $('msg').textContent = `✅ Sessão enviada! cookie ${data.cookieLen} chars, csrf ${data.csrfSet ? 'ok' : 'faltando'}. Agora teste "Gerar link" no painel.`;
      } else {
        $('msg').textContent = `❌ ${data.error || ('HTTP ' + res.status)}`;
      }
    } catch (e) {
      $('msg').textContent = `❌ ${e.message} (confira a URL do painel e se está acessível)`;
    } finally {
      $('send').disabled = false;
    }
  });
});

loadConfig();
renderStatus();
