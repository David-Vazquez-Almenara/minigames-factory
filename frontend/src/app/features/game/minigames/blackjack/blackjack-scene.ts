import type * as ThreeModule from 'three';
import { BlackjackCard } from '../../../../core/services/socket.service';
import { createDealerRig } from '../../../../shared/components/mii-stage/dealer-rig';
import { MiiMood, MiiRig, createFaceTexture } from '../../../../shared/components/mii-stage/mii-rig';
import { CameraDirector, CameraGoal, ViewInsets } from '../../../../shared/three/camera-director';
import { CARD_HEIGHT, CARD_WIDTH, CardFactory, CardMesh } from './card-factory';

type Three = typeof ThreeModule;
type Vector3 = ThreeModule.Vector3;

const TABLE_TOP = 0.88;
const DEALER_Z = -0.45;
const DEALER_CARDS_Z = 0.78;
const CARD_SPREAD = 0.3;
const DEAL_FLIGHT_MS = 380;
const FLIP_MS = 650;
const REMOVE_MS = 520;
const FOV = 36;
const FONT = '"Trebuchet MS", Arial, sans-serif';

export type BlackjackFocus = { kind: 'overview' } | { kind: 'dealer' } | { kind: 'swap'; group: number } | { kind: 'seat' | 'cards'; playerId: string };
export type BlackjackSeatResult = 'win' | 'blackjack' | 'push' | 'lose' | 'sat-out' | null;

export interface BlackjackSeatView {
  playerId: string;
  name: string;
  avatarUrl: string;
  shirt: string;
  chips: number;
  startChips: number;
  bet: number;
  cards: BlackjackCard[];
  mood: MiiMood;
  isLocal: boolean;
  isActive: boolean;
  result: BlackjackSeatResult;
  payout: number;
}

export interface BlackjackSceneState {
  handNumber: number;
  /** Asientos que caben en la mesa (4 como maximo); la mesa se dimensiona con este numero. */
  layoutSeats: number;
  /** Jugadores sentados ahora mismo (el grupo que se esta mostrando). */
  seats: BlackjackSeatView[];
  dealerCards: BlackjackCard[];
  dealOrder: Array<{ to: string; index: number }>;
  /** Inicio del reparto inicial en el reloj de performance.now() (ya convertido desde el del servidor). */
  dealStartsAt: number | null;
  dealInterval: number;
}

/** Color de las fichas segun el saldo: mas de lo inicial, lo inicial, algo menos y pocas fichas. */
export function chipTier(chips: number, startChips: number): { color: string; label: string } {
  if (chips <= 0) {
    return { color: '#9a9a9a', label: 'Sin fichas' };
  }

  if (chips > startChips) {
    return { color: '#f4c430', label: 'Por encima de las iniciales' };
  }

  if (chips === startChips) {
    return { color: '#3d7bf2', label: 'Fichas iniciales' };
  }

  return chips >= startChips / 2 ? { color: '#2fa35b', label: 'Por debajo de las iniciales' } : { color: '#e04a3c', label: 'Pocas fichas' };
}

/** Fichas de una apuesta desglosadas por valor (100, 50, 25, 10, 5, 1), cada valor con su color. */
function betChipColors(amount: number): string[] {
  const denominations: Array<[number, string]> = [
    [100, '#232323'],
    [50, '#8a4fd8'],
    [25, '#ff8fb8'],
    [10, '#f2f2f2'],
    [5, '#ffb347'],
    [1, '#bfe7ff'],
  ];
  const colors: string[] = [];
  let rest = amount;

  for (const [value, color] of denominations) {
    while (rest >= value && colors.length < 24) {
      colors.push(color);
      rest -= value;
    }
  }

  return colors;
}

const easeOutCubic = (value: number) => 1 - Math.pow(1 - value, 3);
const easeInOutCubic = (value: number) => (value < 0.5 ? 4 * value * value * value : 1 - Math.pow(-2 * value + 2, 3) / 2);
const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

interface ChipFlight {
  from: Vector3;
  to: Vector3;
  start: number;
  duration: number;
  shrink: boolean;
}

interface SeatEntry {
  view: BlackjackSeatView;
  index: number;
  /** Taburete + Mii (se encoge al levantarse el grupo) y todo lo que el jugador tiene sobre la mesa. */
  root: ThreeModule.Group;
  table: ThreeModule.Group;
  createdAt: number;
  leavingAt: number | null;
  radial: Vector3;
  right: Vector3;
  yaw: number;
  position: Vector3;
  betSpot: Vector3;
  stackSpot: Vector3;
  rig: MiiRig;
  avatarUrl: string;
  stack: ThreeModule.Group;
  stackKey: string;
  bet: ThreeModule.Group;
  betKey: string;
  betFlight: ChipFlight | null;
  payout: ThreeModule.Group;
  payoutFlight: ChipFlight | null;
  resultKey: string;
  ring: ThreeModule.Mesh;
  spot: ThreeModule.Mesh;
}

interface CardEntry {
  mesh: CardMesh;
  owner: string;
  index: number;
  count: number;
  faceKey: string;
  dealAt: number;
  landed: boolean;
  notified: boolean;
  flipStart: number | null;
  removeAt: number | null;
  removeFrom: Vector3 | null;
  target: Vector3;
  yaw: number;
}

/** Fichas 3D: una geometria y dos materiales (canto con rayas y cara con anillo) por color. */
class ChipFactory {
  readonly geometry: ThreeModule.CylinderGeometry;
  private readonly materials = new Map<string, ThreeModule.MeshStandardMaterial[]>();
  private readonly disposables: Array<{ dispose: () => void }> = [];

  constructor(private readonly THREE: Three) {
    this.geometry = new THREE.CylinderGeometry(0.1, 0.1, 0.032, 28, 1);
  }

