// Reconnecting WebSocket with exponential backoff, URL rotation and stale detection.
// Messages are JSON-parsed before reaching onMessage; unparseable frames are dropped.

const OPEN_TIMEOUT_MS = 8000;

export function createSocket({
  urls,                 // string[] — rotated on each failed attempt
  onOpen,               // (send) => void — e.g. to subscribe
  onMessage,            // (data) => void
  onState,              // (connected: boolean) => void
  staleMs = 0,          // reconnect if no message for this long (0 = never)
  minBackoffMs = 1000,
  maxBackoffMs = 30000,
}) {
  let ws = null;
  let urlIndex = 0;
  let attempt = 0;
  let stopped = false;
  let connected = false;
  let openedAt = 0;
  let lastMessageAt = 0;
  let retryTimer = 0;

  const setConnected = (v) => {
    if (v === connected) return;
    connected = v;
    onState?.(v);
  };

  const send = (obj) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  };

  function detach(sock) {
    if (!sock) return;
    sock.onopen = sock.onmessage = sock.onerror = sock.onclose = null;
    try { sock.close(); } catch { /* ignore */ }
  }

  function scheduleRetry() {
    setConnected(false);
    if (stopped) return;
    detach(ws);
    ws = null;
    urlIndex = (urlIndex + 1) % urls.length;
    const base = Math.min(maxBackoffMs, minBackoffMs * 2 ** attempt);
    attempt++;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(connect, base * (0.7 + Math.random() * 0.6));
  }

  function connect() {
    if (stopped) return;
    let sock;
    try {
      sock = new WebSocket(urls[urlIndex]);
    } catch {
      scheduleRetry();
      return;
    }
    ws = sock;
    openedAt = Date.now();
    lastMessageAt = openedAt;
    sock.onopen = () => {
      attempt = 0;
      setConnected(true);
      onOpen?.(send);
    };
    sock.onmessage = (e) => {
      lastMessageAt = Date.now();
      let data;
      try { data = JSON.parse(e.data); } catch { return; }
      onMessage(data);
    };
    sock.onerror = () => { /* onclose follows */ };
    sock.onclose = () => { if (ws === sock) scheduleRetry(); };
  }

  // Watchdog: kill sockets stuck connecting or silent for too long.
  const watchdog = setInterval(() => {
    if (!ws || stopped) return;
    const now = Date.now();
    if (ws.readyState === WebSocket.CONNECTING && now - openedAt > OPEN_TIMEOUT_MS) scheduleRetry();
    else if (ws.readyState === WebSocket.OPEN && staleMs && now - lastMessageAt > staleMs) scheduleRetry();
  }, 1000);

  connect();

  return {
    send,
    get connected() { return connected; },
    close() {
      stopped = true;
      clearTimeout(retryTimer);
      clearInterval(watchdog);
      detach(ws);
      ws = null;
      setConnected(false);
    },
  };
}
