/* =====================================================================
   FieldService Pro · js/mapa.js
   ---------------------------------------------------------------------
   MOTOR DE MAPA SIMULADO. La clase MapaFieldService toma el <div>
   vacío #map-fieldservice y dibuja dentro un SVG con capas geográficas,
   reproduciendo la API típica de Leaflet / Mapbox GL JS:
       Leaflet:  L.map('map-fieldservice')      → new MapaFieldService('map-fieldservice')
       Capas:    L.polygon / L.marker / L.polyline → dibujarDistritos / actualizarUnidades / dibujarRutas
   Para migrar a un motor real solo se reemplaza el cuerpo de estos
   métodos; el controlador (dashboard.js) no necesita cambiar.
   ===================================================================== */
"use strict";

class MapaFieldService {
  /**
   * Inicializa el motor: localiza el contenedor vacío, calcula el lienzo
   * respetando la proporción real del área (corrigiendo longitud con coseno
   * de la latitud), crea el SVG, sus capas apiladas y los eventos de interacción.
   */
  constructor(idContenedor, limites) {
    this.contenedor = document.getElementById(idContenedor);
    this.limites = limites;
    this.NS = "http://www.w3.org/2000/svg";

    /* Proporción real: ancho en km / alto en km */
    const latMedia = (limites.latMin + limites.latMax) / 2;
    const anchoKm = (limites.lngMax - limites.lngMin) * 111.32 * Math.cos((latMedia * Math.PI) / 180);
    const altoKm = (limites.latMax - limites.latMin) * 111.32;
    this.W = 1000;
    this.H = Math.round(this.W * (altoKm / anchoKm));
    this.pxPorKm = this.W / anchoKm;

    /* Ventana visible (viewBox): se modifica al hacer zoom o arrastrar */
    this.vista = { x: 0, y: 0, w: this.W, h: this.H };

    this.oyentes = {};          // mini sistema de eventos (clic en marcadores)
    this.cache = {};            // últimos datos dibujados, para redibujar tras zoom
    this.seleccion = null;      // { tipo: "reporte"|"cuadrilla", id }

    this.crearLienzo();
    this.definirSimbolos();
    this.dibujarCalles();
    this.habilitarInteraccion();
  }

  /* ------------------------------------------------------------------
     UTILIDADES
     ------------------------------------------------------------------ */

  /**
   * Proyección equirectangular: convierte latitud/longitud en coordenadas x,y
   * del lienzo. Es lineal porque el área es pequeña (~30 km); en Mapbox esto
   * lo resuelve internamente la proyección Web Mercator.
   */
  proyectar({ lat, lng }) {
    const { latMin, latMax, lngMin, lngMax } = this.limites;
    return {
      x: ((lng - lngMin) / (lngMax - lngMin)) * this.W,
      y: ((latMax - lat) / (latMax - latMin)) * this.H
    };
  }

  /**
   * Fábrica de nodos SVG: crea una etiqueta en el espacio de nombres correcto,
   * asigna atributos desde un objeto y, opcionalmente, la inserta en un padre.
   * Reduce código repetitivo y evita errores al usar createElementNS.
   */
  crear(tag, atributos = {}, padre = null) {
    const el = document.createElementNS(this.NS, tag);
    for (const [k, v] of Object.entries(atributos)) el.setAttribute(k, v);
    if (padre) padre.appendChild(el);
    return el;
  }

  /**
   * Factor de escala inverso al zoom. Se aplica a los marcadores para que
   * conserven su tamaño en pantalla mientras el mapa se acerca o aleja, el
   * mismo comportamiento que tienen los íconos en Leaflet o Mapbox.
   */
  get escalaMarcador() {
    return this.vista.w / this.W;
  }

  /* ------------------------------------------------------------------
     CONSTRUCCIÓN DEL LIENZO
     ------------------------------------------------------------------ */

