import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { ConfigService } from './config.service';

export type SoundEffect =
  | 'tick'
  | 'spin-start'
  | 'spin-stop'
  | 'reveal'
  | 'select'
  | 'confirm'
  | 'turn'
  | 'vote-end'
  | 'whoosh'
  | 'impostor-reveal'
  | 'type'
  | 'points'
  | 'victory'
  | 'defeat'
  | 'pop'
  | 'pump'
  | 'burst'
  | 'horn';

export type MusicTrack = 'lobby' | 'roulette' | 'minigame' | 'scoreboard';
export type FileEffect = 'win' | 'lose';
/** Estado real de la musica: 'blocked' = el navegador no deja reproducir hasta que el usuario toque la pagina. */
export type MusicState = 'idle' | 'starting' | 'playing' | 'blocked';

// Archivos de audio: basta con dejarlos en frontend/public/assets/audio con estos nombres.
// Si falta alguno la app sigue funcionando (la musica no suena y los efectos usan su version sintetizada).
const MUSIC_FILES: Record<MusicTrack, string> = {
  lobby: 'assets/audio/musica-lobby.mp3',
  roulette: 'assets/audio/musica-ruleta.mp3',
  minigame: 'assets/audio/musica-minijuego.mp3',
  scoreboard: 'assets/audio/musica-marcador.mp3',
};
// Si una pista no existe se usa otra en su lugar (la de la ruleta es opcional: sin ella suena la de minijuego).
const TRACK_FALLBACK: Partial<Record<MusicTrack, MusicTrack>> = { roulette: 'minigame' };
const EFFECT_FILES: Record<FileEffect, { src: string; fallback: SoundEffect; gain: number }> = {
  win: { src: 'assets/audio/efecto-ganar.mp3', fallback: 'victory', gain: 0.85 },
  // El de perder viene mas fuerte que el de ganar: se baja un poco.
  lose: { src: 'assets/audio/efecto-perder.mp3', fallback: 'defeat', gain: 0.55 },
};
// La musica va por debajo de los efectos y de la voz en Discord.
const MUSIC_HEADROOM = 0.55;
// Ajuste por pista: la de minijuegos viene mas alta que las demas, asi que se atenua un poco.
const TRACK_GAIN: Record<MusicTrack, number> = {
  lobby: 1,
  roulette: 0.8,
  minigame: 0.65,
  scoreboard: 1,
};
const MUSIC_FADE_MS = 450;

// Volumen maximo de los efectos: suaves, pensados para sonar por debajo de una llamada de Discord.
const EFFECTS_HEADROOM = 0.32;
const MIN_GAP_MS: Partial<Record<SoundEffect, number>> = { tick: 38, type: 45, select: 60 };
// Cualquiera de estos gestos cuenta como interaccion para que el navegador permita reproducir audio.
const UNLOCK_EVENTS = ['pointerdown', 'keydown', 'touchend', 'click'];

@Injectable({ providedIn: 'root' })
export class AudioService {
  private readonly configService = inject(ConfigService);
  private context?: AudioContext;
  private master?: GainNode;
  private noiseBuffer?: AudioBuffer;
  private readonly lastPlayedAt = new Map<SoundEffect, number>();
  private music?: HTMLAudioElement;
  private currentTrack: MusicTrack | null = null;
  private musicBlocked = false;
  /** Todos los reproductores de musica vivos (incluidos los que se estan apagando), para poder pararlos en seco. */
  private readonly musicPlayers = new Set<HTMLAudioElement>();
  /** Pistas opcionales que no estan en la carpeta de audio (se usa su pista de reserva directamente). */
  private readonly missingTracks = new Set<MusicTrack>();

  readonly musicVolume = computed(() => this.configService.config().musicVolume / 100);
  readonly effectsVolume = computed(() => this.configService.config().effectsVolume / 100);
  readonly musicState = signal<MusicState>('idle');

  constructor() {
    // Los navegadores solo permiten audio tras un gesto del usuario: se desbloquea con el primero que haya.
    const unlock = () => {
      this.ensureContext();
      void this.context?.resume();

      // Si el navegador bloqueo la musica por falta de interaccion, se reintenta en este gesto.
      if (this.musicBlocked && this.music) {
        const audio = this.music;
        this.musicBlocked = false;
        this.startPlayback(audio);
      }
    };

    for (const eventName of UNLOCK_EVENTS) {
      window.addEventListener(eventName, unlock, { passive: true, capture: true });
    }

    // El volumen de la musica responde en tiempo real al slider.
    effect(() => {
      const volume = this.musicVolume();

      if (this.music && this.currentTrack && !this.music.dataset['fading']) {
        this.music.volume = this.trackVolume(this.currentTrack, volume);
      }
    });
  }

