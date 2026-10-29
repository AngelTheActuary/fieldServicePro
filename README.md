# FieldService Pro · Dashboard del Operador Despachador

Evidencia de aprendizaje · Unidad 2 · Programación Web I (UnADM)

## Cómo ejecutarlo
Abrir `index.html` con doble clic en cualquier navegador moderno (Chrome, Edge, Firefox). No requiere servidor, internet ni instalación.

## Estructura de carpetas
```
fieldservice-pro/
├── index.html                  Estructura semántica HTML5 del dashboard
├── README.md                   Este documento
├── css/
│   └── estilos.css             Tema de alto contraste + 4 puntos de quiebre responsivos
├── js/
│   ├── datos.js                MODELO: clases Geo, UnidadServicio, Cuadrilla, ReporteFalla, MotorDespacho + datos semilla
│   ├── mapa.js                 VISTA: clase MapaFieldService (motor de mapa simulado tipo Leaflet/Mapbox)
│   └── dashboard.js            CONTROLADOR: ControladorDashboard + ReproductorProtocolo (video simulado)
└── assets/
    ├── icons/                  Íconos vectoriales SVG
    │   ├── logo.svg
    │   ├── moto.svg            Motocicleta de inspección
    │   ├── camioneta.svg       Camioneta de servicio
    │   ├── van.svg             Van de herramientas
    │   ├── almacen.svg         Almacén de refacciones
    │   └── falla.svg           Sitio de falla
    └── img/
        └── jerarquia-severidad.svg   Gráfico instructivo de severidad 1-5
```

## Cumplimiento de la actividad

| Inciso | Requisito | Dónde se resuelve |
|---|---|---|
| a | `<header>`, `<main>`, `<section>`, `<aside>`, `<footer>` | `index.html` (comentado por bloque) |
| a | `<table>` de reportes activos y de cuadrillas | `#tabla-reportes`, `#tabla-cuadrillas` |
| b | `<div id="map-fieldservice">` vacío | `index.html`; lo inicializa `new MapaFieldService("map-fieldservice")` |
| b.i | Área de cobertura / distritos industriales | `MapaFieldService.dibujarDistritos()` + `dibujarZonasCalor()` |
| b.ii | Íconos dinámicos de vehículos | `MapaFieldService.actualizarUnidades()` (se mueven cada segundo) |
| b.iii | Rutas planificadas | `MotorDespacho.trazarRuta()` + `MapaFieldService.dibujarRutas()` |
| c.i | Mapa interactivo al centro | Zoom (rueda/botones), arrastre, clic en marcadores, tooltips |
| c.ii | Panel de despacho lateral (pendientes y en curso) | `<aside class="panel-despacho">` + `renderPanelDespacho()` |
| c.iii.1 | Filtro por prioridad | Chips `#filtro-prioridad` |
| c.iii.2 | Filtro por estatus de cuadrilla | Select `#filtro-estatus` |
| d.i | Íconos SVG de vehículos | `assets/icons/*.svg` + `<symbol>` en `definirSimbolos()` |
| d.ii | Video / gráfico instructivo | `ReproductorProtocolo` (6 escenas, 30 s) + `jerarquia-severidad.svg` |
| e | Documentación | Cada clase, atributo y método comentado (20-50 palabras por función) |

## Lógica clave (lo que hace "pensar" al sistema)

**Distancia (Haversine).** Para dos puntos con latitudes φ₁, φ₂ y diferencia de longitud Δλ:

d = 2R · arcsin( √( sin²(Δφ/2) + cos φ₁ · cos φ₂ · sin²(Δλ/2) ) ), con R = 6371 km.

**Algoritmo de despacho** (`MotorDespacho.despachar`):
1. Filtra cuadrillas libres con la certificación de la categoría y vehículo con herramienta e inventario ≥ severidad × 12 %.
2. Prefiere las que estén a ≤ 2 km (equivalente a `ST_DWithin` en PostGIS); si no hay, usa toda la flota.
3. Elige la de menor distancia; en empate, mayor calificación.
4. Traza una ruta en escalón (métrica tipo Manhattan, más realista en ciudad que la línea recta).
5. ETA = distancia ÷ velocidad del vehículo × factor de tráfico (1.0 / 1.35 / 1.8 según la hora).

**Tiempo real.** `tickGPS()` corre cada segundo (1 s real = 30 s operativos) y sustituye a `socket.on('posicion')` de Socket.IO. Cada 40 s llega un reporte nuevo que se despacha solo.

**Flujo de estatus:** Pendiente ➔ Asignado ➔ En Camino ➔ En Sitio ➔ Solucionado, con registro de los 5 tiempos críticos del caso.

## Diseño responsivo
- ≥ 1280 px: 3 columnas (filtros | mapa | despacho), pensado para monitores de sala de control.
- 900-1279 px: 2 columnas, el mapa ocupa el alto de filtros + despacho.
- 600-899 px: 1 columna; el mapa va primero, luego el despacho.
- < 600 px: versión compacta para el supervisor en campo; las tablas hacen scroll horizontal.
- Respeta `prefers-reduced-motion` y tiene foco visible para teclado.

## Migración a Leaflet real
Solo cambia el interior de `mapa.js`; el controlador no se modifica:
```js
const mapa = L.map('map-fieldservice').setView([19.43, -99.13], 12);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(mapa);
L.polygon(distrito.vertices.map(v => [v.lat, v.lng])).addTo(mapa);   // dibujarDistritos
L.marker([c.posicion.lat, c.posicion.lng], { icon }).addTo(mapa);    // actualizarUnidades
L.polyline(r.ruta.map(p => [p.lat, p.lng])).addTo(mapa);              // dibujarRutas
```
