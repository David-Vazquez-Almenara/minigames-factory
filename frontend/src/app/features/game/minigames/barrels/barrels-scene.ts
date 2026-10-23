import type * as ThreeModule from 'three';
import { MiiMood, MiiRig, createFaceTexture } from '../../../../shared/components/mii-stage/mii-rig';
import { CameraDirector, CameraGoal, ViewInsets } from '../../../../shared/three/camera-director';

type Three = typeof ThreeModule;

// Escala de la escena: los 50 m de caida ocupan PATH unidades, desde la coronilla del Mii (subido a su
// peana de 0.1) hacia arriba. 0 m es justo la cabeza.
const PAD_TOP = 0.1;
const HEAD_TOP = PAD_TOP + 2.24;
const PATH = 6.4;
const BARREL_HEIGHT = 1.1;
const BARREL_RADIUS = 0.44;
const BARREL_BULGE = 0.07;
const BEAM_Y = HEAD_TOP + PATH + BARREL_HEIGHT + 0.5;
const SPACING = 2.6;
const BACK_Z = -0.7;
const FOV = 40;
const INTRO_DELAY_MS = 350;
const INTRO_ZOOM_MS = 1900;
const CRUSH_MS = 900;

export interface BarrelColumnView {
  playerId: string;
  name: string;
  avatarUrl: string;
  shirt: string;
  isLocal: boolean;
}

/** Lo que hay que dibujar de cada jugador en este instante (lo decide el componente). */
export interface BarrelColumnState {
  height: number;
  crushed: boolean;
  mood: MiiMood;
}

interface Column {
  view: BarrelColumnView;
  x: number;
  z: number;
  group: ThreeModule.Group;
  rig: MiiRig;
  barrel: ThreeModule.Group;
  rope: ThreeModule.Mesh;
  shadow: ThreeModule.Mesh;
  shadowMaterial: ThreeModule.MeshBasicMaterial;
  shown: number;
  crushedAt: number | null;
  visible: boolean;
}

const easeOutCubic = (value: number) => 1 - Math.pow(1 - value, 3);
const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/**
 * Escena 3D de los barriles: el jugador local en el centro con su recorrido completo de 50 m a la vista
 * y hasta cuatro rivales a los lados. Solo se crean los jugadores visibles; la escena no decide nada del
 * juego, pregunta al componente la altura de cada barril en cada fotograma.
 */
export class BarrelsScene {
  private readonly renderer: ThreeModule.WebGLRenderer;
  private readonly scene: ThreeModule.Scene;
  private readonly camera: ThreeModule.PerspectiveCamera;
  private readonly director: CameraDirector;
  private readonly columns: Column[] = [];
  private readonly disposables: Array<{ dispose: () => void }> = [];
  private readonly resizeObserver: ResizeObserver;
  private readonly scratch: ThreeModule.Vector3;
  private readonly createdAt = performance.now();
  private insets: ViewInsets = { top: 0, right: 0, bottom: 0, left: 0 };
  private frameHandle = 0;
  private lastFrame = performance.now();
  private zoomed = false;
  private disposed = false;

  /** Se llama en cada fotograma, antes de dibujar (el componente actualiza su HUD sin pasar por Angular). */
  onFrame?: (now: number) => void;

  constructor(
    private readonly THREE: Three,
    canvas: HTMLCanvasElement,
    private readonly host: HTMLElement,
    private readonly labelLayer: HTMLElement,
    views: BarrelColumnView[],
    private readonly startHeight: number,
    proxyBase: string,
    private readonly provider: (playerId: string) => BarrelColumnState,
    skipIntro: boolean,
  ) {
    const T = THREE;
    this.renderer = new T.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = T.SRGBColorSpace;
    this.scene = new T.Scene();
    this.scene.background = new T.Color('#bfe9ff');
    this.scene.fog = new T.Fog('#bfe9ff', 26, 70);
    this.camera = new T.PerspectiveCamera(FOV, 1, 0.1, 150);
    this.director = new CameraDirector(T, this.camera);
    this.scratch = new T.Vector3();

    this.buildWorld(views.length);
    const barrelParts = this.barrelParts();
    const time = performance.now() / 1000;

    // Local en el centro; los rivales alternan izquierda y derecha, un poco mas atras.
    views.forEach((view, index) => {
      const side = index % 2 ? -1 : 1;
      const x = index === 0 ? 0 : side * Math.ceil(index / 2) * SPACING;
      const z = index === 0 ? 0 : BACK_Z;
      this.columns.push(this.createColumn(view, x, z, barrelParts, time + 0.15 + index * 0.1, proxyBase));
    });

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();

    if (skipIntro) {
      this.zoomed = true;
      this.director.focus('local', () => this.localGoal(), performance.now());
    } else {
      this.director.focus('overview', () => this.overviewGoal(), performance.now());
    }

    this.loop();
  }

