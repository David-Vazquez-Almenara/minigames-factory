import type * as ThreeModule from 'three';
import { MiiMood, MiiParts, MiiRig, createFaceTexture, loadCorsImage } from '../../../../shared/components/mii-stage/mii-rig';
import { CameraDirector, CameraGoal, ViewInsets } from '../../../../shared/three/camera-director';
import { ragdollDuration, sampleRagdoll } from './russian-ragdoll';

type Three = typeof ThreeModule;
type Vector3 = ThreeModule.Vector3;

// Mesa redonda en el centro (el jugador se pone detras, mirando a camara) y la fila a la derecha.
const TABLE = { x: 0, z: 0.85, top: 0.92, radius: 0.62 };
const SPOT = { x: 0, z: 0.02 };
const QUEUE_START = { x: 2.5, z: 0.45 };
const QUEUE_GAP = 0.95;
const EXIT_X = -11;
const REENTRY_X = 13;
const WALK_SPEED = 3.2;
const BASE_ARM_Z = 0.16;
// Brazo levantado con la mano junto a la cara (un poco por delante) para que la boca del canon toque la sien.
const ARM_TO_HEAD_X = 0.46;
const ARM_TO_HEAD_Z = 2.61;
const GUN_SCALE = 1.05;
const REACH_MS = 500;
const RAISE_MS = 800;
const LOWER_MS = 400;
const PUTDOWN_MS = 350;
const CYLINDER_STEP = Math.PI / 3;
const CYLINDER_TURN_MS = 280;
const CORPSE_FADE_AFTER_MS = 4000;
const CORPSE_FADE_MS = 700;
const FOV = 40;
// Cartel de "SE BUSCA" del fondo de la taberna.
// Foto incluida en el proyecto (ya recortada en cuadrado) para que salga al instante.
const WANTED_PHOTO = 'assets/minigames/se-busca.jpg';
const WANTED_NAME = 'Perro Sanchez';

export interface RussianPlayerView {
  playerId: string;
  name: string;
  avatarUrl: string;
  shirt: string;
}

/** Estado que pinta la escena; todos los instantes ya vienen en el reloj local (performance.now). */
export interface RussianSceneState {
  order: string[];
  alive: string[];
  turnIndex: number;
  turnNumber: number;
  currentPlayerId: string | null;
  arriveAt: number;
  shot: { turnNumber: number; playerId: string; skipped: boolean; bang: boolean; at: number; firesAt: number } | null;
  load: number;
  finished: boolean;
}

type WalkerMode = 'queue' | 'to-table' | 'table' | 'exit' | 'reentry' | 'dead';

interface Walker {
  view: RussianPlayerView;
  holder: ThreeModule.Group;
  faller: ThreeModule.Group;
  rig: MiiRig;
  mode: WalkerMode;
  path: Vector3[];
  speed: number;
  slot: number;
  /** Turno en el que esta (o estuvo) en la mesa. */
  turnNumber: number;
  arriveAt: number;
  deadAt: number;
  ragdoll: number;
  parts: MiiParts | null;
}

interface Revolver {
  group: ThreeModule.Group;
  cylinder: ThreeModule.Group;
  hammer: ThreeModule.Group;
  flash: ThreeModule.Mesh;
  light: ThreeModule.PointLight;
}

interface Drop {
  mesh: ThreeModule.Mesh;
  velocity: Vector3;
  /** Segundos que tarda en salir (los chorros van saliendo poco a poco). */
  delay: number;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const ease = (value: number) => {
  const clamped = clamp01(value);
  return clamped * clamped * (3 - 2 * clamped);
};

/**
 * Escena 3D de la Ruleta rusa: una taberna con una mesa redonda y un revolver encima; los jugadores esperan en
 * fila a la derecha y van pasando de uno en uno. Solo pinta el estado que le pasa el componente.
 */
export class RussianScene {
  private readonly renderer: ThreeModule.WebGLRenderer;
  private readonly scene: ThreeModule.Scene;
  private readonly camera: ThreeModule.PerspectiveCamera;
  private readonly director: CameraDirector;
  private readonly walkers = new Map<string, Walker>();
  private readonly disposables: Array<{ dispose: () => void }> = [];
  private readonly resizeObserver: ResizeObserver;
  private readonly scratch: Vector3;
  private readonly tableGun: Revolver;
  private readonly handGun: Revolver;
  private readonly handGunHolder: ThreeModule.Group;
  private readonly looseGun: Revolver;
  private readonly drops: Drop[] = [];
  private readonly stains: Array<{ mesh: ThreeModule.Mesh; grow: number; size: number; bornAt: number }> = [];
  private readonly bloodMaterial: ThreeModule.MeshStandardMaterial;
  private readonly stainMaterial: ThreeModule.MeshBasicMaterial;
  private readonly dropGeometry: ThreeModule.SphereGeometry;
  private readonly stainGeometry: ThreeModule.CircleGeometry;
  private state: RussianSceneState | null = null;
  private turnNumber = 0;
  private load = 0;
  /** Recamaras que ha avanzado el tambor (para girarlo de 60 en 60 grados). */
  private cylinderSteps = 0;
  private cylinderFrom = 0;
  private cylinderTurnAt = -Infinity;
  private readonly handled = new Set<string>();
  private looseGunAt = -Infinity;
  private looseVelocity: Vector3;
  private shakeUntil = 0;
  private reloadAt = -Infinity;
  private insets: ViewInsets = { top: 0, right: 0, bottom: 0, left: 0 };
  private frameHandle = 0;
  private lastFrame = performance.now();
  private disposed = false;

  /** Avisos para los sonidos: coger el arma, girar el tambor, clic, disparo, cuerpo contra el suelo, recarga. */
  onSound?: (sound: 'pickup' | 'spin' | 'cock' | 'click' | 'bang' | 'thud' | 'putdown' | 'reload' | 'steps') => void;

