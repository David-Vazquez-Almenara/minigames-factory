import type * as ThreeModule from 'three';
import { MiiMood, MiiRig, createFaceTexture } from '../../../../shared/components/mii-stage/mii-rig';
import { CameraDirector, CameraGoal, ViewInsets } from '../../../../shared/three/camera-director';

type Three = typeof ThreeModule;
type Vector3 = ThreeModule.Vector3;

const LANE_WIDTH = 2.3;
const ROAD_HALF = LANE_WIDTH * 2;
const SIDEWALK_WIDTH = 2.8;
const CURB_HEIGHT = 0.16;
const ROAD_LENGTH = 70;
const SIDEWALK_GAP = 1.3;
// Huecos dentro de un carril para que nadie quede encima de otro: 2 filas x 6 columnas.
const LANE_COLUMNS = [-0.7, 0.7, -2.1, 2.1, -3.5, 3.5];
const LANE_ROWS = [-0.5, 0.5];
const WALK_SPEED = 3.4;
const CAR_COLORS = ['#ff5d8f', '#3d7bf2', '#ffb347', '#2fa35b'];
const FOV = 26;

export interface CarsPlayerView {
  playerId: string;
  name: string;
  avatarUrl: string;
  shirt: string;
}

export interface CarsSceneState {
  round: number;
  stage: string;
  sides: Array<{ playerId: string; side: 'left' | 'right'; index: number }>;
  alive: string[];
  /** Carril de cada jugador en esta ronda, en el orden en que eligieron. */
  choices: Array<{ playerId: string; lane: number }>;
  carLanes: number[];
  /** Tiempos en el reloj de performance.now(). */
  passStartsAt: number | null;
  driveMs: number;
}

interface Walker {
  view: CarsPlayerView;
  holder: ThreeModule.Group;
  rig: MiiRig;
  target: Vector3;
  hitAt: number | null;
  velocity: Vector3;
  gone: boolean;
}

const laneZ = (lane: number) => (lane - 1.5) * LANE_WIDTH;

/**
 * Escena 3D de "Esquiva los coches": carretera de 4 carriles con aceras, vista casi isometrica. Los jugadores
 * esperan en las aceras, caminan a su carril y, si pasa un coche por el, salen disparados. Los coches solo
 * aparecen cuando el servidor dice por donde pasan.
 */
export class CarsScene {
  private readonly renderer: ThreeModule.WebGLRenderer;
  private readonly scene: ThreeModule.Scene;
  private readonly camera: ThreeModule.PerspectiveCamera;
  private readonly director: CameraDirector;
  private readonly walkers = new Map<string, Walker>();
  private readonly cars = new Map<number, ThreeModule.Group>();
  private readonly disposables: Array<{ dispose: () => void }> = [];
  private readonly resizeObserver: ResizeObserver;
  private readonly scratch: Vector3;
  private readonly cameraDirection: Vector3;
  private readonly raycaster: ThreeModule.Raycaster;
  private readonly pointer: ThreeModule.Vector2;
  private readonly roadPlane: ThreeModule.Plane;
  private carParts: ReturnType<CarsScene['buildCarParts']>;
  private state: CarsSceneState | null = null;
  private insets: ViewInsets = { top: 0, right: 0, bottom: 0, left: 0 };
  private frameHandle = 0;
  private lastFrame = performance.now();
  private disposed = false;

  /** Se llama al pulsar sobre un carril de la carretera (0..3). */
  onLanePicked?: (lane: number) => void;
  /** Se llama cuando un coche atropella a alguien (para el sonido). */
  onHit?: (playerId: string) => void;

  constructor(
    private readonly THREE: Three,
    private readonly canvas: HTMLCanvasElement,
    private readonly host: HTMLElement,
    private readonly labelLayer: HTMLElement,
    players: CarsPlayerView[],
    initialState: CarsSceneState,
    proxyBase: string,
  ) {
    const T = THREE;
    this.renderer = new T.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = T.SRGBColorSpace;
    this.scene = new T.Scene();
    this.scene.background = new T.Color('#bfe9ff');
    this.scene.fog = new T.Fog('#bfe9ff', 40, 90);
    this.camera = new T.PerspectiveCamera(FOV, 1, 0.1, 200);
    this.director = new CameraDirector(T, this.camera);
    this.scratch = new T.Vector3();
    this.raycaster = new T.Raycaster();
    this.pointer = new T.Vector2();
    this.roadPlane = new T.Plane(new T.Vector3(0, 1, 0), 0);
    // Vista casi isometrica: en diagonal y desde arriba.
    this.cameraDirection = new T.Vector3(0.45, 0.62, 0.65).normalize();

    this.buildWorld();
    this.carParts = this.buildCarParts();
    const time = performance.now() / 1000;
    const byId = new Map(players.map((player) => [player.playerId, player]));
    initialState.sides.forEach((seat, index) => {
      const view = byId.get(seat.playerId);

      if (view) {
        this.createWalker(view, this.sidewalkSpot(seat, initialState), time + 0.15 + index * 0.08, proxyBase);
      }
    });

    canvas.addEventListener('pointerdown', this.handlePointer);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();
    this.director.focus('road', () => this.roadGoal(), performance.now());
    this.sync(initialState);
    this.loop();
  }

