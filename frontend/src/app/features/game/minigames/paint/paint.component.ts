import {
  AfterViewInit,
  Component,
  ElementRef,
  OnDestroy,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatchService } from '../../../../core/services/match.service';

type PaintTool = 'brush' | 'eraser' | 'shape';
type PaintShape = 'circle' | 'square' | 'triangle';

const PAINT_TARGETS = [
  'Manzana',
  'Castillo',
  'Cohete',
  'Guitarra',
  'Zapato',
  'Helado',
  'Sombrero',
  'Llave',
  'Barco',
  'Robot',
  'Dinosaurio',
  'Camara',
  'Pizza',
  'Bicicleta',
  'Reloj',
  'Montana',
  'Avion',
  'Lampara',
  'Corona',
  'Paraguas',
  'Fantasma',
  'Taza',
  'Balon',
  'Arbol',
  'Coche',
];

@Component({
  selector: 'app-paint',
  imports: [FormsModule],
  templateUrl: './paint.component.html',
  styleUrl: './paint.component.scss',
})
export class PaintComponent implements AfterViewInit, OnDestroy {
  private readonly matchService = inject(MatchService);
  private readonly canvasRef = viewChild<ElementRef<HTMLCanvasElement>>('paintCanvas');
  private context?: CanvasRenderingContext2D;
  private drawing = false;
  private preparedRoundKey = '';
  private submittedRoundKey = '';
  private timer?: ReturnType<typeof setInterval>;

  readonly match = this.matchService.match;
  readonly isHost = this.matchService.isHost;
  readonly currentPlayerId = this.matchService.currentPlayerId;
  readonly specialRound = computed(() => this.match()?.specialRound || null);
  readonly target = computed(() => this.specialRound()?.paintTarget || null);
  readonly submissions = computed(() => this.specialRound()?.paintSubmissions || []);
  readonly phase = computed(() => this.specialRound()?.paintPhase || 'preparing');
  readonly remainingSeconds = signal(60);
  readonly tool = signal<PaintTool>('brush');
  readonly shape = signal<PaintShape>('circle');
  readonly color = signal('#111111');
  readonly brushSize = signal(10);
  readonly eraserSize = signal(22);
  readonly submitted = signal(false);
  readonly votedTargetId = signal('');
  readonly loading = signal(false);
  readonly errorMessage = signal('');

  readonly submittedCount = computed(() => this.submissions().length);
  readonly totalPlayers = computed(() => this.match()?.totalPlayers || 0);
  readonly votableSubmissions = computed(() =>
    this.submissions().filter((submission) => submission.playerId !== this.currentPlayerId),
  );
  readonly canSubmit = computed(() => this.phase() === 'drawing' && !this.submitted() && !this.loading());

  constructor() {
    effect(() => {
      const match = this.match();
      const specialRound = match?.specialRound;

      if (!match || !specialRound || specialRound.minigameId !== 'paint' || !this.isHost()) {
        return;
      }

      const roundKey = `${match.lobbyId}:${specialRound.roundNumber}:${specialRound.minigameId}`;

      if (this.preparedRoundKey === roundKey || specialRound.preparedByHost || specialRound.paintTarget) {
        return;
      }

      this.preparedRoundKey = roundKey;
      void this.preparePaint(match.lobbyId);
    });

    effect(() => {
      const phase = this.phase();
      const deadline = phase === 'drawing' ? this.specialRound()?.paintEndsAt : this.specialRound()?.paintVoteEndsAt;

      this.syncTimer(deadline || null);
    });
  }

  ngAfterViewInit(): void {
    this.setupCanvas();
  }

  ngOnDestroy(): void {
    this.clearTimer();
  }

  openImageSearch(): void {
    const label = this.target()?.label;

    if (!label) {
      return;
    }

    window.open(`https://www.google.com/search?tbm=isch&q=${encodeURIComponent(label)}`, '_blank', 'noopener');
  }

  setTool(tool: PaintTool): void {
    this.tool.set(tool);
  }

  setBrushSize(value: string | number): void {
    this.brushSize.set(Number(value));
  }

  setEraserSize(value: string | number): void {
    this.eraserSize.set(Number(value));
  }

  hasVoted(): boolean {
    return Boolean(this.votedTargetId());
  }

  startDrawing(event: PointerEvent): void {
    if (this.phase() !== 'drawing' || this.submitted()) {
      return;
    }

    this.drawing = true;
    this.paint(event);
  }

  stopDrawing(): void {
    this.drawing = false;
  }

