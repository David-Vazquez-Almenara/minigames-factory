import type * as ThreeModule from 'three';

type Three = typeof ThreeModule;

export type MiiMood =
  | 'idle'
  | 'happy'
  | 'sad'
  | 'neutral'
  | 'dance-big'
  | 'dance-small'
  | 'clap'
  // Minijuegos: sentado a la mesa, crupier, mirando al barril y mareado en el suelo.
  | 'seated'
  | 'seated-active'
  | 'seated-happy'
  | 'seated-sad'
  | 'dealer'
  | 'look-up'
  | 'relief'
  | 'dizzy'
  // Cuidado que explota: caminar por el escenario y empujar la palanca.
  | 'walk'
  | 'lever'
  // Cubiletes: el crupier mueve los brazos arriba y abajo mientras mezcla.
  | 'shuffle';
export type MiiPose = 'stand' | 'sit' | 'ground-sit';
export type MiiUpdateMode = 'lobby' | 'scoreboard' | 'podium' | 'game';

export interface MiiRigOptions {
  pantsColor?: string;
  /** Pajarita roja (crupier). */
  bowTie?: boolean;
}
type MiiAction = 'wave' | 'jump' | 'spin' | 'look' | 'stretch' | 'dance' | 'clap';

const LOBBY_ACTIONS: Array<{ type: MiiAction; duration: number }> = [
  { type: 'wave', duration: 2.2 },
  { type: 'jump', duration: 0.9 },
  { type: 'spin', duration: 1.2 },
  { type: 'look', duration: 2 },
  { type: 'stretch', duration: 1.8 },
  { type: 'dance', duration: 2.4 },
  { type: 'clap', duration: 1.6 },
];

const SKIN = 0xf3cfa8;
const PANTS = 0x3b4150;
const SHOES = 0x2c313c;
const BASE_ARM_SPREAD = 0.16;
const HIP_HEIGHT = 0.62;

const easeInOut = (value: number) => (value < 0.5 ? 2 * value * value : 1 - Math.pow(-2 * value + 2, 2) / 2);
const bell = (value: number) => Math.sin(Math.PI * Math.min(1, Math.max(0, value)));

/**
 * Personaje 3D de proporciones "Mii": cabeza grande, cuerpo redondeado y extremidades de capsula.
 * La foto del jugador se proyecta como textura sobre la parte frontal de la cabeza.
 */
export class MiiRig {
  readonly root: ThreeModule.Group;
  private readonly body: ThreeModule.Group;
  private readonly head: ThreeModule.Group;
  private readonly armLeft: ThreeModule.Group;
  private readonly armRight: ThreeModule.Group;
  private readonly legLeft: ThreeModule.Group;
  private readonly legRight: ThreeModule.Group;
  private readonly faceMaterial: ThreeModule.MeshStandardMaterial;
  private readonly shirtMaterial: ThreeModule.MeshStandardMaterial;
  private readonly disposables: Array<{ dispose: () => void }> = [];
  private readonly phase = Math.random() * Math.PI * 2;
  private action: { type: MiiAction; start: number; duration: number } | null = null;
  private nextActionAt = 0;
  private enteredAt = -1;
  private leavingAt = -1;
  private faceTexture: ThreeModule.Texture | null = null;
  private sadVariant: 'sigh' | 'slump' = 'sigh';
  private lastMood: MiiMood = 'idle';

  private dizzyStars: ThreeModule.Group | null = null;

  mood: MiiMood = 'idle';
  pose: MiiPose = 'stand';
  /** 0..1: cuanto esta empujando la palanca hacia abajo (mood 'lever'). */
  leverPull = 0;
  /** Altura sobre el suelo (p. ej. subido a un escalon del podio). */
  baseY = 0;
  targetX = 0;
  removed = false;

