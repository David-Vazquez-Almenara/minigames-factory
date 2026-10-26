import type * as ThreeModule from 'three';

type Three = typeof ThreeModule;

// La barra va a lo largo del eje -z: la linea de salida en z = 0 y el borde en z = -longitud.
const COUNTER_TOP = 1.1;
const LANE_GAP = 0.5;
const ROW_GAP = 0.5;
const PER_ROW = 6;
const JUG_RADIUS = 0.17;
const JUG_HEIGHT = 0.4;
const GRAVITY = 9.8;
const FOV = 42;

export interface BeerSceneJug {
  playerId: string;
  /** Metros recorridos (null mientras no se sabe: la jarra espera en la salida). */
  distance: number | null;
  fell: boolean;
  mine: boolean;
}

export interface BeerSceneState {
  /** Ronda actual: al cambiar, todas las jarras vuelven enteras a la salida. */
  round: number;
  jugs: BeerSceneJug[];
  /** Momento (reloj performance.now) en que salen todas las jarras a la vez. */
  slideStartsAt: number | null;
  slideMs: number;
}

interface Jug {
  data: BeerSceneJug;
  group: ThreeModule.Group;
  lane: number;
  row: number;
  falling: { vz: number; vy: number; y: number; z: number; spin: number } | null;
  landed: boolean;
}

/**
 * Escena 3D de "Jarras en la barra": barra de bar larga vista de lado y un poco desde arriba, con estanterias de
 * botellas al fondo. Todas las jarras salen a la vez y frenan poco a poco hasta su punto final (que llega del
 * servidor); las que se pasan siguen hasta el borde y caen al suelo.
 */
export class BeerScene {
  private readonly renderer: ThreeModule.WebGLRenderer;
  private readonly scene: ThreeModule.Scene;
  private readonly camera: ThreeModule.PerspectiveCamera;
  private readonly disposables: Array<{ dispose: () => void }> = [];
  private readonly resizeObserver: ResizeObserver;
  private readonly jugs = new Map<string, Jug>();
  private readonly scratch: ThreeModule.Vector3;
  private readonly counterWidth: number;
  private state: BeerSceneState;
  private frameHandle = 0;
  private lastFrame = performance.now();

  /** Aviso cuando una jarra cae al suelo (para el sonido de cristales). */
  onJugBroken?: (playerId: string) => void;

  constructor(
    private readonly THREE: Three,
    canvas: HTMLCanvasElement,
    private readonly host: HTMLElement,
    private readonly labelLayer: HTMLElement,
    private readonly length: number,
    state: BeerSceneState,
  ) {
    const T = THREE;
    this.state = state;
    this.renderer = new T.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    this.renderer.outputColorSpace = T.SRGBColorSpace;
    this.scene = new T.Scene();
    this.scene.background = new T.Color('#3a2418');
    this.camera = new T.PerspectiveCamera(FOV, 1, 0.1, 120);
    this.scratch = new T.Vector3();

    const lanes = Math.min(PER_ROW, Math.max(1, state.jugs.length));
    this.counterWidth = Math.max(1.6, lanes * LANE_GAP + 0.5);

    this.scene.add(new T.HemisphereLight(0xffe6c4, 0x3a2418, 1.2));
    const key = new T.DirectionalLight(0xffd9a0, 1.4);
    key.position.set(5, 8, 3);
    this.scene.add(key);

    this.buildBar();
    state.jugs.forEach((jug, index) => this.createJug(jug, index));

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();
    this.loop();
  }

  sync(state: BeerSceneState): void {
    const newRound = state.round !== this.state.round;
    this.state = state;

    for (const data of state.jugs) {
      const jug = this.jugs.get(data.playerId);

      if (jug) {
        jug.data = data;

        // Ronda nueva: jarra nueva en la salida (las rotas o caidas vuelven a estar sobre la barra).
        if (newRound) {
          jug.falling = null;
          jug.landed = false;
          jug.group.rotation.set(0, 0, 0);
          jug.group.position.set(jug.lane * LANE_GAP, COUNTER_TOP, this.startZ(jug.row));
        }
      }
    }
  }

  dispose(): void {
    cancelAnimationFrame(this.frameHandle);
    this.resizeObserver.disconnect();

    for (const item of this.disposables) {
      item.dispose();
    }

    this.scene.clear();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }

  /* ------------------------------ Construccion ------------------------------ */

  private material(color: string, roughness = 0.6, extra: Partial<ThreeModule.MeshStandardMaterialParameters> = {}): ThreeModule.MeshStandardMaterial {
    return this.track(new this.THREE.MeshStandardMaterial({ color, roughness, ...extra }));
  }

