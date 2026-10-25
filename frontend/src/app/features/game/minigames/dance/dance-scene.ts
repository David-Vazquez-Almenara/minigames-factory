import type * as ThreeModule from 'three';
import { MiiMood, MiiRig, createFaceTexture } from '../../../../shared/components/mii-stage/mii-rig';
import { CameraDirector, CameraGoal, ViewInsets } from '../../../../shared/three/camera-director';

type Three = typeof ThreeModule;
type Vector3 = ThreeModule.Vector3;

// Huecos del escenario: el primero (fila delantera, centro) es siempre el del jugador local. Despues se llenan los
// lados de la fila delantera, la fila del medio y la del fondo. Si hay mas jugadores que huecos, el resto no se carga.
const SLOTS: Array<[number, number]> = [
  // El jugador local, algo adelantado respecto al resto de la fila para que se distinga.
  [0, 2.45],
  [-1.6, 1.7],
  [1.6, 1.7],
  [-3.2, 1.7],
  [3.2, 1.7],
  [-0.8, 0.2],
  [0.8, 0.2],
  [-2.4, 0.2],
  [2.4, 0.2],
  [0, -1.3],
  [-1.6, -1.3],
  [1.6, -1.3],
  [-3.2, -1.3],
  [3.2, -1.3],
];
export const DANCE_MAX_VISIBLE = SLOTS.length;
const STAGE_WIDTH = 10;
const STAGE_DEPTH = 6.4;
const EXIT_X = 8.5;
const WALK_SPEED = 3.4;
// Antes de irse del escenario se quedan un momento cabizbajos.
const SAD_BEFORE_EXIT_MS = 1100;
const FOV = 40;
const LIGHT_COLORS = ['#ff4fd8', '#ffd23f', '#4fc3ff', '#7dff6a', '#ff7a3d'];

export interface DancePlayerView {
  playerId: string;
  name: string;
  avatarUrl: string;
  shirt: string;
  isLocal: boolean;
}

export type DancerMood = 'idle' | 'dance' | 'sad' | 'clap' | 'happy';

export interface DanceSceneState {
  /** Estado de cada jugador visible: como se mueve y si ya se ha ido (o se va) del escenario. */
  dancers: Array<{ playerId: string; mood: DancerMood; out: boolean }>;
}

type DancerMode = 'stage' | 'leaving' | 'gone';

interface Dancer {
  view: DancePlayerView;
  holder: ThreeModule.Group;
  rig: MiiRig;
  pool: ThreeModule.Mesh;
  home: Vector3;
  mode: DancerMode;
  mood: DancerMood;
  outSince: number | null;
  /** Estilo de baile propio, para que no se muevan todos igual. */
  style: number;
}

interface Beam {
  pivot: ThreeModule.Group;
  speed: number;
  phase: number;
}

/**
 * Escena 3D de "Pista de baile": escenario de discoteca con focos, columnas de luces y los jugadores en filas.
 * Solo representa lo que le pasa el componente; los bailes y las salidas se animan aqui, sin red.
 */
export class DanceScene {
  private readonly renderer: ThreeModule.WebGLRenderer;
  private readonly scene: ThreeModule.Scene;
  private readonly camera: ThreeModule.PerspectiveCamera;
  private readonly director: CameraDirector;
  private readonly dancers = new Map<string, Dancer>();
  private readonly disposables: Array<{ dispose: () => void }> = [];
  private readonly resizeObserver: ResizeObserver;
  private readonly scratch: Vector3;
  private readonly beams: Beam[] = [];
  private readonly bulbs: ThreeModule.MeshBasicMaterial[] = [];
  private readonly pillarMaterials: ThreeModule.MeshBasicMaterial[] = [];
  private readonly spots: ThreeModule.SpotLight[] = [];
  private insets: ViewInsets = { top: 0, right: 0, bottom: 0, left: 0 };
  private frameHandle = 0;
  private lastFrame = performance.now();
  private pulseAt = -Infinity;
  private disposed = false;

