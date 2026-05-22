import { DOCUMENT } from '@angular/common';
import { Injectable, computed, effect, inject, signal } from '@angular/core';

export type Language = 'es' | 'en';
export type TextSize = 'small' | 'normal' | 'large';

export interface GameConfig {
  musicVolume: number;
  effectsVolume: number;
  language: Language;
  textSize: TextSize;
  highContrastMode: boolean;
}

const STORAGE_KEY = 'quien-soy-online-config';

const DEFAULT_CONFIG: GameConfig = {
  musicVolume: 50,
  effectsVolume: 50,
  language: 'es',
  textSize: 'normal',
  highContrastMode: false,
};

@Injectable({ providedIn: 'root' })
export class ConfigService {
  private readonly document = inject(DOCUMENT);
  private readonly configState = signal<GameConfig>(this.loadConfig());

  readonly config = computed(() => this.configState());

  constructor() {
    effect(() => {
      const config = this.configState();
      localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
      this.applyGlobalClasses(config);
    });
  }

  updateMusicVolume(value: number): void {
    this.updateConfig({ musicVolume: this.clampVolume(value) });
  }

  updateEffectsVolume(value: number): void {
    this.updateConfig({ effectsVolume: this.clampVolume(value) });
  }

  updateLanguage(value: Language): void {
    this.updateConfig({ language: value });
  }

  updateTextSize(value: TextSize): void {
    this.updateConfig({ textSize: value });
  }

  updateHighContrastMode(value: boolean): void {
    this.updateConfig({ highContrastMode: value });
  }

  private updateConfig(partialConfig: Partial<GameConfig>): void {
    this.configState.update((currentConfig) => ({
      ...currentConfig,
      ...partialConfig,
    }));
  }

  private loadConfig(): GameConfig {
    const savedConfig = localStorage.getItem(STORAGE_KEY);

    if (!savedConfig) {
      return DEFAULT_CONFIG;
    }

    try {
      return {
        ...DEFAULT_CONFIG,
        ...JSON.parse(savedConfig),
      };
    } catch {
      return DEFAULT_CONFIG;
    }
  }

  private applyGlobalClasses(config: GameConfig): void {
    const root = this.document.documentElement;

    root.classList.toggle('high-contrast-mode', config.highContrastMode);
    root.classList.remove('text-size-small', 'text-size-normal', 'text-size-large');
    root.classList.add(`text-size-${config.textSize}`);
  }

  private clampVolume(value: number): number {
    return Math.max(0, Math.min(100, Number(value)));
  }
}
