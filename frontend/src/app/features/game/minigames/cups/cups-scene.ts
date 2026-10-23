import type * as ThreeModule from 'three';
import { createDealerRig } from '../../../../shared/components/mii-stage/dealer-rig';
import { MiiRig } from '../../../../shared/components/mii-stage/mii-rig';
import { CameraDirector, CameraGoal, ViewInsets } from '../../../../shared/three/camera-director';

type Three = typeof ThreeModule;

const TABLE_TOP = 0.9;
const SLOT_GAP = 1.45;
const CUP_HEIGHT = 1.05;
const CUP_LIFT = 1.3;
const BALL_RADIUS = 0.21;
// La mesa llega hasta z = -1.8 por detras: el crupier (escalado) queda justo detras de ella.
const DEALER_SCALE = 2.3;
const DEALER_Z = -2.75;
const DEALER_Y = -0.55;
// La bola entra rodando desde el borde delantero de la mesa.
const TABLE_FRONT_Z = 2.3;
// Al intercambiar, un cubilete pasa por detras y el otro por delante: asi nunca se atraviesan.
const SWAP_DEPTH = 0.85;
const FOV = 34;

export interface CupsMove {
  type: 'swap' | 'fake';
  a: number;
  b: number;
}

export interface CupsSceneState {
  round: number;
  cupCount: number;
  initialSlot: number;
  moves: CupsMove[];
  moveMs: number;
  placeMs: number;
  /** Tiempos ya pasados al reloj de performance.now(). */
  placeStartsAt: number;
  shuffleStartsAt: number;
  /** Solo al revelar: hueco donde esta la bola. */
  revealedSlot: number | null;
  selectedSlot: number | null;
  shuffling: boolean;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const easeInOut = (value: number) => (value < 0.5 ? 2 * value * value : 1 - Math.pow(-2 * value + 2, 2) / 2);
const bell = (value: number) => Math.sin(Math.PI * clamp01(value));

/**
 * Escena 3D de los cubiletes: mesa de ajedrezado verde, telon rojo, el crupier detras y cuatro cubiletes
 * dorados. Los cubiletes se mueven solo a partir de los movimientos recibidos y del reloj (igual en todos los
 * clientes). La bola solo existe en la escena cuando se ve: al taparla se retira y al revelar se vuelve a crear.
 */
export class CupsScene {
  private readonly renderer: ThreeModule.WebGLRenderer;
  private readonly scene: ThreeModule.Scene;
  private readonly camera: ThreeModule.PerspectiveCamera;
  private readonly director: CameraDirector;
  private readonly dealer: MiiRig;
  private readonly cups: ThreeModule.Group[] = [];
  private readonly ring: ThreeModule.Mesh;
  private readonly raycaster: ThreeModule.Raycaster;
  private readonly pointer: ThreeModule.Vector2;
  private readonly scratch: ThreeModule.Vector3;
  private readonly disposables: Array<{ dispose: () => void }> = [];
  private readonly resizeObserver: ResizeObserver;
  private ball: ThreeModule.Mesh | null = null;
  private ballGeometry: ThreeModule.SphereGeometry;
  private ballMaterial: ThreeModule.MeshStandardMaterial;
  private state: CupsSceneState | null = null;
  private revealStartedAt: number | null = null;
  private insets: ViewInsets = { top: 0, right: 0, bottom: 0, left: 0 };
  private frameHandle = 0;
  private lastFrame = performance.now();
  private disposed = false;

  /** Se llama al pulsar un cubilete (hueco 0..3). */
  onCupPicked?: (slot: number) => void;