  constructor(
    private readonly THREE: Three,
    canvas: HTMLCanvasElement,
    private readonly host: HTMLElement,
    private readonly labelLayer: HTMLElement,
    players: RussianPlayerView[],
    initialState: RussianSceneState,
    proxyBase: string,
  ) {
    const T = THREE;
    this.renderer = new T.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = T.SRGBColorSpace;
    this.scene = new T.Scene();
    this.scene.background = new T.Color('#2a1a10');
    this.scene.fog = new T.Fog('#2a1a10', 16, 34);
    this.camera = new T.PerspectiveCamera(FOV, 1, 0.1, 120);
    this.director = new CameraDirector(T, this.camera);
    this.scratch = new T.Vector3();
    this.looseVelocity = new T.Vector3();

    this.bloodMaterial = this.track(new T.MeshStandardMaterial({ color: '#b3000c', roughness: 0.25, metalness: 0.1, emissive: '#2a0002' }));
    this.stainMaterial = this.track(
      new T.MeshBasicMaterial({ color: '#7a0008', transparent: true, opacity: 0.92, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }),
    );
    this.dropGeometry = this.track(new T.SphereGeometry(0.028, 8, 6));
    this.stainGeometry = this.track(new T.CircleGeometry(1, 20));

    this.buildTavern();
    this.buildTable();
    this.tableGun = this.buildRevolver();
    this.tableGun.group.position.set(TABLE.x + 0.12, TABLE.top + 0.045, TABLE.z - 0.05);
    this.tableGun.group.rotation.set(0, -0.5, Math.PI / 2);
    this.scene.add(this.tableGun.group);
    this.handGun = this.buildRevolver();
    this.handGunHolder = new T.Group();
    this.handGunHolder.add(this.handGun.group);
    this.handGunHolder.visible = false;
    this.looseGun = this.buildRevolver();
    this.looseGun.group.visible = false;
    this.scene.add(this.looseGun.group);

    const time = performance.now() / 1000;
    const byId = new Map(players.map((player) => [player.playerId, player]));
    initialState.order.forEach((playerId, index) => {
      const view = byId.get(playerId);

      if (view) {
        this.createWalker(view, index, time + 0.15 + index * 0.1, proxyBase);
      }
    });

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();
    this.placeQueue(initialState, true);
    this.sync(initialState);
    this.director.focus('table', () => this.tableGoal(), performance.now());
    this.loop();
  }

  sync(state: RussianSceneState): void {
    if (this.disposed) {
      return;
    }

    this.state = state;
    const now = performance.now();

    // Turno nuevo: el anterior (si sigue vivo) se va por la izquierda y el siguiente camina hacia la mesa.
    if (state.turnNumber !== this.turnNumber && state.currentPlayerId) {
      this.turnNumber = state.turnNumber;

      for (const walker of this.walkers.values()) {
        if ((walker.mode === 'table' || walker.mode === 'to-table') && walker.view.playerId !== state.currentPlayerId) {
          this.startExit(walker);
        }
      }

      const current = this.walkers.get(state.currentPlayerId);

      if (current && current.mode !== 'dead') {
        current.turnNumber = state.turnNumber;
        current.arriveAt = state.arriveAt;
        this.startWalkToTable(current, Math.max(0, state.arriveAt - now));
        this.onSound?.('steps');
      }

      this.placeQueue(state, false);
    }

    // Recarga tras una baja: el revolver vuelve a la mesa con mas balas.
    if (state.load !== this.load) {
      if (this.load) {
        this.reloadAt = now;
        this.looseGun.group.visible = false;
        this.onSound?.('reload');
      }

      this.load = state.load;
      this.cylinderSteps = 0;
      this.cylinderFrom = 0;
    }
  }

  setInsets(insets: ViewInsets): void {
    this.insets = insets;
    this.director.setViewport(this.host.clientWidth, this.host.clientHeight, insets);
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frameHandle);
    this.resizeObserver.disconnect();

    for (const walker of this.walkers.values()) {
      walker.rig.dispose();
    }

    for (const item of this.disposables) {
      item.dispose();
    }

    this.walkers.clear();
    this.scene.clear();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }

  /* ------------------------------ Construccion ------------------------------ */

  private material(color: string, roughness = 0.7, extra: Partial<ThreeModule.MeshStandardMaterialParameters> = {}): ThreeModule.MeshStandardMaterial {
    return this.track(new this.THREE.MeshStandardMaterial({ color, roughness, ...extra }));
  }

  private canvasTexture(width: number, height: number, draw: (context: CanvasRenderingContext2D) => void, repeat?: [number, number]): ThreeModule.CanvasTexture {
    const T = this.THREE;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    draw(canvas.getContext('2d')!);
    const texture = this.track(new T.CanvasTexture(canvas));
    texture.colorSpace = T.SRGBColorSpace;

    if (repeat) {
      texture.wrapS = T.RepeatWrapping;
      texture.wrapT = T.RepeatWrapping;
      texture.repeat.set(...repeat);
    }

    return texture;
  }

