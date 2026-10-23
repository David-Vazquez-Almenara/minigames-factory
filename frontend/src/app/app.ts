import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ConfigService } from './core/services/config.service';
import { MusicDirectorService } from './core/services/music-director.service';
import { VolumeControlsComponent } from './shared/components/volume-controls/volume-controls.component';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, VolumeControlsComponent],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App {
  private readonly configService = inject(ConfigService);
  // Arranca el director de musica para toda la app.
  private readonly musicDirector = inject(MusicDirectorService);

  constructor() {
    this.configService.config();
  }
}
