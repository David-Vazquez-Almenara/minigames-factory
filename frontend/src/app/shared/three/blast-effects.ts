import type * as ThreeModule from 'three';
import type { MiiParts } from '../components/mii-stage/mii-rig';
import type { BlastChannel } from './blast-ragdoll';

type Three = typeof ThreeModule;
type Vector3 = ThreeModule.Vector3;

const BASE_ARM_Z = 0.16;
const GRAVITY = 9.8;

interface Drop {
  mesh: ThreeModule.Mesh;
  velocity: Vector3;
  /** Segundos que tarda en salir (los chorros van saliendo poco a poco). */
  delay: number;
}

interface Puff {
  mesh: ThreeModule.Mesh;
  material: ThreeModule.MeshBasicMaterial | ThreeModule.MeshStandardMaterial;
  velocity: Vector3;
  bornAt: number;
  lifeMs: number;
  from: number;
  to: number;
  opacity: number;
}

interface Stain {
  mesh: ThreeModule.Mesh;
  bornAt: number;
  grow: number;
  size: number;
  ratio: number;
}

const ease = (value: number) => {
  const clamped = Math.min(1, Math.max(0, value));
  return clamped * clamped * (3 - 2 * clamped);
};

/**
 * Efectos de explosion para escenas 3D: bola de fuego, destello, humo, onda expansiva, chispas, mancha de
 * quemado y sangre exagerada (gotas que salen a chorros y dejan manchas al caer). Todo se anima en `update`.
 */
export class BlastEffects {
  private readonly drops: Drop[] = [];
  private readonly puffs: Puff[] = [];
  private readonly stains: Stain[] = [];
  private readonly lights: Array<{ light: ThreeModule.PointLight; bornAt: number; power: number }> = [];
  private readonly disposables: Array<{ dispose: () => void }> = [];
  private readonly bloodMaterial: ThreeModule.MeshStandardMaterial;
  private readonly stainMaterial: ThreeModule.MeshBasicMaterial;
  private readonly scorchMaterial: ThreeModule.MeshBasicMaterial;
  private readonly dropGeometry: ThreeModule.SphereGeometry;
  private readonly puffGeometry: ThreeModule.SphereGeometry;
  private readonly ringGeometry: ThreeModule.RingGeometry;
  private readonly circleGeometry: ThreeModule.CircleGeometry;
  /** Altura del suelo en (x, z): por defecto 0 (la escena puede cambiarla). */
  groundAt: (x: number, z: number) => number = () => 0;

  constructor(
    private readonly THREE: Three,
    private readonly scene: ThreeModule.Scene,
  ) {
    const T = THREE;
    this.bloodMaterial = this.track(new T.MeshStandardMaterial({ color: '#b3000c', roughness: 0.25, metalness: 0.1, emissive: '#2a0002' }));
    this.stainMaterial = this.track(
      new T.MeshBasicMaterial({ color: '#7a0008', transparent: true, opacity: 0.92, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }),
    );
    this.scorchMaterial = this.track(
      new T.MeshBasicMaterial({ color: '#1a1410', transparent: true, opacity: 0.7, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1 }),
    );
    this.dropGeometry = this.track(new T.SphereGeometry(0.03, 8, 6));
    this.puffGeometry = this.track(new T.SphereGeometry(1, 16, 12));
    this.ringGeometry = this.track(new T.RingGeometry(0.85, 1, 40));
    this.circleGeometry = this.track(new T.CircleGeometry(1, 22));
  }

