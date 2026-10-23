import type * as ThreeModule from 'three';
import { MiiMood, MiiRig, createFaceTexture } from '../../../../shared/components/mii-stage/mii-rig';
import { CameraDirector, CameraGoal, ViewInsets } from '../../../../shared/three/camera-director';

type Three = typeof ThreeModule;
type Vector3 = ThreeModule.Vector3;

const STAGE_TOP = 0.7;
const STAGE_RADIUS = 4.2;
// Palanca delante del jugador (que mira a camara) y el globo detras, en lo alto de su soporte.
const LEVER_SPOT = { x: 0, z: 0.15 };
const MACHINE_Z = 0.95;
// Solo la palanca (brazo y mango) va un poco adelantada respecto a la maquina, para no atravesar al jugador.
const LEVER_FORWARD = 0.12;
const PIVOT_Y = STAGE_TOP + 0.66;
const LEVER_LENGTH = 0.6;
const LEVER_REST = -0.6;
const LEVER_PULLED = -1.55;
const NOZZLE = { x: 0, y: STAGE_TOP + 1.05, z: -2.1 };
// El globo crece con el aire (no con lo que le falta para explotar) hasta un tamano maximo.
const BALLOON_BASE_RADIUS = 0.42;
const BALLOON_RADIUS_PER_AIR = 0.068;
const BALLOON_MAX_RADIUS = 3;
const QUEUE_START = { x: 5.3, z: 2.3 };
const QUEUE_GAP = 1.05;
const EXIT_X = -11;
const REENTRY_X = 13;
const WALK_SPEED = 3.2;
const PULL_MS = 460;
const CRUSH_MS = 900;
const FOV = 38;

export interface BalloonPlayerView {
  playerId: string;
  name: string;
  avatarUrl: string;
  shirt: string;
  isLocal: boolean;
}

export interface BalloonSceneState {
  order: string[];
  turnIndex: number;
  turnNumber: number;
  currentPlayerId: string | null;
  air: number;
  /** Momento (reloj performance.now) en que el jugador en turno llega a la palanca. */
  turnStartsAt: number;
  lastPumpKey: string;
  explodedBy: string | null;
  exploded: boolean;
}

type WalkerMode = 'queue' | 'to-lever' | 'lever' | 'exit' | 'reentry';

interface Walker {
  view: BalloonPlayerView;
  holder: ThreeModule.Group;
  rig: MiiRig;
  mode: WalkerMode;
  path: Vector3[];
  speed: number;
  slot: number;
}

interface Fragment {
  mesh: ThreeModule.Mesh;
  velocity: Vector3;
  spin: Vector3;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const easeOutBack = (value: number) => 1 + 2.4 * Math.pow(value - 1, 3) + 1.4 * Math.pow(value - 1, 2);

export function balloonRadius(air: number): number {
  return Math.min(BALLOON_MAX_RADIUS, BALLOON_BASE_RADIUS + air * BALLOON_RADIUS_PER_AIR);
}

/**
 * Escena 3D de "Cuidado que explota": escenario con palanca, globo detras y la fila de jugadores abajo a la
 * derecha. Solo representa el estado que le pasa el componente; los paseos de los Miis se calculan aqui.
 */
export class BalloonScene {
  private readonly renderer: ThreeModule.WebGLRenderer;
  private readonly scene: ThreeModule.Scene;
  private readonly camera: ThreeModule.PerspectiveCamera;
  private readonly director: CameraDirector;
  private readonly walkers = new Map<string, Walker>();
  private readonly disposables: Array<{ dispose: () => void }> = [];
  private readonly resizeObserver: ResizeObserver;
  private readonly scratch: Vector3;
  private readonly lever: ThreeModule.Group;
  private readonly balloon: ThreeModule.Group;
  private readonly balloonMaterial: ThreeModule.MeshStandardMaterial;
  private readonly flash: ThreeModule.Mesh;
  private readonly fragments: Fragment[] = [];
  private state: BalloonSceneState | null = null;
  private turnNumber = 0;
  private shownRadius = BALLOON_BASE_RADIUS;
  private radiusFrom = BALLOON_BASE_RADIUS;
  private radiusTarget = BALLOON_BASE_RADIUS;
  private radiusChangedAt = 0;
  private pullStartedAt = -Infinity;
  private lastPumpKey = '';
  private localPullAt = -Infinity;
  private explodedAt: number | null = null;
  private insets: ViewInsets = { top: 0, right: 0, bottom: 0, left: 0 };
  private frameHandle = 0;
  private lastFrame = performance.now();
  private disposed = false;

