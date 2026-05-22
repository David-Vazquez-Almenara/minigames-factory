import { Injectable, computed, inject, signal } from '@angular/core';
import { BackendHealthService } from './backend-health.service';

export type BackendStatus = 'checking' | 'online' | 'sleeping';

const RETRY_DELAY_MS = 5000;

@Injectable({ providedIn: 'root' })
export class BackendWakeService {
  private readonly backendHealthService = inject(BackendHealthService);
  private readonly statusState = signal<BackendStatus>('checking');
  private started = false;
  private retryTimer?: ReturnType<typeof setTimeout>;

  readonly status = computed(() => this.statusState());
  readonly sleeping = computed(() => this.statusState() === 'sleeping');
  readonly online = computed(() => this.statusState() === 'online');

  startMonitoring(): void {
    if (this.started) {
      return;
    }

    this.started = true;
    this.runInitialCheck();
  }

  private runInitialCheck(): void {
    this.checkBackend({
      onSuccess: () => this.markOnline(),
      onFailure: () => this.scheduleSecondCheck(),
    });
  }

  private scheduleSecondCheck(): void {
    this.retryTimer = setTimeout(() => {
      this.checkBackend({
        onSuccess: () => this.markOnline(),
        onFailure: () => this.markSleepingAndPoll(),
      });
    }, RETRY_DELAY_MS);
  }

  private markSleepingAndPoll(): void {
    this.statusState.set('sleeping');
    this.scheduleSleepingPoll();
  }

  private scheduleSleepingPoll(): void {
    this.retryTimer = setTimeout(() => {
      this.checkBackend({
        onSuccess: () => this.markOnline(),
        onFailure: () => this.scheduleSleepingPoll(),
      });
    }, RETRY_DELAY_MS);
  }

  private markOnline(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
    }

    this.statusState.set('online');
  }

  private checkBackend(handlers: { onSuccess: () => void; onFailure: () => void }): void {
    this.backendHealthService.check().subscribe({
      next: () => handlers.onSuccess(),
      error: () => handlers.onFailure(),
    });
  }
}