  private box(width: number, height: number, depth: number, material: ThreeModule.Material, x: number, y: number, z: number): ThreeModule.Mesh {
    const T = this.THREE;
    const mesh = new T.Mesh(this.track(new T.BoxGeometry(width, height, depth)), material);
    mesh.position.set(x, y, z);
    this.scene.add(mesh);
    return mesh;
  }

  private buildBar(): void {
    const T = this.THREE;
    const total = this.length + 3;
    const centerZ = -this.length / 2 + 0.6;
    const halfWidth = this.counterWidth / 2;

    // Suelo de tablones y pared del fondo con estanterias de botellas.
    const floor = new T.Mesh(this.track(new T.PlaneGeometry(40, total + 16)), this.material('#6b4228', 0.9));
    floor.rotation.x = -Math.PI / 2;
    floor.position.z = centerZ;
    this.scene.add(floor);
    this.box(0.3, 6, total + 16, this.material('#7a4a2c', 0.9), -halfWidth - 2.6, 3, centerZ);

    const bottleColors = ['#2f7d3c', '#7a2f2f', '#c9a227', '#2f4f7d', '#d9d9d9', '#5a2f7a'];
    const bottleGeometry = this.track(new T.CylinderGeometry(0.07, 0.08, 0.36, 10));
    const bottleMaterials = bottleColors.map((color) => this.material(color, 0.2, { metalness: 0.1 }));

    for (const y of [1.6, 2.4, 3.2]) {
      this.box(0.4, 0.06, total + 2, this.material('#4a2c18'), -halfWidth - 2.3, y, centerZ);

      for (let z = 1; z > -this.length - 1; z -= 0.32) {
        const bottle = new T.Mesh(bottleGeometry, bottleMaterials[Math.floor(Math.abs(z * 7 + y * 3)) % bottleMaterials.length]);
        bottle.position.set(-halfWidth - 2.3, y + 0.21, z);
        this.scene.add(bottle);
      }
    }

    // La barra: tablero de madera barnizada sobre un mueble oscuro, con su borde marcado en rojo.
    const counterLength = this.length + 1.5;
    const counterCenter = -this.length / 2 + 0.75;
    this.box(this.counterWidth, 0.1, counterLength, this.material('#a0612f', 0.35), 0, COUNTER_TOP - 0.05, counterCenter);
    this.box(this.counterWidth - 0.2, COUNTER_TOP - 0.1, counterLength - 0.2, this.material('#3b2416', 0.7), 0, (COUNTER_TOP - 0.1) / 2, counterCenter);
    this.box(this.counterWidth, 0.02, 0.06, this.material('#e8262b', 0.4, { emissive: '#5a0000' }), 0, COUNTER_TOP + 0.005, -this.length + 0.03);

    // Marcas de cada metro en el lateral (para calcular a ojo) y la linea de salida.
    const tick = this.material('#fff3d6', 0.5);

    for (let meter = 0; meter <= Math.floor(this.length); meter += 1) {
      this.box(0.02, 0.06, meter % 5 === 0 ? 0.08 : 0.04, tick, halfWidth + 0.005, COUNTER_TOP - 0.05, -meter);
    }

    this.box(this.counterWidth, 0.015, 0.04, this.material('#ffffff', 0.5), 0, COUNTER_TOP + 0.005, 0.25);

    // Lamparas colgando sobre la barra.
    const lampMaterial = this.material('#ffcf6b', 0.3, { emissive: '#ffb347', emissiveIntensity: 0.9 });

    for (let z = 0; z > -this.length; z -= 3.5) {
      const lamp = new T.Mesh(this.track(new T.ConeGeometry(0.3, 0.3, 16, 1, true)), lampMaterial);
      lamp.position.set(0, 3.1, z - 0.5);
      this.scene.add(lamp);
      const light = new T.PointLight(0xffb36b, 4, 6, 1.6);
      light.position.set(0, 2.8, z - 0.5);
      this.scene.add(light);
    }
  }

  private createJug(data: BeerSceneJug, index: number): void {
    const T = this.THREE;
    const group = new T.Group();
    const glass = this.material('#f2a531', 0.15, { transparent: true, opacity: 0.88, emissive: data.mine ? '#5a3300' : '#000000' });
    const body = new T.Mesh(this.track(new T.CylinderGeometry(JUG_RADIUS, JUG_RADIUS * 0.94, JUG_HEIGHT, 16)), glass);
    body.position.y = JUG_HEIGHT / 2;
    const foam = new T.Mesh(this.track(new T.CylinderGeometry(JUG_RADIUS * 1.05, JUG_RADIUS, 0.07, 16)), this.material('#fff8e8', 0.8));
    foam.position.y = JUG_HEIGHT + 0.02;
    const handle = new T.Mesh(this.track(new T.TorusGeometry(0.1, 0.028, 8, 16, Math.PI)), glass);
    handle.rotation.z = -Math.PI / 2;
    handle.position.set(JUG_RADIUS + 0.01, JUG_HEIGHT / 2, 0);
    group.add(body, foam, handle);

    const row = Math.floor(index / PER_ROW);
    const inRow = Math.min(PER_ROW, this.state.jugs.length - row * PER_ROW);
    const lane = (index % PER_ROW) - (inRow - 1) / 2;
    group.position.set(lane * LANE_GAP, COUNTER_TOP, this.startZ(row));
    this.scene.add(group);
    this.jugs.set(data.playerId, { data, group, lane, row, falling: null, landed: false });
  }