  /** Cambia la musica de fondo (en bucle). La anterior se apaga con un fundido; null deja silencio. */
  playMusic(requested: MusicTrack | null): void {
    const track = requested && this.missingTracks.has(requested) ? (TRACK_FALLBACK[requested] ?? requested) : requested;

    if (track === this.currentTrack) {
      return;
    }

    this.currentTrack = track;
    this.fadeOut(this.music);
    this.music = undefined;
    this.musicBlocked = false;

    if (!track) {
      this.musicState.set('idle');
      return;
    }

    const audio = new Audio(MUSIC_FILES[track]);
    audio.loop = true;
    audio.preload = 'auto';
    audio.volume = 0;
    audio.dataset['fading'] = 'in';
    this.music = audio;
    this.musicPlayers.add(audio);
    this.fadeIn(audio, track);

    const fallback = TRACK_FALLBACK[track];

    if (fallback) {
      // Pista opcional que no esta en la carpeta de audio: suena la de reserva (sin cortes al pedirla despues).
      audio.onerror = () => {
        this.missingTracks.add(track);

        if (audio === this.music) {
          this.releasePlayer(audio);
          this.currentTrack = null;
          this.playMusic(fallback);
        }
      };
    }

    this.startPlayback(audio);
  }

  private startPlayback(audio: HTMLAudioElement): void {
    this.musicState.set('starting');
    void audio
      .play()
      .then(() => {
        if (audio === this.music) {
          this.musicState.set('playing');
        }
      })
      .catch(() => {
        if (audio === this.music) {
          this.musicBlocked = true;
          this.musicState.set('blocked');
        }
      });
  }

  stopMusic(): void {
    this.playMusic(null);
  }

  /** true si la musica actual esta reproduciendose de verdad (no bloqueada ni en pausa). */
  isMusicPlaying(): boolean {
    return Boolean(this.music && !this.music.paused && !this.music.ended && !this.musicBlocked);
  }

  /**
   * Comprobacion de seguridad: si deberia sonar musica y no suena, la reinicia. Antes de arrancarla para en
   * seco cualquier reproductor que quedara vivo, para que nunca puedan sonar dos musicas a la vez.
   */
  ensureMusicPlaying(): void {
    const track = this.currentTrack;

    if (!track || this.isMusicPlaying()) {
      return;
    }

    this.stopAllMusicNow();
    this.currentTrack = null;
    this.playMusic(track);
  }

  /** Efecto de sonido desde archivo (ganar / perder); si el archivo no existe, usa el sintetizado. */
  playFileEffect(effect: FileEffect): void {
    const volume = this.effectsVolume();
    const { src, fallback, gain } = EFFECT_FILES[effect];

    if (volume <= 0) {
      return;
    }

    const audio = new Audio(src);
    audio.volume = Math.min(1, volume * gain);
    audio.onerror = () => this.playEffect(fallback);
    void audio.play().catch(() => undefined);
  }

  private trackVolume(track: MusicTrack, volume = this.musicVolume()): number {
    return Math.min(1, volume * MUSIC_HEADROOM * TRACK_GAIN[track]);
  }

  private stopAllMusicNow(): void {
    for (const audio of this.musicPlayers) {
      this.releasePlayer(audio);
    }

    this.musicPlayers.clear();
    this.music = undefined;
    this.musicBlocked = false;
  }

  private releasePlayer(audio: HTMLAudioElement): void {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    this.musicPlayers.delete(audio);
  }

  private fadeIn(audio: HTMLAudioElement, track: MusicTrack): void {
    this.rampVolume(audio, this.trackVolume(track), () => delete audio.dataset['fading']);
  }

  private fadeOut(audio: HTMLAudioElement | undefined): void {
    if (!audio) {
      return;
    }

    audio.dataset['fading'] = 'out';
    this.rampVolume(audio, 0, () => this.releasePlayer(audio));
  }

  private rampVolume(audio: HTMLAudioElement, target: number, done: () => void): void {
    // Con intervalos (y no requestAnimationFrame) el fundido termina aunque la pestana este en segundo plano.
    const start = audio.volume;
    const startedAt = performance.now();
    const timer = setInterval(() => {
      // Si alguien paro este reproductor en seco, el fundido ya no tiene sentido.
      if (!this.musicPlayers.has(audio)) {
        clearInterval(timer);
        return;
      }

      const progress = Math.min(1, (performance.now() - startedAt) / MUSIC_FADE_MS);
      audio.volume = Math.max(0, Math.min(1, start + (target - start) * progress));

      if (progress >= 1) {
        clearInterval(timer);
        done();
      }
    }, 30);
  }

