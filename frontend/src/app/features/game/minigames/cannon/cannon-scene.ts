import type * as ThreeModule from 'three';
import { MiiMood, MiiParts, MiiRig, createFaceTexture } from '../../../../shared/components/mii-stage/mii-rig';
import { BlastEffects, applyBlastPose } from '../../../../shared/three/blast-effects';
import { BLAST_STAND_Y, BLAST_VARIANT_COUNT, blastImpacts, sampleBlast } from '../../../../shared/three/blast-ragdoll';
import { CameraDirector, CameraGoal, ViewInsets } from '../../../../shared/three/camera-director';

type Three = typeof ThreeModule;
type Vector3 = ThreeModule.Vector3;

// Muralla al fondo (con el canon en lo alto) y el patio delante con las 4 zonas en fila.
const WALL = { z: -9.2, depth: 2.6, height: 3.4, width: 20 };
const CANNON_Z = WALL.z + 0.55;
const CANNONEER_Z = WALL.z - 0.6;
const ZONE_SIZE = 2.9;
const ZONE_GAP = 0.45;
const ZONE_Z = 0;
const STAGING_Z = 4.2;
const SLOT_GAP = 0.82;
const WALK_SPEED = 3;
const FOV = 42;
const BARREL_LENGTH = 1.55;
const BALL_RADIUS = 0.22;
const CORPSE_FADE_MS = 600;
const BLOOD_TRAIL_S = 0.8;
// Muros delante de cada cuadrado (por el lado del canon): caen hacia delante al elegir donde disparar.
// Altos de sobra para tapar del todo a quien este detras (cabeza incluida) desde la camara del canonero.
const ZONE_WALL_HEIGHT = 3.1;
const ZONE_WALL_GAP = 0.35;
const WALL_FALL_MS = 650;
const WALL_RISE_MS = 700;
export const ZONE_COLORS = ['#e8414b', '#3b82f6', '#22a447', '#f2b705'];

export interface CannonPlayerView {
  playerId: string;
  name: string;
  avatarUrl: string;
  shirt: string;
}

/** Estado que pinta la escena; los instantes ya vienen en el reloj local (performance.now). */
export interface CannonSceneState {
  /** Desde donde se mira: el canonero (detras del canon) o los de abajo (detras de las zonas). */
  view: 'cannoneer' | 'victim';
  cannoneerId: string;
  victims: string[];
  alive: string[];
  round: number;
  stage: 'choosing' | 'aiming' | 'firing' | 'result' | 'finished';
  /** Zona de cada uno de los de abajo (null = aun en la linea de espera). Solo lo que se puede ver. */
  zones: Record<string, number | null>;
  /** Si los de abajo se ven (el canonero no los ve hasta el disparo). */
  victimsVisible: boolean;
  /** Zona a la que apunta el canon (la elegida o, para el canonero, la que tiene seleccionada). */
  aimZone: number | null;
  target: number | null;
  fireAt: number;
  impactAt: number;
  /** Alcanzados en este disparo. */
  hit: string[];
}

interface Walker {
  view: CannonPlayerView;
  holder: ThreeModule.Group;
  flier: ThreeModule.Group;
  rig: MiiRig;
  parts: MiiParts | null;
  target: Vector3;
  facing: number;
  dead: boolean;
  deadAt: number;
  deadRound: number;
  variant: number;
  impacts: number[];
  fadeAt: number;
  /** Ya se ha visto en pantalla (para que al desvelarse aparezca en su sitio). */
  shown: boolean;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const ease = (value: number) => {
  const clamped = clamp01(value);
  return clamped * clamped * (3 - 2 * clamped);
};

/** Centro de una zona (0..3), de izquierda a derecha vista desde el patio. */
export function zoneCenter(zone: number): { x: number; z: number } {
  return { x: (zone - 1.5) * (ZONE_SIZE + ZONE_GAP), z: ZONE_Z };
}

/**
 * Escena 3D del Canon: una muralla de piedra con el canon (y el canonero) arriba y el patio con 4 zonas de
 * colores. Cada uno se coloca en su zona (en cuadricula, sin amontonarse); el canonero no ve a nadie hasta el
 * disparo. La bala sale en parabola, explota en la zona y los que estan dentro salen volando.
 */
export class CannonScene {
  private readonly renderer: ThreeModule.WebGLRenderer;
  private readonly scene: ThreeModule.Scene;
  private readonly camera: ThreeModule.PerspectiveCamera;
  private readonly director: CameraDirector;
  private readonly effects: BlastEffects;
  private readonly walkers = new Map<string, Walker>();
  private readonly disposables: Array<{ dispose: () => void }> = [];
  private readonly resizeObserver: ResizeObserver;
  private readonly scratch: Vector3;
  private readonly raycaster: ThreeModule.Raycaster;
  private readonly groundPlane: ThreeModule.Plane;
  private readonly handled = new Set<string>();
  private readonly zoneMeshes: Array<{ mesh: ThreeModule.Mesh; material: ThreeModule.MeshStandardMaterial; markerMaterial: ThreeModule.MeshBasicMaterial }> = [];
  private cannon!: { yaw: ThreeModule.Group; pitch: ThreeModule.Group; barrel: ThreeModule.Group; flash: ThreeModule.Mesh; light: ThreeModule.PointLight };
  private readonly ball: ThreeModule.Mesh;
  private state: CannonSceneState;
  private readonly zoneWalls: Array<{ pivot: ThreeModule.Group; materials: ThreeModule.Material[] }> = [];
  private wallsFallAt = -Infinity;
  private wallsRiseAt = -Infinity;
  private layoutRound = -1;
  private hoverZone: number | null = null;
  private shakeUntil = 0;
  private insets: ViewInsets = { top: 0, right: 0, bottom: 0, left: 0 };
  private frameHandle = 0;
  private lastFrame = performance.now();
  private disposed = false;

