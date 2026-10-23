import { Component, computed, inject, signal } from '@angular/core';
import { AudioService } from '../../../core/services/audio.service';
import { MatchService } from '../../../core/services/match.service';
import { RouletteItem, RouletteStripComponent } from '../../../shared/components/roulette-strip/roulette-strip.component';

@Component({
  selector: 'app-minigame-roulette',
  imports: [RouletteStripComponent],
  templateUrl: './minigame-roulette.component.html',
  styleUrl: './minigame-roulette.component.scss',
})
export class MinigameRouletteComponent {
  private readonly matchService = inject(MatchService);
  private readonly audioService = inject(AudioService);

  readonly match = this.matchService.match;
  readonly roulette = computed(() => this.match()?.roulette || null);
  readonly items = computed<RouletteItem[]>(() =>
    (this.roulette()?.options || []).map((option) => ({
      key: option.id,
      label: option.title,
      image: option.image,
      accent: option.accent,
    })),
  );
  readonly landedMinigameId = signal('');
  // El texto revelado sale del ganador que confirma la propia tira al frenar, no de un calculo aparte.
  readonly revealedMinigame = computed(() => {
    const landedId = this.landedMinigameId();
    const roulette = this.roulette();

    return landedId && roulette?.winnerId === landedId
      ? roulette.options.find((option) => option.id === landedId) || null
      : null;
  });

  onLanded(minigameId: string): void {
    this.landedMinigameId.set(minigameId);
    this.audioService.playEffect('reveal');
  }
}
