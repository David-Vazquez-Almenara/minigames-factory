import { Component, OnDestroy, OnInit, inject, input, signal } from '@angular/core';
import { AudioService } from '../../../../../core/services/audio.service';
import { CrewmateComponent } from '../../../../../shared/components/crewmate/crewmate.component';

const TEXT_START_MS = 2300;
const CHAR_MS = 55;

/** Escena de expulsion inspirada en Among Us: el tripulante cruza el espacio girando mientras se escribe el veredicto. */
@Component({
  selector: 'app-ejection',
  imports: [CrewmateComponent],
  templateUrl: './ejection.component.html',
  styleUrl: './ejection.component.scss',
})
export class EjectionComponent implements OnInit, OnDestroy {
  private readonly audioService = inject(AudioService);
  private timers: ReturnType<typeof setTimeout>[] = [];

  /** Color del expulsado; null cuando nadie sale por la escotilla. */
  readonly ejectedColor = input<string | null>(null);
  readonly text = input.required<string>();
  readonly subtitle = input('');
  /** Marca el golpe final de sonido cuando el texto revela algo importante. */
  readonly dramatic = input(false);

  readonly typedText = signal('');
  readonly showSubtitle = signal(false);
  readonly stars = Array.from({ length: 60 }, (_unused, index) => ({
    top: (index * 47) % 100,
    left: (index * 61) % 100,
    size: 1 + (index % 3),
    delay: (index % 9) * 200,
  }));

  ngOnInit(): void {
    if (this.ejectedColor()) {
      this.audioService.playEffect('whoosh');
    }

    const fullText = this.text();
    [...fullText].forEach((_character, index) => {
      this.timers.push(
        setTimeout(() => {
          this.typedText.set(fullText.slice(0, index + 1));
          this.audioService.playEffect('type');
        }, TEXT_START_MS + index * CHAR_MS),
      );
    });

    this.timers.push(
      setTimeout(() => {
        this.showSubtitle.set(true);

        if (this.dramatic()) {
          this.audioService.playEffect('impostor-reveal');
        }
      }, TEXT_START_MS + fullText.length * CHAR_MS + 450),
    );
  }

  ngOnDestroy(): void {
    for (const timer of this.timers) {
      clearTimeout(timer);
    }

    this.timers = [];
  }
}