  /**
   * Crea el elemento SVG raíz y las capas (grupos <g>) en orden de apilamiento:
   * calles, distritos, calor, cobertura, rutas, almacenes, fallas y unidades.
   * También agrega el tooltip flotante y la barra de escala gráfica.
   */
  crearLienzo() {
    this.svg = this.crear("svg", {
      viewBox: `0 0 ${this.W} ${this.H}`,
      preserveAspectRatio: "xMidYMid meet",
      role: "img",
      "aria-label": "Mapa de operaciones FieldService Pro"
    }, this.contenedor);
    this.defs = this.crear("defs", {}, this.svg);

    this.capas = {};
    ["calles", "cobertura", "calor", "distritos", "radio", "rutas", "almacenes", "fallas", "unidades"]
      .forEach((nombre) => (this.capas[nombre] = this.crear("g", { "data-capa": nombre }, this.svg)));

    this.tooltip = document.createElement("div");
    this.tooltip.className = "tooltip-mapa";
    this.contenedor.appendChild(this.tooltip);

    this.escala = document.createElement("div");
    this.escala.className = "escala-mapa";
    this.contenedor.appendChild(this.escala);
    this.actualizarEscala();
  }

  /**
   * Declara en <defs> los íconos vectoriales reutilizables (moto, camioneta,
   * van, almacén y falla) como <symbol>. Usan currentColor, así un mismo
   * dibujo cambia de color según el estatus de la unidad sin duplicar archivos.
   */
  definirSimbolos() {
    const simbolos = {
      moto: `<circle cx="8" cy="22" r="5" fill="none" stroke="currentColor" stroke-width="2.6"/>
             <circle cx="24" cy="22" r="5" fill="none" stroke="currentColor" stroke-width="2.6"/>
             <path d="M8 22 13 13h7l4 9M13 13l-2-4H7m13 4 2-4h4" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>`,
      camioneta: `<path d="M2 22v-7l3-6h10v6h11l4 4v3z" fill="currentColor"/>
                  <path d="M6 14l2-3.5h4V14z" fill="#05080b"/>
                  <circle cx="9" cy="23" r="3.6" fill="#05080b" stroke="currentColor" stroke-width="2"/>
                  <circle cx="24" cy="23" r="3.6" fill="#05080b" stroke="currentColor" stroke-width="2"/>`,
      van: `<path d="M2 22V9a2 2 0 0 1 2-2h17l8 7v8z" fill="currentColor"/>
            <path d="M21 9h-1v5h6z" fill="#05080b"/>
            <path d="M8 11.5a2.5 2.5 0 0 0 3.2 3.2l3.3 3.3 1.5-1.5-3.3-3.3A2.5 2.5 0 0 0 9.5 10l1.3 1.3-1 1z" fill="#05080b"/>
            <circle cx="9" cy="23" r="3.6" fill="#05080b" stroke="currentColor" stroke-width="2"/>
            <circle cx="23" cy="23" r="3.6" fill="#05080b" stroke="currentColor" stroke-width="2"/>`,
      almacen: `<path d="M3 13 16 5l13 8v14H3z" fill="currentColor"/>
                <path d="M9 27V16h14v11M9 19.5h14M9 23h14" fill="none" stroke="#05080b" stroke-width="2"/>`,
      falla: `<path d="M16 3 30 28H2z" fill="currentColor" stroke="#05080b" stroke-width="1.5" stroke-linejoin="round"/>
              <path d="M17.5 10 12 19h4l-1.5 6.5L20 16h-4z" fill="#05080b"/>`
    };
    for (const [id, cuerpo] of Object.entries(simbolos)) {
      const s = this.crear("symbol", { id: `ico-${id}`, viewBox: "0 0 32 32" }, this.defs);
      s.innerHTML = cuerpo;
    }

    /* Degradado radial para el mapa de calor (rojo intenso → transparente) */
    const g = this.crear("radialGradient", { id: "grad-calor" }, this.defs);
    this.crear("stop", { offset: "0%", "stop-color": "#ff3b47", "stop-opacity": "0.75" }, g);
    this.crear("stop", { offset: "55%", "stop-color": "#ff7a20", "stop-opacity": "0.3" }, g);
    this.crear("stop", { offset: "100%", "stop-color": "#ffb020", "stop-opacity": "0" }, g);
  }

