import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject, Observable, interval, Subscription } from 'rxjs';
import { catchError, tap } from 'rxjs/operators';
import { Order, OrdersResponse, OrderStatus, UpdateOrderStatusRequest, UpdateOrderStatusResponse } from '../models/order.model';
import { PushEventsService } from './push-events.service';
import { RestaurantContextService } from './restaurant-context.service';
import { SoundService } from './sound.service';
import { environment } from '../../../environments/environment';

@Injectable({
  providedIn: 'root'
})
export class OrderService {
  private readonly API_BASE_URL = environment.apiUrl;
  private readonly POLLING_INTERVAL = 30000; // 30 seconds fallback polling
  
  private ordersSubject = new BehaviorSubject<Order[]>([]);
  public orders$: Observable<Order[]> = this.ordersSubject.asObservable();
  
  private loadingSubject = new BehaviorSubject<boolean>(false);
  public loading$: Observable<boolean> = this.loadingSubject.asObservable();
  
  private pollingSubscription?: Subscription;
  /** Healthy ntfy push subscription → polling demotes to reconciliation. */
  private pushConnected = false;
  private pushEventDebounce?: ReturnType<typeof setTimeout>;
  private lastFetchAt = 0;
  /** Reconciliation heartbeat while push delivers orders. */
  private readonly PUSH_RECONCILE_INTERVAL = 5 * 60 * 1000;

  constructor(
    private http: HttpClient,
    private restaurantContext: RestaurantContextService,
    private soundService: SoundService,
    private pushEvents: PushEventsService
  ) {
    this.initializeOrderSync();
  }

  /**
   * Initialize order synchronization: ntfy push events drive freshness; the
   * REST poll is a reconciliation safety net (full-rate only while the push
   * subscription is down).
   */
  private initializeOrderSync(): void {
    this.pushEvents.start();
    this.pushEvents.connected$.subscribe((connected) => {
      this.pushConnected = connected;
    });
    this.pushEvents.events$.subscribe(() => {
      // Bursts of transitions collapse into one fetch; alarm/notification
      // logic rides the existing fetch-diff path unchanged.
      if (this.pushEventDebounce) clearTimeout(this.pushEventDebounce);
      this.pushEventDebounce = setTimeout(() => this.fetchOrders(), 800);
    });
    // Components should call fetchOrders() when they're ready
    this.setupPolling();
  }

  /**
   * Fetch all orders from REST API
   */
  fetchOrders(): void {
    const restaurantId = this.restaurantContext.getRestaurantId();
    this.lastFetchAt = Date.now();
    this.loadingSubject.next(true);

    // Snapshot existing IDs before the fetch — used to detect new arrivals
    const existingIds = new Set(this.ordersSubject.value.map(o => o.orderId));
    const isInitialFetch = existingIds.size === 0;

    this.http.get<OrdersResponse>(`${this.API_BASE_URL}/orders?restaurantId=${restaurantId}`)
      .pipe(
        tap(response => {
          // Play alarm when polling detects brand-new orders (skip on initial page load)
          if (!isInitialFetch) {
            const hasNewOrders = response.orders.some(o => !existingIds.has(o.orderId));
            if (hasNewOrders) {
              this.soundService.playNewOrderAlarm();
            }
          }

          this.ordersSubject.next(response.orders);
          this.loadingSubject.next(false);
        }),
        catchError(error => {
          this.loadingSubject.next(false);
          throw error;
        })
      )
      .subscribe({
        error: () => {
          this.loadingSubject.next(false);
        }
      });
  }

  /**
   * Add or update order in local state (handles deduplication)
   * @param order - Order to add or update
   */
  private addOrUpdateOrder(order: Order): void {
    const currentOrders = this.ordersSubject.value;
    const existingIndex = currentOrders.findIndex(o => o.orderId === order.orderId);
    
    if (existingIndex !== -1) {
      // Update existing order
      const updatedOrders = [...currentOrders];
      updatedOrders[existingIndex] = order;
      this.ordersSubject.next(updatedOrders);
    } else {
      // Add new order at the beginning (newest first)
      this.ordersSubject.next([order, ...currentOrders]);
    }
  }

  /**
   * Update order status
   * @param orderId - Order ID to update
   * @param status - New status
   * @param additionalData - Optional additional data (e.g., cancellationReason)
   * @returns Observable of updated order
   */
  updateOrderStatus(orderId: string, status: OrderStatus, additionalData?: Partial<UpdateOrderStatusRequest>): Observable<UpdateOrderStatusResponse> {
    const payload: UpdateOrderStatusRequest = { status, ...additionalData };
    
    return this.http.put<UpdateOrderStatusResponse>(
      `${this.API_BASE_URL}/orders/${orderId}/status`,
      payload
    ).pipe(
      tap(updatedOrder => {
        this.addOrUpdateOrder(updatedOrder);
      }),
      catchError(error => {
        this.fetchOrders();
        throw error;
      })
    );
  }

  /**
   * Setup polling as fallback mechanism. The 30s tick always runs, but while
   * the push subscription is healthy it only actually fetches once per
   * reconciliation interval — push handles the realtime path.
   */
  private setupPolling(): void {
    this.pollingSubscription = interval(this.POLLING_INTERVAL).subscribe(() => {
      if (this.pushConnected && Date.now() - this.lastFetchAt < this.PUSH_RECONCILE_INTERVAL) {
        return;
      }
      this.fetchOrders();
    });
  }

  /**
   * Get orders by status
   * @param status - Filter by status
   * @returns Observable of filtered orders
   */
  getOrdersByStatus(status: OrderStatus): Observable<Order[]> {
    return new Observable(observer => {
      this.orders$.subscribe(orders => {
        observer.next(orders.filter(order => order.status === status));
      });
    });
  }

  /**
   * Get order statistics
   * @returns Statistics object
   */
  getOrderStats(): { pending: number; confirmed: number; preparing: number; ready: number; total: number } {
    const orders = this.ordersSubject.value;
    return {
      pending: orders.filter(o => o.status === OrderStatus.PENDING).length,
      confirmed: orders.filter(o => o.status === OrderStatus.CONFIRMED || o.status === OrderStatus.ACCEPTED).length,
      preparing: orders.filter(o => o.status === OrderStatus.PREPARING).length,
      ready: orders.filter(o => 
        o.status === OrderStatus.READY_FOR_PICKUP || 
        o.status === OrderStatus.AWAITING_RIDER_ASSIGNMENT ||
        o.status === OrderStatus.OFFERED_TO_RIDER ||
        o.status === OrderStatus.RIDER_ASSIGNED
      ).length,
      total: orders.length
    };
  }

  /**
   * Cleanup subscriptions
   */
  ngOnDestroy(): void {
    this.pollingSubscription?.unsubscribe();
  }
}
