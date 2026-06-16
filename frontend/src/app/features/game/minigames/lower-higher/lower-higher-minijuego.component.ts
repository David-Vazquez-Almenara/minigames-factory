import { Component, OnInit, OnDestroy, inject, signal, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MinigameService } from '../shared/minigame.service';
import { MinigameProgress } from '../shared/minigame.models';
import { MinigameFullscreenDirective } from '../shared/minigame-fullscreen.directive';

// ============================================================
// PLANTILLA DE MINIJUEGO
// ============================================================
//   1. Copia la carpeta `lower-higher-minijuego/` entera.
//   2. Renombra los archivos, la clase y el selector.
//   3. Añade el componente a minigame.registry.ts:
//   4. ¡Listo! El service lo detecta automáticamente.
// ----------------------------------------------------------------


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

  // DATOS DEL MINIJUEGO (solo lectura, llegan del servidor)  // ⚠️ NO TOCAR

  private readonly minigameService = inject(MinigameService);
  readonly gameInfo = this.minigameService.receiveGameData();
  readonly currentPlayerId = this.minigameService.currentPlayerId;
  get payload() {
    return this.gameInfo?.payload as {
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

    // setTimeout(() => {
    //   this.countdownTimer();
    // }, 8000);
  }


  // VARIABLES ESTATICAS // ⚠️ NO TOCAR
  points = 0;
  readonly finished = signal(false);
  roundTime = this.payload?.time ?? 60;
  hostMinigameData: any;


  // El guest espera a que preparedByHost sea true para leer hostMinigameData,
  private readonly _hostDataEffect = effect(() => {
    const round = this.minigameService.currentRound();
    if (!round?.preparedByHost) return;

    const data = (round as any).hostMinigameData ?? this.payload?.hostMinigameData ?? null;
    if (!this.minigameService.isHost()) {
      this.hostMinigameData = data;
    }
  });

  hostPrepareMinigame(reciveData: object) {
    if (this.minigameService.isHost()) {

      const data = reciveData

      // Lo guardamos localmente en la propiedad
      this.hostMinigameData = data;
      console.log('Host minigame data:', this.hostMinigameData);

      this.minigameService.prepareGenericMinigame(data).then((res) => { if (!res.ok) { console.error('Error al preparar minijuego:', res.reason); } });

      return data;
    }
    return null;
  }

  //=========================================================














  //                   [ ZONA EDITABLE ]
  // ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️










  //=========================================================
  //              CONFIGURACIÓN DEL MINIJUEGO
  //=========================================================


  itemList = [
    {
      "id": 0,
      "name": "Seat Ibiza",
      "price": 18000,
      "image": "https://source.unsplash.com/featured/?seat-ibiza"
    },
    {
      "id": 1,
      "name": "Toyota Corolla",
      "price": 28000,
      "image": "https://source.unsplash.com/featured/?toyota-corolla"
    },
    {
      "id": 2,
      "name": "Tesla Model 3",
      "price": 42000,
      "image": "https://source.unsplash.com/featured/?tesla-model-3"
    },
    {
      "id": 3,
      "name": "BMW M3",
      "price": 95000,
      "image": "https://source.unsplash.com/featured/?bmw-m3"
    },
    {
      "id": 4,
      "name": "Porsche 911 Carrera",
      "price": 145000,
      "image": "https://source.unsplash.com/featured/?porsche-911"
    },
    {
      "id": 5,
      "name": "McLaren 720S",
      "price": 310000,
      "image": "https://source.unsplash.com/featured/?mclaren-720s"
    },
    {
      "id": 6,
      "name": "Lamborghini Huracan",
      "price": 270000,
      "image": "https://source.unsplash.com/featured/?lamborghini-huracan"
    },
    {
      "id": 7,
      "name": "Ferrari SF90 Stradale",
      "price": 450000,
      "image": "https://source.unsplash.com/featured/?ferrari-sf90"
    },
    {
      "id": 8,
      "name": "Bugatti Chiron",
      "price": 3200000,
      "image": "https://source.unsplash.com/featured/?bugatti-chiron"
    },
    {
      "id": 9,
      "name": "Apartamento en Valencia",
      "price": 250000,
      "image": "https://source.unsplash.com/featured/?valencia-apartment"
    },
    {
      "id": 10,
      "name": "Casa en Sevilla",
      "price": 350000,
      "image": "https://source.unsplash.com/featured/?house-spain"
    },
    {
      "id": 11,
      "name": "Villa en Marbella",
      "price": 2500000,
      "image": "https://source.unsplash.com/featured/?marbella-villa"
    },
    {
      "id": 12,
      "name": "Casa de lujo en Ibiza",
      "price": 2900000,
      "image": "https://source.unsplash.com/featured/?ibiza-villa"
    },
    {
      "id": 13,
      "name": "Pizza Margarita",
      "price": 12,
      "image": "https://source.unsplash.com/featured/?margherita-pizza"
    },
    {
      "id": 14,
      "name": "Hamburguesa Gourmet",
      "price": 15,
      "image": "https://source.unsplash.com/featured/?burger"
    },
    {
      "id": 15,
      "name": "Café Espresso",
      "price": 2,
      "image": "https://source.unsplash.com/featured/?espresso"
    },
    {
      "id": 16,
      "name": "iPhone 16",
      "price": 959,
      "image": "https://source.unsplash.com/featured/?iphone"
    },
    {
      "id": 17,
      "name": "MacBook Pro 16",
      "price": 2999,
      "image": "https://source.unsplash.com/featured/?macbook"
    },
    {
      "id": 18,
      "name": "PlayStation 5",
      "price": 549,
      "image": "https://source.unsplash.com/featured/?playstation-5"
    },
    {
      "id": 19,
      "name": "Nintendo Switch",
      "price": 299,
      "image": "https://source.unsplash.com/featured/?nintendo-switch"
    },
    {
      "id": 20,
      "name": "Rolex Submariner",
      "price": 10500,
      "image": "https://source.unsplash.com/featured/?rolex-submariner"
    },
    {
      "id": 21,
      "name": "Bicicleta de montaña",
      "price": 850,
      "image": "https://source.unsplash.com/featured/?mountain-bike"
    },
    {
      "id": 22,
      "name": "Patinete eléctrico",
      "price": 450,
      "image": "https://source.unsplash.com/featured/?electric-scooter"
    },
    {
      "id": 23,
      "name": "Yate de lujo",
      "price": 15000000,
      "image": "https://source.unsplash.com/featured/?luxury-yacht"
    },
    {
      "id": 24,
      "name": "Jet privado",
      "price": 45000000,
      "image": "https://source.unsplash.com/featured/?private-jet"
    },
    {
      "id": 25,
      "name": "Balón de fútbol profesional",
      "price": 150,
      "image": "https://source.unsplash.com/featured/?football-ball"
    },
    {
      "id": 26,
      "name": "Raqueta de tenis profesional",
      "price": 280,
      "image": "https://source.unsplash.com/featured/?tennis-racket"
    },
    {
      "id": 27,
      "name": "Tabla de surf",
      "price": 700,
      "image": "https://source.unsplash.com/featured/?surfboard"
    },
    {
      "id": 28,
      "name": "Drone DJI Mini 4 Pro",
      "price": 999,
      "image": "https://source.unsplash.com/featured/?drone"
    },
    {
      "id": 29,
      "name": "Cámara Canon EOS R6",
      "price": 2500,
      "image": "https://source.unsplash.com/featured/?camera"
    },
    {
      "id": 30,
      "name": "Impresora 3D",
      "price": 600,
      "image": "https://source.unsplash.com/featured/?3d-printer"
    },
    {
      "id": 31,
      "name": "Piano de cola Yamaha",
      "price": 35000,
      "image": "https://source.unsplash.com/featured/?grand-piano"
    },
    {
      "id": 32,
      "name": "Violín Stradivarius",
      "price": 15000000,
      "image": "https://source.unsplash.com/featured/?violin"
    },
    {
      "id": 33,
      "name": "Guitarra Fender Stratocaster",
      "price": 1800,
      "image": "https://source.unsplash.com/featured/?electric-guitar"
    },
    {
      "id": 34,
      "name": "Diamante de 1 quilate",
      "price": 6000,
      "image": "https://source.unsplash.com/featured/?diamond"
    },
    {
      "id": 35,
      "name": "Anillo de compromiso",
      "price": 2500,
      "image": "https://source.unsplash.com/featured/?engagement-ring"
    },
    {
      "id": 36,
      "name": "Lingote de oro de 1 kg",
      "price": 95000,
      "image": "https://source.unsplash.com/featured/?gold-bar"
    },
    {
      "id": 37,
      "name": "Moneda Bitcoin",
      "price": 105000,
      "image": "https://source.unsplash.com/featured/?bitcoin"
    },
    {
      "id": 38,
      "name": "Caballo de competición",
      "price": 500000,
      "image": "https://source.unsplash.com/featured/?race-horse"
    },
    {
      "id": 39,
      "name": "Perro Bulldog Francés",
      "price": 2500,
      "image": "https://source.unsplash.com/featured/?french-bulldog"
    },
    {
      "id": 40,
      "name": "Loro Guacamayo",
      "price": 1800,
      "image": "https://source.unsplash.com/featured/?macaw"
    },
    {
      "id": 41,
      "name": "Traje espacial NASA",
      "price": 12000000,
      "image": "https://source.unsplash.com/featured/?space-suit"
    },
    {
      "id": 42,
      "name": "Satélite pequeño",
      "price": 1000000,
      "image": "https://source.unsplash.com/featured/?satellite"
    },
    {
      "id": 43,
      "name": "Excavadora industrial",
      "price": 350000,
      "image": "https://source.unsplash.com/featured/?excavator"
    },
    {
      "id": 44,
      "name": "Contenedor marítimo",
      "price": 4500,
      "image": "https://source.unsplash.com/featured/?shipping-container"
    },
    {
      "id": 45,
      "name": "Carta Pokémon Charizard Primera Edición",
      "price": 250000,
      "image": "https://source.unsplash.com/featured/?pokemon-card"
    },
    {
      "id": 46,
      "name": "Comic Action Comics #1",
      "price": 3200000,
      "image": "https://source.unsplash.com/featured/?comic-book"
    },
    {
      "id": 47,
      "name": "Cuadro Salvator Mundi",
      "price": 450300000,
      "image": "https://source.unsplash.com/featured/?painting"
    },
    {
      "id": 48,
      "name": "Escultura moderna de galería",
      "price": 85000,
      "image": "https://source.unsplash.com/featured/?sculpture"
    },
    {
      "id": 49,
      "name": "Reloj Patek Philippe Grandmaster Chime",
      "price": 31000000,
      "image": "https://source.unsplash.com/featured/?luxury-watch"
    }
  ]


  minigamesDataPrepare() {
    let data: {
      selectedItem: { id: number; name: string; price: number; image: string }[];
    };


    const numberOfItems = Math.floor(Math.random() * 4) + 7; //entre 7 y 10

    let itemsPicket = []
    for (let i = 0; i < numberOfItems; i++) {
      const ramdomItemPickNumber = Math.floor(Math.random() * this.itemList.length);
      itemsPicket.push(this.itemList[ramdomItemPickNumber])
    }

    if (itemsPicket.length < 7 || itemsPicket.length > 10) {
      setTimeout(() => {
        this.minigamesDataPrepare()
        console.log(numberOfItems)
        console.log('Reintentando obtener datos del minijuego...');
      }, 1000)
      return
    }

    data = {
      selectedItem: itemsPicket,
    }



    this.hostPrepareMinigame(data)
  }








  //=========================================================
  //                LÓGICA DEL MINIJUEGO
  //=========================================================

  /**  FUNCIONES PRINCIPALES MINIJUEGO
  * 
  *   "this.hostMinigameData.X" se usa para datos del minijuego
  * 
  *   sumarPuntos(cantidad: number)
  * 
  *   finishMinigame()
  * 
  */




  roundItem = [0, 1];

  failAnimationStart = false;

  checkAnswer(selectedIndex: number) {

    let itemSelected: any;
    let itemNoSelected: any;

    if (this.roundItem[0] === selectedIndex) {
      itemSelected = this.hostMinigameData.selectedItem[this.roundItem[0]];
      itemNoSelected = this.hostMinigameData.selectedItem[this.roundItem[1]];
    } else {
      itemSelected = this.hostMinigameData.selectedItem[this.roundItem[1]];
      itemNoSelected = this.hostMinigameData.selectedItem[this.roundItem[0]];
    }

    if (itemSelected.price > itemNoSelected.price) {
      this.sumarPuntos(1);
    } else if (itemSelected.price == itemNoSelected.price) {
      this.sumarPuntos(1);
    } else {
      console.log("Fallaste: ", itemSelected.name, " es menor que ", itemNoSelected.name);
      console.log("Precios: ", itemSelected.name, "= ", itemSelected.price, " | ", itemNoSelected.name, "= ", itemNoSelected.price);
      this.failAnimationStart = true;
      setTimeout(() => {
        this.failAnimationStart = false;
      }, 1250);
    }

    if (this.roundItem[1] != this.hostMinigameData.selectedItem.length - 1) {
      this.roundItem = [
        this.roundItem[1],
        this.roundItem[1] + 1
      ];
    } else {
      this.finishMinigame();
    }
  }



















  //  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆   ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆   ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆   ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆   ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆   ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆   ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆   ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆   ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  
  //                   [ ZONA EDITABLE ]





















  //=========================================================
  //        LÓGICA DE PROGRESO Y PUNTUACIÓN ESTATICA
  //=========================================================
  ngOnDestroy(): void {
  }


  //timer con roundTime y ejecuta finishMinigame al llegar a 0 sin interrumpir el resto de funciones
  countdownTimer() {
    const timerInterval = setInterval(() => {
      this.roundTime--;

      if (this.roundTime <= 0) {
        clearInterval(timerInterval);
        this.finishMinigame();
      }
      console.log("Time: " + this.roundTime);
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

  // Llamar a finishMinigame() cuando el jugador termina

  finishMinigame(): void {
    if (this.finished()) return;
    this.finished.set(true);

    this.updateProgress(true); //finishedAt = true

    if (this.minigameService.isHost()) {
      void this.minigameService.submitPoints([
        { playerId: this.minigameService.currentPlayerId, points: this.points * 3 },
      ]);
    }
  }

}