  /** Las filas de atras esperan un poco mas atras de la linea de salida. */
  private startZ(row: number): number {
    return row * ROW_GAP;
  }

  /* ---------------------------------- Bucle --------------------------------- */

  private updateJug(jug: Jug, now: number, delta: number): void {
    const { slideStartsAt, slideMs } = this.state;
    const distance = jug.data.distance;
    const startZ = this.startZ(jug.row);

    if (distance === null || slideStartsAt === null || now < slideStartsAt) {
      jug.group.position.z = startZ;
      return;
    }

    if (jug.falling) {
      // Fuera de la barra: cae dando vueltas hasta el suelo.
      const fall = jug.falling;

      if (!jug.landed) {
        fall.vy -= GRAVITY * delta;
        fall.y += fall.vy * delta;
        fall.z += fall.vz * delta;
        jug.group.rotation.x -= fall.spin * delta;

        if (fall.y <= 0.05) {
          fall.y = 0.05;
          jug.landed = true;
          jug.group.rotation.x = -Math.PI / 2;
          this.onJugBroken?.(jug.data.playerId);
        }
      }

      jug.group.position.set(jug.lane * LANE_GAP, fall.y, fall.z);
      return;
    }

    // Recorrido hasta su punto final con frenada progresiva (todas a la vez). Quien se pasa del borde no se para:
    // al llegar al borde sigue con la velocidad que lleva y cae.
    const travel = startZ + distance;
    const progress = Math.min(1, (now - slideStartsAt) / slideMs);
    const eased = 1 - Math.pow(1 - progress, 2.4);
    const z = startZ - travel * eased;
    jug.group.position.z = z;

    if (jug.data.fell && z <= -this.length) {
      const speed = (travel * 2.4 * Math.pow(1 - progress, 1.4)) / (slideMs / 1000);
      jug.falling = { vz: -Math.max(1.2, speed), vy: 0, y: COUNTER_TOP, z, spin: 6 };
    }
  }

  private loop(): void {
    this.frameHandle = requestAnimationFrame(() => this.loop());
    const now = performance.now();
    const delta = Math.min(0.05, (now - this.lastFrame) / 1000);
    this.lastFrame = now;

    for (const jug of this.jugs.values()) {
      this.updateJug(jug, now, delta);
    }

    this.renderer.render(this.scene, this.camera);
    this.placeLabels();
  }

  /** Cara del jugador sobre su jarra. */
  private placeLabels(): void {
    const width = this.host.clientWidth;
    const height = this.host.clientHeight;

    for (const label of Array.from(this.labelLayer.querySelectorAll<HTMLElement>('[data-beer-label]'))) {
      const jug = this.jugs.get(label.dataset['beerLabel'] || '');

      if (!jug) {
        label.style.opacity = '0';
        continue;
      }

      const vector = this.scratch.copy(jug.group.position).setY(jug.group.position.y + JUG_HEIGHT + 0.2).project(this.camera);
      label.style.opacity = vector.z < 1 ? '1' : '0';
      label.style.transform = `translate(${((vector.x + 1) / 2) * width}px, ${((1 - vector.y) / 2) * height}px) translate(-50%, -100%)`;
    }
  }

  /** Vista lateral y elevada: se ve la barra entera, de la salida al borde (y un poco del suelo de despues). */
  private resize(): void {
    const width = Math.max(1, this.host.clientWidth);
    const height = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.fov = width / height < 1 ? 70 : FOV;
    this.camera.updateProjectionMatrix();

    const span = this.length + 3.4;
    const horizontalFov = 2 * Math.atan(Math.tan((this.camera.fov * Math.PI) / 360) * this.camera.aspect);
    const distance = span / 2 / Math.tan(horizontalFov / 2) + 1;
    const centerZ = -this.length / 2 - 0.2;
    // Desde el lado del cliente de la barra, elevada unos 30 grados.
    this.camera.position.set(distance * 0.84, COUNTER_TOP + distance * 0.5, centerZ);
    this.camera.lookAt(0, COUNTER_TOP - 0.2, centerZ);
  }

  private track<T extends { dispose: () => void }>(item: T): T {
    this.disposables.push(item);
    return item;
  }
}
