import { AfterViewInit, Component, ElementRef, OnDestroy, effect, input, signal, untracked, viewChild } from '@angular/core';
import type * as ThreeModule from 'three';
import { environment } from '../../../../environments/environment';
import { getPlayerColor } from '../../player-colors';
import { MiiMood, MiiRig, createFaceTexture } from './mii-rig';

export interface MiiStagePlayer {
  id: string;
  name: string;
  avatarUrl: string;
  color: string;
  mood?: MiiMood;
  /** Texto bajo el Mii: el nombre en el lobby, "+X" / "-Y" en el marcador. */
  label?: string;
  labelTone?: 'positive' | 'negative' | 'neutral' | 'name';
  badge?: string;
  /** Altura en la que se coloca (p. ej. escalones del podio). */
  elevation?: number;
  /** Escalon en 3D bajo el Mii (podio final). */
  pedestal?: { color: string; label: string };
}

interface StageEntry {
  rig: MiiRig;
  avatarUrl: string;
  color: string;
  pedestal?: ThreeModule.Mesh;
  pedestalKey: string;
}

const SPACING = 1.25;
const FOV = 30;

/**
 * Escenario 3D con un personaje estilo Mii por jugador, con su foto como textura de la cara.
 * Three.js se carga bajo demanda para no aumentar la carga inicial de la app.
 */
@Component({
  selector: 'app-mii-stage',
  templateUrl: './mii-stage.component.html',
  styleUrl: './mii-stage.component.scss',
})
export class MiiStageComponent implements AfterViewInit, OnDestroy {
  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly hostRef = viewChild.required<ElementRef<HTMLElement>>('stage');
  private THREE?: typeof ThreeModule;
  private renderer?: ThreeModule.WebGLRenderer;
  private scene?: ThreeModule.Scene;
  private camera?: ThreeModule.PerspectiveCamera;
  private clock?: ThreeModule.Clock;
  private frameHandle?: number;
  private resizeObserver?: ResizeObserver;
  private cameraDistance = 6;
  private readonly entries = new Map<string, StageEntry>();
  private readonly projection = { vector: null as ThreeModule.Vector3 | null };
  private destroyed = false;

  readonly players = input.required<MiiStagePlayer[]>();
  readonly mode = input<'lobby' | 'scoreboard' | 'podium'>('lobby');
  readonly unsupported = signal(false);
  readonly ready = signal(false);

  constructor() {
    effect(() => {
      const players = this.players();

      if (this.ready()) {
        untracked(() => this.syncPlayers(players));
      }
    });
  }

