import { Component } from '@angular/core';
import { MinigameContainerComponent } from '../minigames/shared/minigame-container/minigame-container.component';

@Component({
  selector: 'app-special-round',
  imports: [MinigameContainerComponent],
  templateUrl: './special-round.component.html',
  styleUrl: './special-round.component.scss',
})
export class SpecialRoundComponent {}