  materialsFor(color: string): ThreeModule.MeshStandardMaterial[] {
    let materials = this.materials.get(color);

    if (materials) {
      return materials;
    }

    const T = this.THREE;
    const side = document.createElement('canvas');
    side.width = 128;
    side.height = 16;
    const sideContext = side.getContext('2d')!;
    sideContext.fillStyle = color;
    sideContext.fillRect(0, 0, 128, 16);
    sideContext.fillStyle = color === '#f2f2f2' ? '#3d7bf2' : '#ffffff';

    for (let stripe = 0; stripe < 6; stripe += 1) {
      sideContext.fillRect(stripe * 21 + 5, 0, 9, 16);
    }

    const face = document.createElement('canvas');
    face.width = 64;
    face.height = 64;
    const faceContext = face.getContext('2d')!;
    faceContext.fillStyle = color;
    faceContext.fillRect(0, 0, 64, 64);
    faceContext.strokeStyle = color === '#f2f2f2' ? '#3d7bf2' : '#ffffff';
    faceContext.lineWidth = 7;
    faceContext.setLineDash([9, 7]);
    faceContext.beginPath();
    faceContext.arc(32, 32, 26, 0, Math.PI * 2);
    faceContext.stroke();
    faceContext.setLineDash([]);
    faceContext.fillStyle = 'rgba(255, 255, 255, 0.35)';
    faceContext.beginPath();
    faceContext.arc(32, 32, 15, 0, Math.PI * 2);
    faceContext.fill();

    const texture = (canvas: HTMLCanvasElement) => {
      const result = new T.CanvasTexture(canvas);
      result.colorSpace = T.SRGBColorSpace;
      this.disposables.push(result);
      return result;
    };
    const sideMaterial = new T.MeshStandardMaterial({ map: texture(side), roughness: 0.45 });
    const faceMaterial = new T.MeshStandardMaterial({ map: texture(face), roughness: 0.45 });
    this.disposables.push(sideMaterial, faceMaterial);
    materials = [sideMaterial, faceMaterial, faceMaterial];
    this.materials.set(color, materials);
    return materials;
  }

  /** Columna de fichas en (x, z) relativos al grupo, con un pequeno desorden natural. */
  addColumn(group: ThreeModule.Group, colors: string[], x: number, z: number): void {
    colors.forEach((color, index) => {
      const chip = new this.THREE.Mesh(this.geometry, this.materialsFor(color));
      const wobble = ((index * 7919) % 13) / 13 - 0.5;
      chip.position.set(x + wobble * 0.008, 0.016 + index * 0.033, z - wobble * 0.006);
      chip.rotation.y = index * 1.3;
      group.add(chip);
    });
  }

  dispose(): void {
    this.geometry.dispose();

    for (const item of this.disposables) {
      item.dispose();
    }

    this.materials.clear();
  }
}

/**
 * Escena 3D de la mesa de blackjack. Solo representa el estado que recibe (no decide nada del juego):
 * mesa semicircular, Miis sentados, crupier, reparto y volteo de cartas, fichas y una camara unica.
 */
export class BlackjackScene {
  private readonly renderer: ThreeModule.WebGLRenderer;
  private readonly scene: ThreeModule.Scene;
  private readonly camera: ThreeModule.PerspectiveCamera;
  private readonly director: CameraDirector;
  private readonly cardFactory: CardFactory;
  private readonly chipFactory: ChipFactory;
  private readonly seats = new Map<string, SeatEntry>();
  /** Grupo que se levanta de la mesa (animacion de salida antes de retirarlo). */
  private readonly leavingSeats: SeatEntry[] = [];
  private seatKey = '';
  /** Jugadores que se acaban de sentar en este sync: sus cartas ya repartidas aparecen sin volver a volar. */
  private readonly justSeated = new Set<string>();
  private readonly cardEntries = new Map<string, CardEntry>();
  private readonly dealer: MiiRig;
  private readonly disposables: Array<{ dispose: () => void }> = [];
  private readonly resizeObserver: ResizeObserver;
  private readonly shoeMouth: Vector3;
  private readonly discard: Vector3;
  private readonly tray: Vector3;
  private readonly scratch: Vector3;
  private readonly cardRadius: number;
  private readonly tableRadius: number;
  private readonly seatRadius: number;
  private readonly ringMaterial: ThreeModule.MeshBasicMaterial;
  private readonly localRingMaterial: ThreeModule.MeshBasicMaterial;
  private readonly activeRingMaterial: ThreeModule.MeshBasicMaterial;
  private readonly spotMaterial: ThreeModule.MeshBasicMaterial;
  private state: BlackjackSceneState;
  private focus: BlackjackFocus = { kind: 'overview' };
  private insets: ViewInsets = { top: 0, right: 0, bottom: 0, left: 0 };
  private frameHandle = 0;
  private lastFrame = performance.now();
  private disposed = false;

  /** Se llama cuando una carta sale del mazo (para el sonido del reparto). */
  onCardDealt?: () => void;
  /** Se llama al voltear la carta oculta del crupier. */
  onCardFlipped?: () => void;