  playEffect(effect: SoundEffect): void {
    const volume = this.effectsVolume();

    if (volume <= 0) {
      return;
    }

    const now = performance.now();
    const minGap = MIN_GAP_MS[effect] || 0;

    if (minGap && now - (this.lastPlayedAt.get(effect) || 0) < minGap) {
      return;
    }

    this.lastPlayedAt.set(effect, now);

    try {
      const context = this.ensureContext();

      if (!context || !this.master || context.state !== 'running') {
        return;
      }

      this.master.gain.setValueAtTime(volume * EFFECTS_HEADROOM, context.currentTime);
      this.renderEffect(effect, context, context.currentTime + 0.005);
    } catch {
      // El audio es decorativo: un fallo nunca debe afectar a la partida.
    }
  }

  /** Motor de coche que se acerca y se aleja: sube de volumen y de tono y despues se apaga poco a poco. */
  playEngine(durationMs: number): void {
    const volume = this.effectsVolume();

    if (volume <= 0) {
      return;
    }

    try {
      const context = this.ensureContext();

      if (!context || !this.master || context.state !== 'running') {
        return;
      }

      const at = context.currentTime + 0.01;
      const duration = Math.max(0.6, durationMs / 1000);
      this.master.gain.setValueAtTime(volume * EFFECTS_HEADROOM, at);
      const oscillator = context.createOscillator();
      const filter = context.createBiquadFilter();
      const gain = context.createGain();
      oscillator.type = 'sawtooth';
      oscillator.frequency.setValueAtTime(55, at);
      oscillator.frequency.linearRampToValueAtTime(95, at + duration * 0.5);
      oscillator.frequency.linearRampToValueAtTime(60, at + duration);
      filter.type = 'lowpass';
      filter.frequency.value = 520;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.55, at + duration * 0.5);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
      oscillator.connect(filter).connect(gain).connect(this.master);
      oscillator.start(at);
      oscillator.stop(at + duration + 0.05);
      this.noise(context, at, { duration, from: 300, to: 900, gain: 0.25 });
    } catch {
      // El audio es decorativo: un fallo nunca debe afectar a la partida.
    }
  }

  private ensureContext(): AudioContext | undefined {
    if (this.context) {
      return this.context;
    }

    const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

    if (!AudioContextClass) {
      return undefined;
    }

    this.context = new AudioContextClass();
    this.master = this.context.createGain();
    this.master.connect(this.context.destination);
    return this.context;
  }

  private renderEffect(effect: SoundEffect, context: AudioContext, at: number): void {
    switch (effect) {
      case 'tick':
        this.tone(context, at, { frequency: 1850, duration: 0.035, type: 'square', gain: 0.18 });
        break;
      case 'select':
        this.tone(context, at, { frequency: 660, endFrequency: 880, duration: 0.07, type: 'triangle', gain: 0.45 });
        break;
      case 'pop':
        this.tone(context, at, { frequency: 420, endFrequency: 980, duration: 0.09, type: 'sine', gain: 0.55 });
        break;
      case 'confirm':
        this.tone(context, at, { frequency: 587, duration: 0.09, type: 'triangle', gain: 0.5 });
        this.tone(context, at + 0.08, { frequency: 880, duration: 0.14, type: 'triangle', gain: 0.5 });
        break;
      case 'turn':
        this.tone(context, at, { frequency: 523, duration: 0.12, type: 'sine', gain: 0.5 });
        this.tone(context, at + 0.1, { frequency: 784, duration: 0.18, type: 'sine', gain: 0.45 });
        break;
      case 'spin-start':
        this.noise(context, at, { duration: 0.45, from: 400, to: 2600, gain: 0.35 });
        this.tone(context, at, { frequency: 220, endFrequency: 660, duration: 0.35, type: 'sawtooth', gain: 0.12 });
        break;
      case 'spin-stop':
        this.tone(context, at, { frequency: 330, duration: 0.08, type: 'square', gain: 0.25 });
        this.tone(context, at + 0.06, { frequency: 247, duration: 0.12, type: 'square', gain: 0.2 });
        break;
      case 'reveal':
        [523, 659, 784, 1047].forEach((frequency, index) =>
          this.tone(context, at + index * 0.07, { frequency, duration: 0.22, type: 'triangle', gain: 0.4 }),
        );
        break;
      case 'vote-end':
        this.tone(context, at, { frequency: 392, duration: 0.18, type: 'triangle', gain: 0.45 });
        this.tone(context, at + 0.16, { frequency: 294, duration: 0.3, type: 'triangle', gain: 0.4 });
        break;
      case 'whoosh':
        this.noise(context, at, { duration: 1.1, from: 300, to: 1800, gain: 0.5 });
        break;
      case 'impostor-reveal':
        this.tone(context, at, { frequency: 110, duration: 0.45, type: 'sawtooth', gain: 0.22 });
        this.tone(context, at + 0.42, { frequency: 104, duration: 0.8, type: 'sawtooth', gain: 0.22 });
        this.tone(context, at + 0.42, { frequency: 156, duration: 0.8, type: 'triangle', gain: 0.25 });
        break;
      case 'type':
        this.noise(context, at, { duration: 0.025, from: 2500, to: 2500, gain: 0.25 });
        break;
      case 'points':
        [784, 988, 1319].forEach((frequency, index) =>
          this.tone(context, at + index * 0.06, { frequency, duration: 0.12, type: 'sine', gain: 0.35 }),
        );
        break;
      case 'victory':
        [523, 659, 784, 1047, 784, 1047].forEach((frequency, index) =>
          this.tone(context, at + index * 0.11, { frequency, duration: index === 5 ? 0.5 : 0.16, type: 'triangle', gain: 0.4 }),
        );
        break;
      case 'defeat':
        [392, 349, 311, 262].forEach((frequency, index) =>
          this.tone(context, at + index * 0.17, { frequency, duration: index === 3 ? 0.6 : 0.2, type: 'triangle', gain: 0.38 }),
        );
        break;
      case 'pump':
        // Bombazo de aire: soplido que sube y un golpecito seco de la palanca.
        this.noise(context, at, { duration: 0.32, from: 500, to: 2200, gain: 0.42 });
        this.tone(context, at, { frequency: 140, endFrequency: 90, duration: 0.08, type: 'square', gain: 0.22 });
        break;
      case 'burst':
        // Explosion del globo: golpe grave y estallido de ruido.
        this.noise(context, at, { duration: 0.6, from: 4200, to: 220, gain: 0.95 });
        this.tone(context, at, { frequency: 120, endFrequency: 38, duration: 0.45, type: 'sine', gain: 0.9 });
        break;
      case 'horn':
        // Claxon de coche: dos pitidos de dos notas a la vez.
        for (const start of [0, 0.32]) {
          this.tone(context, at + start, { frequency: 392, duration: 0.24, type: 'square', gain: 0.22 });
          this.tone(context, at + start, { frequency: 494, duration: 0.24, type: 'square', gain: 0.18 });
        }
        break;
    }
  }

  private tone(
    context: AudioContext,
    at: number,
    options: { frequency: number; endFrequency?: number; duration: number; type: OscillatorType; gain: number },
  ): void {
    const oscillator = context.createOscillator();
    const gain = context.createGain();

    oscillator.type = options.type;
    oscillator.frequency.setValueAtTime(options.frequency, at);

    if (options.endFrequency) {
      oscillator.frequency.exponentialRampToValueAtTime(options.endFrequency, at + options.duration);
    }

    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(options.gain, at + Math.min(0.015, options.duration / 3));
    gain.gain.exponentialRampToValueAtTime(0.0001, at + options.duration);
    oscillator.connect(gain).connect(this.master!);
    oscillator.start(at);
    oscillator.stop(at + options.duration + 0.02);
  }

  private noise(context: AudioContext, at: number, options: { duration: number; from: number; to: number; gain: number }): void {
    const source = context.createBufferSource();
    const filter = context.createBiquadFilter();
    const gain = context.createGain();

    source.buffer = this.getNoiseBuffer(context);
    filter.type = 'bandpass';
    filter.Q.value = 1.4;
    filter.frequency.setValueAtTime(options.from, at);
    filter.frequency.exponentialRampToValueAtTime(options.to, at + options.duration);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(options.gain, at + options.duration * 0.35);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + options.duration);
    source.connect(filter).connect(gain).connect(this.master!);
    source.start(at);
    source.stop(at + options.duration + 0.02);
  }

  private getNoiseBuffer(context: AudioContext): AudioBuffer {
    if (!this.noiseBuffer) {
      this.noiseBuffer = context.createBuffer(1, context.sampleRate * 1.2, context.sampleRate);
      const data = this.noiseBuffer.getChannelData(0);

      for (let index = 0; index < data.length; index += 1) {
        data[index] = Math.random() * 2 - 1;
      }
    }

    return this.noiseBuffer;
  }
}