  /** Taberna: suelo de tablones, pared de madera con estanterias, barra, barriles y una lampara sobre la mesa. */
  private buildTavern(): void {
    const T = this.THREE;
    this.scene.add(new T.HemisphereLight(0xffd9a8, 0x3a2414, 1.05));
    const key = new T.DirectionalLight(0xffe2b8, 1.1);
    key.position.set(4, 9, 7);
    this.scene.add(key);
    // Lampara colgada sobre la mesa: luz calida que deja la sala en penumbra.
    const lamp = new T.PointLight(0xffc070, 18, 9, 1.4);
    lamp.position.set(TABLE.x, 3.2, TABLE.z - 0.2);
    this.scene.add(lamp);

    const planks = this.canvasTexture(
      256,
      256,
      (context) => {
        for (let row = 0; row < 8; row += 1) {
          context.fillStyle = ['#7a4b2a', '#6e4224', '#82512e', '#734626'][row % 4];
          context.fillRect(0, row * 32, 256, 32);
          context.fillStyle = 'rgba(0, 0, 0, 0.35)';
          context.fillRect(0, row * 32, 256, 2);
          context.fillRect(((row * 97) % 200) + 20, row * 32, 2, 32);
        }
      },
      [10, 10],
    );
    const floor = new T.Mesh(this.track(new T.PlaneGeometry(40, 40)), this.track(new T.MeshStandardMaterial({ map: planks, roughness: 0.85 })));
    floor.rotation.x = -Math.PI / 2;
    this.scene.add(floor);

    const wallTexture = this.canvasTexture(
      256,
      256,
      (context) => {
        for (let column = 0; column < 8; column += 1) {
          context.fillStyle = column % 2 ? '#5b3820' : '#64402a';
          context.fillRect(column * 32, 0, 32, 256);
          context.fillStyle = 'rgba(0, 0, 0, 0.3)';
          context.fillRect(column * 32, 0, 2, 256);
        }
      },
      [6, 1.2],
    );
    const wall = new T.Mesh(this.track(new T.PlaneGeometry(40, 7)), this.track(new T.MeshStandardMaterial({ map: wallTexture, roughness: 0.9 })));
    wall.position.set(0, 3.5, -4.2);
    this.scene.add(wall);

    // Estanterias con botellas detras de la barra.
    const shelfWood = this.material('#3f2716', 0.8);
    const bottleColors = ['#2f7d32', '#7b3f00', '#9fd3c7', '#5c1a1a', '#d9a400', '#3b5bdb'];

    for (const [shelfY, count] of [
      [2.1, 9],
      [2.9, 8],
    ] as const) {
      const shelf = new T.Mesh(this.track(new T.BoxGeometry(5, 0.08, 0.35)), shelfWood);
      shelf.position.set(-3.6, shelfY, -4.0);
      this.scene.add(shelf);

      for (let index = 0; index < count; index += 1) {
        const height = 0.28 + ((index * 7) % 4) * 0.05;
        const bottle = new T.Mesh(
          this.track(new T.CylinderGeometry(0.06, 0.08, height, 10)),
          this.material(bottleColors[(index + count) % bottleColors.length], 0.2, { transparent: true, opacity: 0.85 }),
        );
        bottle.position.set(-5.8 + index * 0.5, shelfY + 0.04 + height / 2, -3.95);
        const neck = new T.Mesh(this.track(new T.CylinderGeometry(0.025, 0.03, 0.1, 8)), bottle.material);
        neck.position.y = height / 2 + 0.05;
        bottle.add(neck);
        this.scene.add(bottle);
      }
    }

    // Barra de la taberna al fondo a la izquierda.
    const counter = new T.Mesh(this.track(new T.BoxGeometry(5.2, 1.1, 0.8)), this.material('#5a341c', 0.6));
    counter.position.set(-3.6, 0.55, -2.9);
    const counterTop = new T.Mesh(this.track(new T.BoxGeometry(5.4, 0.08, 0.95)), this.material('#3a2010', 0.35));
    counterTop.position.set(-3.6, 1.14, -2.9);
    this.scene.add(counter, counterTop);

    // Cartel de "SE BUSCA" en la pared, con la foto (en sepia, como un cartel viejo) y el nombre.
    const drawPoster = (context: CanvasRenderingContext2D, photo: HTMLImageElement | null) => {
      context.fillStyle = '#e8d3a2';
      context.fillRect(0, 0, 256, 320);
      context.strokeStyle = '#6b4a1c';
      context.lineWidth = 8;
      context.strokeRect(6, 6, 244, 308);
      context.fillStyle = '#3a2410';
      context.font = '900 46px serif';
      context.textAlign = 'center';
      context.fillText('SE BUSCA', 128, 58);

      if (photo) {
        // Recorte centrado (un poco hacia arriba, donde esta la cara) para llenar el marco.
        const side = Math.min(photo.naturalWidth, photo.naturalHeight);
        const sx = (photo.naturalWidth - side) / 2;
        const sy = Math.max(0, (photo.naturalHeight - side) * 0.25);
        context.filter = 'sepia(0.55) contrast(1.05)';
        context.drawImage(photo, sx, sy, side, side, 58, 74, 140, 140);
        context.filter = 'none';
        context.lineWidth = 4;
        context.strokeRect(58, 74, 140, 140);
      } else {
        context.fillRect(58, 74, 140, 140);
      }

      context.fillStyle = '#3a2410';
      context.font = '900 25px serif';
      context.fillText(WANTED_NAME, 128, 246);
      context.font = '900 34px serif';
      context.fillText('$ 1.000', 128, 290);
    };
    const posterCanvas = document.createElement('canvas');
    posterCanvas.width = 256;
    posterCanvas.height = 320;
    drawPoster(posterCanvas.getContext('2d')!, null);
    const poster = this.track(new T.CanvasTexture(posterCanvas));
    poster.colorSpace = T.SRGBColorSpace;
    void loadCorsImage(WANTED_PHOTO).then((photo) => {
      if (photo && !this.disposed) {
        drawPoster(posterCanvas.getContext('2d')!, photo);
        poster.needsUpdate = true;
      }
    });
    const wanted = new T.Mesh(this.track(new T.PlaneGeometry(1, 1.25)), this.track(new T.MeshStandardMaterial({ map: poster, roughness: 0.9 })));
    wanted.position.set(1.8, 2.6, -4.15);
    wanted.rotation.z = 0.04;
    this.scene.add(wanted);

    // Barriles a los lados.
    const barrelWood = this.material('#6b4123', 0.75);
    const hoop = this.material('#2b2b2b', 0.4, { metalness: 0.5 });

    for (const [x, z] of [
      [-5.2, -1.2],
      [-4.6, -0.2],
      [5.8, -2.6],
      [6.6, -1.9],
    ]) {
      const barrel = new T.Mesh(this.track(new T.CylinderGeometry(0.42, 0.42, 1, 16)), barrelWood);
      barrel.position.set(x, 0.5, z);

      for (const y of [-0.32, 0.32]) {
        const ring = new T.Mesh(this.track(new T.TorusGeometry(0.43, 0.025, 6, 20)), hoop);
        ring.rotation.x = Math.PI / 2;
        ring.position.y = y;
        barrel.add(ring);
      }

      this.scene.add(barrel);
    }

    // Lampara: cable y pantalla sobre la mesa.
    const cord = new T.Mesh(this.track(new T.CylinderGeometry(0.01, 0.01, 2, 6)), this.material('#111111'));
    cord.position.set(TABLE.x, 4.4, TABLE.z - 0.2);
    const shade = new T.Mesh(this.track(new T.ConeGeometry(0.42, 0.32, 16, 1, true)), this.material('#2c4a2a', 0.5, { side: T.DoubleSide }));
    shade.position.set(TABLE.x, 3.35, TABLE.z - 0.2);
    const bulb = new T.Mesh(this.track(new T.SphereGeometry(0.09, 12, 8)), this.track(new T.MeshBasicMaterial({ color: '#ffe2a0' })));
    bulb.position.set(TABLE.x, 3.22, TABLE.z - 0.2);
    this.scene.add(cord, shade, bulb);
  }