  /** ¡BUM!: bola de fuego, destello, humo, onda expansiva, chispas y mancha de quemado en el suelo. */
  explode(at: Vector3, now: number, size = 1): void {
    const T = this.THREE;
    // Destello blanco y bola de fuego que crece y se apaga.
    this.addPuff(at, new T.Vector3(), now, 180, 0.2 * size, 1.4 * size, new T.MeshBasicMaterial({ color: '#fffbe0', transparent: true }), 1);
    this.addPuff(at, new T.Vector3(0, 0.6, 0), now, 650, 0.3 * size, 1.9 * size, new T.MeshBasicMaterial({ color: '#ff8a1c', transparent: true }), 0.95);
    this.addPuff(at, new T.Vector3(0, 0.9, 0), now, 520, 0.2 * size, 1.3 * size, new T.MeshBasicMaterial({ color: '#ffd23f', transparent: true }), 0.9);

    // Humo negro y gris que sube y se agranda: bocanadas pequenas y repartidas (sin tapar la escena).
    for (let index = 0; index < 18; index += 1) {
      const direction = new T.Vector3(Math.random() - 0.5, 0.5 + Math.random() * 0.9, Math.random() - 0.5).normalize();
      const start = at.clone().addScaledVector(direction, (0.3 + Math.random() * 0.5) * size);
      const grey = 0.15 + Math.random() * 0.3;
      const material = new T.MeshStandardMaterial({ color: new T.Color(grey, grey, grey), transparent: true, roughness: 1, depthWrite: false });
      this.addPuff(start, direction.multiplyScalar(1.6 + Math.random() * 2), now + Math.random() * 200, 1100 + Math.random() * 700, 0.2 * size, (0.35 + Math.random() * 0.45) * size, material, 0.6);
    }

    // Onda expansiva en el suelo.
    const ground = this.groundAt(at.x, at.z);
    const ring = new T.MeshBasicMaterial({ color: '#fff1c9', transparent: true, side: T.DoubleSide, depthWrite: false });
    const shock = this.addPuff(new T.Vector3(at.x, ground + 0.04, at.z), new T.Vector3(), now, 520, 0.3, 5 * size, ring, 0.8, this.ringGeometry);
    shock.mesh.rotation.x = -Math.PI / 2;

    // Chispas y cascotes que salen disparados.
    for (let index = 0; index < 40; index += 1) {
      const direction = new T.Vector3(Math.random() - 0.5, Math.random() * 0.9 + 0.1, Math.random() - 0.5).normalize();
      const material = new T.MeshBasicMaterial({ color: Math.random() < 0.5 ? '#ffcf33' : '#ff6a00', transparent: true });
      this.addPuff(at, direction.multiplyScalar(5 + Math.random() * 7), now, 500 + Math.random() * 400, 0.05, 0.02, material, 1, undefined, true);
    }

    // Luz de la explosion (ilumina a los de alrededor).
    const light = new T.PointLight(0xffa040, 0, 14, 1.6);
    light.position.copy(at).setY(at.y + 0.4);
    this.scene.add(light);
    this.lights.push({ light, bornAt: now, power: 60 * size });

    // Quemado en el suelo.
    const scorch = new T.Mesh(this.circleGeometry, this.scorchMaterial);
    scorch.rotation.x = -Math.PI / 2;
    scorch.position.set(at.x, ground + 0.008, at.z);
    scorch.scale.setScalar(0.001);
    this.scene.add(scorch);
    this.stains.push({ mesh: scorch, bornAt: now, grow: 260, size: 1.25 * size, ratio: 1 });
  }

  /**
   * Sangre exagerada: un surtidor en abanico (hacia `direction` y hacia arriba) y salpicaduras en todas las
   * direcciones. Las gotas salen a chorros durante un rato.
   */
  bloodBurst(at: Vector3, direction: Vector3, count = 260): void {
    const T = this.THREE;

    for (let index = 0; index < count; index += 1) {
      const fan = index < count * 0.65;
      const spread = fan
        ? direction.clone().multiplyScalar(0.8 + Math.random() * 0.6).add(new T.Vector3((Math.random() - 0.5) * 1.6, 0.4 + Math.random() * 1.6, (Math.random() - 0.5) * 1.6)).normalize()
        : new T.Vector3(Math.random() - 0.5, Math.random() * 1.2, Math.random() - 0.5).normalize();
      const mesh = new T.Mesh(this.dropGeometry, this.bloodMaterial);
      mesh.position.copy(at).addScaledVector(spread, 0.15 + Math.random() * 0.2);
      mesh.scale.setScalar(0.4 + Math.random() * 1.3);
      mesh.visible = false;
      this.scene.add(mesh);
      this.drops.push({ mesh, velocity: spread.multiplyScalar((fan ? 3 : 1.5) + Math.random() * 6), delay: Math.random() * (fan ? 0.5 : 0.15) });
    }
  }

  /** Reguero de gotas desde un cuerpo que vuela (llamar en cada fotograma mientras dure). */
  bloodTrail(at: Vector3, count = 3): void {
    const T = this.THREE;

    for (let index = 0; index < count; index += 1) {
      const mesh = new T.Mesh(this.dropGeometry, this.bloodMaterial);
      mesh.position.copy(at).add(new T.Vector3((Math.random() - 0.5) * 0.4, (Math.random() - 0.5) * 0.4, (Math.random() - 0.5) * 0.4));
      mesh.scale.setScalar(0.4 + Math.random() * 0.9);
      this.scene.add(mesh);
      this.drops.push({ mesh, velocity: new T.Vector3((Math.random() - 0.5) * 2, Math.random() * 1.5, (Math.random() - 0.5) * 2), delay: 0 });
    }
  }

  /** Charco que crece en el suelo. */
  pool(x: number, z: number, size: number, grow = 1800): void {
    this.addStain(x, z, size, grow);
  }