  sync(state: CarsSceneState): void {
    if (this.disposed) {
      return;
    }

    this.state = state;
    const lanes = new Map(state.choices.map((choice) => [choice.playerId, choice.lane]));
    const toLane = state.stage === 'choosing' || state.stage === 'waiting' || state.stage === 'passing' || state.stage === 'aftermath';
    const perLane = new Map<number, number>();

    for (const seat of state.sides) {
      const walker = this.walkers.get(seat.playerId);

      if (!walker || walker.hitAt !== null || walker.gone) {
        continue;
      }

      if (!state.alive.includes(seat.playerId)) {
        // Eliminado en una ronda anterior (o al recargar): ya no esta en la partida.
        this.retire(walker);
        continue;
      }

      const lane = lanes.get(seat.playerId);

      if (toLane && lane !== undefined) {
        const slot = perLane.get(lane) || 0;
        perLane.set(lane, slot + 1);
        walker.target.copy(this.laneSpot(lane, slot));
      } else {
        walker.target.copy(this.sidewalkSpot(seat, state));
      }
    }
  }

  setInsets(insets: ViewInsets): void {
    this.insets = insets;
    this.director.setViewport(this.host.clientWidth, this.host.clientHeight, insets);
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frameHandle);
    this.canvas.removeEventListener('pointerdown', this.handlePointer);
    this.resizeObserver.disconnect();

    for (const walker of this.walkers.values()) {
      walker.rig.dispose();
    }

    for (const item of this.disposables) {
      item.dispose();
    }