  constructor(
    private readonly THREE: Three,
    private readonly canvas: HTMLCanvasElement,
    private readonly host: HTMLElement,
    private readonly labelLayer: HTMLElement,
    initialState: CupsSceneState,
    /** Semilla de la cara del crupier (sala + ronda): todos los jugadores ven la misma. */
    dealerSeed: string,
  ) {
    const T = THREE;
    this.renderer = new T.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = T.SRGBColorSpace;
    this.scene = new T.Scene();
    this.scene.background = new T.Color('#2b0d14');
    this.camera = new T.PerspectiveCamera(FOV, 1, 0.1, 100);
    this.director = new CameraDirector(T, this.camera);
    this.raycaster = new T.Raycaster();
    this.pointer = new T.Vector2();
    this.scratch = new T.Vector3();
    this.ballGeometry = this.track(new T.SphereGeometry(BALL_RADIUS, 28, 18));
    this.ballMaterial = this.track(new T.MeshStandardMaterial({ color: '#ffffff', roughness: 0.35, emissive: '#2a2a2a' }));

    this.buildRoom();
    this.buildCups(initialState.cupCount);
    this.ring = new T.Mesh(this.track(new T.RingGeometry(0.5, 0.62, 40)), this.track(new T.MeshBasicMaterial({ color: '#7fd1ff', transparent: true, opacity: 0.9 })));
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.visible = false;
    this.scene.add(this.ring);

    // El crupier del blackjack, grande y de pie detras de la mesa (sin atravesarla): se le ve sobre todo el
    // cuerpo, con las manos a la altura de los cubiletes. Puede que la cabeza quede fuera de plano.
    this.dealer = createDealerRig(T, dealerSeed);
    this.dealer.mood = 'dealer';
    this.dealer.enter(performance.now() / 1000 - 1);
    const dealerHolder = new T.Group();
    dealerHolder.position.set(0, DEALER_Y, DEALER_Z);
    dealerHolder.scale.setScalar(DEALER_SCALE);
    dealerHolder.add(this.dealer.root);
    this.scene.add(dealerHolder);

    canvas.addEventListener('pointerdown', this.handlePointer);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();
    this.director.focus('table', () => this.tableGoal(), performance.now());
    this.sync(initialState);
    this.loop();
  }

  sync(state: CupsSceneState): void {
    if (this.disposed) {
      return;
    }

    if (state.round !== this.state?.round) {
      this.revealStartedAt = null;
    }

    if (state.revealedSlot !== null && this.revealStartedAt === null) {
      this.revealStartedAt = performance.now();
    }

    this.state = state;
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
    this.dealer.dispose();

    for (const item of this.disposables) {
      item.dispose();
    }

    this.scene.clear();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }

  /* ------------------------------ Construccion ------------------------------ */

  private buildRoom(): void {
    const T = this.THREE;
    this.scene.add(new T.HemisphereLight(0xffffff, 0x552233, 1.3));
    const key = new T.DirectionalLight(0xffffff, 1.8);
    key.position.set(2, 8, 6);
    const fill = new T.DirectionalLight(0xffe2b0, 0.6);
    fill.position.set(-5, 4, 3);
    this.scene.add(key, fill);

    // Telon rojo de fondo con pliegues.
    const folds = document.createElement('canvas');
    folds.width = 512;
    folds.height = 32;
    const foldContext = folds.getContext('2d')!;
    const gradient = foldContext.createLinearGradient(0, 0, 64, 0);
    gradient.addColorStop(0, '#7a0f24');
    gradient.addColorStop(0.5, '#c4203f');
    gradient.addColorStop(1, '#7a0f24');
    foldContext.fillStyle = gradient;

    for (let x = 0; x < 512; x += 64) {
      foldContext.save();
      foldContext.translate(x, 0);
      foldContext.fillRect(0, 0, 64, 32);
      foldContext.restore();
    }

    const curtainTexture = this.track(new T.CanvasTexture(folds));
    curtainTexture.colorSpace = T.SRGBColorSpace;
    curtainTexture.wrapS = T.RepeatWrapping;
    curtainTexture.repeat.set(3, 1);
    // Mas atras para dejar sitio al crupier.
    const curtain = new T.Mesh(this.track(new T.PlaneGeometry(34, 15)), this.track(new T.MeshStandardMaterial({ map: curtainTexture, roughness: 0.9 })));
    curtain.position.set(0, 6, -6);
    this.scene.add(curtain);

    // Mesa con tablero de ajedrezado verde y blanco, como en la tele.
    const checks = document.createElement('canvas');
    checks.width = 512;
    checks.height = 256;
    const checksContext = checks.getContext('2d')!;

    for (let row = 0; row < 8; row += 1) {
      for (let column = 0; column < 16; column += 1) {
        checksContext.fillStyle = (row + column) % 2 ? '#2f8f5b' : '#e9f5ec';
        checksContext.fillRect(column * 32, row * 32, 32, 32);
      }
    }

    const checksTexture = this.track(new T.CanvasTexture(checks));
    checksTexture.colorSpace = T.SRGBColorSpace;
    checksTexture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    const tabletop = new T.Mesh(
      this.track(new T.BoxGeometry(8.4, 0.18, 4.2)),
      [
        ...Array(2).fill(this.track(new T.MeshStandardMaterial({ color: '#5a3420', roughness: 0.6 }))),
        this.track(new T.MeshStandardMaterial({ map: checksTexture, roughness: 0.55 })),
        ...Array(3).fill(this.track(new T.MeshStandardMaterial({ color: '#5a3420', roughness: 0.6 }))),
      ],
    );
    tabletop.position.set(0, TABLE_TOP - 0.09, 0.3);
    const skirt = new T.Mesh(this.track(new T.BoxGeometry(8.2, TABLE_TOP - 0.18, 4)), this.track(new T.MeshStandardMaterial({ color: '#8a1730', roughness: 0.8 })));
    skirt.position.set(0, (TABLE_TOP - 0.18) / 2, 0.3);
    const floor = new T.Mesh(this.track(new T.PlaneGeometry(40, 40)), this.track(new T.MeshStandardMaterial({ color: '#3a1420', roughness: 1 })));
    floor.rotation.x = -Math.PI / 2;
    this.scene.add(tabletop, skirt, floor);
  }

