import type { ClientSettings } from '@haunt/shared';

let ctx: AudioContext | null = null;

/** A short two-tone blip generated with WebAudio — no sound files to ship. */
export function blip() {
  try {
    ctx ??= new AudioContext();
    const now = ctx.currentTime;
    for (const [i, f] of [880, 1320].entries()) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = f;
      o.type = 'sine';
      g.gain.setValueAtTime(0.0001, now + i * 0.08);
      g.gain.exponentialRampToValueAtTime(0.12, now + i * 0.08 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.08 + 0.12);
      o.connect(g).connect(ctx.destination);
      o.start(now + i * 0.08);
      o.stop(now + i * 0.08 + 0.14);
    }
  } catch {
    /* audio blocked until first user gesture */
  }
}

export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (typeof Notification === 'undefined') return 'denied';
  if (Notification.permission !== 'default') return Notification.permission;
  return Notification.requestPermission();
}

export function notify(app: { settings: ClientSettings; windowFocused: boolean }, n: { title: string; body: string; url: string; icon?: string }) {
  const s = app.settings;
  if (s.notificationSounds) blip();
  if (!s.desktopNotifications || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  if (app.windowFocused && !document.hidden) return;
  const note = new Notification(n.title, { body: n.body.slice(0, 200), icon: n.icon, tag: n.url, silent: true });
  note.onclick = () => {
    window.focus();
    if (location.pathname !== n.url) {
      void import('$app/navigation').then(({ goto }) => goto(n.url));
    }
    note.close();
  };
}