  constructor(
    private readonly THREE: Three,
    canvas: HTMLCanvasElement,
    private readonly host: HTMLElement,
    private readonly labelLayer: HTMLElement,
    players: DancePlayerView[],
    proxyBase: string,
  ) {
    const T = THREE;
    this.renderer = new T.WebGLRenderer({ canvas, antialias: true });
    // Prioridad al rendimiento: resolucion limitada en pantallas muy densas.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    this.renderer.outputColorSpace = T.SRGBColorSpace;
    this.scene = new T.Scene();
    this.scene.background = new T.Color('#07071a');
    this.camera = new T.PerspectiveCamera(FOV, 1, 0.1, 120);
    this.director = new CameraDirector(T, this.camera);
    this.scratch = new T.Vector3();

    this.buildStage();
    this.buildLights();

    const time = performance.now() / 1000;
    players.slice(0, SLOTS.length).forEach((view, index) => this.createDancer(view, index, time + 0.1 + index * 0.06, proxyBase));

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();
    this.director.focus('stage', () => this.stageGoal(), performance.now());
    this.loop();
  }

  sync(state: DanceSceneState): void {
    if (this.disposed) {
      return;
    }

    const now = performance.now();

    for (const entry of state.dancers) {
      const dancer = this.dancers.get(entry.playerId);

      if (!dancer) {
        continue;
      }

      dancer.mood = entry.mood;

      if (entry.out && dancer.mode === 'stage' && dancer.outSince === null) {
        dancer.outSince = now;
      } else if (!entry.out) {
        dancer.outSince = null;
      }
    }
  }

  /** Quien ya estaba eliminado al cargar la escena no aparece en el escenario. */
  removeNow(playerId: string): void {
    const dancer = this.dancers.get(playerId);

    if (dancer) {
      dancer.mode = 'gone';
      dancer.holder.visible = false;
      dancer.pool.visible = false;
    }
  }

  /** Rebote del jugador local y destello de las luces en cada acierto. */
  pulse(): void {
    this.pulseAt = performance.now();
  }

  setInsets(insets: ViewInsets): void {
    this.insets = insets;
    this.director.setViewport(this.host.clientWidth, this.host.clientHeight, insets);
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frameHandle);
    this.resizeObserver.disconnect();

    for (const dancer of this.dancers.values()) {
      dancer.rig.dispose();
    }

    for (const item of this.disposables) {
      item.dispose();
    }