  private buildCups(count: number): void {
    const T = this.THREE;
    // Cubilete dorado boca abajo: mas ancho abajo (la boca) que arriba, con un reborde.
    const profile = [
      [0.0, CUP_HEIGHT],
      [0.3, CUP_HEIGHT],
      [0.33, CUP_HEIGHT - 0.06],
      [0.42, 0.08],
      [0.46, 0.02],
      [0.44, 0],
    ].map(([radius, y]) => new T.Vector2(radius, y));
    const geometry = this.track(new T.LatheGeometry(profile, 40));
    // Dorado sin mapa de entorno: poco metalico y algo de brillo propio para que no salga oscuro.
    const material = this.track(
      new T.MeshStandardMaterial({ color: '#f4cd57', roughness: 0.32, metalness: 0.18, emissive: '#5a4310', side: T.DoubleSide }),
    );

    for (let index = 0; index < count; index += 1) {
      const cup = new T.Group();
      const mesh = new T.Mesh(geometry, material);
      mesh.userData['cup'] = true;
      cup.add(mesh);
      cup.position.set(this.slotX(index, count), TABLE_TOP, 0);
      this.cups.push(cup);
      this.scene.add(cup);
    }
  }

  private slotX(slot: number, count = this.cups.length): number {
    return (slot - (count - 1) / 2) * SLOT_GAP;
  }

  /* -------------------------------- Animacion -------------------------------- */

  /** Coloca cada cubilete segun el reloj: colocar la bola, mezclar movimiento a movimiento y revelar. */
  private updateCups(now: number): void {
    const state = this.state;

    if (!state) {
      return;
    }

    const count = this.cups.length;
    // cupAt[hueco] = cubilete que esta en ese hueco (los cubiletes viajan, los huecos no).
    const cupAt = [...Array(count).keys()];
    const shuffleElapsed = now - state.shuffleStartsAt;
    const done = Math.max(0, Math.min(state.moves.length, Math.floor(shuffleElapsed / state.moveMs)));

    for (let index = 0; index < done; index += 1) {
      const move = state.moves[index];

      if (move.type === 'swap') {
        [cupAt[move.a], cupAt[move.b]] = [cupAt[move.b], cupAt[move.a]];
      }
    }

    for (let slot = 0; slot < count; slot += 1) {
      const cup = this.cups[cupAt[slot]];
      cup.position.set(this.slotX(slot), TABLE_TOP, 0);
    }

    // Movimiento en curso: uno por detras y otro por delante; el amago se queda a medio camino y vuelve.
    const current = state.moves[done];

    if (current && shuffleElapsed >= 0 && state.shuffling) {
      const progress = (shuffleElapsed - done * state.moveMs) / state.moveMs;
      const cupA = this.cups[cupAt[current.a]];
      const cupB = this.cups[cupAt[current.b]];
      const xa = this.slotX(current.a);
      const xb = this.slotX(current.b);
      const travel = current.type === 'swap' ? easeInOut(progress) : bell(progress) * 0.42;
      const depth = bell(progress) * SWAP_DEPTH;
      cupA.position.set(xa + (xb - xa) * travel, TABLE_TOP + bell(progress) * 0.05, -depth);
      cupB.position.set(xb + (xa - xb) * travel, TABLE_TOP + bell(progress) * 0.05, depth);
    }

    // Colocacion de la bola al empezar la ronda, sincronizada con el cubilete: sube el cubilete, la bola entra
    // rodando desde delante de la mesa (fuera de camara) hasta quedar debajo y solo entonces baja el cubilete.
    const place = (now - state.placeStartsAt) / state.placeMs;
    const placeCup = this.cups[state.initialSlot];

    if (place >= 0 && place < 1) {
      const lift = easeInOut(clamp01(place / 0.22));
      const lower = easeInOut(clamp01((place - 0.72) / 0.22));
      placeCup.position.y = TABLE_TOP + (lift - lower) * CUP_LIFT;

      const roll = clamp01((place - 0.12) / 0.54);

      if (place < 0.94 && roll > 0) {
        const distance = TABLE_FRONT_Z + 0.6;
        const travelled = (1 - Math.pow(1 - roll, 2)) * distance;
        this.showBall(this.slotX(state.initialSlot), TABLE_TOP + BALL_RADIUS, distance - travelled, -travelled / BALL_RADIUS);
      } else {
        // Ya tapada: la bola desaparece de la escena (no queda en ningun sitio donde mirar).
        this.removeBall();
      }
    } else if (state.revealedSlot === null) {
      this.removeBall();
    }

    // Revelacion: la bola aparece bajo su cubilete y este se levanta.
    if (state.revealedSlot !== null && this.revealStartedAt !== null) {
      const lift = clamp01((now - this.revealStartedAt) / 600);
      this.showBall(this.slotX(state.revealedSlot), TABLE_TOP + BALL_RADIUS);
      this.cups[cupAt[state.revealedSlot]].position.y = TABLE_TOP + easeInOut(lift) * CUP_LIFT;
    }

    // Seleccion del jugador: aro bajo el cubilete elegido.
    this.ring.visible = state.selectedSlot !== null;

    if (state.selectedSlot !== null) {
      this.ring.position.set(this.slotX(state.selectedSlot), TABLE_TOP + 0.01, 0);
    }
  }