    this.scene.clear();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }

  /* ------------------------------ Construccion ------------------------------ */

  private buildWorld(): void {
    const T = this.THREE;
    this.scene.add(new T.HemisphereLight(0xffffff, 0xa8d99a, 1.4));
    const sun = new T.DirectionalLight(0xffffff, 1.7);
    sun.position.set(8, 14, 6);
    this.scene.add(sun);

    const grass = new T.Mesh(this.track(new T.PlaneGeometry(200, 200)), this.track(new T.MeshStandardMaterial({ color: '#9ddc8a', roughness: 1 })));
    grass.rotation.x = -Math.PI / 2;
    grass.position.y = -0.02;
    this.scene.add(grass);

    // Asfalto con lineas: discontinuas entre carriles y continuas en los bordes.
    const asphalt = new T.Mesh(this.track(new T.PlaneGeometry(ROAD_LENGTH, ROAD_HALF * 2)), this.track(new T.MeshStandardMaterial({ color: '#4a4f5c', roughness: 0.9 })));
    asphalt.rotation.x = -Math.PI / 2;
    this.scene.add(asphalt);
    const white = this.track(new T.MeshBasicMaterial({ color: '#ffffff' }));
    const yellow = this.track(new T.MeshBasicMaterial({ color: '#ffd23f' }));
    const dash = this.track(new T.PlaneGeometry(1.6, 0.14));
    const edge = this.track(new T.PlaneGeometry(ROAD_LENGTH, 0.14));

    for (let line = 1; line < 4; line += 1) {
      const z = laneZ(line) - LANE_WIDTH / 2;

      for (let x = -ROAD_LENGTH / 2; x < ROAD_LENGTH / 2; x += 3.2) {
        const mesh = new T.Mesh(dash, white);
        mesh.rotation.x = -Math.PI / 2;
        mesh.position.set(x, 0.01, z);
        this.scene.add(mesh);
      }
    }

    for (const side of [-1, 1]) {
      const mesh = new T.Mesh(edge, yellow);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set(0, 0.01, side * (ROAD_HALF - 0.25));
      this.scene.add(mesh);
    }

    // Aceras con baldosas y bordillo.
    const tiles = document.createElement('canvas');
    tiles.width = 128;
    tiles.height = 128;
    const context = tiles.getContext('2d')!;
    context.fillStyle = '#e4e0d8';
    context.fillRect(0, 0, 128, 128);
    context.strokeStyle = '#c9c3b8';
    context.lineWidth = 4;

    for (let offset = 0; offset <= 128; offset += 64) {
      context.beginPath();
      context.moveTo(offset, 0);
      context.lineTo(offset, 128);
      context.moveTo(0, offset);
      context.lineTo(128, offset);
      context.stroke();
    }

    const tileTexture = this.track(new T.CanvasTexture(tiles));
    tileTexture.colorSpace = T.SRGBColorSpace;
    tileTexture.wrapS = T.RepeatWrapping;
    tileTexture.wrapT = T.RepeatWrapping;
    tileTexture.repeat.set(ROAD_LENGTH / 1.2, SIDEWALK_WIDTH / 1.2);
    const sidewalkMaterial = this.track(new T.MeshStandardMaterial({ map: tileTexture, roughness: 0.85 }));
    const curbMaterial = this.track(new T.MeshStandardMaterial({ color: '#b8b2a7', roughness: 0.7 }));
    const sidewalkGeometry = this.track(new T.BoxGeometry(ROAD_LENGTH, CURB_HEIGHT, SIDEWALK_WIDTH));
    const curbGeometry = this.track(new T.BoxGeometry(ROAD_LENGTH, CURB_HEIGHT + 0.04, 0.22));
    const trunk = this.track(new T.CylinderGeometry(0.14, 0.18, 1.4, 10));
    const canopy = this.track(new T.SphereGeometry(0.9, 16, 12));
    const wood = this.track(new T.MeshStandardMaterial({ color: '#8a5a3c', roughness: 0.8 }));
    const leaves = this.track(new T.MeshStandardMaterial({ color: '#4fb36a', roughness: 0.8 }));
    const pole = this.track(new T.CylinderGeometry(0.06, 0.08, 3.2, 10));
    const lamp = this.track(new T.SphereGeometry(0.2, 12, 10));
    const metal = this.track(new T.MeshStandardMaterial({ color: '#5b6170', roughness: 0.4, metalness: 0.3 }));
    const glow = this.track(new T.MeshBasicMaterial({ color: '#fff3b0' }));

    for (const side of [-1, 1]) {
      const sidewalk = new T.Mesh(sidewalkGeometry, [curbMaterial, curbMaterial, sidewalkMaterial, curbMaterial, curbMaterial, curbMaterial]);
      sidewalk.position.set(0, CURB_HEIGHT / 2, side * (ROAD_HALF + SIDEWALK_WIDTH / 2));
      const curb = new T.Mesh(curbGeometry, curbMaterial);
      curb.position.set(0, (CURB_HEIGHT + 0.04) / 2, side * (ROAD_HALF + 0.11));
      this.scene.add(sidewalk, curb);

      // Arboles y farolas al fondo de cada acera.
      for (let x = -18; x <= 18; x += 6) {
        const outer = side * (ROAD_HALF + SIDEWALK_WIDTH + 1.2);
        const tree = new T.Group();
        const stem = new T.Mesh(trunk, wood);
        stem.position.y = 0.7;
        const top = new T.Mesh(canopy, leaves);
        top.position.y = 1.9;
        tree.add(stem, top);
        tree.position.set(x + (side > 0 ? 3 : 0), 0, outer);
        const post = new T.Mesh(pole, metal);
        post.position.set(x + (side > 0 ? 0 : 3), 1.6 + CURB_HEIGHT, side * (ROAD_HALF + SIDEWALK_WIDTH - 0.3));
        const bulb = new T.Mesh(lamp, glow);
        bulb.position.set(post.position.x, 3.3, post.position.z);
        this.scene.add(tree, post, bulb);
      }
    }
  }

  private buildCarParts() {
    const T = this.THREE;
    return {
      body: this.track(new T.BoxGeometry(2.8, 0.6, 1.5)),
      cabin: this.track(new T.BoxGeometry(1.5, 0.55, 1.3)),
      wheel: this.track(new T.CylinderGeometry(0.34, 0.34, 0.26, 18)),
      light: this.track(new T.BoxGeometry(0.06, 0.16, 0.3)),
      glass: this.track(new T.MeshStandardMaterial({ color: '#a8e8ff', roughness: 0.1, metalness: 0.3 })),
      tyre: this.track(new T.MeshStandardMaterial({ color: '#202228', roughness: 0.8 })),
      lamp: this.track(new T.MeshBasicMaterial({ color: '#fff3b0' })),
      paints: CAR_COLORS.map((color) => this.track(new T.MeshStandardMaterial({ color, roughness: 0.35, metalness: 0.2 }))),
    };
  }

  /** Coche sencillo: carroceria, cabina acristalada, ruedas y faros (mirando hacia +X, por donde avanza). */
  private createCar(lane: number): ThreeModule.Group {
    const T = this.THREE;
    const parts = this.carParts;
    const car = new T.Group();
    const body = new T.Mesh(parts.body, parts.paints[lane % parts.paints.length]);
    body.position.y = 0.62;
    const cabin = new T.Mesh(parts.cabin, parts.glass);
    cabin.position.set(-0.2, 1.18, 0);
    car.add(body, cabin);

    for (const x of [-0.9, 0.9]) {
      for (const z of [-0.72, 0.72]) {
        const wheel = new T.Mesh(parts.wheel, parts.tyre);
        wheel.rotation.x = Math.PI / 2;
        wheel.position.set(x, 0.34, z);
        car.add(wheel);
      }
    }

    for (const z of [-0.5, 0.5]) {
      const light = new T.Mesh(parts.light, parts.lamp);
      light.position.set(1.42, 0.7, z);
      car.add(light);
    }

    car.position.set(-ROAD_LENGTH / 2, 0, laneZ(lane));
    this.scene.add(car);
    return car;
  }

  private createWalker(view: CarsPlayerView, spot: Vector3, enterAt: number, proxyBase: string): void {
    const T = this.THREE;
    const holder = new T.Group();
    holder.position.copy(spot);
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

    this.walkers.set(view.playerId, { view, holder, rig, target: spot.clone(), hitAt: null, velocity: new T.Vector3(), gone: false });
  }

  private sidewalkSpot(seat: { side: 'left' | 'right'; index: number }, state: CarsSceneState): Vector3 {
    const count = state.sides.filter((entry) => entry.side === seat.side).length;
    const x = (seat.index - (count - 1) / 2) * SIDEWALK_GAP;
    const z = (seat.side === 'left' ? -1 : 1) * (ROAD_HALF + SIDEWALK_WIDTH / 2);
    return new this.THREE.Vector3(x, CURB_HEIGHT, z);
  }

  private laneSpot(lane: number, slot: number): Vector3 {
    const column = LANE_COLUMNS[Math.floor(slot / LANE_ROWS.length) % LANE_COLUMNS.length];
    const row = LANE_ROWS[slot % LANE_ROWS.length];
    return new this.THREE.Vector3(column, 0, laneZ(lane) + row);
  }

  private retire(walker: Walker): void {
    walker.gone = true;
    walker.holder.visible = false;
  }

  /* ---------------------------------- Bucle --------------------------------- */

  private updateCars(now: number): void {
    const state = this.state;
    const lanes = state?.passStartsAt !== null && state?.passStartsAt !== undefined ? state.carLanes : [];

    for (const lane of lanes) {
      if (!this.cars.has(lane)) {
        this.cars.set(lane, this.createCar(lane));
      }
    }

    for (const [lane, car] of this.cars) {
      if (!lanes.includes(lane) || !state?.passStartsAt) {
        this.scene.remove(car);
        this.cars.delete(lane);
        continue;
      }

      // Cruza la pantalla de lado a lado en driveMs; pasa por el centro justo en el momento del impacto.
      const progress = (now - state.passStartsAt) / state.driveMs;
      car.position.x = -ROAD_LENGTH / 2 + ROAD_LENGTH * Math.min(1.05, Math.max(-0.05, progress));
      car.visible = progress > -0.05 && progress < 1.05;
      car.position.y = Math.abs(Math.sin(now / 45)) * 0.03;

      // Atropello: al llegar el morro del coche a la altura de cada jugador de ese carril.
      for (const choice of state.choices) {
        const walker = this.walkers.get(choice.playerId);

        if (choice.lane === lane && walker && walker.hitAt === null && !walker.gone && car.position.x + 1.4 >= walker.holder.position.x) {
          this.launch(walker, now);
        }
      }
    }
  }

  /** Sale disparado: hacia arriba y hacia la camara, girando, y vuelve a caer alejandose. */
  private launch(walker: Walker, now: number): void {
    walker.hitAt = now;
    walker.velocity.copy(this.cameraDirection).setY(0).normalize().multiplyScalar(5.5);
    walker.velocity.x += 3.5;
    walker.velocity.y = 10;
    this.onHit?.(walker.view.playerId);
  }

  private updateWalker(walker: Walker, now: number, time: number, delta: number): void {
    if (walker.gone) {
      return;
    }

    const holder = walker.holder;
    const rig = walker.rig;
    let mood: MiiMood = 'idle';

    if (walker.hitAt !== null) {
      // En el aire: agachado y con la cabeza dando vueltas, como el aplastado de los barriles.
      walker.velocity.y -= 14 * delta;
      holder.position.addScaledVector(walker.velocity, delta);
      holder.rotation.z += delta * 7;
      holder.rotation.x += delta * 4;
      mood = 'dizzy';
      rig.pose = 'ground-sit';
      const flight = (now - walker.hitAt) / 1000;

      if (flight > 1.4) {
        holder.scale.setScalar(Math.max(0.001, 1 - (flight - 1.4) / 0.4));
      }

      if (flight > 1.8) {
        this.retire(walker);
      }
    } else {
      const distance = holder.position.distanceTo(walker.target);

      if (distance > 0.02) {
        const step = Math.min(distance, WALK_SPEED * delta);
        this.scratch.subVectors(walker.target, holder.position).normalize();
        holder.position.addScaledVector(this.scratch, step);
        holder.rotation.y = Math.atan2(this.scratch.x, this.scratch.z);
        mood = 'walk';
      } else {
        // Quieto: mirando hacia la camara; si ya han salido los coches, mira hacia ellos con nervios.
        const facing = Math.atan2(this.cameraDirection.x, this.cameraDirection.z);
        holder.rotation.y += (facing - holder.rotation.y) * Math.min(1, delta * 6);
        mood = this.state?.stage === 'passing' ? 'look-up' : 'idle';
      }
    }

    rig.mood = mood;
    rig.update(time, delta, 'game');
  }

  private loop(): void {
    this.frameHandle = requestAnimationFrame(() => this.loop());
    const now = performance.now();
    const delta = Math.min(0.05, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    const time = now / 1000;
    this.updateCars(now);

    for (const walker of this.walkers.values()) {
      this.updateWalker(walker, now, time, delta);
    }

    this.director.update(now, delta);
    this.renderer.render(this.scene, this.camera);
    this.placeLabels();
  }

  /* --------------------------------- Camara --------------------------------- */

  private roadGoal(): CameraGoal {
    const T = this.THREE;
    const outer = ROAD_HALF + SIDEWALK_WIDTH;
    return {
      target: new T.Vector3(0, 0.6, 0),
      direction: this.cameraDirection,
      fit: [
        new T.Vector3(-6.5, 0, -outer),
        new T.Vector3(6.5, 0, -outer),
        new T.Vector3(-6.5, 0, outer),
        new T.Vector3(6.5, 0, outer),
        new T.Vector3(-6.5, 2.6, -outer),
        new T.Vector3(6.5, 2.6, outer),
      ],
      margin: 0.96,
    };
  }

  /* ------------------------------ Clics y nombres ----------------------------- */

  private readonly handlePointer = (event: PointerEvent): void => {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.ray.intersectPlane(this.roadPlane, this.scratch);

    if (hit && Math.abs(hit.z) < ROAD_HALF) {
      this.onLanePicked?.(Math.min(3, Math.max(0, Math.floor((hit.z + ROAD_HALF) / LANE_WIDTH))));
    }
  };

  private placeLabels(): void {
    const width = this.host.clientWidth;
    const height = this.host.clientHeight;

    for (const label of Array.from(this.labelLayer.querySelectorAll<HTMLElement>('[data-car-label]'))) {
      const key = label.dataset['carLabel'] || '';
      let point: Vector3 | null = null;

      if (key.startsWith('lane:')) {
        point = this.scratch.set(-6.2, 0.05, laneZ(Number(key.slice(5))));
      } else {
        const walker = this.walkers.get(key);
        point = walker && !walker.gone ? this.scratch.copy(walker.holder.position).setY(walker.holder.position.y + 2.7) : null;
      }

      if (!point) {
        label.style.opacity = '0';
        continue;
      }

      const vector = point.project(this.camera);
      label.style.opacity = vector.z < 1 && Math.abs(vector.x) < 1.02 && Math.abs(vector.y) < 1.02 ? '1' : '0';
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
