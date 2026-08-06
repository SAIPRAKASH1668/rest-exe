import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject, Subject } from 'rxjs';
import { environment } from '../../../environments/environment';
import { RestaurantContextService } from './restaurant-context.service';

/**
 * Push-first order delivery: subscribes to this restaurant's private ntfy
 * topic (SSE) and re-emits order_upsert envelopes. OrderService listens and
 * refetches on events; while the subscription is healthy the 20s polling
 * demotes to a 5-minute reconciliation heartbeat.
 *
 * Config comes from GET /restaurants/<id>/events-config (JWT-gated). Until
 * the ntfy server is provisioned that returns {enabled:false} and this
 * service simply retries later — polling behavior stays exactly as today.
 */
export interface OrderPushEnvelope {
  type: string;
  orderId?: string;
  status?: string;
  ts?: string;
  order?: unknown;
  oversize?: boolean;
}

interface EventsConfig {
  enabled: boolean;
  url?: string;
  topic?: string;
  token?: string;
}

const CONFIG_RETRY_MS = 5 * 60 * 1000; // server not provisioned yet → check later
const ERROR_RETRY_MS = 15 * 1000;      // transient failure → quick retry

@Injectable({ providedIn: 'root' })
export class PushEventsService {
  private readonly API_BASE_URL = environment.apiUrl;

  private source?: EventSource;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private stopped = true;
  /** Unix seconds of the last received message — reconnects replay from here. */
  private lastEventTime = 0;

  readonly events$ = new Subject<OrderPushEnvelope>();
  readonly connected$ = new BehaviorSubject<boolean>(false);

  constructor(
    private http: HttpClient,
    private restaurantContext: RestaurantContextService,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.fetchConfigAndConnect();
  }

  stop(): void {
    this.stopped = true;
    this.teardown();
  }

  private teardown(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.source?.close();
    this.source = undefined;
    this.connected$.next(false);
  }

  private scheduleReconnect(delayMs: number): void {
    if (this.stopped) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.fetchConfigAndConnect(), delayMs);
  }

  private fetchConfigAndConnect(): void {
    const restaurantId = this.restaurantContext.getRestaurantId();
    if (this.stopped || !restaurantId) {
      this.scheduleReconnect(CONFIG_RETRY_MS);
      return;
    }
    this.http.get<EventsConfig>(`${this.API_BASE_URL}/restaurants/${restaurantId}/events-config`).subscribe({
      next: (cfg) => {
        if (!cfg?.enabled || !cfg.url || !cfg.topic) {
          console.info('[push] order events disabled on backend — re-checking in 5 min');
          this.scheduleReconnect(CONFIG_RETRY_MS);
          return;
        }
        this.connect(cfg as Required<EventsConfig>);
      },
      error: (err) => {
        console.warn('[push] events-config fetch failed (HTTP', err?.status, ') — retrying in 15s');
        this.scheduleReconnect(ERROR_RETRY_MS);
      },
    });
  }

  private connect(cfg: { url: string; topic: string; token?: string }): void {
    this.source?.close();

    const params: string[] = [];
    if (cfg.token) {
      // EventSource can't set headers — ntfy accepts the Authorization value
      // base64url-encoded in the `auth` query param.
      params.push(`auth=${encodeURIComponent(btoa(`Bearer ${cfg.token}`).replace(/=+$/, ''))}`);
    }
    if (this.lastEventTime > 0) {
      params.push(`since=${this.lastEventTime}`); // replay anything missed
    }
    const url = `${cfg.url}/${cfg.topic}/sse${params.length ? '?' + params.join('&') : ''}`;

    const source = new EventSource(url);
    this.source = source;

    source.onopen = () => {
      console.info('[push] connected to order events stream — polling demoted to reconciliation');
      this.connected$.next(true);
    };

    source.onmessage = (event) => {
      try {
        const outer = JSON.parse(event.data);
        if (outer?.event && outer.event !== 'message') return; // keepalive/open
        if (typeof outer?.time === 'number') this.lastEventTime = outer.time;
        const envelope: OrderPushEnvelope =
          typeof outer?.message === 'string' ? JSON.parse(outer.message) : outer?.message;
        if (envelope?.type) this.events$.next(envelope);
      } catch {
        // Non-JSON payloads (manual test posts) are ignored.
      }
    };

    source.onerror = () => {
      console.warn('[push] order events stream dropped — full-rate polling until reconnect');
      this.connected$.next(false);
      source.close();
      if (this.source === source) this.source = undefined;
      this.scheduleReconnect(ERROR_RETRY_MS);
    };
  }
}
