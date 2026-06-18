import { Component, OnInit, OnDestroy, inject, signal, computed, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MinigameService } from '../shared/minigame.service';
import { MinigameProgress } from '../shared/minigame.models';
import { MinigameFullscreenDirective } from '../shared/minigame-fullscreen.directive';

type CardSlot = 'slot-0' | 'slot-1' | 'slot-incoming' | 'exit';

interface VisibleCard {
  index: number;
  slot: CardSlot;
  showPrice: boolean;
}

@Component({
  selector: 'app-lower-higher-minijuego',
  standalone: true,
  imports: [CommonModule, MinigameFullscreenDirective],
  templateUrl: './lower-higher-minijuego.component.html',
  styleUrls: ['./lower-higher-minijuego.component.css', './config-css-minijuego.component.css']
})
export class LowerHigherMinijuegoComponent implements OnInit, OnDestroy {

  //=========================================================
  //         ⚠️ DATOS ESTATICOS DEL MINIJUEGO ⚠️
  //=========================================================

  private readonly minigameService = inject(MinigameService);
  readonly gameInfo = computed(() => this.minigameService.receiveGameData());
  readonly currentPlayerId = this.minigameService.currentPlayerId;
  get payload() {
    return this.gameInfo()?.payload as {
      roundNumber: number;
      minigameId: string;
      title: string;
      description: string;
      preparedByHost: boolean;
      progress: unknown[];
      results: unknown[];
      time: number;
      hostMinigameData: any;
    } | undefined;
  }

  ngOnInit(): void {
    if (this.minigameService.isHost()) {
      this.minigamesDataPrepare();
    }
    this.countdownTimer();
  }

  // VARIABLES ESTATICAS
  points = 0;
  readonly finished = signal(false);
  roundTime = this.payload?.time ?? 60;
  hostMinigameData: any;
  private timerInterval?: ReturnType<typeof setInterval>;

  private readonly _hostDataEffect = effect(() => {
    const round = this.minigameService.currentRound();
    if (!round?.preparedByHost) return;

    const data = (round as any).hostMinigameData ?? this.payload?.hostMinigameData ?? null;
    if (!this.minigameService.isHost()) {
      this.hostMinigameData = data;
    }
    if (!this.hostMinigameData && data) {
      this.hostMinigameData = data;
    }
  });

  hostPrepareMinigame(reciveData: object) {
    if (this.minigameService.isHost()) {
      const data = reciveData
      this.hostMinigameData = data;
      console.log('Host minigame data:', this.hostMinigameData);
      this.minigameService.prepareGenericMinigame(data).then((res) => { if (!res.ok) { console.error('Error al preparar minijuego:', res.reason); } });
      return data;
    }
    return null;
  }

  //=========================================================

  //=========================================================
  //              CONFIGURACIÓN DEL MINIJUEGO
  //=========================================================