  constructor(
    private readonly THREE: Three,
    shirtColor: string,
    options: MiiRigOptions = {},
  ) {
    const T = THREE;
    const material = (color: number | string, roughness = 0.42) => this.track(new T.MeshStandardMaterial({ color, roughness, metalness: 0 }));
    const skin = material(SKIN, 0.55);
    const pants = material(options.pantsColor || PANTS, 0.5);
    const shoes = material(SHOES, 0.5);
    this.shirtMaterial = material(shirtColor, 0.38);
    // Hasta que llega la foto, la cara es del color de la piel.
    this.faceMaterial = this.track(new T.MeshStandardMaterial({ color: SKIN, roughness: 0.6 }));

    this.root = new T.Group();

    // Sombra suave en el suelo.
    const shadow = new T.Mesh(
      this.track(new T.CircleGeometry(0.42, 32)),
      this.track(new T.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.16, depthWrite: false })),
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.005;
    shadow.scale.set(1.1, 0.75, 1);
    this.root.add(shadow);

    // Piernas (pivote en la cadera).
    const legGeometry = this.track(new T.CapsuleGeometry(0.095, 0.4, 6, 14));
    const shoeGeometry = this.track(new T.SphereGeometry(0.12, 18, 12));
    const makeLeg = (x: number) => {
      const pivot = new T.Group();
      pivot.position.set(x, HIP_HEIGHT - 0.04, 0);
      const leg = new T.Mesh(legGeometry, pants);
      leg.position.y = -0.27;
      const shoe = new T.Mesh(shoeGeometry, shoes);
      shoe.scale.set(0.95, 0.6, 1.35);
      shoe.position.set(0, -0.52, 0.04);
      pivot.add(leg, shoe);
      this.root.add(pivot);
      return pivot;
    };
    this.legLeft = makeLeg(-0.12);
    this.legRight = makeLeg(0.12);

    // Torso con perfil redondeado: ancho abajo y hombros caidos, como un Mii.
    this.body = new T.Group();
    this.body.position.y = HIP_HEIGHT;
    this.root.add(this.body);

    const torsoProfile = [
      [0.0, -0.02],
      [0.27, 0.0],
      [0.31, 0.1],
      [0.3, 0.3],
      [0.25, 0.5],
      [0.16, 0.6],
      [0.0, 0.62],
    ].map(([radius, y]) => new T.Vector2(radius, y));
    const torso = new T.Mesh(this.track(new T.LatheGeometry(torsoProfile, 32)), this.shirtMaterial);
    torso.scale.z = 0.82;
    const hips = new T.Mesh(this.track(new T.SphereGeometry(0.29, 24, 14)), pants);
    hips.scale.set(1, 0.42, 0.8);
    hips.position.y = 0.02;
    const neck = new T.Mesh(this.track(new T.CylinderGeometry(0.075, 0.085, 0.12, 14)), skin);
    neck.position.y = 0.64;
    this.body.add(torso, hips, neck);

    if (options.bowTie) {
      const bowMaterial = material(0xc0182a, 0.4);
      const knot = new T.Mesh(this.track(new T.SphereGeometry(0.035, 10, 8)), bowMaterial);
      const wing = this.track(new T.ConeGeometry(0.06, 0.1, 10));
      const left = new T.Mesh(wing, bowMaterial);
      left.rotation.z = Math.PI / 2;
      left.position.x = -0.06;
      const right = new T.Mesh(wing, bowMaterial);
      right.rotation.z = -Math.PI / 2;
      right.position.x = 0.06;
      const bow = new T.Group();
      bow.add(knot, left, right);
      bow.position.set(0, 0.59, 0.17);
      this.body.add(bow);
    }

    // Brazos (pivote en el hombro); las manos van del color de la camiseta, como los Mii.
    const armGeometry = this.track(new T.CapsuleGeometry(0.07, 0.36, 6, 12));
    const handGeometry = this.track(new T.SphereGeometry(0.095, 16, 12));
    const makeArm = (side: -1 | 1) => {
      const pivot = new T.Group();
      pivot.position.set(side * 0.26, 0.52, 0);
      const arm = new T.Mesh(armGeometry, this.shirtMaterial);
      arm.position.y = -0.22;
      const hand = new T.Mesh(handGeometry, this.shirtMaterial);
      hand.position.y = -0.47;
      pivot.add(arm, hand);
      this.body.add(pivot);
      return pivot;
    };
    this.armLeft = makeArm(-1);
    this.armRight = makeArm(1);