  /**
   * Dibuja una trama urbana de fondo: calles secundarias en cuadrícula y
   * dos vialidades primarias (anillo tipo Circuito Interior y eje tipo
   * Periférico). Solo es referencia visual; no participa en el cálculo de rutas.
   */
  dibujarCalles() {
    const c = this.capas.calles;
    this.crear("rect", { x: 0, y: 0, width: this.W, height: this.H, fill: "#05080b" }, c);
    for (let x = 0; x <= this.W; x += 40) this.crear("line", { x1: x, y1: 0, x2: x, y2: this.H, class: "calle" }, c);
    for (let y = 0; y <= this.H; y += 40) this.crear("line", { x1: 0, y1: y, x2: this.W, y2: y, class: "calle" }, c);

    const centro = this.proyectar({ lat: 19.425, lng: -99.155 });
    this.crear("ellipse", { cx: centro.x, cy: centro.y, rx: 170, ry: 150, class: "calle calle-principal" }, c);
    const a = this.proyectar({ lat: 19.545, lng: -99.215 });
    const b = this.proyectar({ lat: 19.430, lng: -99.215 });
    const d = this.proyectar({ lat: 19.315, lng: -99.180 });
    this.crear("path", { d: `M${a.x} ${a.y} L${b.x} ${b.y} L${d.x} ${d.y}`, class: "calle calle-principal" }, c);
  }

  /* ------------------------------------------------------------------
     CAPAS ESTÁTICAS
     ------------------------------------------------------------------ */

  /**
   * Requisito b.i: pinta el área de cobertura técnica. Dibuja la envolvente
   * general de servicio y cada distrito como polígono coloreado por tipo
   * (industrial en ámbar, comercial en azul), con su nombre centrado.
   */
  dibujarDistritos(distritos) {
    /* Envolvente de cobertura: rectángulo redondeado que abarca todos los distritos */
    const cob = this.capas.cobertura;
    cob.innerHTML = "";
    const todos = distritos.flatMap((d) => d.vertices.map((v) => this.proyectar(v)));
    const xs = todos.map((p) => p.x), ys = todos.map((p) => p.y);
    this.crear("rect", {
      x: Math.min(...xs) - 25, y: Math.min(...ys) - 25,
      width: Math.max(...xs) - Math.min(...xs) + 50, height: Math.max(...ys) - Math.min(...ys) + 50,
      rx: 40, class: "cobertura"
    }, cob);

    const g = this.capas.distritos;
    g.innerHTML = "";
    distritos.forEach((d) => {
      const pts = d.vertices.map((v) => this.proyectar(v));
      const color = d.tipo === "industrial" ? "#ffb020" : "#4c8dff";
      const poligono = this.crear("polygon", {
        points: pts.map((p) => `${p.x},${p.y}`).join(" "),
        class: "distrito", fill: color, stroke: color
      }, g);
      poligono.addEventListener("mousemove", (e) => this.mostrarTooltip(e, `<b>${d.nombre}</b><br>Distrito ${d.tipo}`));
      poligono.addEventListener("mouseleave", () => this.ocultarTooltip());

      const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
      const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
      const t = this.crear("text", { x: cx, y: cy, "text-anchor": "middle", class: "etiqueta-distrito" }, g);
      t.textContent = d.nombre;
    });
  }

  /**
   * Superpone el mapa de calor de zonas de alta incidencia. Cada zona es un
   * círculo con degradado radial cuyo radio en píxeles proviene del radio en
   * km y cuya opacidad es proporcional a la intensidad histórica de fallas.
   */
  dibujarZonasCalor(zonas) {
    const g = this.capas.calor;
    g.innerHTML = "";
    zonas.forEach((z) => {
      const p = this.proyectar(z);
      this.crear("circle", {
        cx: p.x, cy: p.y, r: z.radioKm * this.pxPorKm,
        fill: "url(#grad-calor)", opacity: 0.35 + 0.65 * z.intensidad, class: "zona-calor"
      }, g);
    });
  }