  setInsets(insets: ViewInsets): void {
    this.insets = insets;
    this.director.setViewport(this.host.clientWidth, this.host.clientHeight, insets);
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frameHandle);
    this.resizeObserver.disconnect();

    for (const column of this.columns) {
      column.rig.dispose();
    }

    for (const item of this.disposables) {
      item.dispose();
    }

    this.scene.clear();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }

  /* ------------------------------ Construccion ------------------------------ */

  private buildWorld(count: number): void {
    const T = this.THREE;
    this.scene.add(new T.HemisphereLight(0xffffff, 0xb9e6a8, 1.45));
    const key = new T.DirectionalLight(0xffffff, 1.6);
    key.position.set(3, 12, 8);
    const fill = new T.DirectionalLight(0xfff2c4, 0.5);
    fill.position.set(-6, 5, 4);
    this.scene.add(key, fill);

    const ground = new T.Mesh(this.track(new T.CircleGeometry(80, 48)), this.track(new T.MeshStandardMaterial({ color: '#c9f1c0', roughness: 0.95 })));
    ground.rotation.x = -Math.PI / 2;
    this.scene.add(ground);

    // Viga de la grua de lado a lado de los jugadores visibles, con dos postes.
    const reach = Math.min(2, Math.ceil((count - 1) / 2)) * SPACING + 1.6;
    const wood = this.track(new T.MeshStandardMaterial({ color: '#8a5a3c', roughness: 0.7 }));
    // Tan profunda como la fila de rivales: todas las cuerdas cuelgan de ella.
    const beam = new T.Mesh(this.track(new T.BoxGeometry(reach * 2, 0.32, Math.abs(BACK_Z) + 0.5)), this.track(new T.MeshStandardMaterial({ color: '#ffcf5a', roughness: 0.55 })));
    beam.position.set(0, BEAM_Y, BACK_Z / 2);
    const postGeometry = this.track(new T.BoxGeometry(0.3, BEAM_Y, 0.3));
    const left = new T.Mesh(postGeometry, wood);
    left.position.set(-reach, BEAM_Y / 2, BACK_Z / 2);
    const right = new T.Mesh(postGeometry, wood);
    right.position.set(reach, BEAM_Y / 2, BACK_Z / 2);
    // Sin regla ni medidor: la altura del barril se calcula por intuicion.
    this.scene.add(beam, left, right);
  }

  /** Piezas compartidas del barril: duelas de madera (torno con panza), aros y tapas. */
  private barrelParts() {
    const T = this.THREE;
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#b5733f';
    context.fillRect(0, 0, 256, 64);

    for (let x = 0; x < 256; x += 32) {
      context.fillStyle = x % 64 ? '#a8683a' : '#bf7d47';
      context.fillRect(x + 2, 0, 28, 64);
      context.fillStyle = '#6e3f1f';
      context.fillRect(x, 0, 3, 64);
    }

    const staves = new T.CanvasTexture(canvas);
    staves.colorSpace = T.SRGBColorSpace;
    this.track(staves);

    const radiusAt = (ratio: number) => BARREL_RADIUS + BARREL_BULGE * Math.sin(Math.PI * ratio);
    const profile = Array.from({ length: 13 }, (_unused, index) => new T.Vector2(radiusAt(index / 12), (index / 12) * BARREL_HEIGHT));

    return {
      radiusAt,
      body: this.track(new T.LatheGeometry(profile, 28)),
      lid: this.track(new T.CircleGeometry(BARREL_RADIUS, 28)),
      hoops: [0.1, 0.32, 0.68, 0.9].map((ratio) => ({ ratio, geometry: this.track(new T.TorusGeometry(radiusAt(ratio) + 0.012, 0.035, 6, 28)) })),
      wood: this.track(new T.MeshStandardMaterial({ map: staves, roughness: 0.65, side: T.DoubleSide })),
      lidMaterial: this.track(new T.MeshStandardMaterial({ color: '#9c6233', roughness: 0.7 })),
      metal: this.track(new T.MeshStandardMaterial({ color: '#4b4b55', roughness: 0.4, metalness: 0.3 })),
      rope: this.track(new T.CylinderGeometry(0.035, 0.035, 1, 6)),
      ropeMaterial: this.track(new T.MeshStandardMaterial({ color: '#d9b77a', roughness: 0.9 })),
      pad: this.track(new T.CylinderGeometry(0.8, 0.86, 0.1, 32)),
      shadow: this.track(new T.CircleGeometry(0.62, 28)),
    };
  }

  private createColumn(
    view: BarrelColumnView,
    x: number,
    z: number,
    parts: ReturnType<BarrelsScene['barrelParts']>,
    enterAt: number,
    proxyBase: string,
  ): Column {
    const T = this.THREE;
    const group = new T.Group();
    group.position.set(x, 0, z);

    const pad = new T.Mesh(parts.pad, this.track(new T.MeshStandardMaterial({ color: view.isLocal ? '#ffe891' : '#fff7ec', roughness: 0.6 })));
    pad.position.y = 0.05;
    const shadowMaterial = this.track(new T.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.1, depthWrite: false }));
    const shadow = new T.Mesh(parts.shadow, shadowMaterial);
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.105;

    const rig = new MiiRig(T, view.shirt);
    rig.baseY = PAD_TOP;
    rig.mood = 'look-up';
    rig.enter(enterAt);

    const barrel = new T.Group();
    const body = new T.Mesh(parts.body, parts.wood);
    const top = new T.Mesh(parts.lid, parts.lidMaterial);
    top.rotation.x = -Math.PI / 2;
    top.position.y = BARREL_HEIGHT;
    const bottom = new T.Mesh(parts.lid, parts.lidMaterial);
    bottom.rotation.x = Math.PI / 2;
    barrel.add(body, top, bottom);

    for (const hoop of parts.hoops) {
      const ring = new T.Mesh(hoop.geometry, parts.metal);
      ring.rotation.x = Math.PI / 2;
      ring.position.y = hoop.ratio * BARREL_HEIGHT;
      barrel.add(ring);
    }

    const rope = new T.Mesh(parts.rope, parts.ropeMaterial);
    group.add(pad, shadow, rig.root, barrel, rope);
    this.scene.add(group);

    void createFaceTexture(T, view.avatarUrl, view.name, proxyBase).then((texture) => {
      if (this.disposed) {
        texture.dispose();
        return;
      }

      rig.setFaceTexture(texture);
    });

    return { view, x, z, group, rig, barrel, rope, shadow, shadowMaterial, shown: this.startHeight, crushedAt: null, visible: true };
  }

  /* --------------------------------- Camara --------------------------------- */

  /** Encuadre final: el jugador local centrado, con su recorrido completo de 50 m y siempre al mismo tamano. */
  private localGoal(): CameraGoal {
    const T = this.THREE;
    const topY = HEAD_TOP + PATH + BARREL_HEIGHT + 0.3;
    return {
      target: new T.Vector3(0, topY / 2 - 0.2, 0),
      direction: new T.Vector3(0, 0.08, 1).normalize(),
      fit: [new T.Vector3(-1.62, -0.55, 0.7), new T.Vector3(1.62, -0.55, 0.7), new T.Vector3(-1.62, topY, 0), new T.Vector3(1.62, topY, 0)],
      margin: 0.95,
    };
  }

  /** Vista general de la intro: todos los jugadores visibles y la grua. */
  private overviewGoal(): CameraGoal {
    const T = this.THREE;
    const fit: ThreeModule.Vector3[] = [];

    for (const column of this.columns) {
      fit.push(new T.Vector3(column.x - 1.3, 0, column.z + 0.6), new T.Vector3(column.x + 1.3, BEAM_Y + 0.4, column.z));
    }

    return { target: new T.Vector3(0, BEAM_Y * 0.4, BACK_Z / 2), direction: new T.Vector3(0, 0.8, 1).normalize(), fit, margin: 0.5 };
  }

  /* ---------------------------------- Bucle --------------------------------- */

  private loop(): void {
    this.frameHandle = requestAnimationFrame(() => this.loop());
    const now = performance.now();
    const delta = Math.min(0.05, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    const time = now / 1000;

    if (!this.zoomed && now - this.createdAt > INTRO_DELAY_MS) {
      this.zoomed = true;
      this.director.focus('local', () => this.localGoal(), now, { durationMs: INTRO_ZOOM_MS });
    }

    this.onFrame?.(now);

    for (const column of this.columns) {
      this.updateColumn(column, now, time, delta);
    }

    this.director.update(now, delta);
    this.shakeCamera(now);
    this.updateVisibility();
    this.renderer.render(this.scene, this.camera);
    this.placeLabels();
  }

  private updateColumn(column: Column, now: number, time: number, delta: number): void {
    const state = this.provider(column.view.playerId);
    const rig = column.rig;

    // La caida sigue exactamente al reloj; si la altura sube (parada remota que llego tarde) se recoloca con suavidad.
    const target = Math.max(0, state.height);
    column.shown = target > column.shown ? column.shown + (target - column.shown) * Math.min(1, delta * 12) : target;

    if (state.crushed && column.crushedAt === null) {
      column.crushedAt = now;
    }

    rig.mood = state.mood;
    rig.update(time, delta, 'game');

    const barrel = column.barrel;
    let barrelBottom = HEAD_TOP + (column.shown / this.startHeight) * PATH;

    if (column.crushedAt !== null) {
      // Aplastado: el barril golpea la cabeza, el Mii se encoge y queda sentado y mareado; el barril rueda al lado.
      const elapsed = now - column.crushedAt;
      const squash = elapsed < 120 ? elapsed / 120 : Math.max(0, 1 - (elapsed - 120) / 380);
      rig.pose = elapsed > 160 ? 'ground-sit' : 'stand';
      rig.root.scale.set(1 + squash * 0.25, 1 - squash * 0.45, 1 + squash * 0.25);
      const roll = clamp01((elapsed - 120) / (CRUSH_MS - 120));
      const eased = easeOutCubic(roll);
      const bounce = roll >= 1 ? 0 : Math.abs(Math.sin(roll * Math.PI * 2.2)) * (1 - roll) * 0.5;
      barrel.position.set(eased * 0.92, HEAD_TOP * (1 - eased) * 0.82 + (BARREL_RADIUS + BARREL_BULGE) * eased + bounce, 0.15 * eased);
      barrel.rotation.set(0, 0, -eased * (Math.PI / 2));
      barrelBottom = barrel.position.y;
    } else {
      rig.pose = 'stand';
      barrel.position.set(0, barrelBottom, 0);
      barrel.rotation.set(0, 0, 0);
    }

    // Cuerda desde la viga hasta la tapa (se suelta al aplastar).
    const ropeBottom = barrelBottom + BARREL_HEIGHT;
    column.rope.visible = column.crushedAt === null;
    column.rope.scale.y = Math.max(0.01, BEAM_Y - ropeBottom);
    column.rope.position.set(0, (BEAM_Y + ropeBottom) / 2, 0);

    // La sombra se oscurece a medida que el barril se acerca.
    const closeness = 1 - column.shown / this.startHeight;
    column.shadowMaterial.opacity = column.crushedAt === null ? 0.06 + closeness * 0.3 : 0.12;
    column.shadow.scale.setScalar(0.7 + closeness * 0.5);
  }

  /** Temblor breve de la camara cuando aplastan al jugador local. */
  private shakeCamera(now: number): void {
    const local = this.columns[0];

    if (!local?.view.isLocal || local.crushedAt === null) {
      return;
    }

    const elapsed = now - local.crushedAt;

    if (elapsed < 420) {
      const strength = (1 - elapsed / 420) * 0.12;
      this.camera.position.x += Math.sin(elapsed * 0.11) * strength;
      this.camera.position.y += Math.cos(elapsed * 0.13) * strength;
    }
  }

  /** Solo se dibujan los rivales que caben enteros en pantalla; el local siempre. */
  private updateVisibility(): void {
    this.camera.updateMatrixWorld();

    for (const column of this.columns) {
      if (column.view.isLocal) {
        column.visible = true;
      } else {
        const middle = HEAD_TOP + PATH / 2;
        const left = this.scratch.set(column.x - 1, middle, column.z).project(this.camera).x;
        const right = this.scratch.set(column.x + 1, middle, column.z).project(this.camera).x;
        column.visible = left >= -1 && right <= 1;
      }

      column.group.visible = column.visible;
    }
  }

  private placeLabels(): void {
    const width = this.host.clientWidth;
    const height = this.host.clientHeight;

    for (const label of Array.from(this.labelLayer.querySelectorAll<HTMLElement>('[data-br-label]'))) {
      const column = this.columns.find((item) => item.view.playerId === label.dataset['brLabel']);

      if (!column || !column.visible) {
        label.style.opacity = '0';
        continue;
      }

      const vector = this.scratch.set(column.x, 0, column.z + 0.75).project(this.camera);
      label.style.opacity = vector.z < 1 ? '1' : '0';
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