  private buildTable(): void {
    const T = this.THREE;
    const wood = this.material('#6a3d1f', 0.55);
    const top = new T.Mesh(this.track(new T.CylinderGeometry(TABLE.radius, TABLE.radius, 0.08, 32)), wood);
    top.position.set(TABLE.x, TABLE.top - 0.04, TABLE.z);
    const felt = new T.Mesh(this.track(new T.CylinderGeometry(TABLE.radius - 0.08, TABLE.radius - 0.08, 0.012, 32)), this.material('#2c5a2e', 0.9));
    felt.position.set(TABLE.x, TABLE.top + 0.001, TABLE.z);
    const leg = new T.Mesh(this.track(new T.CylinderGeometry(0.07, 0.09, TABLE.top - 0.08, 12)), wood);
    leg.position.set(TABLE.x, (TABLE.top - 0.08) / 2, TABLE.z);
    const foot = new T.Mesh(this.track(new T.CylinderGeometry(0.34, 0.38, 0.05, 20)), wood);
    foot.position.set(TABLE.x, 0.025, TABLE.z);
    this.scene.add(top, felt, leg, foot);
  }

  /**
   * Revolver con el origen en la empunadura (donde lo coge la mano) y el canon hacia +z. El tambor (con sus seis
   * recamaras) gira sobre el eje del canon y el percutor se monta hacia atras al apretar el gatillo.
   */
  private buildRevolver(): Revolver {
    const T = this.THREE;
    const metal = this.material('#3b4048', 0.32, { metalness: 0.75 });
    const dark = this.material('#1d2026', 0.4, { metalness: 0.6 });
    const wood = this.material('#7a4a24', 0.55);
    const brass = this.material('#d8a93a', 0.3, { metalness: 0.8 });
    const group = new T.Group();

    const grip = new T.Mesh(this.track(new T.BoxGeometry(0.075, 0.19, 0.1)), wood);
    grip.position.set(0, -0.06, -0.06);
    grip.rotation.x = 0.32;
    const frame = new T.Mesh(this.track(new T.BoxGeometry(0.08, 0.1, 0.22)), metal);
    frame.position.set(0, 0.06, 0.05);
    const barrel = new T.Mesh(this.track(new T.CylinderGeometry(0.032, 0.032, 0.34, 14)), metal);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0.085, 0.3);
    const lug = new T.Mesh(this.track(new T.BoxGeometry(0.03, 0.035, 0.26)), metal);
    lug.position.set(0, 0.05, 0.3);
    const sight = new T.Mesh(this.track(new T.BoxGeometry(0.012, 0.03, 0.04)), dark);
    sight.position.set(0, 0.125, 0.45);
    const muzzle = new T.Mesh(this.track(new T.CylinderGeometry(0.016, 0.016, 0.01, 10)), this.track(new T.MeshBasicMaterial({ color: '#050505' })));
    muzzle.rotation.x = Math.PI / 2;
    muzzle.position.set(0, 0.085, 0.471);
    const guard = new T.Mesh(this.track(new T.TorusGeometry(0.045, 0.009, 6, 14, Math.PI)), metal);
    guard.rotation.set(0, Math.PI / 2, Math.PI);
    guard.position.set(0, 0.0, 0.03);
    const trigger = new T.Mesh(this.track(new T.BoxGeometry(0.012, 0.05, 0.015)), dark);
    trigger.position.set(0, -0.0, 0.02);
    trigger.rotation.x = -0.3;
    group.add(grip, frame, barrel, lug, sight, muzzle, guard, trigger);

    // Tambor: gira sobre el eje z (el del canon). Recamaras con el culote de latón asomando por detras.
    const cylinder = new T.Group();
    cylinder.position.set(0, 0.075, 0.08);
    const drum = new T.Mesh(this.track(new T.CylinderGeometry(0.075, 0.075, 0.13, 18)), metal);
    drum.rotation.x = Math.PI / 2;
    cylinder.add(drum);

    for (let index = 0; index < 6; index += 1) {
      const angle = (index / 6) * Math.PI * 2;
      const hole = new T.Mesh(this.track(new T.CylinderGeometry(0.018, 0.018, 0.012, 10)), dark);
      hole.rotation.x = Math.PI / 2;
      hole.position.set(Math.cos(angle) * 0.045, Math.sin(angle) * 0.045, 0.066);
      const shell = new T.Mesh(this.track(new T.CylinderGeometry(0.017, 0.017, 0.01, 10)), brass);
      shell.rotation.x = Math.PI / 2;
      shell.position.set(Math.cos(angle) * 0.045, Math.sin(angle) * 0.045, -0.066);
      // Estrias del exterior del tambor (se ve girar).
      const flute = new T.Mesh(this.track(new T.BoxGeometry(0.014, 0.012, 0.11)), dark);
      flute.position.set(Math.cos(angle + Math.PI / 6) * 0.073, Math.sin(angle + Math.PI / 6) * 0.073, 0);
      flute.rotation.z = angle + Math.PI / 6;
      cylinder.add(hole, shell, flute);
    }

    group.add(cylinder);

    // Percutor (se monta hacia atras) con su pivote detras del tambor.
    const hammer = new T.Group();
    hammer.position.set(0, 0.1, -0.06);
    const spur = new T.Mesh(this.track(new T.BoxGeometry(0.022, 0.07, 0.03)), dark);
    spur.position.set(0, 0.03, -0.01);
    hammer.add(spur);
    group.add(hammer);

