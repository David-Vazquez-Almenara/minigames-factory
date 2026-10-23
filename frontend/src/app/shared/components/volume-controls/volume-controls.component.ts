import { Component, computed, inject } from '@angular/core';
import { AudioService } from '../../../core/services/audio.service';
import { ConfigService } from '../../../core/services/config.service';

const DEFAULT_RESTORE_VOLUME = 50;

/**
 * Control de volumen siempre visible (arriba a la izquierda) para la musica y los efectos.
 * Los valores viven en ConfigService, que ya los guarda en localStorage y los recupera al recargar.
 */
@Component({
  selector: 'app-volume-controls',
  templateUrl: './volume-controls.component.html',
  styleUrl: './volume-controls.component.scss',
})
export class VolumeControlsComponent {
  private readonly configService = inject(ConfigService);
  private readonly audioService = inject(AudioService);
  private restoreMusic = DEFAULT_RESTORE_VOLUME;
  private restoreEffects = DEFAULT_RESTORE_VOLUME;

  readonly musicVolume = computed(() => this.configService.config().musicVolume);
  readonly effectsVolume = computed(() => this.configService.config().effectsVolume);

  setMusic(value: string | number): void {
    this.configService.updateMusicVolume(Number(value));
  }

  setEffects(value: string | number): void {
    this.configService.updateEffectsVolume(Number(value));
  }

  /** Previsualiza el volumen de efectos al soltar el slider. */
  previewEffects(): void {
    this.audioService.playEffect('pop');
  }

  toggleMusic(): void {
    if (this.musicVolume() > 0) {
      this.restoreMusic = this.musicVolume();
      this.setMusic(0);
    } else {
      this.setMusic(this.restoreMusic || DEFAULT_RESTORE_VOLUME);
    }
  }

  toggleEffects(): void {
    if (this.effectsVolume() > 0) {
      this.restoreEffects = this.effectsVolume();
      this.setEffects(0);
    } else {
      this.setEffects(this.restoreEffects || DEFAULT_RESTORE_VOLUME);
      this.previewEffects();
    }
  }
}