  update(now: number, delta: number): void {
    for (let index = this.drops.length - 1; index >= 0; index -= 1) {
      const drop = this.drops[index];

      if (drop.delay > 0) {
        drop.delay -= delta;
        continue;
      }

      drop.mesh.visible = true;
      drop.velocity.y -= GRAVITY * delta;
      drop.mesh.position.addScaledVector(drop.velocity, delta);
      const { x, y, z } = drop.mesh.position;

      // Al tocar el suelo deja una mancha.
      if (y <= this.groundAt(x, z) + 0.02) {
        this.addStain(x, z, 0.06 + Math.random() * 0.14 * drop.mesh.scale.x, 220);
        this.scene.remove(drop.mesh);
        this.drops.splice(index, 1);
      }
    }

    for (let index = this.puffs.length - 1; index >= 0; index -= 1) {
      const puff = this.puffs[index];
      const age = now - puff.bornAt;

      if (age < 0) {
        puff.mesh.visible = false;
        continue;
      }

      const life = age / puff.lifeMs;

      if (life >= 1) {
        this.scene.remove(puff.mesh);
        puff.material.dispose();
        this.puffs.splice(index, 1);
        continue;
      }

      puff.mesh.visible = true;
      puff.mesh.position.addScaledVector(puff.velocity, delta);

      // Las chispas caen; el humo frena poco a poco.
      if (puff.mesh.userData['spark']) {
        puff.velocity.y -= GRAVITY * delta;
      } else {
        puff.velocity.multiplyScalar(Math.max(0, 1 - delta * 1.6));
      }

      puff.mesh.scale.setScalar(puff.from + (puff.to - puff.from) * (1 - (1 - life) * (1 - life)));
      puff.material.opacity = puff.opacity * (1 - life * life);
    }

    for (let index = this.lights.length - 1; index >= 0; index -= 1) {
      const entry = this.lights[index];
      const life = (now - entry.bornAt) / 700;

      if (life >= 1) {
        this.scene.remove(entry.light);
        this.lights.splice(index, 1);
        continue;
      }

      entry.light.intensity = entry.power * (1 - life) * (1 - life);
    }

    for (const stain of this.stains) {
      const progress = ease((now - stain.bornAt) / stain.grow);
      stain.mesh.scale.set(stain.size * progress, stain.size * progress * stain.ratio, 1);
    }
  }

  dispose(): void {
    for (const puff of this.puffs) {
      puff.material.dispose();
    }

    for (const item of this.disposables) {
      item.dispose();
    }
  }

  private addStain(x: number, z: number, size: number, grow: number): void {
    const mesh = new this.THREE.Mesh(this.circleGeometry, this.stainMaterial);
    mesh.rotation.x = -Math.PI / 2;
    mesh.rotation.z = Math.random() * Math.PI;
    mesh.position.set(x, this.groundAt(x, z) + 0.012 + Math.random() * 0.002, z);
    mesh.scale.set(0.001, 0.001, 1);
    this.scene.add(mesh);
    this.stains.push({ mesh, bornAt: performance.now(), grow, size, ratio: 0.7 + Math.random() * 0.6 });
  }

  private addPuff(
    at: Vector3,
    velocity: Vector3,
    bornAt: number,
    lifeMs: number,
    from: number,
    to: number,
    material: ThreeModule.MeshBasicMaterial | ThreeModule.MeshStandardMaterial,
    opacity: number,
    geometry: ThreeModule.BufferGeometry = this.puffGeometry,
    spark = false,
  ): Puff {
    const mesh = new this.THREE.Mesh(geometry, material);
    mesh.position.copy(at);
    mesh.scale.setScalar(from);
    mesh.visible = false;
    mesh.userData['spark'] = spark;
    this.scene.add(mesh);
    const puff = { mesh, material, velocity: velocity.clone(), bornAt, lifeMs, from, to, opacity };
    this.puffs.push(puff);
    return puff;
  }

  private track<T extends { dispose: () => void }>(item: T): T {
    this.disposables.push(item);
    return item;
  }
}

/**
 * Coloca un Mii segun una postura de voladura. `flier` es el grupo que gira sobre la cadera (dentro del grupo
 * del jugador, que mira hacia +z), con el Mii colgado 0.9 m por debajo.
 */
export function applyBlastPose(flier: ThreeModule.Object3D, parts: MiiParts | null, pose: Record<BlastChannel, number>): void {
  flier.rotation.order = 'YXZ';
  flier.position.set(pose.side, pose.y, -pose.back);
  flier.rotation.set(pose.pitch, pose.yaw, pose.roll);

  if (!parts) {
    return;
  }

  parts.body.rotation.x += pose.bodyX;
  parts.head.rotation.set(pose.headX, 0, pose.headZ);
  parts.armLeft.rotation.set(pose.armLX, 0, -BASE_ARM_Z + pose.armLZ);
  parts.armRight.rotation.set(pose.armRX, 0, BASE_ARM_Z + pose.armRZ);
  parts.legLeft.rotation.set(pose.legLX, 0, pose.legLZ);
  parts.legRight.rotation.set(pose.legRX, 0, pose.legRZ);
}
