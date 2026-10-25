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

/** Efectos de sonido grabados en assets/audio/efectos (se regeneran con scripts/generate-sfx.mjs). */
export type SfxName =
  | 'boton'
  | 'acierto'
  | 'entregar'
  | 'voto'
  | 'carta-repartir'
  | 'carta-voltear'
  | 'fichas'
  | 'barril-cayendo'
  | 'cuerda-freno'
  | 'aplastar'
  | 'globo-inflar'
  | 'globo-explotar'
  | 'palanca'
  | 'pasos'
  | 'cubilete-deslizar'
  | 'cubilete-levantar'
  | 'bola-rodar'
  | 'salto-carril'
  | 'atropello'
  | 'muelle'
  | 'disparo'
  | 'timbre'
  | 'cristal'
  | 'deslizar'
  | 'corte'
  | 'yuju'
  | 'bolos'
  | 'cacareo'
  | 'campana-tren'
  | 'tren'
  | 'lanzar'
  | 'clavar'
  | 'rebote'
  | 'chapuzon'
  | 'clic'
  | 'tambor'
  | 'martillo'
  | 'recarga'
  | 'bala';

/** Control de un efecto en curso (para cortarlo, p. ej. el silbido del barril al frenarlo). */
export interface SfxHandle {
  stop(fadeMs?: number): void;
}

/** 'minigame:<id>' es la musica propia de un minijuego (opcional; si no existe suena la de minijuego normal). */
export type MusicTrack = 'lobby' | 'roulette' | 'minigame' | 'scoreboard' | `minigame:${string}`;
type BaseTrack = 'lobby' | 'roulette' | 'minigame' | 'scoreboard';
export type FileEffect = 'win' | 'lose';
/** Estado real de la musica: 'blocked' = el navegador no deja reproducir hasta que el usuario toque la pagina. */
export type MusicState = 'idle' | 'starting' | 'playing' | 'blocked';

// Archivos de audio: basta con dejarlos en frontend/public/assets/audio con estos nombres.
// Si falta alguno la app sigue funcionando (la musica no suena y los efectos usan su version sintetizada).
const MUSIC_FILES: Record<BaseTrack, string> = {
  lobby: 'assets/audio/musica-lobby.mp3',
  roulette: 'assets/audio/musica-ruleta.mp3',
  minigame: 'assets/audio/musica-minijuego.mp3',
  scoreboard: 'assets/audio/musica-marcador.mp3',
};
// Musica propia de un minijuego: assets/audio/sonido-minijuegos/<id del minijuego>.mp3 (p. ej. dance.mp3).
const MINIGAME_MUSIC_DIR = 'assets/audio/sonido-minijuegos/';
const isMinigameTrack = (track: MusicTrack): track is `minigame:${string}` => track.startsWith('minigame:');
const musicFile = (track: MusicTrack) => (isMinigameTrack(track) ? `${MINIGAME_MUSIC_DIR}${track.slice('minigame:'.length)}.mp3` : MUSIC_FILES[track]);
// Si una pista no existe se usa otra en su lugar: la de la ruleta y las propias de cada minijuego son opcionales.
const trackFallback = (track: MusicTrack): MusicTrack | undefined => (track === 'roulette' || isMinigameTrack(track) ? 'minigame' : undefined);
const EFFECT_FILES: Record<FileEffect, { src: string; fallback: SoundEffect; gain: number }> = {
  win: { src: 'assets/audio/efecto-ganar.mp3', fallback: 'victory', gain: 0.85 },
  // El de perder viene mas fuerte que el de ganar: se baja un poco.
  lose: { src: 'assets/audio/efecto-perder.mp3', fallback: 'defeat', gain: 0.55 },
};
// La musica va por debajo de los efectos y de la voz en Discord.
const MUSIC_HEADROOM = 0.55;
// Ajuste por pista: la de minijuegos viene mas alta que las demas, asi que se atenua un poco.
const TRACK_GAIN: Record<BaseTrack, number> = {
  lobby: 1,
  roulette: 0.8,
  minigame: 0.65,
  scoreboard: 1,
};
const CUSTOM_TRACK_GAIN = 0.75;
// Musicas propias que vienen mas bajas que el resto: se suben un poco (multiplica a CUSTOM_TRACK_GAIN).
const CUSTOM_TRACK_BOOST: Record<string, number> = {
  duel: 1.35,
};
const MUSIC_FADE_MS = 450;