  itemList = [
    { "id": 0, "name": "Seat Ibiza", "price": 18000, "image": "/minigame-assets/lower-or-higher/Seat-Ibiza.avif" },
    { "id": 1, "name": "Toyota Corolla", "price": 28000, "image": "/minigame-assets/lower-or-higher/Toyota-Corolla.png" },
    { "id": 2, "name": "Tesla Model 3", "price": 42000, "image": "/minigame-assets/lower-or-higher/Tesla-Model-3.png" },
    { "id": 3, "name": "BMW M3", "price": 95000, "image": "/minigame-assets/lower-or-higher/BMW-M3.jpg" },
    { "id": 4, "name": "Porsche 911 Carrera", "price": 145000, "image": "/minigame-assets/lower-or-higher/Porsche-911-Carrera.jpg" },
    { "id": 5, "name": "McLaren 720S", "price": 310000, "image": "/minigame-assets/lower-or-higher/McLaren-720S.jpg" },
    { "id": 6, "name": "Lamborghini Huracan", "price": 270000, "image": "/minigame-assets/lower-or-higher/Lamborghini-Huracan.jpg" },
    { "id": 7, "name": "Ferrari SF90 Stradale", "price": 450000, "image": "/minigame-assets/lower-or-higher/Ferrari-SF90-Stradale.jpg" },
    { "id": 8, "name": "Bugatti Chiron", "price": 3200000, "image": "/minigame-assets/lower-or-higher/Bugatti-Chiron.jpg" },
    { "id": 9, "name": "Apartamento en Valencia", "price": 250000, "image": "/minigame-assets/lower-or-higher/Apartamento-en-Valencia.jpg" },
    { "id": 10, "name": "Casa en Sevilla", "price": 350000, "image": "/minigame-assets/lower-or-higher/Casa-en-Sevilla.jpg" },
    { "id": 11, "name": "Villa en Marbella", "price": 2500000, "image": "/minigame-assets/lower-or-higher/Villa-en-Marbella.jpg" },
    { "id": 12, "name": "Casa de lujo en Ibiza", "price": 2900000, "image": "/minigame-assets/lower-or-higher/Casa-de-lujo-en-Ibiza.png" },
    { "id": 13, "name": "Pizza Margarita", "price": 12, "image": "/minigame-assets/lower-or-higher/Pizza-Margarita.avif" },
    { "id": 14, "name": "Hamburguesa Gourmet", "price": 15, "image": "/minigame-assets/lower-or-higher/Hamburguesa-Gourmet.webp" },
    { "id": 15, "name": "Café Espresso", "price": 2, "image": "/minigame-assets/lower-or-higher/Café-Espresso.jpg" },
    { "id": 16, "name": "iPhone 16", "price": 959, "image": "/minigame-assets/lower-or-higher/iPhone-16.jpg" },
    { "id": 17, "name": "MacBook Pro 16", "price": 2999, "image": "/minigame-assets/lower-or-higher/MacBook-Pro-16.jpg" },
    { "id": 18, "name": "PlayStation 5", "price": 549, "image": "/minigame-assets/lower-or-higher/PlayStation-5.webp" },
    { "id": 19, "name": "Nintendo Switch", "price": 299, "image": "/minigame-assets/lower-or-higher/Nintendo-Switch.jpg" },
    { "id": 20, "name": "Rolex Submariner", "price": 10500, "image": "/minigame-assets/lower-or-higher/Rolex-Submariner.avif" },
    { "id": 21, "name": "Bicicleta de montaña", "price": 850, "image": "/minigame-assets/lower-or-higher/Bicicleta-de-montaña.jpg" },
    { "id": 22, "name": "Patinete eléctrico", "price": 450, "image": "/minigame-assets/lower-or-higher/Patinete-eléctrico.webp" },
    { "id": 23, "name": "Yate de lujo", "price": 15000000, "image": "/minigame-assets/lower-or-higher/Yate-de-lujo.webp" },
    { "id": 24, "name": "Jet privado", "price": 45000000, "image": "/minigame-assets/lower-or-higher/Jet-privado.jpg" },
    { "id": 25, "name": "Balón de fútbol profesional", "price": 150, "image": "/minigame-assets/lower-or-higher/Balón-de-fútbol-profesional.webp" },
    { "id": 26, "name": "Raqueta de tenis profesional", "price": 280, "image": "/minigame-assets/lower-or-higher/Raqueta-de-tenis-profesional.jpg" },
    { "id": 27, "name": "Tabla de surf", "price": 700, "image": "/minigame-assets/lower-or-higher/Tabla-de-surf.jpg" },
    { "id": 28, "name": "Drone DJI Mini 4 Pro", "price": 999, "image": "/minigame-assets/lower-or-higher/Drone-DJI-Mini-4-Pro.jpg" },
    { "id": 29, "name": "Cámara Canon EOS R6", "price": 2500, "image": "/minigame-assets/lower-or-higher/Cámara-Canon-EOS-R6.webp" },
    { "id": 30, "name": "Impresora 3D", "price": 600, "image": "/minigame-assets/lower-or-higher/Impresora-3D.jpg" },
    { "id": 31, "name": "Piano de cola Yamaha", "price": 35000, "image": "/minigame-assets/lower-or-higher/Piano-de-cola-Yamaha.jpg" },
    { "id": 32, "name": "Violín Stradivarius", "price": 15000000, "image": "/minigame-assets/lower-or-higher/Violín-Stradivarius.jpg" },
    { "id": 33, "name": "Guitarra Fender Stratocaster", "price": 1800, "image": "/minigame-assets/lower-or-higher/Guitarra-Fender-Stratocaster.webp" },
    { "id": 34, "name": "Diamante de 1 quilate", "price": 6000, "image": "/minigame-assets/lower-or-higher/Diamante-de-1-quilate.jpg" },
    { "id": 35, "name": "Anillo de compromiso", "price": 2500, "image": "/minigame-assets/lower-or-higher/Anillo-de-compromiso.jpg" },
    { "id": 36, "name": "Lingote de oro de 1 kg", "price": 95000, "image": "/minigame-assets/lower-or-higher/Lingote-de-oro-de-1-kg.jpg" },
    { "id": 37, "name": "Moneda Bitcoin", "price": 105000, "image": "/minigame-assets/lower-or-higher/Moneda-Bitcoin.webp" },
    { "id": 38, "name": "Caballo de competición", "price": 500000, "image": "/minigame-assets/lower-or-higher/Caballo-de-competición.jpg" },
    { "id": 39, "name": "Perro Bulldog Francés", "price": 2500, "image": "/minigame-assets/lower-or-higher/Perro-Bulldog-Francés.jpg" },
    { "id": 40, "name": "Loro Guacamayo", "price": 1800, "image": "/minigame-assets/lower-or-higher/Loro-Guacamayo.jpg" },
    { "id": 41, "name": "Traje espacial NASA", "price": 12000000, "image": "/minigame-assets/lower-or-higher/Traje-espacial-NASA.jpg" },
    { "id": 42, "name": "Satélite pequeño", "price": 1000000, "image": "/minigame-assets/lower-or-higher/Satélite-pequeño.jpg" },
    { "id": 43, "name": "Excavadora industrial", "price": 350000, "image": "/minigame-assets/lower-or-higher/Excavadora-industrial.jpg" },
    { "id": 44, "name": "Contenedor marítimo", "price": 4500, "image": "/minigame-assets/lower-or-higher/Contenedor-marítimo.jpg" },
    { "id": 45, "name": "Carta Pokémon Charizard Primera Edición", "price": 250000, "image": "/minigame-assets/lower-or-higher/Carta-Pokémon-Charizard-Primera-Edición.jpg" },
    { "id": 46, "name": "Comic Action Comics #1", "price": 3200000, "image": "/minigame-assets/lower-or-higher/Comic-Action-Comics-1.jpg" },
    { "id": 47, "name": "Cuadro Salvator Mundi", "price": 450300000, "image": "/minigame-assets/lower-or-higher/Cuadro-Salvator-Mundi.jpg" },
    { "id": 48, "name": "Escultura moderna de galería", "price": 85000, "image": "/minigame-assets/lower-or-higher/Escultura-moderna-de-galería.jpg" },
    { "id": 49, "name": "Reloj Patek Philippe Grandmaster Chime", "price": 31000000, "image": "/minigame-assets/lower-or-higher/Reloj-Patek-Philippe-Grandmaster-Chime.jpg" }
  ]

