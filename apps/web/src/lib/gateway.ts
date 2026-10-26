import type { ClientMessage, GatewayEventName, GatewayEvents, ServerMessage } from '@dbb/shared';

type Handler = <K extends GatewayEventName>(t: K, d: GatewayEvents[K]) => void;

/**
 * WebSocket client: heartbeats, clock-offset estimation (for watch-together sync),
 * reconnect with backoff, idle detection.
 */
export class Gateway {
  private ws: WebSocket | null = null;
  private hbTimer: ReturnType<typeof setInterval> | null = null;
  private retry = 0;
  private stopped = false;
  private lastAck = 0;
  private idle = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** serverTime ≈ Date.now() + offset */
  offset = 0;
  rtt = 0;
  status: 'connecting' | 'open' | 'closed' = 'closed';

  constructor(
    private onEvent: Handler,
    private onStatus: (s: 'connecting' | 'open' | 'closed', willRetry: boolean) => void,
    private onInvalid: () => void,
  ) {}

  connect() {
    this.stopped = false;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.setStatus('connecting');
    const ws = new WebSocket(`${proto}//${location.host}/gateway`);
    this.ws = ws;
    ws.onmessage = (ev) => this.handle(JSON.parse(String(ev.data)) as ServerMessage);
    ws.onclose = (ev) => {
      this.clearHeartbeat();
      if (this.ws !== ws) return;
      this.ws = null;
      if (ev.code === 4001 || ev.code === 4004) {
        this.setStatus('closed', false);
        this.onInvalid();
        return;
      }
      if (this.stopped) return this.setStatus('closed', false);
      this.setStatus('closed', true);
      const delay = Math.min(30_000, 1000 * 2 ** this.retry) * (0.7 + Math.random() * 0.6);
      this.retry++;
      setTimeout(() => !this.stopped && this.connect(), delay);
    };
    this.watchIdle();
  }

  disconnect() {
    this.stopped = true;
    this.clearHeartbeat();
    this.ws?.close(1000);
    this.ws = null;
  }

  send(msg: ClientMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  serverNow() {
    return Date.now() + this.offset;
  }

  private setStatus(s: 'connecting' | 'open' | 'closed', willRetry = false) {
    this.status = s;
    this.onStatus(s, willRetry);
  }

  private handle(msg: ServerMessage) {
    switch (msg.op) {
      case 'hello':
        this.clearHeartbeat();
        this.heartbeat();
        this.hbTimer = setInterval(() => this.heartbeat(), msg.d.heartbeatInterval);
        return;
      case 'heartbeat_ack': {
        const now = Date.now();
        this.rtt = now - msg.d.t;
        // assume symmetric latency
        const sample = msg.d.server - (msg.d.t + this.rtt / 2);
        this.offset = this.lastAck ? this.offset * 0.7 + sample * 0.3 : sample;
        this.lastAck = now;
        return;
      }
      case 'invalid_session':
        this.onInvalid();
        return;
      case 'reconnect':
        this.ws?.close(4000);
        return;
      case 'dispatch':
        if (msg.t === 'READY') {
          this.retry = 0;
          this.setStatus('open');
        }
        this.onEvent(msg.t, msg.d as never);
        return;
    }
  }

  private heartbeat() {
    this.send({ op: 'heartbeat', d: { t: Date.now() } });
  }

  private clearHeartbeat() {
    if (this.hbTimer) clearInterval(this.hbTimer);
    this.hbTimer = null;
  }

  /** 10 minutes without input = idle. */
  private watchIdle() {
    if (typeof window === 'undefined' || this.idleTimer !== null) return;
    const reset = () => {
      if (this.idle) {
        this.idle = false;
        this.send({ op: 'idle', d: { idle: false } });
      }
      if (this.idleTimer) clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => {
        this.idle = true;
        this.send({ op: 'idle', d: { idle: true } });
      }, 10 * 60_000);
    };
    for (const ev of ['mousemove', 'keydown', 'pointerdown', 'focus']) window.addEventListener(ev, reset, { passive: true });
    reset();
  }
}