  async ngAfterViewInit(): Promise<void> {
    try {
      this.THREE = await import('three');
    } catch {
      this.unsupported.set(true);
      return;
    }

    if (this.destroyed) {
      return;
    }

    const T = this.THREE;

    try {
      this.renderer = new T.WebGLRenderer({ canvas: this.canvasRef().nativeElement, alpha: true, antialias: true });
    } catch {
      // Sin WebGL el resto de la pantalla sigue funcionando con las fotos en 2D.
      this.unsupported.set(true);
      return;
    }

    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = T.SRGBColorSpace;
    this.scene = new T.Scene();
    this.camera = new T.PerspectiveCamera(FOV, 1, 0.1, 100);
    this.clock = new T.Clock();
    this.projection.vector = new T.Vector3();

    this.scene.add(new T.HemisphereLight(0xffffff, 0xffc4dc, 1.6));
    const key = new T.DirectionalLight(0xffffff, 1.9);
    key.position.set(2.5, 5, 6);
    const rim = new T.DirectionalLight(0xfff2c4, 0.7);
    rim.position.set(-4, 3, -3);
    this.scene.add(key, rim);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.hostRef().nativeElement);
    this.resize();
    this.ready.set(true);
    this.syncPlayers(this.players());
    this.loop();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.frameHandle || 0);
    this.resizeObserver?.disconnect();

    for (const entry of this.entries.values()) {
      entry.rig.dispose();
      this.removePedestal(entry);
    }

    this.entries.clear();
    this.renderer?.dispose();
    this.renderer?.forceContextLoss();
  }

  private syncPlayers(players: MiiStagePlayer[]): void {
    const T = this.THREE;
    const scene = this.scene;

    if (!T || !scene || !this.clock) {
      return;
    }

    const time = this.clock.getElapsedTime();
    const wanted = new Set(players.map((player) => player.id));

    for (const [id, entry] of this.entries) {
      if (!wanted.has(id) && !entry.rig.removed) {
        entry.rig.leave(time);
      }
    }

    players.forEach((player, index) => {
      const shirt = getPlayerColor(player.color).body;
      let entry = this.entries.get(player.id);

      if (!entry || entry.rig.removed) {
        if (entry) {
          scene.remove(entry.rig.root);
          entry.rig.dispose();
        }

        const rig = new MiiRig(T, shirt);
        rig.root.position.x = (index - (players.length - 1) / 2) * SPACING;
        rig.enter(time + index * 0.12);
        scene.add(rig.root);
        entry = { rig, avatarUrl: '', color: player.color, pedestalKey: '' };
        this.entries.set(player.id, entry);
      }

      entry.rig.targetX = (index - (players.length - 1) / 2) * SPACING;
      entry.rig.mood = player.mood || 'idle';
      entry.rig.baseY = player.elevation || 0;
      this.syncPedestal(entry, player);

      if (entry.color !== player.color) {
        entry.color = player.color;
        entry.rig.setShirtColor(shirt);
      }

      if (entry.avatarUrl !== player.avatarUrl) {
        entry.avatarUrl = player.avatarUrl;
        const rig = entry.rig;
        void createFaceTexture(T, player.avatarUrl, player.name, environment.apiUrl).then((texture) => {
          if (this.destroyed || rig.removed) {
            texture.dispose();
            return;
          }

          rig.setFaceTexture(texture);
        });
      }
    });
  }

  private loop(): void {
    this.frameHandle = requestAnimationFrame(() => this.loop());

    if (!this.renderer || !this.scene || !this.camera || !this.clock) {
      return;
    }

    const delta = Math.min(0.05, this.clock.getDelta());
    const time = this.clock.getElapsedTime();
    const mode = this.mode();
    const activeCount = [...this.entries.values()].filter((entry) => !entry.rig.removed).length;

    for (const [id, entry] of this.entries) {
      entry.rig.update(time, delta, mode);

      if (entry.pedestal) {
        entry.pedestal.position.x = entry.rig.root.position.x;
        entry.pedestal.scale.y = Math.max(0.001, entry.rig.root.scale.y);
      }

      if (entry.rig.isGone(time)) {
        this.scene.remove(entry.rig.root);
        entry.rig.dispose();
        this.removePedestal(entry);
        this.entries.delete(id);
      }
    }

    this.fitCamera(Math.max(1, activeCount), delta);
    this.renderer.render(this.scene, this.camera);
    this.placeLabels();
  }

  /** Aleja la camara lo justo para que quepan todos los Mii, con una transicion suave. */
  private fitCamera(count: number, delta: number): void {
    const camera = this.camera!;
    const halfFov = ((FOV / 2) * Math.PI) / 180;
    const neededWidth = (count - 1) * SPACING + 1.4;
    // Margen por arriba para los saltos y por abajo para las etiquetas.
    const elevation = Math.max(0, ...[...this.entries.values()].map((entry) => entry.rig.baseY));
    const neededHeight = 3.1 + elevation;
    const target = Math.max(neededWidth / (2 * Math.tan(halfFov) * camera.aspect), neededHeight / (2 * Math.tan(halfFov)));
    this.cameraDistance += (target - this.cameraDistance) * Math.min(1, delta * 4);
    camera.position.set(0, 1.3 + elevation / 2, this.cameraDistance);
    camera.lookAt(0, 1.15 + elevation / 2, 0);
  }

  private placeLabels(): void {
    const host = this.hostRef().nativeElement;
    const vector = this.projection.vector!;
    const width = host.clientWidth;
    const height = host.clientHeight;

    for (const label of Array.from(host.querySelectorAll<HTMLElement>('[data-mii-label]'))) {
      const entry = this.entries.get(label.dataset['miiLabel'] || '');

      if (!entry) {
        label.style.opacity = '0';
        continue;
      }

      vector.set(entry.rig.root.position.x, entry.pedestal ? 0 : entry.rig.baseY, 0).project(this.camera!);
      label.style.opacity = entry.rig.removed ? '0' : '1';
      label.style.transform = `translate(${((vector.x + 1) / 2) * width}px, ${((1 - vector.y) / 2) * height}px) translate(-50%, 4px)`;
    }
  }

  /** Escalon del podio: caja con el puesto pintado en la cara frontal. */
  private syncPedestal(entry: StageEntry, player: MiiStagePlayer): void {
    const T = this.THREE!;
    const height = player.elevation || 0;
    const key = player.pedestal && height > 0 ? `${player.pedestal.color}:${player.pedestal.label}:${height}` : '';

    if (key === entry.pedestalKey) {
      return;
    }

    this.removePedestal(entry);
    entry.pedestalKey = key;

    if (!key || !player.pedestal) {
      return;
    }

    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const context = canvas.getContext('2d')!;
    context.fillStyle = player.pedestal.color;
    context.fillRect(0, 0, 256, 256);
    context.strokeStyle = '#000';
    context.lineWidth = 14;
    context.strokeRect(7, 7, 242, 242);
    context.fillStyle = '#000';
    context.font = '900 120px "Trebuchet MS", Arial, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(player.pedestal.label, 128, 136);
    const texture = new T.CanvasTexture(canvas);
    texture.colorSpace = T.SRGBColorSpace;

    const side = new T.MeshStandardMaterial({ color: player.pedestal.color, roughness: 0.5 });
    const front = new T.MeshStandardMaterial({ map: texture, roughness: 0.5 });
    const mesh = new T.Mesh(new T.BoxGeometry(1.08, height, 0.95), [side, side, side, side, front, side]);
    mesh.position.set(entry.rig.root.position.x, height / 2, 0);
    this.scene!.add(mesh);
    entry.pedestal = mesh;
  }

  private removePedestal(entry: StageEntry): void {
    const mesh = entry.pedestal;

    if (!mesh) {
      return;
    }

    this.scene?.remove(mesh);
    mesh.geometry.dispose();

    for (const material of mesh.material as ThreeModule.MeshStandardMaterial[]) {
      material.map?.dispose();
      material.dispose();
    }

    entry.pedestal = undefined;
  }

  private resize(): void {    const host = this.hostRef().nativeElement;
    const width = Math.max(1, host.clientWidth);
    const height = Math.max(1, host.clientHeight);
    this.renderer?.setSize(width, height, false);

    if (this.camera) {
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
    }
  }
}