  constructor(
    private readonly THREE: Three,
    canvas: HTMLCanvasElement,
    private readonly host: HTMLElement,
    private readonly labelLayer: HTMLElement,
    initialState: BlackjackSceneState,
    private readonly proxyBase: string,
    /** Semilla de la cara del crupier (sala + ronda): todos los jugadores ven la misma. */
    dealerSeed: string,
  ) {
    const T = THREE;
    this.state = initialState;
    this.renderer = new T.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = T.SRGBColorSpace;
    this.scene = new T.Scene();
    this.scene.background = new T.Color('#ffd6e8');
    this.scene.fog = new T.Fog('#ffd6e8', 22, 60);
    this.camera = new T.PerspectiveCamera(FOV, 1, 0.1, 120);
    this.director = new CameraDirector(T, this.camera);
    this.cardFactory = new CardFactory(T, Math.min(8, this.renderer.capabilities.getMaxAnisotropy()));
    this.chipFactory = new ChipFactory(T);
    this.scratch = new T.Vector3();

    // El radio crece con los asientos para que las manos de asientos vecinos no se solapen (4 como maximo).
    const step = this.seatStep(Math.max(1, initialState.layoutSeats));
    this.cardRadius = Math.min(5.2, Math.max(2.05, 1.3 / Math.max(step, 0.01)));
    this.tableRadius = this.cardRadius + 1.3;
    this.seatRadius = this.tableRadius + 0.62;
    this.shoeMouth = new T.Vector3(0.9, TABLE_TOP + 0.18, 0.5);
    this.discard = new T.Vector3(-1.05, TABLE_TOP + 0.12, 0.34);
    this.tray = new T.Vector3(0, TABLE_TOP + 0.06, 0.2);

    this.ringMaterial = this.track(new T.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.75 }));
    this.localRingMaterial = this.track(new T.MeshBasicMaterial({ color: '#ffe891', transparent: true, opacity: 0.95 }));
    this.activeRingMaterial = this.track(new T.MeshBasicMaterial({ color: '#ffe891', transparent: true, opacity: 1 }));
    this.spotMaterial = this.track(new T.MeshBasicMaterial({ color: '#ffe891', transparent: true, opacity: 0.8, depthWrite: false }));

    this.buildRoom();
    this.buildTable();
    const time = performance.now() / 1000;

    // Crupier: un Mii normal vestido de negro, de pie y sin foto en la cara.
    this.dealer = createDealerRig(T, dealerSeed);
    this.dealer.mood = 'dealer';
    this.dealer.root.position.z = DEALER_Z;
    this.dealer.enter(time);
    this.scene.add(this.dealer.root);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();
    this.sync(initialState);
    this.setFocus({ kind: 'overview' });
    this.loop();
  }

  sync(state: BlackjackSceneState): void {
    if (this.disposed) {
      return;
    }

    this.state = state;
    const now = performance.now();
    this.syncSeats(state.seats, now);

    for (const view of state.seats) {
      const seat = this.seats.get(view.playerId);

      if (!seat) {
        continue;
      }

      seat.view = view;
      seat.rig.mood = view.mood;
      seat.ring.material = view.isActive ? this.activeRingMaterial : view.isLocal ? this.localRingMaterial : this.ringMaterial;
      this.loadFace(seat);
      this.syncChips(seat, state.handNumber, now);
    }

    this.syncCards(state, now);
    this.justSeated.clear();
  }

  setFocus(focus: BlackjackFocus): void {
    this.focus = focus;
    const key =
      focus.kind === 'overview' || focus.kind === 'dealer' ? focus.kind : focus.kind === 'swap' ? `swap:${focus.group}` : `${focus.kind}:${focus.playerId}`;
    this.director.focus(key, () => this.goalFor(this.focus), performance.now(), { durationMs: 1150, arc: 0.6 });
  }

  /** Zonas de la pantalla tapadas por el HUD: la camara encuadra en el hueco libre. */
  setInsets(insets: ViewInsets): void {
    this.insets = insets;
    this.director.setViewport(this.host.clientWidth, this.host.clientHeight, insets);
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frameHandle);
    this.resizeObserver.disconnect();

    for (const seat of [...this.seats.values(), ...this.leavingSeats]) {
      seat.rig.dispose();
    }

    this.leavingSeats.length = 0;
    this.dealer.dispose();
    this.cardFactory.dispose();
    this.chipFactory.dispose();

    for (const item of this.disposables) {
      item.dispose();
    }

    this.seats.clear();
    this.cardEntries.clear();
    this.scene.clear();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }

  /* ------------------------------ Construccion ------------------------------ */

  private buildRoom(): void {
    const T = this.THREE;
    this.scene.add(new T.HemisphereLight(0xffffff, 0xffc4dc, 1.35));
    const key = new T.DirectionalLight(0xffffff, 1.7);
    key.position.set(4, 10, 6);
    const fill = new T.DirectionalLight(0xfff2c4, 0.6);
    fill.position.set(-5, 6, -4);
    this.scene.add(key, fill);

    const floor = new T.Mesh(this.track(new T.CircleGeometry(60, 48)), this.track(new T.MeshStandardMaterial({ color: '#ffc3db', roughness: 0.9 })));
    floor.rotation.x = -Math.PI / 2;
    const rug = new T.Mesh(
      this.track(new T.CircleGeometry(this.seatRadius + 1.5, 64)),
      this.track(new T.MeshStandardMaterial({ color: '#e97aa5', roughness: 0.95 })),
    );
    rug.rotation.x = -Math.PI / 2;
    rug.position.set(0, 0.002, this.tableRadius * 0.3);
    const rugBorder = new T.Mesh(
      this.track(new T.RingGeometry(this.seatRadius + 1.5, this.seatRadius + 1.68, 64)),
      this.track(new T.MeshStandardMaterial({ color: '#ffe891', roughness: 0.8 })),
    );
    rugBorder.rotation.x = -Math.PI / 2;
    rugBorder.position.copy(rug.position);
    rugBorder.position.y = 0.003;
    this.scene.add(floor, rug, rugBorder);
  }

  private buildTable(): void {
    const T = this.THREE;
    const radius = this.tableRadius;
    const wood = this.track(new T.MeshStandardMaterial({ color: '#5a3420', roughness: 0.6 }));
    const leather = this.track(new T.MeshStandardMaterial({ color: '#4a2316', roughness: 0.5 }));

    // Tablero: medio disco extruido; la tapa lleva el tapete pintado y el canto es de madera.
    const shape = new T.Shape();
    shape.moveTo(-radius, 0);
    shape.absarc(0, 0, radius, Math.PI, Math.PI * 2, false);
    shape.closePath();
    const slabGeometry = this.track(new T.ExtrudeGeometry(shape, { depth: 0.1, bevelEnabled: false, curveSegments: 96 }));
    const felt = this.feltTexture();
    // Las tapas usan las coordenadas de la forma como UV: se ajustan para cubrir el lienzo entero.
    felt.repeat.set(1 / (2 * radius), 1 / radius);
    felt.offset.set(0.5, 1);
    const feltMaterial = this.track(new T.MeshStandardMaterial({ map: felt, roughness: 0.92 }));
    const slab = new T.Mesh(slabGeometry, [feltMaterial, wood]);
    slab.rotation.x = -Math.PI / 2;
    slab.position.y = TABLE_TOP - 0.1;
    this.scene.add(slab);

    // Barandilla acolchada por el lado de los jugadores y canto recto del lado del crupier.
    const rail = new T.Mesh(this.track(new T.TorusGeometry(radius, 0.12, 12, 96, Math.PI)), leather);
    rail.rotation.x = Math.PI / 2;
    rail.position.y = TABLE_TOP + 0.03;
    const capGeometry = this.track(new T.SphereGeometry(0.12, 14, 10));
    const capLeft = new T.Mesh(capGeometry, leather);
    capLeft.position.set(-radius, TABLE_TOP + 0.03, 0);
    const capRight = new T.Mesh(capGeometry, leather);
    capRight.position.set(radius, TABLE_TOP + 0.03, 0);
    const edge = new T.Mesh(this.track(new T.BoxGeometry(radius * 2, 0.1, 0.16)), wood);
    edge.position.set(0, TABLE_TOP - 0.045, -0.06);
    const pedestal = new T.Mesh(this.track(new T.CylinderGeometry(0.42, 0.62, TABLE_TOP - 0.1, 24)), wood);
    pedestal.position.set(0, (TABLE_TOP - 0.1) / 2, radius * 0.35);
    this.scene.add(rail, capLeft, capRight, edge, pedestal);

    // Zapato de cartas, descarte y bandeja de fichas del crupier.
    const shoe = new T.Mesh(this.track(new T.BoxGeometry(0.34, 0.22, 0.5)), this.track(new T.MeshStandardMaterial({ color: '#8a2433', roughness: 0.5 })));
    shoe.position.set(1.04, TABLE_TOP + 0.11, 0.32);
    shoe.rotation.y = -0.35;
    const discardTray = new T.Mesh(this.track(new T.BoxGeometry(0.4, 0.1, 0.52)), this.track(new T.MeshStandardMaterial({ color: '#2b2b33', roughness: 0.6 })));
    discardTray.position.set(-1.05, TABLE_TOP + 0.05, 0.32);
    discardTray.rotation.y = 0.35;
    const chipTray = new T.Mesh(this.track(new T.BoxGeometry(1.36, 0.06, 0.36)), wood);
    chipTray.position.set(0, TABLE_TOP + 0.03, 0.2);
    this.scene.add(shoe, discardTray, chipTray);

    const roll = this.track(new T.CylinderGeometry(0.1, 0.1, 0.3, 24));
    ['#232323', '#8a4fd8', '#ff8fb8', '#f2f2f2', '#ffb347'].forEach((color, index) => {
      const mesh = new T.Mesh(roll, this.chipFactory.materialsFor(color));
      mesh.rotation.x = Math.PI / 2;
      mesh.position.set((index - 2) * 0.25, TABLE_TOP + 0.13, 0.2);
      this.scene.add(mesh);
    });
  }

  /** Tapete verde con los textos de la mesa en arco (legibles desde el lado de los jugadores). */
  private feltTexture(): ThreeModule.CanvasTexture {
    const T = this.THREE;
    const canvas = document.createElement('canvas');
    canvas.width = 2048;
    canvas.height = 1024;
    const context = canvas.getContext('2d')!;
    const centerX = 1024;
    const gradient = context.createRadialGradient(centerX, 0, 80, centerX, 0, 1024);
    gradient.addColorStop(0, '#2fae63');
    gradient.addColorStop(1, '#167a40');
    context.fillStyle = gradient;
    context.fillRect(0, 0, 2048, 1024);

    const scale = 1024 / this.tableRadius;
    context.strokeStyle = 'rgba(255, 232, 145, 0.75)';
    context.lineWidth = 6;

    for (const radius of [this.cardRadius * 0.52, this.cardRadius * 0.86]) {
      context.beginPath();
      context.arc(centerX, 0, radius * scale, 0.12 * Math.PI, 0.88 * Math.PI);
      context.stroke();
    }

    context.fillStyle = '#ffe891';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    this.arcText(context, 'BLACKJACK PAGA 3 A 2', centerX, this.cardRadius * 0.74 * scale, 0.17 * scale, 0.025 * scale);
    context.fillStyle = 'rgba(255, 247, 236, 0.9)';
    this.arcText(context, 'EL CRUPIER SE PLANTA CON 17 O SI YA OS GANA A TODOS', centerX, this.cardRadius * 0.62 * scale, 0.09 * scale, 0.01 * scale);

    const texture = new T.CanvasTexture(canvas);
    texture.colorSpace = T.SRGBColorSpace;
    texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    this.track(texture);
    return texture;
  }

  private arcText(context: CanvasRenderingContext2D, text: string, centerX: number, radius: number, size: number, spacing: number): void {
    context.font = `900 ${Math.round(size)}px ${FONT}`;
    const widths = [...text].map((character) => context.measureText(character).width + spacing);
    const total = widths.reduce((sum, width) => sum + width, 0) - spacing;
    let angle = -total / radius / 2;

    [...text].forEach((character, index) => {
      const phi = angle + (widths[index] - spacing) / 2 / radius;
      context.save();
      context.translate(centerX + radius * Math.sin(phi), radius * Math.cos(phi));
      context.rotate(-phi);
      context.fillText(character, 0, 0);
      context.restore();
      angle += widths[index] / radius;
    });
  }

  /** Separacion angular entre asientos: hasta 40 grados, repartidos en un arco de 150 como mucho. */
  private seatStep(count: number): number {
    return count > 1 ? Math.min((150 * Math.PI) / 180 / (count - 1), (40 * Math.PI) / 180) : 0;
  }

  /**
   * Sienta al grupo que toca. Si cambia el grupo (mesas de 4), los que estaban se levantan y desaparecen, y
   * los nuevos se sientan cayendo en su sitio; las cartas que ya tenian aparecen directamente sobre la mesa.
   */
  private syncSeats(views: BlackjackSeatView[], now: number): void {
    const key = views.map((view) => view.playerId).join(',');

    if (key === this.seatKey) {
      return;
    }

    const swapping = this.seatKey !== '';
    this.seatKey = key;
    const wanted = new Set(views.map((view) => view.playerId));

    for (const [playerId, seat] of this.seats) {
      if (!wanted.has(playerId)) {
        seat.leavingAt = now;
        seat.table.visible = false;
        this.leavingSeats.push(seat);
        this.seats.delete(playerId);
      }
    }

    const step = this.seatStep(views.length);
    const time = now / 1000;
    views.forEach((view, index) => {
      if (this.seats.has(view.playerId)) {
        return;
      }

      const angle = ((views.length - 1) / 2 - index) * step;
      this.createSeat(view, index, angle, time + (swapping ? 0.45 : 0.2) + index * 0.12, now);
      this.justSeated.add(view.playerId);
    });
  }

  /** Animacion de entrada y salida de los asientos al cambiar de grupo. */
  private updateSeatTransitions(now: number, time: number, delta: number): void {
    for (const seat of this.seats.values()) {
      const appear = clamp01((now - seat.createdAt) / 380);
      seat.root.scale.setScalar(Math.max(0.001, easeOutCubic(appear)));
    }

    for (let index = this.leavingSeats.length - 1; index >= 0; index -= 1) {
      const seat = this.leavingSeats[index];
      const progress = clamp01((now - (seat.leavingAt || now)) / 450);
      seat.rig.update(time, delta, 'game');
      seat.root.scale.setScalar(Math.max(0.001, 1 - easeOutCubic(progress)));
      seat.root.position.y = progress * 0.4;

      if (progress >= 1) {
        this.scene.remove(seat.root, seat.table);
        seat.rig.dispose();
        this.leavingSeats.splice(index, 1);
      }
    }
  }

  private createSeat(view: BlackjackSeatView, index: number, angle: number, enterAt: number, now: number): void {
    const T = this.THREE;
    const radial = new T.Vector3(Math.sin(angle), 0, Math.cos(angle));
    // "Derecha" vista desde el centro de la mesa mirando hacia el jugador.
    const right = new T.Vector3(-Math.cos(angle), 0, Math.sin(angle));
    const position = radial.clone().multiplyScalar(this.seatRadius);
    const group = new T.Group();
    group.position.copy(position);
    group.rotation.y = angle + Math.PI;
    group.scale.setScalar(0.001);

    // Taburete con el cojin del color del jugador.
    const cushion = new T.Mesh(this.track(new T.CylinderGeometry(0.27, 0.25, 0.09, 24)), this.track(new T.MeshStandardMaterial({ color: view.shirt, roughness: 0.5 })));
    cushion.position.y = 0.455;
    const metal = this.track(new T.MeshStandardMaterial({ color: '#c9c9d6', roughness: 0.35, metalness: 0.2 }));
    const pole = new T.Mesh(this.track(new T.CylinderGeometry(0.045, 0.045, 0.41, 12)), metal);
    pole.position.y = 0.205;
    const base = new T.Mesh(this.track(new T.CylinderGeometry(0.24, 0.26, 0.03, 24)), metal);
    base.position.y = 0.015;
    const spot = new T.Mesh(this.track(new T.RingGeometry(0.5, 0.66, 48)), this.spotMaterial);
    spot.rotation.x = -Math.PI / 2;
    spot.position.y = 0.012;
    spot.visible = false;
    group.add(cushion, pole, base, spot);

    if (view.isLocal) {
      const mine = new T.Mesh(this.track(new T.CircleGeometry(0.62, 48)), this.track(new T.MeshBasicMaterial({ color: '#a8e8ff', transparent: true, opacity: 0.9 })));
      mine.rotation.x = -Math.PI / 2;
      mine.position.y = 0.008;
      group.add(mine);
    }

    const rig = new MiiRig(T, view.shirt);
    rig.pose = 'sit';
    rig.mood = view.mood;
    rig.enter(enterAt);
    group.add(rig.root);
    this.scene.add(group);

    const betSpot = radial.clone().multiplyScalar(this.cardRadius + 0.68).setY(TABLE_TOP);
    const stackSpot = radial.clone().multiplyScalar(this.cardRadius + 0.98).addScaledVector(right, 0.42).setY(TABLE_TOP);
    const ring = new T.Mesh(this.track(new T.RingGeometry(0.24, 0.285, 48)), this.ringMaterial);
    ring.rotation.x = -Math.PI / 2;
    ring.position.copy(betSpot).setY(TABLE_TOP + 0.003);
    const stack = new T.Group();
    stack.position.copy(stackSpot);
    const bet = new T.Group();
    bet.position.copy(betSpot);
    const payout = new T.Group();
    payout.visible = false;
    const table = new T.Group();
    table.add(ring, stack, bet, payout);
    this.scene.add(table);

    this.seats.set(view.playerId, {
      view,
      index,
      root: group,
      table,
      createdAt: now,
      leavingAt: null,
      radial,
      right,
      yaw: angle + Math.PI,
      position,
      betSpot,
      stackSpot,
      rig,
      avatarUrl: '',
      stack,
      stackKey: '',
      bet,
      betKey: '',
      betFlight: null,
      payout,
      payoutFlight: null,
      resultKey: '',
      ring,
      spot,
    });
  }

  private loadFace(seat: SeatEntry): void {
    if (seat.avatarUrl === seat.view.avatarUrl) {
      return;
    }

    seat.avatarUrl = seat.view.avatarUrl;
    void createFaceTexture(this.THREE, seat.view.avatarUrl, seat.view.name, this.proxyBase).then((texture) => {
      if (this.disposed) {
        texture.dispose();
        return;
      }

      seat.rig.setFaceTexture(texture);
    });
  }

  /* --------------------------------- Fichas --------------------------------- */

  private syncChips(seat: SeatEntry, hand: number, now: number): void {
    const view = seat.view;

    // Saldo: entre 1 y 36 fichas (una cada 20) en columnas de hasta 12, del color de su nivel.
    const tier = chipTier(view.chips, view.startChips);
    const count = view.chips > 0 ? Math.min(36, Math.max(1, Math.ceil(view.chips / 20))) : 0;
    const stackKey = `${tier.color}:${count}`;

    if (stackKey !== seat.stackKey) {
      seat.stackKey = stackKey;
      seat.stack.clear();

      for (let column = 0; column * 12 < count; column += 1) {
        const offset = seat.right.clone().multiplyScalar(column * 0.22).addScaledVector(seat.radial, column % 2 ? -0.12 : 0);
        this.chipFactory.addColumn(seat.stack, Array(Math.min(12, count - column * 12)).fill(tier.color), offset.x, offset.z);
      }
    }

    // Apuesta: fichas por valor en el circulo de apuesta.
    const betKey = `${hand}:${view.bet}`;

    if (betKey !== seat.betKey) {
      seat.betKey = betKey;
      seat.bet.clear();
      this.addChipColumns(seat.bet, betChipColors(view.bet), seat.right);
      seat.bet.position.copy(seat.betSpot);
      seat.bet.scale.setScalar(1);
      seat.bet.visible = view.bet > 0;
      seat.betFlight = null;
    }

    // Resultado de la mano: la apuesta perdida se la lleva el crupier; la ganada recibe su pago.
    const resultKey = view.result && view.bet > 0 ? `${hand}:${view.result}` : '';

    if (resultKey === seat.resultKey) {
      return;
    }

    seat.resultKey = resultKey;
    seat.payout.clear();
    seat.payout.visible = false;
    seat.payoutFlight = null;

    if (view.result === 'lose') {
      seat.betFlight = { from: seat.betSpot.clone(), to: this.tray.clone(), start: now + 350, duration: 700, shrink: true };
    } else if ((view.result === 'win' || view.result === 'blackjack') && view.payout > 0) {
      this.addChipColumns(seat.payout, betChipColors(view.payout), seat.right);
      seat.payout.visible = true;
      seat.payout.position.copy(this.tray);
      const target = seat.betSpot.clone().addScaledVector(seat.right, -0.26);
      seat.payoutFlight = { from: this.tray.clone(), to: target, start: now + 350, duration: 750, shrink: false };
    }
  }

  private addChipColumns(group: ThreeModule.Group, colors: string[], right: Vector3): void {
    for (let column = 0; column * 12 < colors.length; column += 1) {
      const offset = right.clone().multiplyScalar(column * 0.21);
      this.chipFactory.addColumn(group, colors.slice(column * 12, column * 12 + 12), offset.x, offset.z);
    }
  }

  private updateFlight(group: ThreeModule.Group, flight: ChipFlight | null, now: number): ChipFlight | null {
    if (!flight) {
      return null;
    }

    const progress = clamp01((now - flight.start) / flight.duration);
    const eased = easeInOutCubic(progress);
    group.position.lerpVectors(flight.from, flight.to, eased);
    group.position.y += Math.sin(Math.PI * progress) * 0.4;

    if (flight.shrink) {
      group.scale.setScalar(Math.max(0.001, 1 - eased * 0.9));
    }

    if (progress >= 1) {
      group.visible = !flight.shrink;
      return null;
    }

    return flight;
  }

  /* --------------------------------- Cartas --------------------------------- */

  private syncCards(state: BlackjackSceneState, now: number): void {
    const wanted = new Map<string, { owner: string; index: number; count: number; card: BlackjackCard }>();

    for (const seat of state.seats) {
      seat.cards.forEach((card, index) => wanted.set(`${state.handNumber}:${seat.playerId}:${index}`, { owner: seat.playerId, index, count: seat.cards.length, card }));
    }

    state.dealerCards.forEach((card, index) => wanted.set(`${state.handNumber}:dealer:${index}`, { owner: 'dealer', index, count: state.dealerCards.length, card }));

    // Cartas de la mano anterior: se recogen hacia el descarte.
    for (const [key, entry] of this.cardEntries) {
      if (!wanted.has(key) && entry.removeAt === null) {
        entry.removeAt = now;
        entry.removeFrom = entry.mesh.group.position.clone();
      }
    }

    for (const [key, item] of wanted) {
      let entry = this.cardEntries.get(key);

      if (!entry) {
        // Cada carta tiene una clave unica (mano:dueno:posicion): repetir un estado nunca reparte dos veces.
        const mesh = this.cardFactory.createCard();
        mesh.group.visible = false;
        this.scene.add(mesh.group);
        // Un jugador que se acaba de sentar (vuelve su grupo a la mesa) ya tenia sus cartas: no se reparten de nuevo.
        const alreadyDealt = this.justSeated.has(item.owner) ? -Infinity : null;
        entry = {
          mesh,
          owner: item.owner,
          index: item.index,
          count: item.count,
          faceKey: '',
          dealAt: alreadyDealt ?? this.dealTime(state, item.owner, item.index) ?? now,
          landed: false,
          notified: false,
          flipStart: null,
          removeAt: null,
          removeFrom: null,
          target: new this.THREE.Vector3(),
          yaw: 0,
        };
        this.cardEntries.set(key, entry);
      }

      entry.count = item.count;
      const faceKey = !item.card.hidden && item.card.rank && item.card.suit ? `${item.card.rank}${item.card.suit}` : '';

      if (faceKey && faceKey !== entry.faceKey) {
        entry.mesh.face.material = this.cardFactory.faceMaterial(item.card.rank!, item.card.suit!);

        // La carta oculta ya estaba en la mesa boca abajo: se voltea con animacion.
        if (entry.landed && !entry.faceKey) {
          entry.flipStart = now;
          this.onCardFlipped?.();
        }
      }

      entry.faceKey = faceKey;
    }
  }

  /** Momento del reparto inicial de una carta: el orden lo marca el servidor (dealOrder). */
  private dealTime(state: BlackjackSceneState, owner: string, index: number): number | null {
    if (state.dealStartsAt === null) {
      return null;
    }

    const order = state.dealOrder.findIndex((entry) => entry.to === owner && entry.index === index);
    return order < 0 ? null : state.dealStartsAt + order * state.dealInterval;
  }

  private cardTarget(entry: CardEntry): void {
    const offset = (entry.index - (entry.count - 1) / 2) * CARD_SPREAD;
    const lift = TABLE_TOP + 0.004 + entry.index * 0.0025;

    if (entry.owner === 'dealer') {
      entry.target.set(offset * 1.1, lift, DEALER_CARDS_Z);
      entry.yaw = 0;
      return;
    }

    const seat = this.seats.get(entry.owner);

    if (!seat) {
      return;
    }

    entry.target.copy(seat.radial).multiplyScalar(this.cardRadius).addScaledVector(seat.right, offset).setY(lift);
    entry.yaw = seat.yaw;
  }

  private updateCards(now: number, delta: number): void {
    for (const [key, entry] of this.cardEntries) {
      const group = entry.mesh.group;
      const flipper = entry.mesh.flipper;

      if (entry.removeAt !== null && entry.removeFrom) {
        const progress = clamp01((now - entry.removeAt) / REMOVE_MS);
        group.visible = entry.landed;
        group.position.lerpVectors(entry.removeFrom, this.discard, easeInOutCubic(progress));
        group.position.y += Math.sin(Math.PI * progress) * 0.3;

        if (progress >= 1) {
          this.scene.remove(group);
          this.cardEntries.delete(key);
        }
        continue;
      }

      this.cardTarget(entry);

      if (now < entry.dealAt) {
        group.visible = false;
        continue;
      }

      group.visible = true;
      const progress = clamp01((now - entry.dealAt) / DEAL_FLIGHT_MS);

      if (!entry.notified) {
        entry.notified = true;

        if (progress < 1) {
          this.onCardDealt?.();
        }
      }

      if (progress < 1) {
        // Vuela desde el zapato con un pequeno arco y se gira boca arriba durante el vuelo.
        const eased = easeOutCubic(progress);
        group.position.lerpVectors(this.shoeMouth, entry.target, eased);
        group.position.y += Math.sin(Math.PI * progress) * 0.35;
        group.rotation.y = entry.yaw;
        flipper.rotation.z = entry.faceKey ? Math.PI * (1 - eased) : Math.PI;
        continue;
      }

      if (!entry.landed) {
        entry.landed = true;
        group.position.copy(entry.target);
      }

      // Al llegar cartas nuevas la mano se recoloca con suavidad.
      group.position.lerp(entry.target, Math.min(1, delta * 10));
      group.rotation.y = entry.yaw;

      if (entry.flipStart !== null) {
        const flip = clamp01((now - entry.flipStart) / FLIP_MS);
        flipper.rotation.z = Math.PI * (1 - easeInOutCubic(flip));
        flipper.position.y = Math.sin(Math.PI * flip) * 0.3;

        if (flip >= 1) {
          entry.flipStart = null;
          flipper.position.y = 0;
        }
      } else {
        flipper.rotation.z = entry.faceKey ? 0 : Math.PI;
      }
    }
  }

  /** true cuando todas las cartas de una mano han llegado a la mesa (y ninguna se esta volteando). */
  private handSettled(owner: string, now: number): boolean {
    let any = false;

    for (const entry of this.cardEntries.values()) {
      if (entry.owner !== owner || entry.removeAt !== null) {
        continue;
      }

      any = true;

      if (now < entry.dealAt + DEAL_FLIGHT_MS || entry.flipStart !== null) {
        return false;
      }
    }

    return any;
  }

  /* --------------------------------- Camara --------------------------------- */

  private goalFor(focus: BlackjackFocus): CameraGoal {
    const T = this.THREE;
    const point = (x: number, y: number, z: number) => new T.Vector3(x, y, z);
    const fromAngle = (degrees: number, side: Vector3) => {
      const radians = (degrees * Math.PI) / 180;
      return side.clone().multiplyScalar(Math.cos(radians)).setY(Math.sin(radians)).normalize();
    };
    const seat = focus.kind === 'seat' || focus.kind === 'cards' ? this.seats.get(focus.playerId) : undefined;

    if (seat && focus.kind === 'cards') {
      // Turno de un jugador: la camara termina centrada exactamente en sus cartas (y su suma), vistas desde
      // el centro de la mesa; el encuadre se recalcula al llegar cada carta nueva.
      const count = Math.max(2, seat.view.cards.length);
      const center = seat.radial.clone().multiplyScalar(this.cardRadius).setY(TABLE_TOP);
      const half = ((count - 1) / 2) * CARD_SPREAD + CARD_WIDTH / 2 + 0.45;
      const depth = CARD_HEIGHT / 2 + 0.3;
      const fit = [-1, 1].flatMap((side) =>
        [-1, 1].map((row) => center.clone().addScaledVector(seat.right, side * half).addScaledVector(seat.radial, row * depth)),
      );
      fit.push(this.labelPoint('sum', seat.view.playerId));
      return { target: center, direction: fromAngle(52, seat.radial.clone().negate()), fit, margin: 0.86 };
    }

    if (seat && focus.kind === 'seat') {
      // Apuestas: el jugador local con sus fichas y su circulo de apuesta.
      const fit = [
        seat.position.clone().setY(2.6),
        seat.position.clone().setY(0.3),
        seat.betSpot.clone().addScaledVector(seat.radial, -0.35),
        seat.stackSpot.clone().setY(TABLE_TOP + 0.45),
        seat.betSpot.clone().addScaledVector(seat.right, -0.5),
        seat.stackSpot.clone().addScaledVector(seat.right, 0.3),
      ];
      // Lo bastante alta para pasar por encima de la cabeza del crupier.
      return {
        target: seat.radial.clone().multiplyScalar(this.cardRadius + 1).setY(TABLE_TOP + 0.5),
        direction: fromAngle(40, seat.radial.clone().negate()),
        fit,
        margin: 0.9,
      };
    }

    if (focus.kind === 'dealer') {
      const count = Math.max(2, this.state.dealerCards.length);
      const half = ((count - 1) / 2) * CARD_SPREAD * 1.1 + CARD_WIDTH / 2;
      const fit = [
        point(-half, TABLE_TOP, DEALER_CARDS_Z - CARD_HEIGHT / 2),
        point(half, TABLE_TOP, DEALER_CARDS_Z + CARD_HEIGHT / 2),
        point(-half, TABLE_TOP, DEALER_CARDS_Z + CARD_HEIGHT / 2),
        point(half, TABLE_TOP, DEALER_CARDS_Z - CARD_HEIGHT / 2),
        this.labelPoint('sum', 'dealer'),
        point(0, 2.45, DEALER_Z),
      ];
      return { target: point(0, TABLE_TOP + 0.5, DEALER_CARDS_Z - 0.3), direction: fromAngle(26, point(0, 0, 1)), fit, margin: 0.9 };
    }

    // Vista general desde detras del crupier: toda la mesa y las caras de todos los asientos. Se encuadran los
    // asientos de la mesa completa (no solo los ocupados) para que la vista no cambie entre grupos.
    const fit: Vector3[] = [point(0, 2.3, DEALER_Z)];
    const layout = Math.max(1, this.state.layoutSeats);
    const step = this.seatStep(layout);

    for (let index = 0; index < layout; index += 1) {
      const angle = ((layout - 1) / 2 - index) * step;
      const seat = point(Math.sin(angle) * this.seatRadius, 0, Math.cos(angle) * this.seatRadius);
      fit.push(seat.clone().setY(2.75), seat.clone().setY(0.2));
    }

    for (let degrees = -90; degrees <= 90; degrees += 30) {
      const radians = (degrees * Math.PI) / 180;
      fit.push(point(Math.sin(radians) * this.tableRadius, TABLE_TOP, Math.cos(radians) * this.tableRadius));
    }

    if (focus.kind === 'swap') {
      // Cambio de grupo: plano alto y abierto mientras un grupo se levanta y el siguiente se sienta.
      return { target: point(0, TABLE_TOP, this.tableRadius * 0.3), direction: fromAngle(72, point(0, 0, -1)), fit, margin: 0.66 };
    }

    return { target: point(0, TABLE_TOP, this.tableRadius * 0.42), direction: fromAngle(55, point(0, 0, -1)), fit, margin: 0.92 };
  }

  /* -------------------------------- Etiquetas ------------------------------- */

  private labelPoint(kind: string, owner: string): Vector3 {
    const T = this.THREE;

    if (owner === 'dealer') {
      return kind === 'name' ? new T.Vector3(0, 2.55, DEALER_Z) : new T.Vector3(0, TABLE_TOP, DEALER_CARDS_Z + CARD_HEIGHT / 2 + 0.08);
    }

    const seat = this.seats.get(owner);

    if (!seat) {
      return new T.Vector3(0, -100, 0);
    }

    switch (kind) {
      case 'name':
        return seat.position.clone().setY(2.5);
      case 'bet':
        return seat.betSpot.clone().addScaledVector(seat.right, -0.4);
      default:
        return seat.radial.clone().multiplyScalar(this.cardRadius - CARD_HEIGHT / 2 - 0.08).setY(TABLE_TOP);
    }
  }

  /** Coloca las etiquetas HTML (nombre, suma y apuesta) sobre su punto 3D proyectado. */
  private placeLabels(now: number): void {
    const width = this.host.clientWidth;
    const height = this.host.clientHeight;

    for (const label of Array.from(this.labelLayer.querySelectorAll<HTMLElement>('[data-bj-label]'))) {
      const [kind, owner] = (label.dataset['bjLabel'] || '').split(':');
      const vector = this.scratch.copy(this.labelPoint(kind, owner)).project(this.camera);
      // La suma no aparece hasta que las cartas han llegado, para no adelantar el resultado.
      const visible = vector.z < 1 && Math.abs(vector.x) < 1.05 && Math.abs(vector.y) < 1.05 && (kind !== 'sum' || this.handSettled(owner, now));
      label.style.opacity = visible ? '1' : '0';
      label.style.transform = `translate(${((vector.x + 1) / 2) * width}px, ${((1 - vector.y) / 2) * height}px) translate(-50%, ${kind === 'name' ? '-100%' : '0'})`;
    }
  }

  /* ---------------------------------- Bucle --------------------------------- */

  private loop(): void {
    this.frameHandle = requestAnimationFrame(() => this.loop());
    const now = performance.now();
    const delta = Math.min(0.05, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    const time = now / 1000;
    const pulse = 0.55 + Math.sin(time * 5) * 0.35;
    this.spotMaterial.opacity = pulse;
    this.activeRingMaterial.opacity = 0.6 + pulse * 0.4;

    for (const seat of this.seats.values()) {
      seat.rig.update(time, delta, 'game');
      seat.spot.visible = seat.view.isActive;
      seat.betFlight = this.updateFlight(seat.bet, seat.betFlight, now);
      seat.payoutFlight = this.updateFlight(seat.payout, seat.payoutFlight, now);
    }

    this.updateSeatTransitions(now, time, delta);
    this.dealer.update(time, delta, 'game');
    this.updateCards(now, delta);
    this.director.update(now, delta);
    this.renderer.render(this.scene, this.camera);
    this.placeLabels(now);
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
