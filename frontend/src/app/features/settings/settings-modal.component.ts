import { Component, computed, inject, output } from '@angular/core';
import { ConfigService, Language, TextSize } from '../../core/services/config.service';

@Component({
  selector: 'app-settings-modal',
  imports: [],
  templateUrl: './settings-modal.component.html',
  styleUrl: './settings-modal.component.scss',
})
export class SettingsModalComponent {
  private readonly configService = inject(ConfigService);

  readonly config = computed(() => this.configService.config());
  readonly textSizes: Array<{ value: TextSize; label: string }> = [
    { value: 'small', label: 'Pequeno' },
    { value: 'normal', label: 'Normal' },
    { value: 'large', label: 'Grande' },
  ];

  readonly closed = output<void>();

  close(): void {
    this.closed.emit();
  }

  onMusicVolumeChange(event: Event): void {
    this.configService.updateMusicVolume(Number((event.target as HTMLInputElement).value));
  }

  onEffectsVolumeChange(event: Event): void {
    this.configService.updateEffectsVolume(Number((event.target as HTMLInputElement).value));
  }

  onLanguageChange(event: Event): void {
    this.configService.updateLanguage((event.target as HTMLSelectElement).value as Language);
  }

  onTextSizeChange(event: Event): void {
    this.configService.updateTextSize((event.target as HTMLSelectElement).value as TextSize);
  }

  onHighContrastChange(event: Event): void {
    this.configService.updateHighContrastMode((event.target as HTMLInputElement).checked);
  }
}