    // Fogonazo en la boca del canon.
    const flash = new T.Mesh(this.track(new T.SphereGeometry(0.12, 12, 8)), this.track(new T.MeshBasicMaterial({ color: '#fff1a8', transparent: true, opacity: 0.95 })));
    flash.position.set(0, 0.085, 0.55);
    flash.scale.set(1, 1, 1.8);
    flash.visible = false;
    const light = new T.PointLight(0xffd27a, 0, 4, 2);
    light.position.copy(flash.position);
    group.add(flash, light);
    group.scale.setScalar(GUN_SCALE);
    return { group, cylinder, hammer, flash, light };
  }

  private createWalker(view: RussianPlayerView, slot: number, enterAt: number, proxyBase: string): void {
    const T = this.THREE;
    const holder = new T.Group();
    const faller = new T.Group();
    const rig = new MiiRig(T, view.shirt);
    rig.enter(enterAt);
    faller.add(rig.root);
    holder.add(faller);
    this.scene.add(holder);

    void createFaceTexture(T, view.avatarUrl, view.name, proxyBase).then((texture) => {
      if (this.disposed) {
        texture.dispose();
        return;
      }

      rig.setFaceTexture(texture);
    });

    const walker: Walker = {
      view,
      holder,
      faller,
      rig,
      mode: 'queue',
      path: [],
      speed: WALK_SPEED,
      slot,
      turnNumber: 0,
      arriveAt: 0,
      deadAt: 0,
      ragdoll: 0,
      parts: null,
    };
    rig.poseOverride = (parts) => {
      walker.parts = parts;
      this.applyPose(walker, parts);
    };
    this.walkers.set(view.playerId, walker);
  }

  /* --------------------------------- Paseos --------------------------------- */

  private queuePoint(slot: number): Vector3 {
    return new this.THREE.Vector3(QUEUE_START.x + slot * QUEUE_GAP, 0, QUEUE_START.z);
  }

  /** Fila de los que esperan (vivos), por orden de turno desde el que esta en la mesa. */
  private placeQueue(state: RussianSceneState, instant: boolean): void {
    const alive = state.order.filter((playerId) => state.alive.includes(playerId));
    const currentIndex = Math.max(0, alive.indexOf(state.currentPlayerId || ''));

    alive.forEach((playerId, index) => {
      const walker = this.walkers.get(playerId);

      if (!walker || playerId === state.currentPlayerId || walker.mode === 'dead') {
        return;
      }

      walker.slot = (index - currentIndex - 1 + alive.length) % alive.length;

      if (instant) {
        walker.holder.position.copy(this.queuePoint(walker.slot));
        walker.mode = 'queue';
        walker.path = [];
      } else if (walker.mode === 'queue') {
        walker.path = [this.queuePoint(walker.slot)];
        walker.speed = WALK_SPEED;
      }
    });

    if (instant && state.currentPlayerId) {
      this.walkers.get(state.currentPlayerId)?.holder.position.copy(this.queuePoint(-1).setX(QUEUE_START.x - QUEUE_GAP * 0.6));
    }
  }

  private startWalkToTable(walker: Walker, durationMs: number): void {
    const T = this.THREE;
    walker.mode = 'to-table';
    walker.path = [new T.Vector3(1.4, 0, 0.35), new T.Vector3(SPOT.x + 0.5, 0, SPOT.z), new T.Vector3(SPOT.x, 0, SPOT.z)];
    const length = this.pathLength(walker.holder.position, walker.path);
    walker.speed = durationMs > 200 ? Math.max(WALK_SPEED * 0.6, length / (durationMs / 1000)) : length / 0.35;
  }

  private startExit(walker: Walker): void {
    const T = this.THREE;
    walker.mode = 'exit';
    walker.speed = WALK_SPEED * 1.1;
    walker.path = [new T.Vector3(-1.2, 0, SPOT.z + 0.2), new T.Vector3(-3.5, 0, 1.6), new T.Vector3(EXIT_X, 0, 2.4)];
  }

  private pathLength(from: Vector3, path: Vector3[]): number {
    let length = 0;
    let previous = from;

    for (const point of path) {
      length += previous.distanceTo(point);
      previous = point;
    }

    return length;
  }

  private arrive(walker: Walker): void {
    switch (walker.mode) {
      case 'to-table':
        walker.mode = 'table';
        break;
      case 'exit':
        // Sale por la izquierda y vuelve a la cola por la derecha.
        walker.holder.position.set(REENTRY_X, 0, QUEUE_START.z);
        walker.mode = 'reentry';
        walker.speed = WALK_SPEED * 1.4;
        walker.path = [this.queuePoint(walker.slot)];
        break;
      case 'reentry':
        walker.mode = 'queue';
        walker.path = [this.queuePoint(walker.slot)];
        break;
      default:
        break;
    }
  }

  private updateWalker(walker: Walker, now: number, time: number, delta: number): void {
    const holder = walker.holder;
    let moving = false;

    if (walker.path.length && walker.mode !== 'dead') {
      const target = walker.path[0];
      const step = walker.speed * delta;
      const distance = holder.position.distanceTo(target);

      if (distance <= step) {
        holder.position.copy(target);
        walker.path.shift();
      } else {
        this.scratch.subVectors(target, holder.position).normalize();
        holder.position.addScaledVector(this.scratch, step);
        holder.rotation.y = Math.atan2(this.scratch.x, this.scratch.z);
        moving = true;
      }

      if (!walker.path.length) {
        this.arrive(walker);
      }
    }

    if (!moving && walker.mode !== 'dead') {
      holder.rotation.y += (0 - holder.rotation.y) * Math.min(1, delta * 8);
    }

    let mood: MiiMood = 'idle';

    if (walker.mode === 'dead') {
      mood = 'idle';
    } else if (moving) {
      mood = 'walk';
    } else if (this.state?.finished && this.state.alive.includes(walker.view.playerId)) {
      mood = 'happy';
    } else if (walker.mode === 'queue' && this.state && this.isTense(now)) {
      // Los de la fila miran con nervios mientras el de la mesa se apunta.
      mood = 'look-up';
    }

    walker.rig.mood = mood;
    walker.rig.update(time, delta, 'game');

    if (walker.mode === 'dead') {
      this.updateCorpse(walker, now);
    }
  }

  private isTense(now: number): boolean {
    const shot = this.state?.shot;
    return Boolean(shot && shot.turnNumber === this.turnNumber && now < shot.firesAt + 200);
  }

  /* --------------------------- Brazo y revolver ----------------------------- */

  /** Cuanto alarga el brazo hacia la mesa (reach) y cuanto lo sube hasta la sien (raise) en este instante. */
  private armState(walker: Walker, now: number): { reach: number; raise: number; holding: boolean } {
    if (walker.mode !== 'table' || walker.turnNumber !== this.turnNumber || !this.state) {
      return { reach: 0, raise: 0, holding: false };
    }

    const start = walker.arriveAt;
    const shot = this.state.shot?.turnNumber === walker.turnNumber ? this.state.shot : null;

    // Despues de un disparo en vacio: baja el brazo y deja el revolver en la mesa.
    if (shot && !shot.bang && now >= shot.firesAt + 150) {
      const lowered = ease((now - shot.firesAt - 150) / LOWER_MS);
      const placing = (now - shot.firesAt - 150 - LOWER_MS) / PUTDOWN_MS;
      const reach = placing < 0 ? lowered : 1 - ease(placing - 0.5);
      return { reach: Math.max(0, reach), raise: 1 - lowered, holding: placing < 0.5 };
    }

    const reach = ease((now - start) / REACH_MS);
    const raise = ease((now - start - REACH_MS) / RAISE_MS);
    return { reach, raise, holding: now - start >= REACH_MS };
  }

  private applyPose(walker: Walker, parts: MiiParts): void {
    const now = performance.now();

    if (walker.mode === 'dead') {
      this.applyRagdoll(walker, parts, now);
      return;
    }

    const { reach, raise } = this.armState(walker, now);

    if (reach <= 0 && raise <= 0) {
      return;
    }

    const shot = this.state?.shot?.turnNumber === walker.turnNumber ? this.state.shot : null;
    let wiggle = 0;

    // Saltar bala: mueve un poco el revolver mientras gira el tambor.
    if (shot?.skipped && now >= shot.at && now < shot.at + 800) {
      wiggle = Math.sin(((now - shot.at) / 800) * Math.PI * 4) * 0.12 * (1 - (now - shot.at) / 800);
    }

    // Temblor de nervios mientras se apunta.
    const tremble = raise > 0.95 ? Math.sin(now / 38) * 0.012 + Math.sin(now / 71) * 0.01 : 0;
    parts.armRight.rotation.set(
      -1.15 * reach * (1 - raise) + ARM_TO_HEAD_X * raise + wiggle * 0.5,
      0,
      BASE_ARM_Z + (ARM_TO_HEAD_Z - BASE_ARM_Z) * raise + tremble + wiggle,
    );
    parts.body.rotation.x += 0.22 * reach * (1 - raise);
    parts.head.rotation.z += 0.14 * raise;
    parts.head.rotation.x = 0.05 + 0.1 * raise;
    // La otra mano, apoyada en la mesa.
    parts.armLeft.rotation.set(-0.75 * Math.max(reach, raise), 0, -0.2);
  }

  /** Orienta el revolver de la mano: hacia la mesa al cogerlo y con el canon contra la sien al apuntarse. */
  private orientHandGun(walker: Walker, raise: number): void {
    const T = this.THREE;
    const parts = walker.parts;

    if (!parts) {
      return;
    }

    // Del frente (al cogerlo) a apuntar desde la mano, junto a la cara, en diagonal hacia la sien.
    const forward = new T.Vector3(0, -0.35, 1).normalize();
    const toHead = new T.Vector3(-0.72, 0.62, 0.08).normalize();
    const direction = forward.lerp(toHead, raise).normalize();
    const target = new T.Quaternion().setFromUnitVectors(new T.Vector3(0, 0, 1), direction);
    const arm = parts.armRight.quaternion.clone().invert();
    this.handGun.group.quaternion.copy(arm.multiply(target));
  }

  private updateGuns(now: number): void {
    const state = this.state;
    const walker = state?.currentPlayerId ? this.walkers.get(state.currentPlayerId) : undefined;
    const { raise, holding } = walker ? this.armState(walker, now) : { raise: 0, holding: false };
    const shot = state?.shot && state.shot.turnNumber === this.turnNumber ? state.shot : null;
    const dropped = Boolean(shot?.bang && now >= shot.firesAt);
    const inHand = Boolean(walker && holding && !dropped && walker.mode === 'table');

    // El arma de la mano va pegada a la mano derecha de quien esta en la mesa.
    if (walker && this.handGunHolder.parent !== walker.parts?.armRight && walker.parts) {
      this.handGunHolder.removeFromParent();
      this.handGunHolder.position.set(0, -0.5, 0.02);
      walker.parts.armRight.add(this.handGunHolder);
    }

    this.handGunHolder.visible = inHand;

    if (inHand && walker) {
      this.orientHandGun(walker, raise);

      if (!this.handled.has(`pickup:${this.turnNumber}`)) {
        this.handled.add(`pickup:${this.turnNumber}`);
        this.onSound?.('pickup');
      }
    }

    // En la mesa solo cuando nadie lo tiene (y no salio volando con el disparo).
    const reloading = now - this.reloadAt < 500;
    this.tableGun.group.visible = !inHand && !this.looseGun.group.visible;
    this.tableGun.group.scale.setScalar(GUN_SCALE * (reloading ? ease((now - this.reloadAt) / 500) : 1));

    if (shot) {
      this.updateShot(shot, now, walker);
    }

    // Tambor: gira 60 grados cada vez que avanza (en las dos armas a la vez).
    const turn = ease((now - this.cylinderTurnAt) / CYLINDER_TURN_MS);
    const angle = (this.cylinderFrom + (this.cylinderSteps - this.cylinderFrom) * turn) * CYLINDER_STEP;

    for (const gun of [this.handGun, this.tableGun, this.looseGun]) {
      gun.cylinder.rotation.z = angle;
    }

    this.updateLooseGun(now);
  }

  private advanceCylinder(now: number): void {
    this.cylinderFrom = this.cylinderSteps;
    this.cylinderSteps += 1;
    this.cylinderTurnAt = now;
  }

  /** Secuencia del disparo: (saltar bala) -> percutor atras -> clic o disparo. */
  private updateShot(shot: NonNullable<RussianSceneState['shot']>, now: number, walker: Walker | undefined): void {
    const key = (name: string) => `${name}:${shot.turnNumber}`;
    const once = (name: string, action: () => void) => {
      if (!this.handled.has(key(name))) {
        this.handled.add(key(name));
        action();
      }
    };

    if (shot.skipped && now >= shot.at + 120) {
      once('skip', () => {
        this.advanceCylinder(now);
        this.onSound?.('spin');
      });
    }

    // Percutor: se monta hacia atras en los ultimos 600 ms y cae al disparar.
    const cock = clamp01(1 - (shot.firesAt - now) / 600);
    const hammer = now < shot.firesAt ? (now > shot.firesAt - 600 ? -0.7 * ease(cock) : 0) : 0;
    this.handGun.hammer.rotation.x = hammer;

    if (now >= shot.firesAt - 600) {
      once('cock', () => this.onSound?.('cock'));
    }

    if (now < shot.firesAt) {
      return;
    }

    if (shot.bang) {
      once('bang', () => this.fire(walker, now));
    } else {
      once('click', () => this.onSound?.('click'));

      if (now >= shot.firesAt + 180) {
        once('advance', () => this.advanceCylinder(now));
      }

      if (now >= shot.firesAt + 150 + LOWER_MS + PUTDOWN_MS * 0.5) {
        once('putdown', () => this.onSound?.('putdown'));
      }
    }

    // Fogonazo breve.
    const flash = (now - shot.firesAt) / 140;
    const showFlash = shot.bang && flash < 1;
    this.handGun.flash.visible = showFlash;
    this.handGun.light.intensity = showFlash ? 6 * (1 - flash) : 0;
  }

  /** ¡Bang!: fogonazo, chorro de sangre exagerado, el arma sale despedida y el jugador se desploma. */
  private fire(walker: Walker | undefined, now: number): void {
    this.onSound?.('bang');
    this.shakeUntil = now + 700;

    if (!walker || !walker.parts) {
      return;
    }

    const T = this.THREE;
    walker.mode = 'dead';
    walker.deadAt = now;
    walker.ragdoll = this.turnNumber % 3;
    walker.path = [];
    setTimeout(() => !this.disposed && this.onSound?.('thud'), ragdollDuration(walker.ragdoll) * 620);

    // El revolver sale volando de la mano y cae al suelo.
    walker.parts.armRight.updateWorldMatrix(true, true);
    this.handGunHolder.getWorldPosition(this.looseGun.group.position);
    this.looseGun.group.quaternion.copy(this.handGun.group.getWorldQuaternion(new T.Quaternion()));
    this.looseGun.group.visible = true;
    this.looseGunAt = now;
    this.looseVelocity.set(1.6 + Math.random(), 2.4, 0.8);
    this.handGunHolder.visible = false;

    // Sangre: sale por el lado contrario a la pistola (hacia la izquierda), en abanico y a chorros.
    walker.rig.root.updateWorldMatrix(true, true);
    const head = new T.Vector3();
    walker.parts.head.getWorldPosition(head);
    head.y += 0.45;

    // Chorros escalonados (no todo de golpe) para que se vea un surtidor y no una bola de gotas.
    for (let index = 0; index < 170; index += 1) {
      const spread = new T.Vector3(-1 - Math.random() * 0.6, Math.random() * 1.6 - 0.3, (Math.random() - 0.5) * 2).normalize();
      const speed = 2.5 + Math.random() * 6;
      const mesh = new T.Mesh(this.dropGeometry, this.bloodMaterial);
      mesh.position.copy(head).addScaledVector(spread, 0.32 + Math.random() * 0.2);
      mesh.scale.setScalar(0.35 + Math.random() * 1.1);
      mesh.visible = false;
      this.scene.add(mesh);
      this.drops.push({ mesh, velocity: spread.multiplyScalar(speed), delay: Math.random() * 0.35 });
    }

    // Unas gotas tambien hacia la derecha (por donde entra).
    for (let index = 0; index < 40; index += 1) {
      const spread = new T.Vector3(0.6 + Math.random() * 0.6, Math.random() * 0.9, (Math.random() - 0.5) * 1.2).normalize();
      const mesh = new T.Mesh(this.dropGeometry, this.bloodMaterial);
      mesh.position.copy(head).addScaledVector(spread, 0.35);
      mesh.scale.setScalar(0.35 + Math.random() * 0.8);
      mesh.visible = false;
      this.scene.add(mesh);
      this.drops.push({ mesh, velocity: spread.multiplyScalar(1.5 + Math.random() * 2.5), delay: Math.random() * 0.2 });
    }
  }

  private updateLooseGun(now: number): void {
    if (!this.looseGun.group.visible) {
      return;
    }

    const elapsed = (now - this.looseGunAt) / 1000;
    const group = this.looseGun.group;

    if (group.position.y > 0.06) {
      this.looseVelocity.y -= 9.8 * 0.016;
      group.position.addScaledVector(this.looseVelocity, 0.016);
      group.rotation.x += 0.25;
      group.rotation.z += 0.12;
    } else {
      group.position.y = 0.06;
      group.rotation.set(0, elapsed, Math.PI / 2);
    }
  }

  /* ------------------------------- Ragdoll ---------------------------------- */

  private applyRagdoll(walker: Walker, parts: MiiParts, now: number): void {
    const pose = sampleRagdoll(walker.ragdoll, (now - walker.deadAt) / 1000);
    parts.body.position.y -= pose.drop;
    parts.legLeft.position.y -= pose.drop;
    parts.legRight.position.y -= pose.drop;
    parts.body.rotation.set(pose.bodyX, 0, pose.bodyZ);
    parts.head.rotation.set(pose.headX, 0, pose.headZ);
    parts.armLeft.rotation.set(pose.armLX, 0, -BASE_ARM_Z + pose.armLZ);
    parts.armRight.rotation.set(pose.armRX, 0, BASE_ARM_Z + pose.armRZ);
    parts.legLeft.rotation.set(pose.legLX, 0, 0);
    parts.legRight.rotation.set(pose.legRX, 0, 0);
    walker.faller.rotation.set(pose.fallX, 0, pose.fallZ);
    // Tumbado, el cuerpo apoya sobre el suelo (no se hunde).
    walker.faller.position.y = 0.3 * Math.max(Math.abs(Math.sin(pose.fallX)), Math.abs(Math.sin(pose.fallZ)));
  }

  private updateCorpse(walker: Walker, now: number): void {
    const elapsed = now - walker.deadAt;

    // Charco de sangre que crece bajo la cabeza una vez en el suelo.
    if (elapsed > ragdollDuration(walker.ragdoll) * 1000 && !this.handled.has(`pool:${walker.view.playerId}`)) {
      this.handled.add(`pool:${walker.view.playerId}`);
      const head = new this.THREE.Vector3();
      walker.parts?.head.getWorldPosition(head);
      this.addStain(head.x, 0.012, head.z, 1.1, 2200);
    }

    // Al rato desaparece (encogiendose) y deja la sangre en el suelo.
    const fade = (elapsed - CORPSE_FADE_AFTER_MS) / CORPSE_FADE_MS;

    if (fade > 0) {
      const scale = Math.max(0.001, 1 - ease(fade));
      walker.holder.scale.setScalar(scale);
      walker.holder.visible = fade < 1;
    }
  }

  private addStain(x: number, y: number, z: number, size: number, grow = 260): void {
    const mesh = new this.THREE.Mesh(this.stainGeometry, this.stainMaterial);
    mesh.rotation.x = -Math.PI / 2;
    mesh.rotation.z = Math.random() * Math.PI;
    mesh.position.set(x, y, z);
    mesh.scale.set(0.001, 0.001 * (0.7 + Math.random() * 0.6), 1);
    this.scene.add(mesh);
    this.stains.push({ mesh, grow, size, bornAt: performance.now() });
  }

  private updateBlood(now: number, delta: number): void {
    for (let index = this.drops.length - 1; index >= 0; index -= 1) {
      const drop = this.drops[index];

      if (drop.delay > 0) {
        drop.delay -= delta;
        continue;
      }

      drop.mesh.visible = true;
      drop.velocity.y -= 9.8 * delta;
      drop.mesh.position.addScaledVector(drop.velocity, delta);
      const { x, y, z } = drop.mesh.position;
      const overTable = Math.hypot(x - TABLE.x, z - TABLE.z) < TABLE.radius;

      // Al tocar el suelo (o la mesa) deja una mancha.
      if ((overTable && y <= TABLE.top + 0.01 && y > TABLE.top - 0.15) || y <= 0.02) {
        const surface = overTable && y > TABLE.top - 0.15 ? TABLE.top + 0.014 : 0.012;
        this.addStain(x, surface, z, 0.05 + Math.random() * 0.12 * drop.mesh.scale.x);
        this.scene.remove(drop.mesh);
        this.drops.splice(index, 1);
      }
    }

    for (const stain of this.stains) {
      const progress = ease((now - stain.bornAt) / stain.grow);
      const ratio = stain.mesh.userData['ratio'] ?? (stain.mesh.userData['ratio'] = 0.7 + Math.random() * 0.6);
      stain.mesh.scale.set(stain.size * progress, stain.size * progress * ratio, 1);
    }
  }

  /* --------------------------------- Camara --------------------------------- */

  /** Mesa, jugador y las primeras plazas de la fila (la camara un poco alejada). */
  private tableGoal(): CameraGoal {
    const T = this.THREE;
    return {
      target: new T.Vector3(0.9, 1.1, 0.4),
      direction: new T.Vector3(0, 0.3, 1).normalize(),
      fit: [
        new T.Vector3(-1.8, 0, 1.4),
        new T.Vector3(-1.4, 2.4, 0),
        new T.Vector3(QUEUE_START.x + QUEUE_GAP * 2.6, 0, QUEUE_START.z + 0.4),
        new T.Vector3(QUEUE_START.x + QUEUE_GAP * 2.6, 2.4, QUEUE_START.z),
        new T.Vector3(0, 3.0, -0.6),
      ],
      margin: 0.94,
    };
  }

  /* ---------------------------------- Bucle --------------------------------- */

  private loop(): void {
    this.frameHandle = requestAnimationFrame(() => this.loop());
    const now = performance.now();
    const delta = Math.min(0.05, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    const time = now / 1000;

    for (const walker of this.walkers.values()) {
      this.updateWalker(walker, now, time, delta);
    }

    this.updateGuns(now);
    this.updateBlood(now, delta);
    this.director.update(now, delta);

    // Temblor de camara con el disparo.
    if (now < this.shakeUntil) {
      const strength = ((this.shakeUntil - now) / 700) * 0.18;
      this.camera.position.x += Math.sin(now * 0.09) * strength;
      this.camera.position.y += Math.cos(now * 0.11) * strength;
    }

    this.renderer.render(this.scene, this.camera);
    this.placeLabels();
  }

  /** Nombre bajo los pies de cada Mii visible (los caidos, sin nombre). */
  private placeLabels(): void {
    const width = this.host.clientWidth;
    const height = this.host.clientHeight;

    for (const label of Array.from(this.labelLayer.querySelectorAll<HTMLElement>('[data-rr-label]'))) {
      const walker = this.walkers.get(label.dataset['rrLabel'] || '');

      if (!walker || walker.mode === 'dead') {
        label.style.opacity = '0';
        continue;
      }

      const vector = this.scratch.copy(walker.holder.position).setZ(walker.holder.position.z + 0.5).project(this.camera);
      const visible = vector.z < 1 && Math.abs(vector.x) < 1.02 && Math.abs(vector.y) < 1.02;
      label.style.opacity = visible ? '1' : '0';
      label.style.transform = `translate(${((vector.x + 1) / 2) * width}px, ${((1 - vector.y) / 2) * height}px) translate(-50%, 4px)`;
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