  /**
   * Coloca los almacenes técnicos de refacciones con el símbolo de bodega en
   * color violeta. Muestran tooltip con su nombre al pasar el cursor, lo que
   * ayuda al despachador a ubicar el punto de salida de las unidades.
   */
  dibujarAlmacenes(almacenes) {
    this.cache.almacenes = almacenes;
    const g = this.capas.almacenes;
    g.innerHTML = "";
    const k = this.escalaMarcador;
    almacenes.forEach((a) => {
      const p = this.proyectar(a);
      const m = this.crear("g", { transform: `translate(${p.x} ${p.y}) scale(${k})`, class: "marcador", color: "#b07cff" }, g);
      this.crear("use", { href: "#ico-almacen", x: -13, y: -13, width: 26, height: 26 }, m);
      m.addEventListener("mousemove", (e) => this.mostrarTooltip(e, `<b>${a.nombre}</b><br>Centro de suministro`));
      m.addEventListener("mouseleave", () => this.ocultarTooltip());
    });
  }

  /* ------------------------------------------------------------------
     CAPAS DINÁMICAS (se redibujan en cada "tick" GPS)
     ------------------------------------------------------------------ */

  /**
   * Requisito b.iii: dibuja las rutas de atención planificadas de los reportes
   * asignados o en camino. Cada polilínea se colorea según prioridad y se
   * anima con stroke-dashoffset para comunicar el sentido del desplazamiento.
   */
  dibujarRutas(reportes) {
    this.cache.reportes = reportes;
    const g = this.capas.rutas;
    g.innerHTML = "";
    reportes
      .filter((r) => r.ruta.length && (r.estatus === "asignado" || r.estatus === "en-camino"))
      .forEach((r) => {
        const d = r.ruta.map((pt, i) => {
          const p = this.proyectar(pt);
          return `${i ? "L" : "M"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
        }).join(" ");
        const resaltada = this.seleccion && this.seleccion.tipo === "reporte" && this.seleccion.id === r.folio;
        this.crear("path", {
          d, class: `ruta ruta-${r.prioridad}${resaltada ? " resaltada" : ""}`,
          "stroke-width": (resaltada ? 7 : 4) * this.escalaMarcador
        }, g);
      });
  }

  /**
   * Muestra un marcador pulsante por cada reporte abierto en su ubicación.
   * El color del triángulo depende de la prioridad y al hacer clic emite el
   * evento "reporte" para que el controlador abra el detalle del operativo.
   */
  actualizarFallas(reportes) {
    this.cache.reportes = reportes;
    const g = this.capas.fallas;
    g.innerHTML = "";
    const k = this.escalaMarcador;
    const colores = { critica: "#ff3b47", estandar: "#ffb020", programado: "#4c8dff" };
    reportes.filter((r) => r.estatus !== "solucionado").forEach((r) => {
      const p = this.proyectar(r.ubicacion);
      const sel = this.seleccion && this.seleccion.tipo === "reporte" && this.seleccion.id === r.folio;
      const m = this.crear("g", {
        transform: `translate(${p.x} ${p.y}) scale(${k})`,
        class: `marcador marcador-falla${sel ? " seleccionado" : ""}`, color: colores[r.prioridad]
      }, g);
      if (r.prioridad === "critica") this.crear("circle", { r: 12, class: "pulso" }, m);
      this.crear("circle", { r: 16, class: "halo", stroke: sel ? "#19d3ff" : "transparent" }, m);
      this.crear("use", { href: "#ico-falla", x: -13, y: -15, width: 26, height: 26 }, m);
      m.addEventListener("click", (e) => { e.stopPropagation(); this.emitir("reporte", r.folio); });
      m.addEventListener("mousemove", (e) => this.mostrarTooltip(e,
        `<b>${r.folio}</b> · ${CATALOGO.prioridad[r.prioridad]}<br>${r.ubicacion.nombre}<br>Severidad ${r.severidad}/5 · ${CATALOGO.estatusReporte[r.estatus]}`));
      m.addEventListener("mouseleave", () => this.ocultarTooltip());
    });
  }

  /**
   * Requisito b.ii: dibuja cada cuadrilla con el ícono de su vehículo (moto,
   * camioneta o van) coloreado según su estatus y rotulado con su ID. Se
   * invoca en cada actualización GPS, emulando el rastreo en vivo por WebSocket.
   */
  actualizarUnidades(cuadrillas) {
    this.cache.cuadrillas = cuadrillas;
    const g = this.capas.unidades;
    g.innerHTML = "";
    const k = this.escalaMarcador;
    const colores = { "disponible": "#2fe07a", "en-centro": "#b07cff", "en-camino": "#ffb020", "en-sitio": "#19d3ff" };
    cuadrillas.forEach((c) => {
      const p = this.proyectar(c.posicion);
      const sel = this.seleccion && this.seleccion.tipo === "cuadrilla" && this.seleccion.id === c.id;
      const m = this.crear("g", {
        transform: `translate(${p.x.toFixed(1)} ${p.y.toFixed(1)}) scale(${k})`,
        class: `marcador${sel ? " seleccionado" : ""}`, color: colores[c.estatus]
      }, g);
      this.crear("circle", { r: 17, fill: "#05080b", class: "halo", stroke: colores[c.estatus] }, m);
      this.crear("use", { href: `#ico-${c.unidad.tipo}`, x: -12, y: -12, width: 24, height: 24 }, m);
      const t = this.crear("text", { y: 30, "text-anchor": "middle", class: "etiqueta-unidad" }, m);
      t.textContent = c.unidad.id;
      m.addEventListener("click", (e) => { e.stopPropagation(); this.emitir("cuadrilla", c.id); });
      m.addEventListener("mousemove", (e) => this.mostrarTooltip(e,
        `<b>${c.unidad.id}</b> · ${CATALOGO.tipoUnidad[c.unidad.tipo]}<br>${c.supervisor}<br>${CATALOGO.estatusCuadrilla[c.estatus]}${c.reporteFolio ? " → " + c.reporteFolio : ""}`));
      m.addEventListener("mouseleave", () => this.ocultarTooltip());
    });
  }

  /**
   * Dibuja el Radio de Cobertura del técnico asignado como polígono de 36
   * lados calculado por Geo.poligonoRadio. Si no se recibe centro, limpia la
   * capa. Equivale a dibujar el resultado de ST_Buffer en PostGIS.
   */
  mostrarRadio(centro, radioKm = 2) {
    const g = this.capas.radio;
    g.innerHTML = "";
    this.cache.radio = centro ? { centro, km: radioKm } : null;
    if (!centro) return;
    const pts = Geo.poligonoRadio(centro, radioKm).map((v) => this.proyectar(v));
    this.crear("polygon", {
      points: pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" "),
      fill: "#19d3ff", "fill-opacity": 0.1, stroke: "#19d3ff", "stroke-width": 2 * this.escalaMarcador,
      "stroke-dasharray": "8 5", "pointer-events": "none"
    }, g);
  }

  /**
   * Marca qué elemento está seleccionado (reporte o cuadrilla) y redibuja las
   * capas dinámicas para resaltarlo. Centraliza el estado de selección dentro
   * del mapa, igual que un popup abierto en Leaflet.
   */
  seleccionar(tipo, id) {
    this.seleccion = tipo ? { tipo, id } : null;
    this.redibujarDinamicos();
  }

  /**
   * Vuelve a dibujar todas las capas que dependen del zoom o de la selección
   * utilizando los últimos datos guardados en caché. Evita que el controlador
   * tenga que reenviar la información después de cada interacción con el mapa.
   */
  redibujarDinamicos() {
    if (this.cache.reportes) { this.dibujarRutas(this.cache.reportes); this.actualizarFallas(this.cache.reportes); }
    if (this.cache.cuadrillas) this.actualizarUnidades(this.cache.cuadrillas);
    if (this.cache.almacenes) this.dibujarAlmacenes(this.cache.almacenes);
    if (this.cache.radio) this.mostrarRadio(this.cache.radio.centro, this.cache.radio.km);
  }

  /**
   * Muestra u oculta una capa completa (cobertura, calor, rutas o almacenes)
   * cambiando su atributo display. Corresponde a map.addLayer / removeLayer en
   * Leaflet y permite al operador limpiar la vista según la tarea actual.
   */
  alternarCapa(nombre, visible) {
    if (this.capas[nombre]) this.capas[nombre].style.display = visible ? "" : "none";
  }

  /* ------------------------------------------------------------------
     NAVEGACIÓN: ZOOM, ARRASTRE Y ESCALA
     ------------------------------------------------------------------ */

  /**
   * Aplica zoom multiplicando el tamaño de la ventana visible por 1/factor,
   * manteniendo fijo el punto (cx, cy) bajo el cursor. Limita el acercamiento
   * máximo a 6x y nunca permite alejarse más allá del área total de operación.
   */
  zoom(factor, cx = this.vista.x + this.vista.w / 2, cy = this.vista.y + this.vista.h / 2) {
    const nuevoW = Math.min(this.W, Math.max(this.W / 6, this.vista.w / factor));
    const f = nuevoW / this.vista.w;
    this.vista.x = cx - (cx - this.vista.x) * f;
    this.vista.y = cy - (cy - this.vista.y) * f;
    this.vista.w = nuevoW;
    this.vista.h = this.vista.h * f;
    this.aplicarVista();
  }

  /**
   * Restringe la vista para que no salga de los límites del lienzo y escribe
   * el nuevo viewBox en el SVG. Después ajusta la escala gráfica y redibuja
   * los marcadores para conservar su tamaño legible en pantalla.
   */
  aplicarVista() {
    const v = this.vista;
    v.x = Math.min(Math.max(v.x, 0), this.W - v.w);
    v.y = Math.min(Math.max(v.y, 0), this.H - v.h);
    this.svg.setAttribute("viewBox", `${v.x} ${v.y} ${v.w} ${v.h}`);
    this.actualizarEscala();
    this.redibujarDinamicos();
  }

  /**
   * Restablece la vista completa del área metropolitana. Si se recibe un punto
   * geográfico, en cambio, acerca 2.5x y centra la cámara sobre él, como
   * map.flyTo() de Mapbox al seleccionar un reporte o una unidad.
   */
  centrar(punto = null) {
    if (!punto) {
      this.vista = { x: 0, y: 0, w: this.W, h: this.H };
    } else {
      const p = this.proyectar(punto);
      this.vista.w = this.W / 2.5;
      this.vista.h = this.H / 2.5;
      this.vista.x = p.x - this.vista.w / 2;
      this.vista.y = p.y - this.vista.h / 2;
    }
    this.aplicarVista();
  }

  /**
   * Convierte coordenadas de pantalla (píxeles del evento de ratón) en
   * coordenadas internas del SVG considerando zoom y desplazamiento actuales.
   * Es indispensable para hacer zoom exactamente donde apunta el cursor.
   */
  pantallaALienzo(clientX, clientY) {
    const r = this.svg.getBoundingClientRect();
    const escala = Math.max(this.vista.w / r.width, this.vista.h / r.height);
    const offX = (r.width - this.vista.w / escala) / 2;
    const offY = (r.height - this.vista.h / escala) / 2;
    return {
      x: this.vista.x + (clientX - r.left - offX) * escala,
      y: this.vista.y + (clientY - r.top - offY) * escala
    };
  }

  /**
   * Calcula cuántos kilómetros representa una barra de 80 px en pantalla con
   * el zoom actual y actualiza el texto de la escala. Da al despachador una
   * noción real de distancia para valorar el SLA de dos horas.
   */
  actualizarEscala() {
    const anchoPantalla = this.contenedor.clientWidth || 800;
    const kmPorPxPantalla = (this.vista.w / anchoPantalla) / this.pxPorKm;
    this.escala.textContent = `▬ ${(kmPorPxPantalla * 80).toFixed(1)} km`;
  }

  /**
   * Registra los gestos del usuario: rueda del ratón para zoom, arrastre con
   * puntero (ratón o dedo) para desplazar la vista y redimensionamiento de
   * ventana para recalcular la escala. Usa Pointer Events para compatibilidad táctil.
   */
  habilitarInteraccion() {
    this.contenedor.addEventListener("wheel", (e) => {
      e.preventDefault();
      const p = this.pantallaALienzo(e.clientX, e.clientY);
      this.zoom(e.deltaY < 0 ? 1.2 : 1 / 1.2, p.x, p.y);
    }, { passive: false });

    let arrastre = null;
    this.svg.addEventListener("pointerdown", (e) => {
      if (e.target.closest(".marcador")) return;      // no arrastrar al pulsar íconos
      arrastre = { x: e.clientX, y: e.clientY, vx: this.vista.x, vy: this.vista.y };
      this.contenedor.classList.add("arrastrando");
      this.svg.setPointerCapture(e.pointerId);
    });
    this.svg.addEventListener("pointermove", (e) => {
      if (!arrastre) return;
      const r = this.svg.getBoundingClientRect();
      const escala = Math.max(this.vista.w / r.width, this.vista.h / r.height);
      this.vista.x = arrastre.vx - (e.clientX - arrastre.x) * escala;
      this.vista.y = arrastre.vy - (e.clientY - arrastre.y) * escala;
      this.aplicarVista();
    });
    const soltar = () => { arrastre = null; this.contenedor.classList.remove("arrastrando"); };
    this.svg.addEventListener("pointerup", soltar);
    this.svg.addEventListener("pointercancel", soltar);
    window.addEventListener("resize", () => this.actualizarEscala());
  }

  /* ------------------------------------------------------------------
     TOOLTIP Y EVENTOS
     ------------------------------------------------------------------ */

  /**
   * Posiciona y muestra la etiqueta flotante cerca del cursor con el HTML
   * recibido. Se coloca relativa al contenedor del mapa para que funcione
   * correctamente aunque la página tenga desplazamiento vertical.
   */
  mostrarTooltip(evento, html) {
    const r = this.contenedor.getBoundingClientRect();
    this.tooltip.innerHTML = html;
    this.tooltip.style.display = "block";
    const x = Math.min(evento.clientX - r.left + 14, r.width - 240);
    this.tooltip.style.left = `${Math.max(x, 4)}px`;
    this.tooltip.style.top = `${evento.clientY - r.top + 14}px`;
  }

  /**
   * Oculta la etiqueta flotante cuando el cursor abandona un marcador o un
   * distrito. Se separa de mostrarTooltip para poder llamarla desde cualquier
   * evento mouseleave sin necesidad de pasar parámetros adicionales.
   */
  ocultarTooltip() {
    this.tooltip.style.display = "none";
  }

  /**
   * Suscribe una función a un evento del mapa ("reporte" o "cuadrilla"). Es un
   * patrón Observador mínimo que desacopla el motor de mapa del controlador,
   * igual que map.on('click', …) en las bibliotecas de mapas reales.
   */
  on(evento, callback) {
    (this.oyentes[evento] ||= []).push(callback);
  }

  /**
   * Notifica a todas las funciones suscritas a un evento, pasándoles el
   * identificador del elemento que lo originó. Lo usan los marcadores al recibir
   * un clic para avisar al dashboard qué reporte o cuadrilla mostrar.
   */
  emitir(evento, dato) {
    (this.oyentes[evento] || []).forEach((fn) => fn(dato));
  }
}