  constructor(
    private readonly THREE: Three,
    canvas: HTMLCanvasElement,
    private readonly host: HTMLElement,
    private readonly labelLayer: HTMLElement,
    players: BalloonPlayerView[],
    initialState: BalloonSceneState,
    proxyBase: string,
  ) {
    const T = THREE;
    this.renderer = new T.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = T.SRGBColorSpace;
    this.scene = new T.Scene();
    this.scene.background = new T.Color('#ffe3f1');
    this.scene.fog = new T.Fog('#ffe3f1', 30, 70);
    this.camera = new T.PerspectiveCamera(FOV, 1, 0.1, 150);
    this.director = new CameraDirector(T, this.camera);
    this.scratch = new T.Vector3();

    this.buildStage();
    this.lever = this.buildMachine();
    this.balloonMaterial = this.track(new T.MeshStandardMaterial({ color: '#ff5d8f', roughness: 0.28, metalness: 0.05, emissive: '#3a0013' }));
    this.balloon = this.buildBalloon();
    this.flash = new T.Mesh(this.track(new T.SphereGeometry(1, 24, 16)), this.track(new T.MeshBasicMaterial({ color: '#fff7ec', transparent: true, opacity: 0 })));
    this.flash.visible = false;
    this.scene.add(this.flash);

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
    this.director.focus('stage', () => this.stageGoal(), performance.now());
    this.loop();
  }

  sync(state: BalloonSceneState): void {
    if (this.disposed) {
      return;
    }

    const previous = this.state;
    this.state = state;
    const now = performance.now();

    // Turno nuevo: el anterior se va andando por la izquierda y el siguiente sube a la palanca.
    if (state.turnNumber !== this.turnNumber && !state.exploded) {
      this.turnNumber = state.turnNumber;

      for (const walker of this.walkers.values()) {
        if ((walker.mode === 'lever' || walker.mode === 'to-lever') && walker.view.playerId !== state.currentPlayerId) {
          this.startExit(walker);
        }
      }

      const current = state.currentPlayerId ? this.walkers.get(state.currentPlayerId) : undefined;

      if (current && current.mode !== 'lever') {
        this.startWalkToLever(current, Math.max(0, state.turnStartsAt - now));
      }

      this.placeQueue(state, false);
    }

    if (state.air !== previous?.air) {
      this.radiusFrom = this.shownRadius;
      this.radiusTarget = balloonRadius(state.air);
      this.radiusChangedAt = now;
    }

    // Un palancazo nuevo de otro jugador (el propio ya se animo al pulsar).
    if (state.lastPumpKey && state.lastPumpKey !== this.lastPumpKey) {
      this.lastPumpKey = state.lastPumpKey;

      if (now - this.localPullAt > 900) {
        this.pullStartedAt = now;
      }
    }

    if (state.exploded && this.explodedAt === null) {
      this.explode(now);
    }
  }