  minigamesDataPrepare() {
    const numberOfItems = Math.floor(Math.random() * 4) + 7;
    let itemsPicket = []
    for (let i = 0; i < numberOfItems; i++) {
      const ramdomItemPickNumber = Math.floor(Math.random() * this.itemList.length);
      itemsPicket.push(this.itemList[ramdomItemPickNumber])
    }

    if (itemsPicket.length < 7 || itemsPicket.length > 10) {
      setTimeout(() => {
        this.minigamesDataPrepare()
        console.log('Reintentando obtener datos del minijuego...');
      }, 1000)
      return
    }

    this.hostPrepareMinigame({ selectedItem: itemsPicket })
  }

  //=========================================================
  //          LÓGICA DEL MINIJUEGO (CARRUSEL + PRECIOS)
  //=========================================================

  readonly cardSlots = signal<[number, number]>([0, 1]);
  readonly carouselPhase = signal<'idle' | 'incoming-shown' | 'active'>('idle');
  readonly showCorrectAnim = signal(false);
  readonly showWrongAnim = signal(false);
  readonly lastClickedIndex = signal<number | null>(null);

  readonly nextCardIndex = computed(() => {
    const items = this.hostMinigameData?.selectedItem;
    if (!items || !items.length) return null;
    const next = this.cardSlots()[1] + 1;
    return next < items.length ? next : null;
  });

  readonly showPrices = signal(false);

  readonly blocked = computed(() =>
    this.finished() || this.carouselPhase() !== 'idle' || this.showPrices()
  );

  readonly visibleCards = computed<VisibleCard[]>(() => {
    const items = this.hostMinigameData?.selectedItem;
    if (!items || !items.length) return [];

    const phase = this.carouselPhase();
    const s0 = this.cardSlots()[0];
    const s1 = this.cardSlots()[1];
    const result: VisibleCard[] = [];

    // Slot-0: always shows price, exits during carousel
    result.push({
      index: s0,
      slot: phase === 'active' ? 'exit' : 'slot-0',
      showPrice: true
    });

    // Slot-1: shows price during interaction+carousel, shifts to slot-0 during carousel
    result.push({
      index: s1,
      slot: phase === 'active' ? 'slot-0' : 'slot-1',
      showPrice: this.showPrices() || phase !== 'idle'
    });

    // Incoming card (only during carousel, never shows price)
    const next = this.nextCardIndex();
    if (next !== null && phase !== 'idle') {
      result.push({
        index: next,
        slot: phase === 'incoming-shown' ? 'slot-incoming' : 'slot-1',
        showPrice: false
      });
    }

    return result;
  });

