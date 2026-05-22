import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { timeout } from 'rxjs/operators';
import { environment } from '../../../environments/environment';

export interface HealthResponse {
  status: 'ok';
}

@Injectable({ providedIn: 'root' })
export class BackendHealthService {
  private readonly http = inject(HttpClient);

  check(): Observable<HealthResponse> {
    return this.http.get<HealthResponse>(`${environment.apiUrl}/health`).pipe(timeout(4000));
  }
}
