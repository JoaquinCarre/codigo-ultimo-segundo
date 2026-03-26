# CÓDIGO: ÚLTIMO SEGUNDO — Servidor Multijugador

Juego cooperativo de desactivación de bombas, 2 a 6 jugadores en tiempo real.

## Estructura

```
ultimo-segundo/
├── src/
│   └── server.js       ← Servidor Express + WebSocket
├── public/
│   └── index.html      ← Cliente del juego (HTML completo)
├── package.json
├── railway.toml
└── .gitignore
```

## Deploy en Railway (paso a paso)

### 1. Preparar el repositorio en GitHub

```bash
# En tu computadora, entrá a la carpeta del proyecto
cd ultimo-segundo

# Inicializá git
git init
git add .
git commit -m "Primer commit — Código: Último Segundo"

# Creá un repositorio nuevo en github.com (botón + > New repository)
# Nómbralo: codigo-ultimo-segundo
# Dejalo público o privado, sin README ni .gitignore (ya los tenemos)

# Luego conectá y pusheá:
git remote add origin https://github.com/TU_USUARIO/codigo-ultimo-segundo.git
git branch -M main
git push -u origin main
```

### 2. Deployar en Railway

1. Entrá a [railway.app](https://railway.app) y logeate con GitHub
2. Hacé clic en **"New Project"**
3. Seleccioná **"Deploy from GitHub repo"**
4. Elegí el repositorio `codigo-ultimo-segundo`
5. Railway detecta automáticamente que es Node.js y usa el `railway.toml`
6. Esperá ~2 minutos mientras buildea
7. Una vez deployado, entrá a **Settings > Networking > Generate Domain**
8. Railway te da una URL pública tipo: `https://codigo-ultimo-segundo-production.up.railway.app`

### 3. Listo

Compartí esa URL con tus amigos. Cada uno:
- Abre la URL en su navegador
- Escribe su nombre
- El host crea la sala y obtiene un **código de 6 letras**
- Los demás ingresan ese código para unirse
- El host presiona **INICIAR PARTIDA**

## Desarrollo local

```bash
npm install
npm run dev   # con nodemon (auto-reload)
# o
npm start     # sin auto-reload
```

El servidor corre en `http://localhost:3000`

## Cómo funciona la comunicación

- **REST** (`/api/rooms`): crear sala, unirse, consultar estado
- **WebSocket**: sincronización del estado del juego en tiempo real
- El **host** construye el estado inicial del juego (`G`) y lo envía al servidor
- Cada acción del jugador activo modifica `G` localmente y lo empuja al servidor via WebSocket
- El servidor retransmite `G` a todos los conectados → pantallas sincronizadas
- Reconexión automática si se pierde la conexión (cada 3 segundos)

## Capacidad

- Hasta 100 salas simultáneas (limitado por la RAM del plan gratuito de Railway)
- Las salas se limpian automáticamente después de 2 horas de inactividad
- Plan gratuito de Railway: $5 USD de crédito/mes → suficiente para ~500 horas de uso