  leftForSlot(slot: CardSlot): string {
    switch (slot) {
      case 'slot-0': return 'calc(50% - 42% - 12px)';
      case 'slot-1': return 'calc(50% + 12px)';
      case 'slot-incoming': return 'calc(100% + 10px)';
      case 'exit': return 'calc(0% - 42% - 40px)';
    }
  }

  //=========================================================
  //             FEEDBACK + CARRUSEL FLOW
  //=========================================================

  private answerLock = false;
  private feedbackTimer?: ReturnType<typeof setTimeout>;
  private carouselTimer?: ReturnType<typeof setTimeout>;

  checkAnswer(selectedIndex: number) {
    if (this.answerLock || this.finished() || !this.hostMinigameData?.selectedItem) return;

    this.answerLock = true;
    const items = this.hostMinigameData.selectedItem;
    const slotA = this.cardSlots()[0];
    const slotB = this.cardSlots()[1];
    const itemSelected = selectedIndex === slotA ? items[slotA] : items[slotB];
    const itemNoSelected = selectedIndex === slotA ? items[slotB] : items[slotA];

    this.lastClickedIndex.set(selectedIndex);
    this.showPrices.set(true);

    if (itemSelected.price >= itemNoSelected.price) {
      this.sumarPuntos(1);
      this.showCorrectAnim.set(true);
      this.feedbackTimer = setTimeout(() => this.showCorrectAnim.set(false), 700);
    } else {
      console.log("Fallaste:", itemSelected.name, itemSelected.price, "<", itemNoSelected.name, itemNoSelected.price);
      this.showWrongAnim.set(true);
      this.feedbackTimer = setTimeout(() => this.showWrongAnim.set(false), 700);
    }

    if (slotB >= items.length - 1) {
      setTimeout(() => {
        this.finishMinigame();
      }, 2000);
      return;
    }

    // Step 1: show feedback + prices for 2 seconds, then start carousel
    this.carouselTimer = setTimeout(() => {
      this.startCarousel(slotB);
    }, 2000);
  }

  private startCarousel(slotB: number): void {
    // Step 2: render incoming card off-screen
    this.carouselPhase.set('incoming-shown');

    // Step 3: next frame → trigger left transitions
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        this.carouselPhase.set('active');
      });
    });

    // Step 4: after transitions complete, update data
    this.carouselTimer = setTimeout(() => {
      this.cardSlots.set([slotB, slotB + 1]);
      this.carouselPhase.set('idle');
      this.showPrices.set(false);
      this.answerLock = false;
    }, 680);
  }

  //=========================================================
  //        LÓGICA DE PROGRESO Y PUNTUACIÓN ESTATICA
  //=========================================================
  ngOnDestroy(): void {
    this.clearTimer();
    if (this.feedbackTimer !== undefined) clearTimeout(this.feedbackTimer);
    if (this.carouselTimer !== undefined) clearTimeout(this.carouselTimer);
  }

  private clearTimer(): void {
    if (this.timerInterval !== undefined) {
      clearInterval(this.timerInterval);
      this.timerInterval = undefined;
    }
  }

  countdownTimer() {
    this.clearTimer();
    this.timerInterval = setInterval(() => {
      if (this.finished()) {
        this.clearTimer();
        return;
      }
      this.roundTime--;
      if (this.roundTime <= 0) {
        this.clearTimer();
        this.finishMinigame();
      }
    }, 1000);
  }

  sumarPuntos(cantidad: number): void {
    this.points += cantidad;
    this.updateProgress();
  }

  updateProgress(completed = false): void {
    const progress: MinigameProgress = {
      answeredCount: this.points,
      correctCount: this.points,
      completed,
      finishedAt: completed ? Date.now() : null,
    };
    this.minigameService.submitProgress(progress).then((res) => {
      if (!res.ok) console.error('Error al reportar progreso:', res.reason);
    });
  }

  finishMinigame(): void {
    if (this.finished()) return;
    this.finished.set(true);
    this.clearTimer();
    this.updateProgress(true);
    if (this.minigameService.isHost()) {
      void this.minigameService.submitPoints([
        { playerId: this.minigameService.currentPlayerId, points: this.points * 3 },
      ]);
    }
  }

}