  /** Palancazo del jugador local: la palanca baja al instante, sin esperar al servidor. */
  pullLeverNow(): void {
    this.pullStartedAt = performance.now();
    this.localPullAt = this.pullStartedAt;
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

  private buildStage(): void {
    const T = this.THREE;
    this.scene.add(new T.HemisphereLight(0xffffff, 0xffc4dc, 1.45));
    const key = new T.DirectionalLight(0xffffff, 1.6);
    key.position.set(4, 10, 8);
    const fill = new T.DirectionalLight(0xfff2c4, 0.55);
    fill.position.set(-6, 5, 4);
    this.scene.add(key, fill);

    const ground = new T.Mesh(this.track(new T.CircleGeometry(80, 48)), this.track(new T.MeshStandardMaterial({ color: '#ffd0e4', roughness: 0.95 })));
    ground.rotation.x = -Math.PI / 2;
    this.scene.add(ground);

    // Escenario redondo con borde de color y telon de fondo a rayas.
    const wood = this.track(new T.MeshStandardMaterial({ color: '#ffcf5a', roughness: 0.6 }));
    const trim = this.track(new T.MeshStandardMaterial({ color: '#ff6f9f', roughness: 0.5 }));
    const stage = new T.Mesh(this.track(new T.CylinderGeometry(STAGE_RADIUS, STAGE_RADIUS + 0.15, STAGE_TOP, 64)), wood);
    stage.position.set(0, STAGE_TOP / 2, -0.5);
    const rim = new T.Mesh(this.track(new T.TorusGeometry(STAGE_RADIUS + 0.02, 0.07, 10, 80)), trim);
    rim.rotation.x = Math.PI / 2;
    rim.position.set(0, STAGE_TOP, -0.5);
    this.scene.add(stage, rim);

    const stripes = document.createElement('canvas');
    stripes.width = 512;
    stripes.height = 64;
    const context = stripes.getContext('2d')!;

    for (let x = 0; x < 512; x += 64) {
      context.fillStyle = x % 128 ? '#ffe891' : '#ff9acb';
      context.fillRect(x, 0, 64, 64);
    }

    const curtainTexture = new T.CanvasTexture(stripes);
    curtainTexture.colorSpace = T.SRGBColorSpace;
    this.track(curtainTexture);
    const curtainHeight = 4.6;
    const curtain = new T.Mesh(
      this.track(new T.CylinderGeometry(STAGE_RADIUS + 0.2, STAGE_RADIUS + 0.2, curtainHeight, 48, 1, true, Math.PI * 0.6, Math.PI * 0.8)),
      this.track(new T.MeshStandardMaterial({ map: curtainTexture, roughness: 0.85, side: T.BackSide })),
    );
    curtain.position.set(0, STAGE_TOP + curtainHeight / 2, -0.5);
    const valance = new T.Mesh(this.track(new T.TorusGeometry(STAGE_RADIUS + 0.2, 0.14, 10, 60, Math.PI * 0.8)), trim);
    valance.rotation.set(-Math.PI / 2, 0, Math.PI * 1.1);
    valance.position.set(0, STAGE_TOP + curtainHeight, -0.5);
    this.scene.add(curtain, valance);

    // Escaleras a ambos lados: por la derecha se sube a la palanca y por la izquierda se baja.
    for (const side of [1, -1]) {
      for (let step = 0; step < 3; step += 1) {
        const height = (STAGE_TOP * (3 - step)) / 3;
        const mesh = new T.Mesh(this.track(new T.BoxGeometry(0.55, height, 1.4)), step % 2 ? trim : wood);
        mesh.position.set(side * (3.75 + step * 0.5), height / 2, 1.45);
        mesh.rotation.y = side * -0.32;
        this.scene.add(mesh);
      }
    }
  }

  private buildMachine(): ThreeModule.Group {
    const T = this.THREE;
    const red = this.track(new T.MeshStandardMaterial({ color: '#e63e62', roughness: 0.4 }));
    const white = this.track(new T.MeshStandardMaterial({ color: '#fff7ec', roughness: 0.5 }));
    const dark = this.track(new T.MeshStandardMaterial({ color: '#3b4150', roughness: 0.45, metalness: 0.2 }));

    const base = new T.Mesh(this.track(new T.BoxGeometry(0.95, 0.6, 0.6)), red);
    base.position.set(0, STAGE_TOP + 0.3, MACHINE_Z);
    const band = new T.Mesh(this.track(new T.BoxGeometry(0.97, 0.12, 0.62)), white);
    band.position.set(0, STAGE_TOP + 0.42, MACHINE_Z);
    const post = new T.Mesh(this.track(new T.CylinderGeometry(0.07, 0.09, 0.12, 12)), dark);
    post.position.set(0, PIVOT_Y - 0.03, MACHINE_Z);
    this.scene.add(base, band, post);

    // Palanca: brazo y mango que giran sobre el eje X desde lo alto de la maquina.
    const lever = new T.Group();
    lever.position.set(0, PIVOT_Y, MACHINE_Z + LEVER_FORWARD);
    const arm = new T.Mesh(this.track(new T.CylinderGeometry(0.045, 0.045, LEVER_LENGTH, 10)), dark);
    arm.position.y = LEVER_LENGTH / 2;
    const handle = new T.Mesh(this.track(new T.CapsuleGeometry(0.08, 0.5, 6, 12)), red);
    handle.rotation.z = Math.PI / 2;
    handle.position.y = LEVER_LENGTH;
    lever.add(arm, handle);
    lever.rotation.x = LEVER_REST;
    this.scene.add(lever);

    // Manguera desde la maquina hasta la boquilla del globo.
    const hose = new T.Mesh(
      this.track(
        new T.TubeGeometry(
          new T.CatmullRomCurve3([
            new T.Vector3(0.2, STAGE_TOP + 0.2, MACHINE_Z - 0.3),
            new T.Vector3(0.7, STAGE_TOP + 0.08, -0.4),
            new T.Vector3(0.3, STAGE_TOP + 0.1, -1.6),
            new T.Vector3(NOZZLE.x, STAGE_TOP + 0.12, NOZZLE.z),
          ]),
          40,
          0.07,
          8,
        ),
      ),
      dark,
    );
    const stand = new T.Mesh(this.track(new T.CylinderGeometry(0.09, 0.14, NOZZLE.y - STAGE_TOP, 12)), dark);
    stand.position.set(NOZZLE.x, (NOZZLE.y + STAGE_TOP) / 2, NOZZLE.z);
    this.scene.add(hose, stand);
    return lever;
  }

  private buildBalloon(): ThreeModule.Group {
    const T = this.THREE;
    const group = new T.Group();
    group.position.set(NOZZLE.x, NOZZLE.y, NOZZLE.z);
    const body = new T.Mesh(this.track(new T.SphereGeometry(1, 48, 32)), this.balloonMaterial);
    body.name = 'body';
    const knot = new T.Mesh(this.track(new T.ConeGeometry(0.12, 0.2, 14)), this.balloonMaterial);
    knot.position.y = 0.04;
    group.add(body, knot);
    this.scene.add(group);
    return group;
  }

  private createWalker(view: BalloonPlayerView, slot: number, enterAt: number, proxyBase: string): void {
    const T = this.THREE;
    const holder = new T.Group();
    const rig = new MiiRig(T, view.shirt);
    rig.enter(enterAt);
    holder.add(rig.root);
    this.scene.add(holder);

    void createFaceTexture(T, view.avatarUrl, view.name, proxyBase).then((texture) => {
      if (this.disposed) {
        texture.dispose();
        return;
      }

      rig.setFaceTexture(texture);
    });

    this.walkers.set(view.playerId, { view, holder, rig, mode: 'queue', path: [], speed: WALK_SPEED, slot });
  }

  /* --------------------------------- Paseos --------------------------------- */

  private queuePoint(slot: number): Vector3 {
    return new this.THREE.Vector3(QUEUE_START.x + slot * QUEUE_GAP, 0, QUEUE_START.z);
  }

  /** Posicion en la fila de cada jugador que espera: el siguiente en jugar va el primero. */
  private placeQueue(state: BalloonSceneState, instant: boolean): void {
    const count = state.order.length;

    state.order.forEach((playerId, index) => {
      const walker = this.walkers.get(playerId);

      if (!walker || playerId === state.currentPlayerId) {
        return;
      }

      // Distancia en la fila respecto al jugador en turno (el orden de la ronda 1 se mantiene siempre).
      walker.slot = (index - state.turnIndex - 1 + count) % count;

      if (instant) {
        walker.holder.position.copy(this.queuePoint(walker.slot));
        walker.mode = 'queue';
        walker.path = [];
      } else if (walker.mode === 'queue') {
        walker.path = [this.queuePoint(walker.slot)];
        walker.speed = WALK_SPEED;
      }
    });

    // Al empezar, el primero de la fila espera en cabeza hasta que le toca subir.
    if (instant && state.currentPlayerId) {
      this.walkers.get(state.currentPlayerId)?.holder.position.copy(this.queuePoint(-1).setX(QUEUE_START.x - QUEUE_GAP * 0.6));
    }
  }

  private startWalkToLever(walker: Walker, durationMs: number): void {
    const T = this.THREE;
    walker.mode = 'to-lever';
    walker.path = [
      new T.Vector3(4.55, 0, 1.75),
      new T.Vector3(3.35, STAGE_TOP, 1.05),
      new T.Vector3(LEVER_SPOT.x + 0.9, STAGE_TOP, LEVER_SPOT.z + 0.15),
      new T.Vector3(LEVER_SPOT.x, STAGE_TOP, LEVER_SPOT.z),
    ];
    // Velocidad para llegar justo cuando empieza su turno (como minimo el paso normal).
    const length = this.pathLength(walker.holder.position, walker.path);
    walker.speed = durationMs > 200 ? Math.max(WALK_SPEED * 0.6, length / (durationMs / 1000)) : length / 0.35;
  }

  private startExit(walker: Walker): void {
    const T = this.THREE;
    walker.mode = 'exit';
    walker.speed = WALK_SPEED * 1.15;
    walker.path = [
      new T.Vector3(-0.9, STAGE_TOP, LEVER_SPOT.z + 0.15),
      new T.Vector3(-3.35, STAGE_TOP, 1.05),
      new T.Vector3(-4.55, 0, 1.75),
      new T.Vector3(EXIT_X, 0, 2.6),
    ];
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

  private updateWalker(walker: Walker, now: number, time: number, delta: number): void {
    const holder = walker.holder;
    let moving = false;

    if (walker.path.length) {
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

    if (!moving) {
      // Quieto: mirando a camara (en la palanca, con la maquina delante).
      holder.rotation.y += (0 - holder.rotation.y) * Math.min(1, delta * 8);
    }

    const rig = walker.rig;
    const exploded = this.explodedAt !== null;
    const victim = exploded && this.state?.explodedBy === walker.view.playerId;
    let mood: MiiMood = 'idle';

    if (victim) {
      mood = 'dizzy';
    } else if (moving) {
      mood = 'walk';
    } else if (walker.mode === 'lever' && !exploded) {
      mood = 'lever';
      const pull = (now - this.pullStartedAt) / PULL_MS;
      rig.leverPull = pull >= 0 && pull < 1 ? Math.sin(Math.PI * pull) : 0;
    } else if (exploded) {
      mood = 'happy';
    } else if ((this.state?.air || 0) >= 18) {
      // Con el globo ya grande, los de la fila miran arriba con nervios.
      mood = 'look-up';
    }

    rig.mood = mood;
    rig.update(time, delta, 'game');

    if (victim && this.explodedAt !== null) {
      // Igual que el barril: se encoge del susto y acaba sentado en el suelo, mareado.
      const elapsed = now - this.explodedAt;
      const squash = elapsed < 120 ? elapsed / 120 : Math.max(0, 1 - (elapsed - 120) / 380);
      rig.pose = elapsed > 160 ? 'ground-sit' : 'stand';
      rig.root.scale.set(1 + squash * 0.25, 1 - squash * 0.45, 1 + squash * 0.25);
    }
  }

  private arrive(walker: Walker): void {
    switch (walker.mode) {
      case 'to-lever':
        walker.mode = 'lever';
        break;
      case 'exit':
        // Sale por la izquierda y vuelve a la cola por la derecha, en el mismo orden de siempre.
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

  /* --------------------------------- Globo ---------------------------------- */

  private updateBalloon(now: number, time: number): void {
    // El tamano cambia con un pequeno rebote elastico en cada palancazo.
    const progress = clamp01((now - this.radiusChangedAt) / 520);
    this.shownRadius = this.radiusFrom + (this.radiusTarget - this.radiusFrom) * easeOutBack(progress);
    const body = this.balloon.getObjectByName('body')!;
    const wobble = 1 + Math.sin(time * 2.4) * 0.012;
    body.scale.set(this.shownRadius * wobble, this.shownRadius * 1.12, this.shownRadius * wobble);
    body.position.y = this.shownRadius * 1.08;
    this.balloon.rotation.z = Math.sin(time * 0.9) * 0.04;

    // Palanca: baja y vuelve en cada palancazo.
    const pull = (now - this.pullStartedAt) / PULL_MS;
    const amount = pull >= 0 && pull < 1 ? Math.sin(Math.PI * pull) : 0;
    this.lever.rotation.x = LEVER_REST + (LEVER_PULLED - LEVER_REST) * amount;
  }

  private explode(now: number): void {
    const T = this.THREE;
    this.explodedAt = now;
    this.balloon.visible = false;
    // Sin globo, la camara se acerca a la palanca para ver al que se ha quedado sentado y mareado.
    this.director.focus('aftermath', () => this.aftermathGoal(), now, { durationMs: 1600, arc: 0.3 });
    const center = new T.Vector3(NOZZLE.x, NOZZLE.y + this.shownRadius * 1.08, NOZZLE.z);
    this.flash.position.copy(center);
    this.flash.visible = true;
    const geometry = this.track(new T.PlaneGeometry(0.32, 0.22));
    const material = this.track(new T.MeshStandardMaterial({ color: '#ff5d8f', roughness: 0.4, side: T.DoubleSide }));

    for (let index = 0; index < 46; index += 1) {
      const direction = new T.Vector3(Math.random() - 0.5, Math.random() - 0.3, Math.random() - 0.5).normalize();
      const mesh = new T.Mesh(geometry, material);
      mesh.position.copy(center).addScaledVector(direction, this.shownRadius * 0.9);
      mesh.scale.setScalar(0.6 + this.shownRadius * 0.35);
      this.scene.add(mesh);
      this.fragments.push({
        mesh,
        velocity: direction.multiplyScalar(5 + Math.random() * 6 + this.shownRadius * 2),
        spin: new T.Vector3(Math.random() * 12, Math.random() * 12, Math.random() * 12),
      });
    }
  }

  private updateExplosion(now: number, delta: number): void {
    if (this.explodedAt === null) {
      return;
    }

    const elapsed = now - this.explodedAt;
    const flash = clamp01(elapsed / 420);
    this.flash.scale.setScalar(this.shownRadius * (1 + flash * 2.2));
    (this.flash.material as ThreeModule.MeshBasicMaterial).opacity = 0.9 * (1 - flash);
    this.flash.visible = flash < 1;

    for (const fragment of this.fragments) {
      fragment.velocity.y -= 9.8 * delta;
      fragment.velocity.multiplyScalar(1 - delta * 0.9);
      fragment.mesh.position.addScaledVector(fragment.velocity, delta);
      fragment.mesh.rotation.x += fragment.spin.x * delta;
      fragment.mesh.rotation.y += fragment.spin.y * delta;

      if (fragment.mesh.position.y < 0.02) {
        fragment.mesh.position.y = 0.02;
        fragment.velocity.set(0, 0, 0);
        fragment.spin.set(0, 0, 0);
      }
    }

    // Temblor de camara justo despues del estallido.
    if (elapsed < 600) {
      const strength = (1 - elapsed / 600) * 0.25;
      this.camera.position.x += Math.sin(elapsed * 0.09) * strength;
      this.camera.position.y += Math.cos(elapsed * 0.11) * strength;
    }
  }

  /* --------------------------------- Camara --------------------------------- */

  /** Escenario, palanca, globo (con su tamano actual) y la cabeza de la fila. Se aleja segun crece el globo. */
  private stageGoal(): CameraGoal {
    const T = this.THREE;
    const balloonTop = NOZZLE.y + Math.max(1.2, this.shownRadius) * 2.25 + 0.3;
    return {
      target: new T.Vector3(0.8, STAGE_TOP + 1.2, 0),
      direction: new T.Vector3(0, 0.22, 1).normalize(),
      fit: [
        new T.Vector3(-STAGE_RADIUS - 0.6, 0, 1.4),
        new T.Vector3(QUEUE_START.x + QUEUE_GAP * 1.6, 0, QUEUE_START.z + 0.4),
        new T.Vector3(QUEUE_START.x + QUEUE_GAP * 1.6, 2.6, QUEUE_START.z),
        new T.Vector3(-STAGE_RADIUS, STAGE_TOP + 2.6, -0.5),
        new T.Vector3(0, balloonTop, NOZZLE.z),
        new T.Vector3(-Math.max(1.2, this.shownRadius) - 0.3, NOZZLE.y + this.shownRadius * 1.1, NOZZLE.z),
        new T.Vector3(Math.max(1.2, this.shownRadius) + 0.3, NOZZLE.y + this.shownRadius * 1.1, NOZZLE.z),
      ],
      margin: 0.94,
    };
  }

  private aftermathGoal(): CameraGoal {
    const T = this.THREE;
    return {
      target: new T.Vector3(0.6, STAGE_TOP + 0.7, 0.4),
      direction: new T.Vector3(0, 0.38, 1).normalize(),
      fit: [
        new T.Vector3(-2.4, STAGE_TOP, 1.2),
        new T.Vector3(-2.4, STAGE_TOP + 2.6, 0),
        new T.Vector3(QUEUE_START.x + QUEUE_GAP, 0, QUEUE_START.z + 0.5),
        new T.Vector3(QUEUE_START.x + QUEUE_GAP, 2.6, QUEUE_START.z),
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

    this.updateBalloon(now, time);
    this.director.update(now, delta);
    this.updateExplosion(now, delta);
    this.renderer.render(this.scene, this.camera);
    this.placeLabels();
  }

  /** Nombre bajo los pies de cada Mii visible. */
  private placeLabels(): void {
    const width = this.host.clientWidth;
    const height = this.host.clientHeight;

    for (const label of Array.from(this.labelLayer.querySelectorAll<HTMLElement>('[data-bl-label]'))) {
      const walker = this.walkers.get(label.dataset['blLabel'] || '');

      if (!walker) {
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
