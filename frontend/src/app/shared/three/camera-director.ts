import type * as ThreeModule from 'three';

type Three = typeof ThreeModule;

export interface CameraGoal {
  /** Punto al que mira la camara. */
  target: ThreeModule.Vector3;
  /** Direccion (normalizada) desde el objetivo hacia la camara. */
  direction: ThreeModule.Vector3;
  /** Distancia fija; si se omite se calcula para que quepan todos los puntos de `fit`. */
  distance?: number;
  /** Puntos que deben quedar dentro del encuadre util (sin los paneles del HUD). */
  fit?: ThreeModule.Vector3[];
  /** Fraccion del encuadre util que pueden ocupar los puntos (1 = hasta el borde). */
  margin?: number;
  minDistance?: number;
}

export interface ViewInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

const easeInOutCubic = (value: number) => (value < 0.5 ? 4 * value * value * value : 1 - Math.pow(-2 * value + 2, 3) / 2);

/**
 * Camara unica de una escena 3D, desacoplada de la logica del juego: la logica solo indica que encuadrar
 * (una clave y una funcion que calcula el objetivo) y el director hace la transicion suave. El objetivo se
 * recalcula en cada fotograma, asi que al terminar la transicion la camara queda exactamente sobre el,
 * aunque se muevan las cartas o cambie el tamano de la ventana.
 */
export class CameraDirector {
  private readonly position: ThreeModule.Vector3;
  private readonly target: ThreeModule.Vector3;
  private readonly fromPosition: ThreeModule.Vector3;
  private readonly fromTarget: ThreeModule.Vector3;
  private readonly goalPosition: ThreeModule.Vector3;
  private readonly goalTarget: ThreeModule.Vector3;
  private readonly scratch: ThreeModule.Vector3;
  private readonly probe: ThreeModule.PerspectiveCamera;
  private key = '';
  private goal: (() => CameraGoal) | null = null;
  private startedAt = 0;
  private durationMs = 0;
  private arc = 0;
  private width = 1;
  private height = 1;
  private insets: ViewInsets = { top: 0, right: 0, bottom: 0, left: 0 };
  private targetInsets: ViewInsets = { top: 0, right: 0, bottom: 0, left: 0 };

  constructor(
    THREE: Three,
    readonly camera: ThreeModule.PerspectiveCamera,
  ) {
    this.position = new THREE.Vector3();
    this.target = new THREE.Vector3();
    this.fromPosition = new THREE.Vector3();
    this.fromTarget = new THREE.Vector3();
    this.goalPosition = new THREE.Vector3();
    this.goalTarget = new THREE.Vector3();
    this.scratch = new THREE.Vector3();
    this.probe = camera.clone();
  }

  /** Clave del encuadre actual (p. ej. "cards:<jugador>"). */
  get focusKey(): string {
    return this.key;
  }

  /** true cuando la ultima transicion ha terminado y la camara esta clavada en su objetivo. */
  settled(now: number): boolean {
    return !this.durationMs || now - this.startedAt >= this.durationMs;
  }

  /**
   * Cambia lo que se encuadra. Con la misma clave solo actualiza el calculo del objetivo, sin reiniciar
   * la transicion. El primer encuadre se aplica sin transicion.
   */
  focus(key: string, goal: () => CameraGoal, now: number, options: { durationMs?: number; arc?: number } = {}): void {
    this.goal = goal;

    if (key === this.key) {
      return;
    }

    const first = !this.key;
    this.key = key;
    this.fromPosition.copy(this.position);
    this.fromTarget.copy(this.target);
    this.startedAt = now;
    this.durationMs = first ? 0 : (options.durationMs ?? 1000);
    this.arc = options.arc ?? 0;
  }

