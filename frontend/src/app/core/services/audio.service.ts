import { Injectable, computed, inject } from '@angular/core';
import { ConfigService } from './config.service';

@Injectable({ providedIn: 'root' })
export class AudioService {
  private readonly configService = inject(ConfigService);

  readonly musicVolume = computed(() => this.configService.config().musicVolume / 100);
  readonly effectsVolume = computed(() => this.configService.config().effectsVolume / 100);

  playMusic(_source: string): void {
    // Placeholder for the future music player.
  }

  stopMusic(): void {
    // Placeholder for stopping background music.
  }

  playEffect(_source: string): void {
    // Placeholder for small UI sounds such as the logo pop.
  }
}