    this.dancers.clear();
    this.scene.clear();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }

  /* ------------------------------ Construccion ------------------------------ */

  private canvasTexture(width: number, height: number, draw: (context: CanvasRenderingContext2D) => void): ThreeModule.CanvasTexture {
    const T = this.THREE;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    draw(canvas.getContext('2d')!);
    const texture = this.track(new T.CanvasTexture(canvas));
    texture.colorSpace = T.SRGBColorSpace;
    return texture;
  }

  private buildStage(): void {
    const T = this.THREE;

    // Suelo de baldosas oscuras con un dibujo de octogonos.
    const floorTexture = this.canvasTexture(256, 256, (context) => {
      context.fillStyle = '#1b2140';
      context.fillRect(0, 0, 256, 256);
      context.strokeStyle = '#3a4578';
      context.lineWidth = 6;
      context.strokeRect(3, 3, 250, 250);
      context.beginPath();

      for (let side = 0; side < 8; side += 1) {
        const angle = (side / 8) * Math.PI * 2 + Math.PI / 8;
        const x = 128 + Math.cos(angle) * 88;
        const y = 128 + Math.sin(angle) * 88;
        side ? context.lineTo(x, y) : context.moveTo(x, y);
      }

      context.closePath();
      context.lineWidth = 4;
      context.stroke();
    });
    floorTexture.wrapS = T.RepeatWrapping;
    floorTexture.wrapT = T.RepeatWrapping;
    floorTexture.repeat.set(7, 5);
    const floor = new T.Mesh(this.track(new T.PlaneGeometry(STAGE_WIDTH + 8, STAGE_DEPTH + 4)), this.track(new T.MeshStandardMaterial({ map: floorTexture, roughness: 0.35, metalness: 0.2 })));
    floor.rotation.x = -Math.PI / 2;
    floor.position.z = 0.4;
    this.scene.add(floor);

    // Fondo: cielo estrellado azul oscuro.
    const starsTexture = this.canvasTexture(512, 256, (context) => {
      const gradient = context.createLinearGradient(0, 0, 0, 256);
      gradient.addColorStop(0, '#05051a');
      gradient.addColorStop(1, '#1d1f5c');
      context.fillStyle = gradient;
      context.fillRect(0, 0, 512, 256);

      for (let index = 0; index < 220; index += 1) {
        context.fillStyle = `rgba(255,255,255,${0.3 + Math.random() * 0.7})`;
        context.fillRect(Math.random() * 512, Math.random() * 256, Math.random() < 0.15 ? 2 : 1, Math.random() < 0.15 ? 2 : 1);
      }
    });
    const backdrop = new T.Mesh(this.track(new T.PlaneGeometry(STAGE_WIDTH + 6, 7)), this.track(new T.MeshBasicMaterial({ map: starsTexture })));
    backdrop.position.set(0, 3.2, -STAGE_DEPTH / 2 - 0.4);
    this.scene.add(backdrop);

    // Fila de bombillas de colores al fondo del escenario.
    const bulbGeometry = this.track(new T.SphereGeometry(0.14, 14, 10));

    for (let index = 0; index < 15; index += 1) {
      const material = this.track(new T.MeshBasicMaterial({ color: LIGHT_COLORS[index % LIGHT_COLORS.length] }));
      const bulb = new T.Mesh(bulbGeometry, material);
      bulb.position.set(-4.9 + index * 0.7, 0.22, -STAGE_DEPTH / 2 + 0.1);
      this.bulbs.push(material);
      this.scene.add(bulb);
    }

    // Columnas laterales cubiertas de cuadros de colores que se iluminan.
    const pillarGeometry = this.track(new T.CylinderGeometry(0.85, 0.85, 4.6, 24, 1, true));

    for (const side of [-1, 1]) {
      const material = this.track(new T.MeshBasicMaterial({ map: this.pillarTexture(), side: T.DoubleSide }));
      const pillar = new T.Mesh(pillarGeometry, material);
      pillar.position.set(side * (STAGE_WIDTH / 2 + 0.6), 2.3, -STAGE_DEPTH / 2 + 0.9);
      this.pillarMaterials.push(material);
      const capMaterial = this.track(new T.MeshStandardMaterial({ color: '#141a3a', roughness: 0.4, metalness: 0.4 }));
      const capGeometry = this.track(new T.CylinderGeometry(0.95, 0.95, 0.22, 24));
      const top = new T.Mesh(capGeometry, capMaterial);
      top.position.set(pillar.position.x, 4.65, pillar.position.z);
      const bottom = new T.Mesh(capGeometry, capMaterial);
      bottom.position.set(pillar.position.x, 0.1, pillar.position.z);
      this.scene.add(pillar, top, bottom);
    }

    // Barra de focos en el techo.
    const truss = new T.Mesh(this.track(new T.BoxGeometry(STAGE_WIDTH, 0.25, 0.25)), this.track(new T.MeshStandardMaterial({ color: '#2a2f45', metalness: 0.6, roughness: 0.35 })));
    truss.position.set(0, 5.6, -0.6);
    this.scene.add(truss);
  }

  private pillarTexture(): ThreeModule.CanvasTexture {
    return this.canvasTexture(128, 256, (context) => {
      context.fillStyle = '#0d1230';
      context.fillRect(0, 0, 128, 256);

      for (let y = 0; y < 256; y += 21) {
        for (let x = 0; x < 128; x += 21) {
          context.fillStyle = LIGHT_COLORS[Math.floor(Math.random() * LIGHT_COLORS.length)];
          context.globalAlpha = 0.45 + Math.random() * 0.55;
          context.fillRect(x + 2, y + 2, 17, 17);
        }
      }

      context.globalAlpha = 1;
    });
  }

  private buildLights(): void {
    const T = this.THREE;
    this.scene.add(new T.HemisphereLight(0x8fa0ff, 0x1a1030, 0.9));
    const front = new T.DirectionalLight(0xffffff, 1.1);
    front.position.set(0, 6, 9);
    this.scene.add(front);

    // Focos de colores que barren el escenario (luz real) y sus conos visibles (aditivos, sin coste de sombras).
    const coneGeometry = this.track(new T.ConeGeometry(1.25, 6, 24, 1, true));
    coneGeometry.translate(0, -3, 0);

    LIGHT_COLORS.forEach((color, index) => {
      const x = -4 + index * 2;
      const pivot = new T.Group();
      pivot.position.set(x, 5.5, -0.6);
      const cone = new T.Mesh(
        coneGeometry,
        this.track(new T.MeshBasicMaterial({ color, transparent: true, opacity: 0.13, blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide })),
      );
      pivot.add(cone);
      this.scene.add(pivot);
      this.beams.push({ pivot, speed: 0.6 + index * 0.17, phase: index * 1.3 });

      if (index % 2 === 0) {
        const spot = new T.SpotLight(color, 18, 14, 0.45, 0.6, 1.4);
        spot.position.set(x, 5.5, -0.6);
        this.scene.add(spot, spot.target);
        this.spots.push(spot);
      }
    });
  }

  private createDancer(view: DancePlayerView, slot: number, enterAt: number, proxyBase: string): void {
    const T = this.THREE;
    const [x, z] = SLOTS[slot];
    const holder = new T.Group();
    const home = new T.Vector3(x, 0, z);
    holder.position.copy(home);
    // Los de las filas de atras, un poco mas pequenos para dar profundidad sin tapar a los de delante.
    holder.scale.setScalar(z < 1 ? 0.92 : 1);
    const rig = new MiiRig(T, view.shirt);
    rig.enter(enterAt);
    holder.add(rig.root);
    this.scene.add(holder);

    // Circulo de luz bajo cada bailarin, como en un escenario de verdad.
    const pool = new T.Mesh(
      this.track(new T.CircleGeometry(0.75, 32)),
      this.track(new T.MeshBasicMaterial({ map: this.poolTexture(), transparent: true, blending: T.AdditiveBlending, depthWrite: false })),
    );
    pool.rotation.x = -Math.PI / 2;
    pool.position.set(x, 0.012, z);
    this.scene.add(pool);

    void createFaceTexture(T, view.avatarUrl, view.name, proxyBase).then((texture) => {
      if (this.disposed) {
        texture.dispose();
        return;
      }

      rig.setFaceTexture(texture);
    });

    this.dancers.set(view.playerId, { view, holder, rig, pool, home, mode: 'stage', mood: 'idle', outSince: null, style: slot % 3 });
  }

  private poolTextureCache?: ThreeModule.CanvasTexture;

  private poolTexture(): ThreeModule.CanvasTexture {
    this.poolTextureCache ??= this.canvasTexture(128, 128, (context) => {
      const gradient = context.createRadialGradient(64, 64, 4, 64, 64, 64);
      gradient.addColorStop(0, 'rgba(255,255,240,0.75)');
      gradient.addColorStop(0.6, 'rgba(255,255,240,0.25)');
      gradient.addColorStop(1, 'rgba(255,255,240,0)');
      context.fillStyle = gradient;
      context.fillRect(0, 0, 128, 128);
    });
    return this.poolTextureCache;
  }

  /* -------------------------------- Bailarines ------------------------------- */

  private updateDancer(dancer: Dancer, now: number, time: number, delta: number): void {
    const holder = dancer.holder;

    if (dancer.mode === 'gone') {
      return;
    }

    // Eliminado: cabizbajo un momento y despues se va andando por su lado del escenario.
    if (dancer.mode === 'stage' && dancer.outSince !== null && now - dancer.outSince > SAD_BEFORE_EXIT_MS) {
      dancer.mode = 'leaving';
    }

    let mood: MiiMood = 'idle';

    if (dancer.mode === 'leaving') {
      const side = dancer.home.x < -0.1 ? -1 : dancer.home.x > 0.1 ? 1 : dancer.view.playerId.charCodeAt(0) % 2 ? 1 : -1;
      const step = WALK_SPEED * delta;
      holder.position.x += side * step;
      holder.rotation.y = side * (Math.PI / 2);
      dancer.pool.visible = false;
      mood = 'walk';

      if (Math.abs(holder.position.x) > EXIT_X) {
        dancer.mode = 'gone';
        holder.visible = false;
        dancer.pool.visible = false;
        return;
      }
    } else {
      holder.rotation.y += (0 - holder.rotation.y) * Math.min(1, delta * 8);
      mood = this.rigMood(dancer);
    }

    const rig = dancer.rig;
    rig.mood = mood;
    rig.update(time, delta, 'game');

    // Rebote extra del jugador local en cada acierto.
    if (dancer.view.isLocal && dancer.mood === 'dance') {
      const pulse = (now - this.pulseAt) / 220;

      if (pulse >= 0 && pulse < 1) {
        rig.root.position.y += Math.sin(Math.PI * pulse) * 0.12;
      }
    }
  }

  private rigMood(dancer: Dancer): MiiMood {
    switch (dancer.mood) {
      case 'dance':
        // Dos bailes del podio alternandose (cada uno con su estilo y su ritmo).
        return (Math.floor(performance.now() / 2400) + dancer.style) % 2 ? 'dance-big' : 'dance-small';
      case 'sad':
        return 'sad';
      case 'clap':
        return 'clap';
      case 'happy':
        return 'happy';
      default:
        return 'idle';
    }
  }

  /* --------------------------------- Luces ---------------------------------- */

  private updateLights(now: number, time: number): void {
    const flash = Math.max(0, 1 - (now - this.pulseAt) / 260);

    for (const beam of this.beams) {
      beam.pivot.rotation.z = Math.sin(time * beam.speed + beam.phase) * 0.5;
      beam.pivot.rotation.x = 0.25 + Math.cos(time * beam.speed * 0.7 + beam.phase) * 0.25;
    }

    this.spots.forEach((spot, index) => {
      spot.target.position.set(Math.sin(time * (0.5 + index * 0.2) + index) * 3.5, 0, Math.cos(time * 0.4 + index) * 1.6 + 0.4);
      spot.intensity = 18 + flash * 14;
    });

    // Bombillas que parpadean por turnos y columnas que laten con el ritmo.
    const beat = Math.floor(time * 4);
    this.bulbs.forEach((material, index) => {
      const on = (index + beat) % 3 !== 0;
      material.color.set(on ? LIGHT_COLORS[(index + Math.floor(time)) % LIGHT_COLORS.length] : '#222233');
    });

    const glow = 0.75 + Math.abs(Math.sin(time * Math.PI)) * 0.25 + flash * 0.2;
    this.pillarMaterials.forEach((material) => material.color.setScalar(Math.min(1.2, glow)));
  }

  /* --------------------------------- Camara --------------------------------- */

  /**
   * Escenario de frente y algo elevado, con el jugador local en primer plano. Encuadra solo los huecos ocupados
   * (con pocos jugadores la camara se acerca) y no se mueve aunque se vayan bajando del escenario.
   */
  private stageGoal(): CameraGoal {
    const T = this.THREE;
    const homes = [...this.dancers.values()].map((dancer) => dancer.home);
    const halfWidth = Math.max(2.4, ...homes.map((home) => Math.abs(home.x) + 0.7));
    const back = Math.min(1.7, ...homes.map((home) => home.z));
    return {
      // Algo elevada para que las filas de atras asomen por encima de las cabezas de delante.
      target: new T.Vector3(0, 1.1, (back + 1.7) / 2),
      direction: new T.Vector3(0, back < 1 ? 0.55 : 0.42, 1).normalize(),
      fit: [
        new T.Vector3(-halfWidth, 0, 2.3),
        new T.Vector3(halfWidth, 0, 2.3),
        // Pies del jugador local (que esta adelantado) con hueco para su nombre debajo.
        new T.Vector3(0, 0, SLOTS[0][1] + 1.1),
        new T.Vector3(-halfWidth, 2.3, back),
        new T.Vector3(halfWidth, 2.3, back),
        new T.Vector3(0, 2.6, back),
      ],
      margin: 0.98,
    };
  }

  /* ---------------------------------- Bucle --------------------------------- */

  private loop(): void {
    this.frameHandle = requestAnimationFrame(() => this.loop());
    const now = performance.now();
    const delta = Math.min(0.05, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    const time = now / 1000;

    for (const dancer of this.dancers.values()) {
      this.updateDancer(dancer, now, time, delta);
    }

    this.updateLights(now, time);
    this.director.update(now, delta);
    this.renderer.render(this.scene, this.camera);
    this.placeLabels();
  }

  /** Nombre bajo los pies de cada bailarin que sigue en el escenario. */
  private placeLabels(): void {
    const width = this.host.clientWidth;
    const height = this.host.clientHeight;

    for (const label of Array.from(this.labelLayer.querySelectorAll<HTMLElement>('[data-dn-label]'))) {
      const dancer = this.dancers.get(label.dataset['dnLabel'] || '');

      if (!dancer || dancer.mode === 'gone') {
        label.style.opacity = '0';
        continue;
      }

      const vector = this.scratch.copy(dancer.holder.position).setZ(dancer.holder.position.z + 0.45).project(this.camera);
      const visible = vector.z < 1 && Math.abs(vector.x) < 1.02 && Math.abs(vector.y) < 1.02;
      label.style.opacity = visible ? '1' : '0';
      label.style.transform = `translate(${((vector.x + 1) / 2) * width}px, ${((1 - vector.y) / 2) * height}px) translate(-50%, 2px)`;
    }
  }

  private resize(): void {
    const width = Math.max(1, this.host.clientWidth);
    const height = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(width, height, false);
    this.director.setViewport(width, height, this.insets);
  }

  private track<T extends { dispose: () => void }>(item: T): T {
    this.disposables.push(item);
    return item;
  }
}