  paint(event: PointerEvent): void {
    if (!this.drawing || !this.context) {
      return;
    }

    const point = this.getCanvasPoint(event);

    if (this.tool() === 'eraser') {
      this.context.clearRect(
        point.x - this.eraserSize() / 2,
        point.y - this.eraserSize() / 2,
        this.eraserSize(),
        this.eraserSize(),
      );
      return;
    }

    this.context.fillStyle = this.color();

    if (this.tool() === 'shape') {
      this.drawShape(point.x, point.y);
      return;
    }

    this.context.beginPath();
    this.context.arc(point.x, point.y, this.brushSize() / 2, 0, Math.PI * 2);
    this.context.fill();
  }

  async submitDrawing(): Promise<void> {
    const lobbyId = this.match()?.lobbyId;
    const round = this.specialRound();
    const canvas = this.canvasRef()?.nativeElement;

    if (!lobbyId || !round || !canvas || !this.canSubmit()) {
      return;
    }

    const submitKey = `${lobbyId}:${round.roundNumber}:${this.currentPlayerId}`;

    if (submitKey === this.submittedRoundKey) {
      return;
    }

    this.submittedRoundKey = submitKey;
    this.loading.set(true);
    const response = await this.matchService.submitPaintDrawing(lobbyId, canvas.toDataURL('image/png'));
    this.loading.set(false);

    if (!response.ok) {
      this.submittedRoundKey = '';
      this.errorMessage.set(response.reason || 'No se pudo enviar el dibujo.');
      return;
    }

    this.submitted.set(true);
  }

  async vote(targetPlayerId: string): Promise<void> {
    const lobbyId = this.match()?.lobbyId;

    if (!lobbyId || this.phase() !== 'voting' || this.votedTargetId() || targetPlayerId === this.currentPlayerId) {
      return;
    }

    this.loading.set(true);
    const response = await this.matchService.submitPaintVote(lobbyId, targetPlayerId);
    this.loading.set(false);

    if (!response.ok) {
      this.errorMessage.set(response.reason || 'No se pudo votar el dibujo.');
      return;
    }

    this.votedTargetId.set(targetPlayerId);
  }

  private async preparePaint(lobbyId: string): Promise<void> {
    const label = PAINT_TARGETS[Math.floor(Math.random() * PAINT_TARGETS.length)];
    const response = await this.matchService.preparePaintMinigame(lobbyId, {
      id: label.toLowerCase().replace(/\s+/g, '-'),
      label,
    });

    if (!response.ok) {
      this.errorMessage.set(response.reason || 'No se pudo preparar A Pintar.');
    }
  }

  private setupCanvas(): void {
    const canvas = this.canvasRef()?.nativeElement;

    if (!canvas) {
      return;
    }

    const context = canvas.getContext('2d');

    if (!context) {
      return;
    }

    this.context = context;
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
  }

  private drawShape(x: number, y: number): void {
    if (!this.context) {
      return;
    }

    const size = this.brushSize() * 2;

    if (this.shape() === 'square') {
      this.context.fillRect(x - size / 2, y - size / 2, size, size);
      return;
    }

    if (this.shape() === 'triangle') {
      this.context.beginPath();
      this.context.moveTo(x, y - size / 2);
      this.context.lineTo(x - size / 2, y + size / 2);
      this.context.lineTo(x + size / 2, y + size / 2);
      this.context.closePath();
      this.context.fill();
      return;
    }

    this.context.beginPath();
    this.context.arc(x, y, size / 2, 0, Math.PI * 2);
    this.context.fill();
  }

  private getCanvasPoint(event: PointerEvent): { x: number; y: number } {
    const canvas = this.canvasRef()?.nativeElement;
    const rect = canvas?.getBoundingClientRect();

    if (!canvas || !rect) {
      return { x: 0, y: 0 };
    }

    return {
      x: ((event.clientX - rect.left) / rect.width) * canvas.width,
      y: ((event.clientY - rect.top) / rect.height) * canvas.height,
    };
  }

  private syncTimer(deadline: number | null): void {
    this.clearTimer();

    if (!deadline) {
      return;
    }

    const update = () => {
      const nextSeconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      this.remainingSeconds.set(nextSeconds);

      if (nextSeconds <= 0) {
        this.clearTimer();

        if (this.phase() === 'drawing' && !this.submitted()) {
          void this.submitDrawing();
        }
      }
    };

    update();
    this.timer = setInterval(update, 1000);
  }

  private clearTimer(): void {
    if (!this.timer) {
      return;
    }

    clearInterval(this.timer);
    this.timer = undefined;
  }
}