  /** Tamano del lienzo y zonas tapadas por el HUD; el encuadre util se centra en lo que queda libre. */
  setViewport(width: number, height: number, insets?: ViewInsets): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);

    if (insets) {
      this.targetInsets = insets;
    }

    this.applyView(this.camera);
  }

  update(now: number, delta: number): void {
    if (!this.goal) {
      return;
    }

    // Los paneles del HUD aparecen y desaparecen: el centro util se desplaza con suavidad.
    const blend = Math.min(1, delta * 6);
    const insetsChanged = (Object.keys(this.insets) as Array<keyof ViewInsets>).some((side) => {
      const next = this.insets[side] + (this.targetInsets[side] - this.insets[side]) * blend;
      const changed = Math.abs(next - this.insets[side]) > 0.05;
      this.insets[side] = Math.abs(this.targetInsets[side] - next) < 0.5 ? this.targetInsets[side] : next;
      return changed;
    });

    if (insetsChanged) {
      this.applyView(this.camera);
    }

    this.resolveGoal(this.goal());
    const progress = this.durationMs ? Math.min(1, Math.max(0, (now - this.startedAt) / this.durationMs)) : 1;

    if (progress >= 1) {
      // Fin de la transicion: la camara se fuerza exactamente sobre el objetivo.
      this.position.copy(this.goalPosition);
      this.target.copy(this.goalTarget);
    } else {
      const eased = easeInOutCubic(progress);
      this.position.lerpVectors(this.fromPosition, this.goalPosition, eased);
      this.position.y += Math.sin(Math.PI * progress) * this.arc;
      this.target.lerpVectors(this.fromTarget, this.goalTarget, eased);
    }

    this.camera.position.copy(this.position);
    this.camera.lookAt(this.target);
  }

  private resolveGoal(goal: CameraGoal): void {
    const distance = goal.distance ?? this.fitDistance(goal);
    this.goalTarget.copy(goal.target);
    this.goalPosition.copy(goal.direction).multiplyScalar(distance).add(goal.target);
  }

  /** Distancia minima a la que todos los puntos caben en la zona util (busqueda binaria). */
  private fitDistance(goal: CameraGoal): number {
    const points = goal.fit || [];

    if (!points.length) {
      return goal.minDistance ?? 6;
    }

    const probe = this.probe;
    probe.fov = this.camera.fov;
    probe.near = this.camera.near;
    probe.far = this.camera.far;
    this.applyView(probe);

    let low = goal.minDistance ?? 0.5;
    let high = 90;

    for (let step = 0; step < 18; step += 1) {
      const middle = (low + high) / 2;

      if (this.fits(points, goal, middle, goal.margin ?? 0.88)) {
        high = middle;
      } else {
        low = middle;
      }
    }

    return high;
  }

  private fits(points: ThreeModule.Vector3[], goal: CameraGoal, distance: number, margin: number): boolean {
    const probe = this.probe;
    probe.position.copy(goal.direction).multiplyScalar(distance).add(goal.target);
    probe.lookAt(goal.target);
    probe.updateMatrixWorld();

    // Zona util en coordenadas normalizadas del lienzo (sin las franjas del HUD).
    const top = 1 - (2 * this.insets.top) / this.height;
    const bottom = -1 + (2 * this.insets.bottom) / this.height;
    const right = 1 - (2 * this.insets.right) / this.width;
    const left = -1 + (2 * this.insets.left) / this.width;
    const centerY = (top + bottom) / 2;
    const centerX = (left + right) / 2;
    const halfY = ((top - bottom) / 2) * margin;
    const halfX = ((right - left) / 2) * margin;

    for (const point of points) {
      this.scratch.copy(point).project(probe);

      if (this.scratch.z > 1 || Math.abs(this.scratch.x - centerX) > halfX || Math.abs(this.scratch.y - centerY) > halfY) {
        return false;
      }
    }

    return true;
  }

  /**
   * Desplaza el centro optico al centro de la zona libre: se renderiza una ventana de un fotograma mayor,
   * asi el objetivo queda en medio del hueco entre los paneles sin deformar la imagen.
   */
  private applyView(camera: ThreeModule.PerspectiveCamera): void {
    const dx = (this.insets.right - this.insets.left) / 2;
    const dy = (this.insets.bottom - this.insets.top) / 2;
    const fullWidth = this.width + 2 * Math.abs(dx);
    const fullHeight = this.height + 2 * Math.abs(dy);
    camera.aspect = fullWidth / fullHeight;
    camera.setViewOffset(fullWidth, fullHeight, dx > 0 ? 2 * dx : 0, dy > 0 ? 2 * dy : 0, this.width, this.height);
  }
}