  /** Clic en una zona del patio (para elegir zona o donde disparar). */
  onZonePicked?: (zone: number) => void;
  /** Avisos para los sonidos. */
  onSound?: (sound: 'fire' | 'whistle' | 'boom' | 'thud' | 'reveal' | 'walls') => void;
  /** Si se puede hacer clic en las zonas ahora mismo. */
  picking = false;

  constructor(
    private readonly THREE: Three,
    private readonly canvas: HTMLCanvasElement,
    private readonly host: HTMLElement,
    private readonly labelLayer: HTMLElement,
    players: CannonPlayerView[],
    initialState: CannonSceneState,
    proxyBase: string,
  ) {
    const T = THREE;
    this.renderer = new T.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = T.SRGBColorSpace;
    this.scene = new T.Scene();
    this.scene.background = new T.Color('#9fd6f5');
    this.scene.fog = new T.Fog('#9fd6f5', 26, 60);
    this.camera = new T.PerspectiveCamera(FOV, 1, 0.1, 140);
    this.director = new CameraDirector(T, this.camera);
    this.effects = new BlastEffects(T, this.scene);
    this.scratch = new T.Vector3();
    this.raycaster = new T.Raycaster();
    this.groundPlane = new T.Plane(new T.Vector3(0, 1, 0), 0);
    this.state = initialState;

    this.buildCourtyard();
    this.buildWall();
    this.buildCannon();
    this.ball = new T.Mesh(this.track(new T.SphereGeometry(BALL_RADIUS, 20, 14)), this.material('#1c1e22', 0.35, { metalness: 0.5 }));
    this.ball.visible = false;
    this.scene.add(this.ball);

    const time = performance.now() / 1000;
    const byId = new Map(players.map((player) => [player.playerId, player]));
    [initialState.cannoneerId, ...initialState.victims].forEach((playerId, index) => {
      const view = byId.get(playerId);

      if (view) {
        this.createWalker(view, time + 0.15 + index * 0.08, proxyBase);
      }
    });

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();
    this.placeCannoneer();
    this.layout(initialState, true);
    this.sync(initialState);
    canvas.addEventListener('pointerdown', this.pointerDown);
    canvas.addEventListener('pointermove', this.pointerMove);
    this.loop();
  }

