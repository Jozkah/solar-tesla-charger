// Server-initiated push notifications (true push, instant). The server makes an
// outbound HTTPS call to a push service that delivers to your phone — so it works
// even though the dashboard itself is plain HTTP on the LAN.
//
// Supported channels (auto-detected from .env, or set NOTIFY_CHANNEL):
//   ntfy      — free, no account; install the ntfy app + subscribe to NTFY_TOPIC
//   pushover  — PUSHOVER_TOKEN + PUSHOVER_USER
//   telegram  — TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID
import config from './config.js';

const N = config.notify || {};

export function channel() {
  if (N.channel && N.channel !== 'auto') return N.channel;
  if (N.ntfy?.topic) return 'ntfy';
  if (N.pushover?.token && N.pushover?.user) return 'pushover';
  if (N.telegram?.token && N.telegram?.chatId) return 'telegram';
  return null;
}

export function enabled() {
  return N.enabled !== false && channel() != null;
}

export async function send(title, message, { tags, priority } = {}) {
  const ch = channel();
  if (N.enabled === false || !ch) return { skipped: true, reason: 'notifications not configured' };
  try {
    if (ch === 'ntfy') {
      const base = (N.ntfy.server || 'https://ntfy.sh').replace(/\/$/, '');
      const headers = { Title: title };
      if (tags) headers.Tags = tags;
      if (priority) headers.Priority = String(priority);
      if (N.ntfy.token) headers.Authorization = `Bearer ${N.ntfy.token}`;
      await fetch(`${base}/${N.ntfy.topic}`, { method: 'POST', headers, body: message, signal: AbortSignal.timeout(8000) });
    } else if (ch === 'pushover') {
      const body = new URLSearchParams({ token: N.pushover.token, user: N.pushover.user, title, message });
      await fetch('https://api.pushover.net/1/messages.json', { method: 'POST', body, signal: AbortSignal.timeout(8000) });
    } else if (ch === 'telegram') {
      await fetch(`https://api.telegram.org/bot${N.telegram.token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: N.telegram.chatId, text: `${title}\n${message}` }),
        signal: AbortSignal.timeout(8000),
      });
    }
    return { ok: true, channel: ch };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

export default { channel, enabled, send };
