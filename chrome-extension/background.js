// Observa (sem bloquear) as requisições do portal de afiliados do ML e captura
// o Cookie + x-csrf-token EXATOS que o portal envia. Guarda o último em storage.
// Requer "extraHeaders" pra ler o header Cookie no MV3.

const PORTAL_FILTER = { urls: ['*://*.mercadolivre.com.br/*affiliate-program/*', '*://*.mercadolivre.com.br/*afiliados/*'] };

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    const headers = details.requestHeaders || [];
    let cookie = null;
    let csrf = null;
    for (const h of headers) {
      const n = (h.name || '').toLowerCase();
      if (n === 'cookie') cookie = h.value;
      else if (n === 'x-csrf-token') csrf = h.value;
    }
    if (!cookie && !csrf) return;
    chrome.storage.local.get(['captured'], ({ captured }) => {
      const prev = captured || {};
      chrome.storage.local.set({
        captured: {
          cookie: cookie || prev.cookie || null,
          csrf: csrf || prev.csrf || null,
          at: Date.now(),
          url: details.url,
        },
      });
      const has = (cookie || prev.cookie) && (csrf || prev.csrf);
      chrome.action.setBadgeText({ text: has ? 'OK' : '…' });
      chrome.action.setBadgeBackgroundColor({ color: has ? '#16a34a' : '#9ca3af' });
    });
  },
  PORTAL_FILTER,
  ['requestHeaders', 'extraHeaders']
);