    // Cabeza grande con la foto en la cara.
    this.head = new T.Group();
    this.head.position.y = 0.7;
    this.body.add(this.head);

    const headShape = new T.Group();
    headShape.position.y = 0.42;
    headShape.scale.set(1, 1.1, 0.94);
    this.head.add(headShape);

    const skull = new T.Mesh(this.track(new T.SphereGeometry(0.44, 40, 28)), skin);
    // Casquete frontal que recibe la textura: la foto cubre la cara y se funde con la piel en los bordes.
    const face = new T.Mesh(
      this.track(new T.SphereGeometry(0.4425, 40, 28, Math.PI / 2 - 1.05, 2.1, 0.2 * Math.PI, 0.62 * Math.PI)),
      this.faceMaterial,
    );
    const earGeometry = this.track(new T.SphereGeometry(0.08, 14, 10));
    const earLeft = new T.Mesh(earGeometry, skin);
    earLeft.position.set(-0.43, -0.02, 0);
    earLeft.scale.set(0.55, 1, 0.8);
    const earRight = earLeft.clone();
    earRight.position.x = 0.43;
    headShape.add(skull, face, earLeft, earRight);
  }

  setFaceTexture(texture: ThreeModule.Texture): void {
    this.faceTexture?.dispose();
    this.faceTexture = texture;
    this.faceMaterial.map = texture;
    this.faceMaterial.color.set(0xffffff);
    this.faceMaterial.needsUpdate = true;
  }

  setShirtColor(color: string): void {
    this.shirtMaterial.color.set(color);
  }

  enter(time: number): void {
    this.enteredAt = time;
    this.nextActionAt = time + 2 + Math.random() * 3;
  }

  leave(time: number): void {
    this.leavingAt = time;
    this.removed = true;
  }

  /** true cuando la animacion de salida ha terminado y se puede retirar de la escena. */
  isGone(time: number): boolean {
    return this.leavingAt >= 0 && time - this.leavingAt > 0.45;
  }

  update(time: number, delta: number, mode: MiiUpdateMode): void {
    const root = this.root;
    root.position.x += (this.targetX - root.position.x) * Math.min(1, delta * 6);
    root.position.y = this.baseY;
    root.rotation.set(0, -root.position.x * 0.06, 0);

    this.body.position.y = HIP_HEIGHT;
    this.body.rotation.set(0, 0, 0);
    this.head.rotation.set(0, 0, 0);
    this.armLeft.rotation.set(0, 0, BASE_ARM_SPREAD * -1);
    this.armRight.rotation.set(0, 0, BASE_ARM_SPREAD);
    this.legLeft.rotation.set(0, 0, 0);
    this.legRight.rotation.set(0, 0, 0);

    this.applyIdle(time);

    if (mode === 'lobby' || (mode !== 'game' && this.mood === 'idle')) {
      this.applyLobbyActions(time);
    } else if (this.mood !== 'idle') {
      this.applyMood(time);
    }

    this.applyPose();
    this.updateDizzyStars(time);
    this.applyEnterAndLeave(time);
  }

  /** Posturas que cambian la base del cuerpo: sentado en un taburete o sentado en el suelo. */
  private applyPose(): void {
    const hip = this.pose === 'ground-sit' ? 0.2 : HIP_HEIGHT;
    this.body.position.y += hip - HIP_HEIGHT;
    this.legLeft.position.y = hip - 0.04;
    this.legRight.position.y = hip - 0.04;

    if (this.pose === 'sit' || this.pose === 'ground-sit') {
      // Piernas hacia delante; en el suelo, un poco abiertas.
      const spread = this.pose === 'ground-sit' ? 0.22 : 0.04;
      this.legLeft.rotation.set(-1.45, 0, -spread);
      this.legRight.rotation.set(-1.45, 0, spread);
    }
  }

  /** Estrellitas girando sobre la cabeza cuando esta mareado. */
  private updateDizzyStars(time: number): void {
    const dizzy = this.mood === 'dizzy';

    if (!dizzy) {
      if (this.dizzyStars) {
        this.dizzyStars.visible = false;
      }
      return;
    }

    if (!this.dizzyStars) {
      const T = this.THREE;
      const starMaterial = this.track(new T.MeshStandardMaterial({ color: 0xffd23f, emissive: 0x6b5200, roughness: 0.4 }));
      const starGeometry = this.track(new T.OctahedronGeometry(0.07, 0));
      this.dizzyStars = new T.Group();

      for (let index = 0; index < 4; index += 1) {
        const star = new T.Mesh(starGeometry, starMaterial);
        const angle = (index / 4) * Math.PI * 2;
        star.position.set(Math.cos(angle) * 0.42, 0, Math.sin(angle) * 0.42);
        this.dizzyStars.add(star);
      }

      this.dizzyStars.position.y = 1.02;
      this.head.add(this.dizzyStars);
    }

    this.dizzyStars.visible = true;
    this.dizzyStars.rotation.y = time * 2.2;
  }

  dispose(): void {
    this.faceTexture?.dispose();

    for (const item of this.disposables) {
      item.dispose();
    }
  }

  private applyIdle(time: number): void {
    const breathe = Math.sin(time * 2.1 + this.phase);
    this.body.position.y += breathe * 0.008;
    this.body.scale.set(1 + breathe * 0.006, 1 - breathe * 0.006, 1);
    this.head.rotation.z = Math.sin(time * 0.8 + this.phase) * 0.05;
    this.head.rotation.y = Math.sin(time * 0.45 + this.phase) * 0.14;
    this.armLeft.rotation.z -= Math.sin(time * 2.1 + this.phase) * 0.025;
    this.armRight.rotation.z += Math.sin(time * 2.1 + this.phase) * 0.025;
  }

  private applyLobbyActions(time: number): void {
    if (!this.action && time >= this.nextActionAt && this.enteredAt >= 0) {
      const choice = LOBBY_ACTIONS[Math.floor(Math.random() * LOBBY_ACTIONS.length)];
      this.action = { ...choice, start: time };
    }

    if (!this.action) {
      return;
    }

    const progress = (time - this.action.start) / this.action.duration;

    if (progress >= 1) {
      this.action = null;
      this.nextActionAt = time + 3 + Math.random() * 6;
      return;
    }

    this.applyAction(this.action.type, progress);
  }

  private applyAction(type: MiiAction, progress: number): void {
    const lift = bell(progress);

    switch (type) {
      case 'wave': {
        const raised = Math.min(1, progress * 5, (1 - progress) * 5);
        this.armRight.rotation.z = BASE_ARM_SPREAD + raised * (2.55 + Math.sin(progress * Math.PI * 10) * 0.3);
        this.head.rotation.z += raised * 0.12;
        break;
      }
      case 'jump':
        this.root.position.y += lift * 0.42;
        this.armLeft.rotation.z = -(BASE_ARM_SPREAD + lift * 1.4);
        this.armRight.rotation.z = BASE_ARM_SPREAD + lift * 1.4;
        this.legLeft.rotation.x = -lift * 0.35;
        this.legRight.rotation.x = -lift * 0.35;
        break;
      case 'spin':
        this.root.rotation.y += easeInOut(progress) * Math.PI * 2;
        this.root.position.y += lift * 0.12;
        break;
      case 'look':
        this.head.rotation.y = Math.sin(progress * Math.PI * 2) * 0.75;
        this.head.rotation.x = -lift * 0.1;
        break;
      case 'stretch':
        this.armLeft.rotation.z = -(BASE_ARM_SPREAD + lift * 2.75);
        this.armRight.rotation.z = BASE_ARM_SPREAD + lift * 2.75;
        this.body.rotation.x = -lift * 0.12;
        this.head.rotation.x = -lift * 0.25;
        break;
      case 'dance': {
        const beat = Math.sin(progress * Math.PI * 8);
        this.root.rotation.z = beat * 0.12 * lift;
        this.body.position.y += Math.abs(beat) * 0.05 * lift;
        this.armLeft.rotation.z = -(BASE_ARM_SPREAD + (beat > 0 ? 1.8 : 0.4) * lift);
        this.armRight.rotation.z = BASE_ARM_SPREAD + (beat < 0 ? 1.8 : 0.4) * lift;
        this.head.rotation.z = -beat * 0.15 * lift;
        break;
      }
      case 'clap': {
        const clap = Math.abs(Math.sin(progress * Math.PI * 7));
        this.armLeft.rotation.x = -1.25 * lift;
        this.armRight.rotation.x = -1.25 * lift;
        this.armLeft.rotation.z = -(BASE_ARM_SPREAD + 0.15) + clap * 0.45 * lift;
        this.armRight.rotation.z = BASE_ARM_SPREAD + 0.15 - clap * 0.45 * lift;
        break;
      }
    }
  }

  private applyMood(time: number): void {
    const local = time + this.phase;

    if (this.mood === 'happy') {
      // Celebracion: saltos con los brazos arriba y, de vez en cuando, una vuelta.
      const cycle = (local % 1.25) / 1.25;
      const jump = bell(Math.min(1, cycle / 0.7));
      this.root.position.y += jump * 0.38;
      this.armLeft.rotation.z = -(BASE_ARM_SPREAD + 2.3 + Math.sin(local * 14) * 0.15);
      this.armRight.rotation.z = BASE_ARM_SPREAD + 2.3 + Math.sin(local * 14 + 1) * 0.15;
      this.legLeft.rotation.x = -jump * 0.3;
      this.legRight.rotation.x = -jump * 0.3;
      this.head.rotation.x = -0.12;

      if (Math.floor(local / 1.25) % 4 === 3) {
        this.root.rotation.y += easeInOut(cycle) * Math.PI * 2;
      }
      return;
    }

    if (this.mood !== this.lastMood) {
      // Cada vez que se pone triste elige al azar una de las dos tristezas.
      this.sadVariant = Math.random() < 0.5 ? 'sigh' : 'slump';
      this.lastMood = this.mood;
    }

    if (this.applyGameMood(local)) {
      return;
    }

    if (this.mood === 'dance-big') {
      this.applyBigDance(local);
      return;
    }

    if (this.mood === 'dance-small') {
      this.applySmallDance(local);
      return;
    }

    if (this.mood === 'clap') {
      // Aplauso continuo con un pequeno rebote.
      const clap = Math.abs(Math.sin(local * 9));
      this.armLeft.rotation.x = -1.3;
      this.armRight.rotation.x = -1.3;
      this.armLeft.rotation.z = -(BASE_ARM_SPREAD + 0.2) + clap * 0.5;
      this.armRight.rotation.z = BASE_ARM_SPREAD + 0.2 - clap * 0.5;
      this.body.position.y += Math.abs(Math.sin(local * 4.5)) * 0.025;
      this.head.rotation.z += Math.sin(local * 2.2) * 0.08;
      return;
    }

    if (this.mood === 'sad' && this.sadVariant === 'slump') {
      // Tristeza exagerada: encorvado hacia delante, brazos colgando y cabeza gacha y ladeada.
      const sway = Math.sin(local * 1.1);
      const lean = 0.36 + Math.sin(local * 0.7) * 0.03;
      this.body.rotation.x = lean;
      this.body.rotation.z = sway * 0.04;
      this.body.position.y -= 0.07;
      this.head.rotation.x = 0.62;
      this.head.rotation.y = sway * 0.08;
      this.head.rotation.z = 0.26 + sway * 0.04;
      this.armLeft.rotation.x = -lean + 0.18 + sway * 0.05;
      this.armRight.rotation.x = -lean + 0.18 - sway * 0.05;
      this.armLeft.rotation.z = -0.02;
      this.armRight.rotation.z = 0.02;
      this.legLeft.rotation.x = 0.06;
      this.legRight.rotation.x = 0.06;
      return;
    }

    if (this.mood === 'sad') {
      // Desanimo: cabeza gacha, hombros caidos y algun suspiro.
      const sigh = bell(((local % 3.2) / 3.2 - 0.5) * 3);
      this.head.rotation.x = 0.42 + sigh * 0.1;
      this.head.rotation.y *= 0.3;
      this.body.rotation.x = 0.14 + sigh * 0.05;
      this.body.position.y -= 0.02 + sigh * 0.02;
      this.armLeft.rotation.z = -0.04;
      this.armRight.rotation.z = 0.04;
      this.armLeft.rotation.x = 0.12;
      this.armRight.rotation.x = 0.12;
      return;
    }

    // Sin puntos: encogerse de hombros de vez en cuando.
    const cycle = (local % 2.8) / 2.8;
    const shrug = cycle < 0.45 ? bell(cycle / 0.45) : 0;
    this.armLeft.rotation.z = -(BASE_ARM_SPREAD + shrug * 0.75);
    this.armRight.rotation.z = BASE_ARM_SPREAD + shrug * 0.75;
    this.armLeft.rotation.x = -shrug * 0.6;
    this.armRight.rotation.x = -shrug * 0.6;
    this.body.position.y += shrug * 0.03;
    this.head.rotation.z += shrug * 0.22;
  }

  /** Estados de los minijuegos 3D (mesa de blackjack y barriles). Devuelve true si ha aplicado alguno. */
  private applyGameMood(local: number): boolean {
    switch (this.mood) {
      case 'seated':
        // Brazos apoyados sobre la mesa.
        this.armLeft.rotation.set(-1.15, 0, -0.08);
        this.armRight.rotation.set(-1.15, 0, 0.08);
        this.head.rotation.x = 0.12;
        return true;
      case 'seated-active': {
        // Su turno: mira sus cartas y tamborilea con los dedos.
        this.armLeft.rotation.set(-1.2, 0, -0.06);
        this.armRight.rotation.set(-1.3 + Math.sin(local * 9) * 0.08, 0, 0.1);
        this.head.rotation.x = 0.28;
        this.head.rotation.y = Math.sin(local * 0.9) * 0.15;
        return true;
      }
      case 'seated-happy': {
        const wave = Math.sin(local * 10);
        this.armLeft.rotation.set(0, 0, -(2.3 + wave * 0.18));
        this.armRight.rotation.set(0, 0, 2.3 - wave * 0.18);
        this.body.position.y += Math.abs(Math.sin(local * 5)) * 0.04;
        this.head.rotation.x = -0.15;
        return true;
      }
      case 'seated-sad':
        this.armLeft.rotation.set(-1.0, 0, -0.04);
        this.armRight.rotation.set(-1.0, 0, 0.04);
        this.body.rotation.x = 0.2;
        this.head.rotation.x = 0.55;
        this.head.rotation.z = 0.15 + Math.sin(local * 0.8) * 0.04;
        return true;
      case 'dealer': {
        // Crupier: manos sobre la mesa, atento al juego.
        this.armLeft.rotation.set(-0.95, 0, -0.1);
        this.armRight.rotation.set(-0.95 + Math.max(0, Math.sin(local * 1.7)) * 0.15, 0, 0.1);
        this.head.rotation.x = 0.18;
        return true;
      }
      case 'look-up': {
        // Mirando el barril con nervios: cabeza arriba y un leve temblor.
        const tremble = Math.sin(local * 38) * 0.012;
        this.head.rotation.x = -0.55 + tremble;
        this.head.rotation.y *= 0.3;
        this.armLeft.rotation.set(-0.35, 0, -0.45 + tremble * 4);
        this.armRight.rotation.set(-0.35, 0, 0.45 - tremble * 4);
        this.body.position.y -= 0.02;
        return true;
      }
      case 'relief': {
        // Se ha salvado: se seca la frente y respira.
        const breath = Math.sin(local * 2.4);
        this.armRight.rotation.set(-2.4, 0, 0.55 + breath * 0.08);
        this.armLeft.rotation.set(0.1, 0, -0.25);
        this.head.rotation.x = -0.2 + breath * 0.05;
        this.head.rotation.z = 0.1;
        return true;
      }
      case 'walk': {
        // Paso alegre: piernas y brazos alternos, con un pequeno rebote en cada paso.
        const stride = Math.sin(local * 9);
        this.legLeft.rotation.x = stride * 0.55;
        this.legRight.rotation.x = -stride * 0.55;
        this.armLeft.rotation.x = -stride * 0.5;
        this.armRight.rotation.x = stride * 0.5;
        this.body.position.y += Math.abs(Math.cos(local * 9)) * 0.05;
        this.body.rotation.z = stride * 0.04;
        this.head.rotation.x = 0.04;
        return true;
      }
      case 'shuffle': {
        // Brazos alternos arriba y abajo sobre la mesa, rapido, como moviendo los cubiletes.
        const beat = Math.sin(local * 13);
        this.armLeft.rotation.set(-1.15 + beat * 0.35, 0, -0.28 - Math.abs(beat) * 0.12);
        this.armRight.rotation.set(-1.15 - beat * 0.35, 0, 0.28 + Math.abs(beat) * 0.12);
        this.body.rotation.y = beat * 0.08;
        this.head.rotation.x = 0.22;
        this.head.rotation.y = -beat * 0.12;
        return true;
      }
      case 'lever': {
        // Con las dos manos en el mango de la palanca, a la altura del pecho; al empujar se agacha un poco.
        const pull = Math.min(1, Math.max(0, this.leverPull));
        this.armLeft.rotation.set(-1.45 + pull * 0.65, 0, -0.32);
        this.armRight.rotation.set(-1.45 + pull * 0.65, 0, 0.32);
        this.body.rotation.x = 0.08 + pull * 0.22;
        this.body.position.y -= pull * 0.07;
        this.head.rotation.x = -0.35 + pull * 0.2;
        this.legLeft.rotation.x = pull * 0.12;
        this.legRight.rotation.x = -pull * 0.12;
        return true;
      }
      case 'dizzy': {
        // Sentado en el suelo, apoyado en las manos, con la cabeza girando en circulos sobre el cuello.
        const swirl = local * 1.7;
        this.head.rotation.x = Math.sin(swirl) * 0.28;
        this.head.rotation.z = Math.cos(swirl) * 0.28;
        this.head.rotation.y = Math.sin(swirl * 0.5) * 0.15;
        this.body.rotation.x = -0.12;
        this.armLeft.rotation.set(0.75, 0, -0.55);
        this.armRight.rotation.set(0.75, 0, 0.55);
        return true;
      }
      default:
        return false;
    }
  }

  /** Baile de campeon: saltitos, brazos arriba alternos, cadera y una vuelta cada pocos compases. */
  private applyBigDance(local: number): void {
    const beat = local * 2 * Math.PI * 1.6;
    const bounce = Math.abs(Math.sin(beat / 2));
    this.root.position.y += bounce * 0.22;
    this.root.rotation.y += Math.sin(beat / 4) * 0.45;
    this.root.rotation.z = Math.sin(beat / 2) * 0.14;
    this.body.position.y += bounce * 0.05;
    this.armLeft.rotation.z = -(BASE_ARM_SPREAD + 1.3 + Math.sin(beat) * 1.1);
    this.armRight.rotation.z = BASE_ARM_SPREAD + 1.3 + Math.sin(beat + Math.PI) * 1.1;
    this.armLeft.rotation.x = Math.sin(beat / 2) * 0.4;
    this.armRight.rotation.x = -Math.sin(beat / 2) * 0.4;
    this.legLeft.rotation.x = -Math.max(0, Math.sin(beat / 2)) * 0.5;
    this.legRight.rotation.x = -Math.max(0, -Math.sin(beat / 2)) * 0.5;
    this.head.rotation.z = Math.sin(beat / 2) * 0.22;
    this.head.rotation.x = -0.1 + Math.sin(beat) * 0.08;

    const bar = (local % 6) / 6;

    if (bar > 0.8) {
      this.root.rotation.y += easeInOut((bar - 0.8) / 0.2) * Math.PI * 2;
    }
  }

  /** Baile tranquilo: balanceo de lado a lado y brazos suaves. */
  private applySmallDance(local: number): void {
    const beat = local * 2 * Math.PI * 0.9;
    this.root.rotation.z = Math.sin(beat) * 0.07;
    this.root.rotation.y += Math.sin(beat / 2) * 0.2;
    this.body.position.y += Math.abs(Math.sin(beat)) * 0.025;
    this.armLeft.rotation.z = -(BASE_ARM_SPREAD + 0.45 + Math.sin(beat) * 0.25);
    this.armRight.rotation.z = BASE_ARM_SPREAD + 0.45 - Math.sin(beat) * 0.25;
    this.armLeft.rotation.x = -0.35;
    this.armRight.rotation.x = -0.35;
    this.head.rotation.z = -Math.sin(beat) * 0.12;
  }

  private applyEnterAndLeave(time: number): void {
    if (this.leavingAt >= 0) {
      const progress = Math.min(1, (time - this.leavingAt) / 0.45);
      this.root.scale.setScalar(Math.max(0.001, 1 - progress));
      return;
    }

    if (this.enteredAt < 0) {
      this.root.scale.setScalar(0.001);
      return;
    }

    // Entrada: cae desde arriba y rebota al llegar al suelo.
    const progress = Math.min(1, (time - this.enteredAt) / 0.75);
    const drop = progress < 0.6 ? 1 - Math.pow(progress / 0.6, 2) : 0;
    const bounce = progress >= 0.6 ? Math.sin(((progress - 0.6) / 0.4) * Math.PI) * 0.12 : 0;
    this.root.position.y += drop * 2.6 + bounce;
    this.root.scale.setScalar(1);
    this.body.scale.y *= progress >= 0.6 && progress < 0.75 ? 0.9 : 1;
  }

  private track<T extends { dispose: () => void }>(item: T): T {
    this.disposables.push(item);
    return item;
  }
}