  sync(state: CannonSceneState): void {
    if (this.disposed) {
      return;
    }

    this.state = state;

    if (state.round !== this.layoutRound) {
      this.layout(state, false);
    }

    // Sitio de cada uno de abajo. Los que aun no se han visto (el canonero no los ve hasta el disparo) aparecen
    // directamente en su cuadrado, sin cruzar el patio desde la linea de espera.
    for (const walker of this.walkers.values()) {
      if (walker.view.playerId !== state.cannoneerId && !walker.dead) {
        walker.target.copy(this.spotFor(walker.view.playerId, state));

        if (!walker.shown) {
          walker.holder.position.copy(walker.target);
        }
      }
    }

    // Se ha elegido donde disparar: los muros caen hacia delante y se ve quien estaba en cada cuadrado.
    if ((state.stage === 'firing' || state.stage === 'result' || state.stage === 'finished') && !this.handled.has(`walls-down:${state.round}`)) {
      this.handled.add(`walls-down:${state.round}`);
      this.wallsFallAt = performance.now();
    }

    // Disparo: los de la zona saldran volando al llegar la bala.
    if (state.target !== null && (state.stage === 'firing' || state.stage === 'result') && !this.handled.has(`shot:${state.round}`)) {
      this.handled.add(`shot:${state.round}`);
      const center = zoneCenter(state.target);

      state.hit.forEach((playerId, index) => {
        const walker = this.walkers.get(playerId);

        if (walker && !walker.dead) {
          walker.dead = true;
          walker.deadAt = state.impactAt;
          walker.deadRound = state.round;
          walker.variant = (state.round + index + state.victims.indexOf(playerId)) % BLAST_VARIANT_COUNT;
          walker.impacts = blastImpacts(walker.variant);
          // Mira hacia la explosion para salir despedido hacia atras (lejos de ella). Al canonero, de cara a el
          // (hacia la muralla, abriendose un poco segun su sitio), para que se les vea la cara al salir volando.
          const dx = center.x - walker.target.x;
          const dz = center.z - walker.target.z;
          walker.facing =
            state.view === 'cannoneer'
              ? Math.PI + Math.max(-0.5, Math.min(0.5, dx * 0.4))
              : Math.hypot(dx, dz) > 0.05
                ? Math.atan2(dx, dz)
                : (index / Math.max(1, state.hit.length)) * Math.PI * 2;
        }
      });
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
    this.canvas.removeEventListener('pointerdown', this.pointerDown);
    this.canvas.removeEventListener('pointermove', this.pointerMove);

    for (const walker of this.walkers.values()) {
      walker.rig.dispose();
    }

    this.effects.dispose();

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

  /** Patio de arena con cesped alrededor y las 4 zonas de colores (con su numero). */
  private buildCourtyard(): void {
    const T = this.THREE;
    this.scene.add(new T.HemisphereLight(0xffffff, 0x6b5a3a, 1.3));
    const sun = new T.DirectionalLight(0xfff0d0, 1.35);
    sun.position.set(-6, 14, 10);
    this.scene.add(sun);

    const grass = new T.Mesh(this.track(new T.PlaneGeometry(140, 140)), this.material('#6cbf4a', 0.95));
    grass.rotation.x = -Math.PI / 2;
    this.scene.add(grass);

    const sandTexture = this.canvasTexture(
      128,
      128,
      (context) => {
        context.fillStyle = '#d9bf8a';
        context.fillRect(0, 0, 128, 128);

        for (let index = 0; index < 260; index += 1) {
          context.fillStyle = index % 2 ? 'rgba(120, 90, 40, 0.18)' : 'rgba(255, 245, 210, 0.25)';
          context.fillRect((index * 53) % 128, (index * 97) % 128, 2, 2);
        }
      },
      [8, 6],
    );
    const sand = new T.Mesh(this.track(new T.PlaneGeometry(WALL.width, 18)), this.track(new T.MeshStandardMaterial({ map: sandTexture, roughness: 1 })));
    sand.rotation.x = -Math.PI / 2;
    sand.position.set(0, 0.003, WALL.z + 9);
    this.scene.add(sand);

    for (let zone = 0; zone < 4; zone += 1) {
      const center = zoneCenter(zone);
      const material = this.material(ZONE_COLORS[zone], 0.8, { transparent: true, opacity: 0.85 });
      const mesh = new T.Mesh(this.track(new T.PlaneGeometry(ZONE_SIZE, ZONE_SIZE)), material);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set(center.x, 0.01, center.z);
      mesh.userData['zone'] = zone;
      // Borde blanco.
      const border = new T.Mesh(this.track(new T.RingGeometry(ZONE_SIZE * 0.69, ZONE_SIZE * 0.71, 4, 1)), this.track(new T.MeshBasicMaterial({ color: '#ffffff' })));
      border.rotation.set(-Math.PI / 2, 0, Math.PI / 4);
      border.position.set(center.x, 0.015, center.z);
      // Marca de la zona apuntada (brilla y late). El numero de cada zona va en una etiqueta HTML encima.
      const markerMaterial = this.track(new T.MeshBasicMaterial({ color: '#ff1a1a', transparent: true, opacity: 0 }));
      const marker = new T.Mesh(this.track(new T.RingGeometry(ZONE_SIZE * 0.5, ZONE_SIZE * 0.6, 32)), markerMaterial);
      marker.rotation.x = -Math.PI / 2;
      marker.position.set(center.x, 0.03, center.z);
      this.scene.add(mesh, border, marker);
      this.zoneMeshes.push({ mesh, material, markerMaterial });
      this.buildZoneWall(zone);
    }

    // Linea de espera (donde estan los de abajo antes de elegir).
    const line = new T.Mesh(this.track(new T.PlaneGeometry(ZONE_SIZE * 4 + ZONE_GAP * 3, 0.08)), this.track(new T.MeshBasicMaterial({ color: '#ffffff' })));
    line.rotation.x = -Math.PI / 2;
    line.position.set(0, 0.012, STAGING_Z - 0.7);
    this.scene.add(line);
  }

  /**
   * Muro de tablones delante de un cuadrado, con su numero grande en la cara que ve el canonero. Gira sobre su
   * borde inferior delantero para caer hacia el canon.
   */
  private buildZoneWall(zone: number): void {
    const T = this.THREE;
    const center = zoneCenter(zone);
    const width = ZONE_SIZE + 0.1;
    const planks = this.canvasTexture(256, 192, (context) => {
      context.fillStyle = ZONE_COLORS[zone];
      context.fillRect(0, 0, 256, 192);

      for (let plank = 0; plank < 8; plank += 1) {
        context.fillStyle = plank % 2 ? 'rgba(0, 0, 0, 0.12)' : 'rgba(255, 255, 255, 0.1)';
        context.fillRect(plank * 32, 0, 32, 192);
        context.fillStyle = 'rgba(0, 0, 0, 0.35)';
        context.fillRect(plank * 32, 0, 3, 192);
      }

      // Travesanos.
      context.fillStyle = 'rgba(60, 35, 15, 0.55)';
      context.fillRect(0, 26, 256, 14);
      context.fillRect(0, 150, 256, 14);
    });
    const wood = this.track(new T.MeshStandardMaterial({ map: planks, roughness: 0.85, transparent: true }));
    const number = this.canvasTexture(256, 256, (context) => {
      context.font = '900 210px sans-serif';
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.lineWidth = 18;
      context.strokeStyle = '#000';
      context.strokeText(String(zone + 1), 128, 140);
      context.fillStyle = '#fff';
      context.fillText(String(zone + 1), 128, 140);
    });
    const numberMaterial = this.track(new T.MeshBasicMaterial({ map: number, transparent: true, depthWrite: false }));
    const pivot = new T.Group();
    pivot.position.set(center.x, 0, center.z - ZONE_SIZE / 2 - ZONE_WALL_GAP);
    const board = new T.Mesh(this.track(new T.BoxGeometry(width, ZONE_WALL_HEIGHT, 0.18)), wood);
    board.position.set(0, ZONE_WALL_HEIGHT / 2, 0.09);
    // El numero, en la cara del lado del canon (mirando hacia -z).
    const label = new T.Mesh(this.track(new T.PlaneGeometry(1.5, 1.5)), numberMaterial);
    label.position.set(0, ZONE_WALL_HEIGHT * 0.55, -0.01);
    label.rotation.y = Math.PI;
    pivot.add(board, label);
    this.scene.add(pivot);
    this.zoneWalls.push({ pivot, materials: [wood, numberMaterial] });
  }

  /** Muros: caen hacia delante (acelerando y con un pequeno rebote) o se levantan apareciendo poco a poco. */
  private updateZoneWalls(now: number): void {
    const falling = this.wallsFallAt > this.wallsRiseAt;
    let angle = 0;
    let opacity = 1;

    if (falling) {
      const progress = (now - this.wallsFallAt) / WALL_FALL_MS;
      angle = progress < 1 ? progress * progress * (Math.PI / 2) : Math.PI / 2 - Math.max(0, Math.sin(Math.min(1, (progress - 1) / 0.35) * Math.PI)) * 0.1;

      if (progress >= 1 && !this.handled.has(`walls-thud:${this.wallsFallAt}`)) {
        this.handled.add(`walls-thud:${this.wallsFallAt}`);
        this.onSound?.('walls');
      }
    } else {
      opacity = clamp01((now - this.wallsRiseAt) / WALL_RISE_MS);
    }

    for (const wall of this.zoneWalls) {
      wall.pivot.rotation.x = -angle;
      wall.pivot.visible = opacity > 0.01;

      for (const material of wall.materials) {
        material.opacity = opacity;
      }
    }
  }

  /** Muralla de piedra con almenas; el canon asoma por el centro. */
  private buildWall(): void {
    const T = this.THREE;
    const bricks = this.canvasTexture(
      256,
      256,
      (context) => {
        context.fillStyle = '#8f8a80';
        context.fillRect(0, 0, 256, 256);

        for (let row = 0; row < 8; row += 1) {
          for (let column = 0; column < 5; column += 1) {
            const shade = 120 + ((row * 31 + column * 17) % 40);
            context.fillStyle = `rgb(${shade}, ${shade - 6}, ${shade - 14})`;
            context.fillRect(column * 56 + (row % 2) * 28 - 26, row * 32 + 2, 52, 28);
          }
        }
      },
      [6, 1.4],
    );
    const stone = this.track(new T.MeshStandardMaterial({ map: bricks, roughness: 0.95 }));
    const wall = new T.Mesh(this.track(new T.BoxGeometry(WALL.width, WALL.height, WALL.depth)), stone);
    wall.position.set(0, WALL.height / 2, WALL.z);
    this.scene.add(wall);

    // Almenas (con hueco en el centro para el canon).
    const merlon = this.track(new T.BoxGeometry(0.9, 0.7, 0.5));

    for (let x = -WALL.width / 2 + 0.6; x <= WALL.width / 2 - 0.5; x += 1.6) {
      if (Math.abs(x) < 1.4) {
        continue;
      }

      const block = new T.Mesh(merlon, stone);
      block.position.set(x, WALL.height + 0.35, WALL.z + WALL.depth / 2 - 0.25);
      this.scene.add(block);
    }

    // Torreones a los lados.
    for (const x of [-WALL.width / 2 - 0.6, WALL.width / 2 + 0.6]) {
      const tower = new T.Mesh(this.track(new T.CylinderGeometry(1.5, 1.6, WALL.height + 2, 16)), stone);
      tower.position.set(x, (WALL.height + 2) / 2, WALL.z);
      const roof = new T.Mesh(this.track(new T.ConeGeometry(1.8, 1.8, 16)), this.material('#a33b2b', 0.7));
      roof.position.set(x, WALL.height + 2.9, WALL.z);
      this.scene.add(tower, roof);
    }

    // Banderines en lo alto de los torreones (lejos de la camara del canonero).
    const flagMaterial = this.material('#ffd23f', 0.6, { side: T.DoubleSide });

    for (const x of [-WALL.width / 2 - 0.6, WALL.width / 2 + 0.6]) {
      const pole = new T.Mesh(this.track(new T.CylinderGeometry(0.04, 0.04, 2, 8)), this.material('#3a3a3a'));
      pole.position.set(x, WALL.height + 4.4, WALL.z);
      const flag = new T.Mesh(this.track(new T.PlaneGeometry(0.9, 0.55)), flagMaterial);
      flag.position.set(x + 0.45, WALL.height + 5.1, WALL.z);
      this.scene.add(pole, flag);
    }
  }

  /** Canon sobre su cureña: gira (yaw) hacia la zona y el tubo se inclina un poco hacia el patio. */
  private buildCannon(): void {
    const T = this.THREE;
    const iron = this.material('#2b2f36', 0.35, { metalness: 0.65 });
    const wood = this.material('#7a4a24', 0.65);
    const yaw = new T.Group();
    yaw.position.set(0, WALL.height, CANNON_Z);
    const carriage = new T.Mesh(this.track(new T.BoxGeometry(0.9, 0.35, 1.3)), wood);
    carriage.position.y = 0.3;
    yaw.add(carriage);

    for (const side of [-1, 1]) {
      const wheel = new T.Mesh(this.track(new T.CylinderGeometry(0.42, 0.42, 0.14, 20)), wood);
      wheel.rotation.z = Math.PI / 2;
      wheel.position.set(side * 0.55, 0.42, 0.15);
      const hub = new T.Mesh(this.track(new T.CylinderGeometry(0.1, 0.1, 0.18, 10)), iron);
      hub.rotation.z = Math.PI / 2;
      hub.position.copy(wheel.position);
      yaw.add(wheel, hub);
    }

    const pitch = new T.Group();
    pitch.position.set(0, 0.72, 0);
    const barrel = new T.Group();
    const tube = new T.Mesh(this.track(new T.CylinderGeometry(0.22, 0.3, BARREL_LENGTH, 20)), iron);
    tube.rotation.x = Math.PI / 2;
    tube.position.z = BARREL_LENGTH / 2 - 0.3;
    const muzzle = new T.Mesh(this.track(new T.TorusGeometry(0.23, 0.06, 10, 20)), iron);
    muzzle.position.z = BARREL_LENGTH - 0.3;
    const back = new T.Mesh(this.track(new T.SphereGeometry(0.3, 16, 12)), iron);
    back.position.z = -0.3;
    const hole = new T.Mesh(this.track(new T.CircleGeometry(0.17, 16)), this.track(new T.MeshBasicMaterial({ color: '#050505' })));
    hole.position.z = BARREL_LENGTH - 0.29;
    const flash = new T.Mesh(this.track(new T.SphereGeometry(0.35, 14, 10)), this.track(new T.MeshBasicMaterial({ color: '#ffd27a', transparent: true, opacity: 0.95 })));
    flash.position.z = BARREL_LENGTH - 0.05;
    flash.scale.set(1, 1, 2);
    flash.visible = false;
    const light = new T.PointLight(0xffc070, 0, 8, 2);
    light.position.copy(flash.position);
    barrel.add(tube, muzzle, back, hole, flash, light);
    pitch.add(barrel);
    yaw.add(pitch);
    this.scene.add(yaw);
    this.cannon = { yaw, pitch, barrel, flash, light };
  }

  private createWalker(view: CannonPlayerView, enterAt: number, proxyBase: string): void {
    const T = this.THREE;
    const holder = new T.Group();
    const flier = new T.Group();
    flier.position.y = BLAST_STAND_Y;
    const offset = new T.Group();
    offset.position.y = -BLAST_STAND_Y;
    const rig = new MiiRig(T, view.shirt);
    rig.enter(enterAt);
    offset.add(rig.root);
    flier.add(offset);
    holder.add(flier);
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
      flier,
      rig,
      parts: null,
      target: new T.Vector3(),
      facing: Math.PI,
      dead: false,
      deadAt: 0,
      deadRound: 0,
      variant: 0,
      impacts: [],
      fadeAt: 0,
      shown: false,
    };
    rig.poseOverride = (parts) => {
      walker.parts = parts;
      this.applyPose(walker, parts);
    };
    this.walkers.set(view.playerId, walker);
  }

  /** El canonero, en lo alto de la muralla detras del canon, mirando al patio. */
  private placeCannoneer(): void {
    const walker = this.walkers.get(this.state.cannoneerId);

    if (walker) {
      walker.holder.position.set(0, WALL.height, CANNONEER_Z);
      walker.target.copy(walker.holder.position);
      walker.facing = 0;
      walker.holder.rotation.y = 0;
    }
  }

  /** Ronda nueva: los vivos vuelven a la linea de espera y los caidos desaparecen. */
  private layout(state: CannonSceneState, instant: boolean): void {
    this.layoutRound = state.round;

    // Ronda nueva: los muros vuelven a levantarse (apareciendo poco a poco).
    if (!instant) {
      this.wallsRiseAt = performance.now();
    }

    for (const walker of this.walkers.values()) {
      if (walker.view.playerId === state.cannoneerId) {
        continue;
      }

      if (walker.dead && walker.deadRound < state.round && !walker.fadeAt) {
        walker.fadeAt = performance.now();
      }

      if (!walker.dead) {
        walker.target.copy(this.spotFor(walker.view.playerId, state));

        if (instant) {
          walker.holder.position.copy(walker.target);
        }
      }
    }
  }

  /** Sitio de un jugador de abajo: en cuadricula dentro de su zona (sin amontonarse) o en la linea de espera. */
  private spotFor(playerId: string, state: CannonSceneState): Vector3 {
    const T = this.THREE;
    const zone = state.zones[playerId];
    const alive = state.victims.filter((id) => state.alive.includes(id) || state.hit.includes(id));

    if (zone === null || zone === undefined) {
      const waiting = alive.filter((id) => state.zones[id] === null || state.zones[id] === undefined);
      const index = Math.max(0, waiting.indexOf(playerId));
      const span = (ZONE_SIZE * 4 + ZONE_GAP * 3) / Math.max(1, waiting.length);
      return new T.Vector3(-((ZONE_SIZE * 4 + ZONE_GAP * 3) / 2) + span * (index + 0.5), 0, STAGING_Z);
    }

    const mates = alive.filter((id) => state.zones[id] === zone);
    const index = Math.max(0, mates.indexOf(playerId));
    const columns = Math.max(1, Math.ceil(Math.sqrt(mates.length)));
    const rows = Math.ceil(mates.length / columns);
    // Si son muchos, se aprietan para caber en el cuadrado.
    const gap = Math.min(SLOT_GAP, (ZONE_SIZE - 0.7) / Math.max(1, Math.max(columns, rows) - 1));
    const column = index % columns;
    const row = Math.floor(index / columns);
    const center = zoneCenter(zone);
    return new T.Vector3(center.x + (column - (columns - 1) / 2) * gap, 0, center.z + (row - (rows - 1) / 2) * gap);
  }

  /* --------------------------------- Clics ---------------------------------- */

  private zoneAt(event: PointerEvent): number | null {
    const rect = this.canvas.getBoundingClientRect();
    const pointer = new this.THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(pointer, this.camera);
    const hit = this.raycaster.ray.intersectPlane(this.groundPlane, this.scratch);

    if (!hit) {
      return null;
    }

    for (let zone = 0; zone < 4; zone += 1) {
      const center = zoneCenter(zone);

      if (Math.abs(hit.x - center.x) <= ZONE_SIZE / 2 + 0.1 && Math.abs(hit.z - center.z) <= ZONE_SIZE / 2 + 0.1) {
        return zone;
      }
    }

    return null;
  }

  private readonly pointerDown = (event: PointerEvent) => {
    if (!this.picking) {
      return;
    }

    const zone = this.zoneAt(event);

    if (zone !== null) {
      this.onZonePicked?.(zone);
    }
  };

  private readonly pointerMove = (event: PointerEvent) => {
    this.hoverZone = this.picking ? this.zoneAt(event) : null;
    this.canvas.style.cursor = this.hoverZone !== null ? 'pointer' : '';
  };

  /* -------------------------------- Posturas -------------------------------- */

  private applyPose(walker: Walker, parts: MiiParts): void {
    const now = performance.now();

    if (walker.dead) {
      if (now >= walker.deadAt) {
        applyBlastPose(walker.flier, parts, sampleBlast(walker.variant, (now - walker.deadAt) / 1000));
      }

      return;
    }

    // El canonero sujeta el canon por detras con las dos manos (si esta mirando al patio).
    if (walker.view.playerId === this.state.cannoneerId && Math.abs(walker.holder.rotation.y) < 0.4) {
      const recoil = this.state.stage === 'firing' && now >= this.state.fireAt && now < this.state.fireAt + 300 ? 1 - (now - this.state.fireAt) / 300 : 0;
      parts.armLeft.rotation.set(-0.95 + recoil * 0.4, 0, 0.3);
      parts.armRight.rotation.set(-0.95 + recoil * 0.4, 0, -0.3);
      parts.body.rotation.x += 0.15 - recoil * 0.2;
    }
  }

  private updateWalker(walker: Walker, now: number, time: number, delta: number): void {
    const holder = walker.holder;
    const state = this.state;
    const isCannoneer = walker.view.playerId === state.cannoneerId;
    let moving = false;

    if (walker.fadeAt) {
      const fade = (now - walker.fadeAt) / CORPSE_FADE_MS;
      holder.scale.setScalar(Math.max(0.001, 1 - ease(fade)));
      holder.visible = fade < 1;

      if (fade >= 1) {
        return;
      }
    } else {
      holder.visible = isCannoneer || state.victimsVisible;
    }

    if (!walker.dead && !isCannoneer) {
      const distance = holder.position.distanceTo(walker.target);

      // Oculto (vista del canonero): al desvelarse aparece ya en su sitio, sin caminar hasta el.
      if (!holder.visible || !walker.shown) {
        walker.shown = holder.visible;
        holder.position.copy(walker.target);
        // Aparecen ya mirando a la muralla (al canonero), con la cara hacia el.
        holder.rotation.y = Math.PI;
      } else if (distance > 0.02) {
        const step = Math.min(distance, WALK_SPEED * delta);
        this.scratch.subVectors(walker.target, holder.position).normalize();
        holder.position.addScaledVector(this.scratch, step);
        holder.rotation.y = Math.atan2(this.scratch.x, this.scratch.z);
        moving = true;
      } else {
        // Quietos mirando a la muralla (al canon).
        let turn = Math.PI - holder.rotation.y;
        turn = Math.atan2(Math.sin(turn), Math.cos(turn));
        holder.rotation.y += turn * Math.min(1, delta * 7);
      }
    }

    if (walker.dead) {
      holder.rotation.y = walker.facing;
    }

    // El canonero, de espaldas al patio (mirando a camara) mientras los de abajo se esconden; despues se da la
    // vuelta hacia ellos para apuntar.
    if (isCannoneer) {
      const goal = state.stage === 'choosing' ? Math.PI : 0;
      holder.rotation.y += (goal - holder.rotation.y) * Math.min(1, delta * 4);
    }

    let mood: MiiMood = 'idle';
    const survived = state.stage === 'result' || state.stage === 'finished';

    if (walker.dead) {
      mood = 'idle';
    } else if (moving) {
      mood = 'run';
    } else if (isCannoneer) {
      mood = survived ? (state.hit.length ? 'happy' : 'sad') : 'idle';
    } else if (survived && state.target !== null) {
      mood = 'happy';
    } else if (state.stage === 'aiming' || state.stage === 'firing') {
      mood = 'look-up';
    }

    walker.rig.mood = mood;
    walker.rig.update(time, delta, 'game');

    if (walker.dead) {
      this.updateCorpse(walker, now);
    }
  }

  private updateCorpse(walker: Walker, now: number): void {
    const elapsed = (now - walker.deadAt) / 1000;
    const key = `${walker.view.playerId}:${walker.deadRound}`;

    if (elapsed < 0) {
      return;
    }

    if (!this.handled.has(`blood:${key}`)) {
      this.handled.add(`blood:${key}`);
      const T = this.THREE;
      const backward = new T.Vector3(-Math.sin(walker.facing), 0, -Math.cos(walker.facing));
      this.effects.bloodBurst(walker.holder.position.clone().setY(1.1), backward, 200);
    }

    const body = walker.flier.getWorldPosition(this.scratch);

    if (elapsed < BLOOD_TRAIL_S) {
      this.effects.bloodTrail(body, 3);
    }

    walker.impacts.forEach((impact, index) => {
      if (elapsed >= impact && !this.handled.has(`hit:${key}:${index}`)) {
        this.handled.add(`hit:${key}:${index}`);
        this.effects.pool(body.x, body.z, index === walker.impacts.length - 1 ? 1.4 : 0.6, index === walker.impacts.length - 1 ? 2400 : 300);
        this.onSound?.('thud');
      }
    });
  }

  /* ---------------------------------- Canon --------------------------------- */

  /** Donde sale la bala (boca del canon) en el mundo. */
  private muzzlePosition(target: Vector3): Vector3 {
    this.cannon.barrel.updateWorldMatrix(true, false);
    return target.set(0, 0, BARREL_LENGTH - 0.1).applyMatrix4(this.cannon.barrel.matrixWorld);
  }

  private updateCannon(now: number, delta: number): void {
    const state = this.state;
    const cannon = this.cannon;
    // Apunta a la zona elegida; mientras piensa, el canon barre el patio de lado a lado.
    const zone = state.target ?? state.aimZone ?? (this.picking && state.view === 'cannoneer' ? this.hoverZone : null);
    let yawGoal = Math.sin(now / 1400) * 0.35;

    if (zone !== null) {
      const center = zoneCenter(zone);
      yawGoal = Math.atan2(center.x, center.z - CANNON_Z);
    }

    cannon.yaw.rotation.y += (yawGoal - cannon.yaw.rotation.y) * Math.min(1, delta * 5);
    cannon.pitch.rotation.x = 0.28;

    // Retroceso y fogonazo al disparar.
    const sinceFire = state.stage === 'firing' || state.stage === 'result' ? now - state.fireAt : -1;
    const firing = sinceFire >= 0 && sinceFire < 400;
    cannon.barrel.position.z = firing ? -0.35 * (1 - sinceFire / 400) : 0;
    cannon.flash.visible = sinceFire >= 0 && sinceFire < 160;
    cannon.light.intensity = sinceFire >= 0 && sinceFire < 300 ? 8 * (1 - sinceFire / 300) : 0;

    if (sinceFire >= 0 && !this.handled.has(`fire:${state.round}`)) {
      this.handled.add(`fire:${state.round}`);
      this.onSound?.('fire');
      this.onSound?.('whistle');
      this.shakeUntil = now + 300;
      // Humo en la boca del canon.
      this.effects.explode(this.muzzlePosition(new this.THREE.Vector3()), now, 0.35);
    }

    this.updateBall(now);

    // Zonas: la apuntada se marca en rojo y late; el resto, normales.
    this.zoneMeshes.forEach((entry, index) => {
      const marked = zone === index && (state.view === 'cannoneer' || state.target !== null);
      const hover = this.picking && this.hoverZone === index;
      entry.markerMaterial.opacity = marked ? 0.55 + Math.sin(now / 120) * 0.35 : hover ? 0.35 : 0;
      entry.material.emissive.set(hover || marked ? ZONE_COLORS[index] : '#000000');
      entry.material.emissiveIntensity = hover || marked ? 0.35 : 0;
    });
  }

  private updateBall(now: number): void {
    const state = this.state;

    if (state.target === null || !(state.stage === 'firing' || state.stage === 'result') || now < state.fireAt) {
      this.ball.visible = false;
      return;
    }

    const progress = (now - state.fireAt) / Math.max(1, state.impactAt - state.fireAt);

    if (progress >= 1) {
      this.ball.visible = false;

      if (!this.handled.has(`impact:${state.round}`)) {
        this.handled.add(`impact:${state.round}`);
        const center = zoneCenter(state.target);
        this.effects.explode(new this.THREE.Vector3(center.x, 0.4, center.z), now, 1.25);
        this.shakeUntil = now + 900;
        this.onSound?.('boom');
      }

      return;
    }

    // Parabola desde la boca del canon hasta el centro de la zona.
    const from = this.muzzlePosition(new this.THREE.Vector3());
    const center = zoneCenter(state.target);
    this.ball.visible = true;
    this.ball.position.set(from.x + (center.x - from.x) * progress, 0, from.z + (center.z - from.z) * progress);
    this.ball.position.y = from.y + (0.25 - from.y) * progress + Math.sin(Math.PI * progress) * 2.2;
  }

  /* --------------------------------- Camara --------------------------------- */

  private zonesFit(): Vector3[] {
    const T = this.THREE;
    const half = ZONE_SIZE / 2;
    const left = zoneCenter(0).x - half;
    const right = zoneCenter(3).x + half;
    return [new T.Vector3(left, 0, ZONE_Z - half), new T.Vector3(right, 0, ZONE_Z - half), new T.Vector3(left, 0, ZONE_Z + half), new T.Vector3(right, 0, ZONE_Z + half)];
  }

  /** Canonero: detras del canon, en lo alto de la muralla, mirando al patio. */
  private cannoneerGoal(): CameraGoal {
    const T = this.THREE;
    // Por encima y detras del canonero (se le ve de espaldas, con el canon, y el patio entero por delante).
    return {
      target: new T.Vector3(0, 0.6, ZONE_Z - 1.2),
      direction: new T.Vector3(0, 0.6, -0.8).normalize(),
      fit: [
        ...this.zonesFit(),
        new T.Vector3(-0.9, WALL.height + 2.3, CANNONEER_Z - 0.4),
        new T.Vector3(0.9, WALL.height, CANNONEER_Z - 0.4),
        new T.Vector3(0, WALL.height + 0.4, CANNON_Z + 1.4),
      ],
      margin: 0.94,
    };
  }

  /**
   * Canonero mientras los de abajo eligen: mas atras y algo inclinada hacia arriba (el parapeto tapa el patio).
   * Se ve al canonero de frente, de espaldas al patio.
   */
  private blindGoal(): CameraGoal {
    const T = this.THREE;
    const target = new T.Vector3(0, WALL.height + 3, CANNON_Z + 10);
    const camera = new T.Vector3(0, WALL.height + 1.7, CANNONEER_Z - 4.5);
    return { target, direction: camera.clone().sub(target).normalize(), distance: camera.distanceTo(target) };
  }

  /** Los de abajo: a su espalda, mirando a la muralla y al canon. */
  private victimGoal(): CameraGoal {
    const T = this.THREE;
    return {
      target: new T.Vector3(0, 1.6, (ZONE_Z + WALL.z) / 2 + 0.5),
      direction: new T.Vector3(0, 0.38, 1).normalize(),
      fit: [...this.zonesFit(), new T.Vector3(-6.5, WALL.height + 1.2, WALL.z), new T.Vector3(6.5, WALL.height + 1.2, WALL.z), new T.Vector3(0, 0, STAGING_Z + 0.4)],
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

    this.updateCannon(now, delta);
    this.updateZoneWalls(now);
    this.effects.update(now, delta);
    // El canonero, mientras los de abajo se esconden, mira al horizonte (sin ver el suelo del patio).
    const view = this.state.view;
    const key = view === 'cannoneer' ? (this.state.stage === 'choosing' ? 'cannoneer-blind' : 'cannoneer') : 'victim';
    // La transicion del canonero va en arco por encima de su cabeza (sin atravesarla).
    this.director.focus(key, () => (key === 'cannoneer-blind' ? this.blindGoal() : key === 'cannoneer' ? this.cannoneerGoal() : this.victimGoal()), now, {
      durationMs: 1400,
      arc: view === 'cannoneer' ? 3 : 0,
    });
    this.director.update(now, delta);

    if (now < this.shakeUntil) {
      const strength = Math.min(1, (this.shakeUntil - now) / 900) * 0.22;
      this.camera.position.x += Math.sin(now * 0.09) * strength;
      this.camera.position.y += Math.cos(now * 0.11) * strength;
    }

    this.renderer.render(this.scene, this.camera);
    this.placeLabels();
  }

  /** Nombre bajo los pies de cada Mii visible. */
  private placeLabels(): void {
    const width = this.host.clientWidth;
    const height = this.host.clientHeight;

    for (const label of Array.from(this.labelLayer.querySelectorAll<HTMLElement>('[data-cn-label]'))) {
      const walker = this.walkers.get(label.dataset['cnLabel'] || '');

      if (!walker || walker.dead || !walker.holder.visible) {
        label.style.opacity = '0';
        continue;
      }

      const vector = this.scratch.copy(walker.holder.position).project(this.camera);
      const visible = vector.z < 1 && Math.abs(vector.x) < 1.02 && Math.abs(vector.y) < 1.02;
      label.style.opacity = visible ? '1' : '0';
      label.style.transform = `translate(${((vector.x + 1) / 2) * width}px, ${((1 - vector.y) / 2) * height}px) translate(-50%, 4px)`;
    }

    // Numero de cada zona, en el borde de la zona mas cercano a la camara.
    // Al canonero, mientras los muros estan en pie, el numero ya se lo dan los muros.
    const towardCamera = this.state.view === 'cannoneer' ? -1 : 1;
    const wallsUp = this.wallsFallAt <= this.wallsRiseAt;

    for (const label of Array.from(this.labelLayer.querySelectorAll<HTMLElement>('[data-cn-zone]'))) {
      const center = zoneCenter(Number(label.dataset['cnZone']));
      const vector = this.scratch.set(center.x, 0.05, center.z + towardCamera * ZONE_SIZE * 0.36).project(this.camera);
      label.style.opacity = vector.z < 1 && !(this.state.view === 'cannoneer' && wallsUp) ? '1' : '0';
      label.style.transform = `translate(${((vector.x + 1) / 2) * width}px, ${((1 - vector.y) / 2) * height}px) translate(-50%, -50%)`;
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