  private showBall(x: number, y: number, z = 0, spin = 0): void {
    if (!this.ball) {
      this.ball = new this.THREE.Mesh(this.ballGeometry, this.ballMaterial);
      this.scene.add(this.ball);
    }

    this.ball.position.set(x, y, z);
    this.ball.rotation.x = spin;
  }

  private removeBall(): void {
    if (this.ball) {
      this.scene.remove(this.ball);
      this.ball = null;
    }
  }

  /* ---------------------------------- Clics ---------------------------------- */

  private readonly handlePointer = (event: PointerEvent): void => {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.intersectObjects(this.cups, true)[0];

    if (!hit) {
      return;
    }

    // Se elige el hueco mas cercano al punto pulsado (los cubiletes estan quietos al votar).
    let best = 0;

    for (let slot = 1; slot < this.cups.length; slot += 1) {
      if (Math.abs(hit.point.x - this.slotX(slot)) < Math.abs(hit.point.x - this.slotX(best))) {
        best = slot;
      }
    }

    this.onCupPicked?.(best);
  };

  /* --------------------------------- Camara --------------------------------- */

  /** Desde delante y algo por encima: la fila de cubiletes, las caras de los votos y el crupier detras. */
  private tableGoal(): CameraGoal {
    const T = this.THREE;
    const half = this.slotX(this.cups.length - 1) + 1.6;
    return {
      target: new T.Vector3(0, TABLE_TOP + 0.75, -0.2),
      direction: new T.Vector3(0, 0.62, 1).normalize(),
      fit: [
        new T.Vector3(-half, TABLE_TOP, 1.6),
        new T.Vector3(half, TABLE_TOP, 1.6),
        new T.Vector3(-half, TABLE_TOP + CUP_HEIGHT + 1.4, 0),
        new T.Vector3(half, TABLE_TOP + CUP_HEIGHT + 1.4, 0),
        // Hombros del crupier: se le ve el cuerpo (la cabeza puede quedar cortada).
        new T.Vector3(-1.4, DEALER_Y + 1.25 * DEALER_SCALE, DEALER_Z),
        new T.Vector3(1.4, DEALER_Y + 1.25 * DEALER_SCALE, DEALER_Z),
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
    // El crupier mueve los brazos solo mientras se mezclan los cubiletes (con la bola ya tapada), no al colocarla.
    const state = this.state;
    const mixing = Boolean(state?.shuffling && now >= state.shuffleStartsAt && now < state.shuffleStartsAt + state.moves.length * state.moveMs);
    this.dealer.mood = mixing ? 'shuffle' : 'dealer';
    this.dealer.update(time, delta, 'game');
    this.updateCups(now);
    this.director.update(now, delta);
    this.renderer.render(this.scene, this.camera);
    this.placeLabels();
  }

  /** Caras de quien ha votado cada cubilete, encima de el. */
  private placeLabels(): void {
    const width = this.host.clientWidth;
    const height = this.host.clientHeight;

    for (const label of Array.from(this.labelLayer.querySelectorAll<HTMLElement>('[data-cup-slot]'))) {
      const slot = Number(label.dataset['cupSlot']);
      const vector = this.scratch.set(this.slotX(slot), TABLE_TOP + CUP_HEIGHT + 0.25, 0).project(this.camera);
      label.style.transform = `translate(${((vector.x + 1) / 2) * width}px, ${((1 - vector.y) / 2) * height}px) translate(-50%, -100%)`;
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