/**
 * Prepara la textura de la cara: recorta la foto en cuadrado y difumina los bordes hacia el tono de piel
 * para que se funda con la cabeza. Si la foto no se puede usar (sin CORS ni proxy), dibuja la inicial.
 */
export async function createFaceTexture(THREE: Three, avatarUrl: string, name: string, proxyBase: string): Promise<ThreeModule.Texture> {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d')!;
  context.fillStyle = '#f3cfa8';
  context.fillRect(0, 0, size, size);

  const image =
    (await loadCorsImage(avatarUrl)) ||
    (/^https?:\/\//i.test(avatarUrl) ? await loadCorsImage(`${proxyBase}/avatar-proxy?url=${encodeURIComponent(avatarUrl)}`) : null);

  if (image) {
    const layer = document.createElement('canvas');
    layer.width = size;
    layer.height = size;
    const layerContext = layer.getContext('2d')!;
    const side = Math.min(image.naturalWidth, image.naturalHeight);
    layerContext.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side, 0, 0, size, size);
    const fade = layerContext.createRadialGradient(size / 2, size / 2, size * 0.3, size / 2, size / 2, size * 0.5);
    fade.addColorStop(0, 'rgba(0,0,0,1)');
    fade.addColorStop(1, 'rgba(0,0,0,0)');
    layerContext.globalCompositeOperation = 'destination-in';
    layerContext.fillStyle = fade;
    layerContext.fillRect(0, 0, size, size);
    context.drawImage(layer, 0, 0);
  } else {
    context.fillStyle = '#3b4150';
    context.font = `900 ${size * 0.42}px "Trebuchet MS", Arial, sans-serif`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText((name.trim().charAt(0) || '?').toUpperCase(), size / 2, size / 2);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

function loadCorsImage(url: string): Promise<HTMLImageElement | null> {
  if (!url) {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    const image = new Image();
    const timer = setTimeout(() => resolve(null), 8000);
    image.crossOrigin = 'anonymous';
    image.referrerPolicy = 'no-referrer';
    image.onload = () => {
      clearTimeout(timer);
      resolve(image.naturalWidth ? image : null);
    };
    image.onerror = () => {
      clearTimeout(timer);
      resolve(null);
    };
    image.src = url;
  });
}