// Volumen maximo de los efectos: suaves, pensados para sonar por debajo de una llamada de Discord.
const EFFECTS_HEADROOM = 0.32;
const SFX_DIR = 'assets/audio/efectos/';
// Ajuste de volumen por efecto (los archivos vienen normalizados al mismo pico).
const SFX_GAIN: Record<SfxName, number> = {
  boton: 0.45,
  acierto: 0.9,
  entregar: 0.8,
  voto: 0.85,
  'carta-repartir': 0.8,
  'carta-voltear': 0.8,
  fichas: 0.75,
  'barril-cayendo': 0.5,
  'cuerda-freno': 0.95,
  aplastar: 1,
  'globo-inflar': 0.75,
  'globo-explotar': 1.1,
  palanca: 0.8,
  pasos: 0.7,
  'cubilete-deslizar': 0.5,
  'cubilete-levantar': 0.9,
  'bola-rodar': 0.9,
  'salto-carril': 0.8,
  atropello: 1,
  muelle: 0.75,
  disparo: 1,
  timbre: 0.6,
  cristal: 0.8,
  deslizar: 0.7,
  corte: 0.7,
  yuju: 0.7,
  bolos: 0.9,
  cacareo: 0.5,
  'campana-tren': 0.6,
  tren: 0.85,
  lanzar: 0.7,
  clavar: 0.8,
  rebote: 0.7,
  chapuzon: 0.85,
  clic: 0.9,
  tambor: 0.7,
  martillo: 0.7,
  recarga: 0.7,
  bala: 0.85,
};
const SFX_NAMES = Object.keys(SFX_GAIN) as SfxName[];
// Si un efecto aun no se ha descargado al pedirlo, solo se reproduce si llega a tiempo (si no, ya no viene a cuento).
const SFX_LATE_LIMIT_MS = 250;
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
  private readonly sfxBuffers = new Map<SfxName, AudioBuffer>();
  private readonly sfxLoading = new Map<SfxName, Promise<AudioBuffer | null>>();
  /** Ultima vez que sono cualquier efecto: el click generico de los botones no se solapa con otro sonido. */
  private lastAnyEffectAt = 0;

  readonly musicVolume = computed(() => this.configService.config().musicVolume / 100);
  readonly effectsVolume = computed(() => this.configService.config().effectsVolume / 100);
  readonly musicState = signal<MusicState>('idle');

  constructor() {
    // Los navegadores solo permiten audio tras un gesto del usuario: se desbloquea con el primero que haya.
    const unlock = () => {
      this.ensureContext();
      void this.context?.resume();
      this.preloadSfx();

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

    // Click suave en cualquier boton de la interfaz. Se escucha en la fase de burbuja (despues del manejador del
    // propio boton): si ese manejador ya ha sonado algo, no se anade el click. data-sfx="off" lo desactiva.
    window.addEventListener('click', (event) => {
      const button = (event.target as Element | null)?.closest?.('button, [role="button"]');

      if (!button || button.matches(':disabled, [data-sfx="off"]') || performance.now() - this.lastAnyEffectAt < 60) {
        return;
      }

      this.playSfx('boton');
    });

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
    const track = requested && this.missingTracks.has(requested) ? (trackFallback(requested) ?? requested) : requested;

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

    const audio = new Audio(musicFile(track));
    audio.loop = true;
    audio.preload = 'auto';
    audio.volume = 0;
    audio.dataset['fading'] = 'in';
    this.music = audio;
    this.musicPlayers.add(audio);
    this.fadeIn(audio, track);

    const fallback = trackFallback(track);

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

    this.lastAnyEffectAt = performance.now();
    const audio = new Audio(src);
    audio.volume = Math.min(1, volume * gain);
    audio.onerror = () => this.playEffect(fallback);
    void audio.play().catch(() => undefined);
  }

  private trackVolume(track: MusicTrack, volume = this.musicVolume()): number {
    const gain = isMinigameTrack(track) ? CUSTOM_TRACK_GAIN * (CUSTOM_TRACK_BOOST[track.slice('minigame:'.length)] ?? 1) : TRACK_GAIN[track];
    return Math.min(1, volume * MUSIC_HEADROOM * gain);
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
    this.lastAnyEffectAt = now;

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

  /**
   * Efecto de sonido de la carpeta de efectos (va con el volumen de efectos, nunca con el de musica).
   * rate cambia velocidad y tono (1 = original); gain ajusta el volumen de esta reproduccion.
   */
  playSfx(name: SfxName, options: { rate?: number; gain?: number } = {}): SfxHandle {
    let source: AudioBufferSourceNode | undefined;
    let output: GainNode | undefined;
    let stopped = false;
    const handle: SfxHandle = {
      stop: (fadeMs = 60) => {
        stopped = true;

        if (!source || !output || !this.context) {
          return;
        }

        const now = this.context.currentTime;
        output.gain.cancelScheduledValues(now);
        output.gain.setValueAtTime(output.gain.value, now);
        output.gain.linearRampToValueAtTime(0, now + fadeMs / 1000);
        source.stop(now + fadeMs / 1000 + 0.02);
      },
    };
    const volume = this.effectsVolume();

    if (volume <= 0) {
      return handle;
    }

    const requestedAt = performance.now();
    this.lastAnyEffectAt = requestedAt;

    const start = (buffer: AudioBuffer | null) => {
      const context = this.context;

      if (!buffer || stopped || !context || !this.master || context.state !== 'running' || performance.now() - requestedAt > SFX_LATE_LIMIT_MS) {
        return;
      }

      try {
        this.master.gain.setValueAtTime(this.effectsVolume() * EFFECTS_HEADROOM, context.currentTime);
        source = context.createBufferSource();
        output = context.createGain();
        source.buffer = buffer;
        source.playbackRate.value = options.rate ?? 1;
        output.gain.value = SFX_GAIN[name] * (options.gain ?? 1);
        source.connect(output).connect(this.master);
        source.start();
      } catch {
        // El audio es decorativo: un fallo nunca debe afectar a la partida.
      }
    };

    const ready = this.sfxBuffers.get(name);

    if (ready) {
      start(ready);
    } else {
      void this.loadSfx(name).then(start);
    }

    return handle;
  }

  /** Descarga y decodifica todos los efectos de una vez (son pequenos) para que suenen sin retraso. */
  private preloadSfx(): void {
    if (this.sfxLoading.size < SFX_NAMES.length) {
      SFX_NAMES.forEach((name) => void this.loadSfx(name));
    }
  }

  private loadSfx(name: SfxName): Promise<AudioBuffer | null> {
    const cached = this.sfxLoading.get(name);

    if (cached) {
      return cached;
    }

    const context = this.ensureContext();
    const loading = context
      ? fetch(`${SFX_DIR}${name}.wav`)
          .then((response) => (response.ok ? response.arrayBuffer() : Promise.reject(new Error(response.statusText))))
          .then((data) => context.decodeAudioData(data))
          .then((buffer) => {
            this.sfxBuffers.set(name, buffer);
            return buffer;
          })
          .catch(() => {
            // Si falta el archivo se vuelve a intentar la proxima vez.
            this.sfxLoading.delete(name);
            return null;
          })
      : Promise.resolve(null);

    if (context) {
      this.sfxLoading.set(name, loading);
    }

    return loading;
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
