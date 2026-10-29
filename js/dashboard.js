/* =====================================================================
   FieldService Pro · js/dashboard.js
   ---------------------------------------------------------------------
   CONTROLADOR. Une el modelo (datos.js) con la vista (HTML + mapa.js):
   aplica filtros, pinta tablas y KPIs, gestiona el flujo de estatus,
   simula el rastreo GPS en tiempo real (como lo haría Socket.IO) y
   controla el reproductor del video instructivo simulado.
   ===================================================================== */
"use strict";

/* Aceleración de la simulación: 1 segundo real = 30 segundos operativos */
const VELOCIDAD_SIMULACION = 30;

/* =====================================================================
   CLASE ReproductorProtocolo (video instructivo simulado · requisito d.ii)
   ===================================================================== */
class ReproductorProtocolo {
  /**
   * Prepara el reproductor con seis escenas de cinco segundos cada una que
   * resumen el protocolo de atención de fallas críticas y seguridad industrial.
   * Guarda referencias a pantalla, botón, barra de progreso y contador de tiempo.
   */
  constructor() {
    this.escenas = [
      { icono: "⚠️", titulo: "1 · Recepción y clasificación", texto: "Registrar ubicación, categoría y severidad 1-5. Severidad ≥ 4 se marca como Crítica y activa el SLA de 2 horas." },
      { icono: "🔒", titulo: "2 · Aislamiento de energía (LOTO)", texto: "Bloqueo y etiquetado de la fuente eléctrica, térmica o de datos antes de intervenir. Nadie toca equipo energizado." },
      { icono: "🦺", titulo: "3 · Equipo de protección personal", texto: "Casco dieléctrico, guantes clase 0, lentes y calzado de seguridad. El supervisor verifica el EPP en sitio." },
      { icono: "🚐", titulo: "4 · Despacho de cuadrilla certificada", texto: "El sistema asigna la unidad más cercana con herramienta e inventario aptos. La ruta considera tráfico y accesos restringidos." },
      { icono: "🔧", titulo: "5 · Diagnóstico y reparación", texto: "Permiso de trabajo firmado, medición previa, reparación y prueba funcional. Reportar avance al despachador cada 15 min." },
      { icono: "✅", titulo: "6 · Verificación y cierre", texto: "Retiro de bloqueos, prueba con el cliente, evidencia fotográfica y registro de la hora de solución final." }
    ];
    this.duracionEscena = 5;                      // segundos por escena
    this.duracionTotal = this.escenas.length * this.duracionEscena;
    this.tiempo = 0;
    this.intervalo = null;

    this.escenaEl = document.getElementById("escena-video");
    this.boton = document.getElementById("btn-play");
    this.progreso = document.getElementById("progreso-video");
    this.contador = document.getElementById("tiempo-video");
    this.barra = this.progreso.parentElement;

    this.boton.addEventListener("click", () => (this.intervalo ? this.pausar() : this.reproducir()));
    this.barra.addEventListener("click", (e) => this.buscar(e));
    this.mostrarEscena(0);
  }

  /**
   * Inicia o reanuda la reproducción avanzando el tiempo cada 250 ms. Al
   * llegar al final reinicia desde cero, como un video en bucle colocado en
   * una pantalla de sala de control. Cambia el ícono del botón a pausa.
   */
  reproducir() {
    this.boton.textContent = "⏸";
    this.boton.setAttribute("aria-label", "Pausar video");
    this.intervalo = setInterval(() => {
      this.tiempo += 0.25;
      if (this.tiempo >= this.duracionTotal) this.tiempo = 0;
      this.actualizar();
    }, 250);
  }

  /**
   * Detiene el temporizador interno sin perder la posición actual, de modo que
   * el operador pueda leer con calma el paso en pantalla. Restablece el ícono
   * del botón y su etiqueta accesible para lectores de pantalla.
   */
  pausar() {
    clearInterval(this.intervalo);
    this.intervalo = null;
    this.boton.textContent = "▶";
    this.boton.setAttribute("aria-label", "Reproducir video");
  }

  /**
   * Permite saltar a cualquier punto del video haciendo clic en la barra de
   * progreso. Calcula la fracción horizontal del clic respecto al ancho total
   * y la convierte en segundos dentro de la duración del protocolo.
   */
  buscar(evento) {
    const r = this.barra.getBoundingClientRect();
    this.tiempo = ((evento.clientX - r.left) / r.width) * this.duracionTotal;
    this.actualizar();
  }

  /**
   * Sincroniza la interfaz con el tiempo actual: ancho de la barra, texto
   * minutos:segundos, valor ARIA del progreso y, si cambió de bloque de cinco
   * segundos, la escena visible. Es el "fotograma" del video simulado.
   */
  actualizar() {
    const pct = (this.tiempo / this.duracionTotal) * 100;
    this.progreso.style.width = `${pct}%`;
    this.barra.setAttribute("aria-valuenow", Math.round(pct));
    const f = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
    this.contador.textContent = `${f(this.tiempo)} / ${f(this.duracionTotal)}`;
    const indice = Math.min(Math.floor(this.tiempo / this.duracionEscena), this.escenas.length - 1);
    if (indice !== this.indiceActual) this.mostrarEscena(indice);
  }

  /**
   * Reemplaza el contenido de la pantalla con la escena indicada: número de
   * paso, ícono, título y explicación breve. Reinicia la animación CSS de
   * aparición para que cada cambio se perciba como un corte de video.
   */
  mostrarEscena(indice) {
    this.indiceActual = indice;
    const e = this.escenas[indice];
    this.escenaEl.innerHTML = `
      <div class="icono-escena" aria-hidden="true">${e.icono}</div>
      <div class="paso-num">PASO ${indice + 1} DE ${this.escenas.length}</div>
      <h4>${e.titulo.split("· ")[1]}</h4>
      <p>${e.texto}</p>`;
    this.escenaEl.style.animation = "none";
    void this.escenaEl.offsetWidth;            // fuerza reflow para reiniciar animación
    this.escenaEl.style.animation = "";
  }
}

/* =====================================================================
   CLASE ControladorDashboard (orquestador principal)
   ===================================================================== */
class ControladorDashboard {
  /**
   * Crea el estado de la aplicación: flota, reportes, motor de despacho,
   * instancia del mapa sobre el div vacío y valores iniciales de filtros.
   * El contador de folios continúa la numeración de los reportes semilla.
   */
  constructor() {
    const { flota, reportes } = crearEstadoInicial();
    this.cuadrillas = flota;
    this.reportes = reportes;
    this.motor = new MotorDespacho(this.cuadrillas, ALMACENES);
    this.mapa = new MapaFieldService("map-fieldservice", LIMITES);
    this.filtros = { prioridad: "todas", estatus: "todos", especialidad: "todas" };
    this.seleccion = null;                       // { tipo, id }
    this.siguienteFolio = 1047;
    this.simulando = true;
    this.segundos = 0;
  }

  /**
   * Punto de arranque: dibuja capas estáticas del mapa, prepara escenarios
   * iniciales, conecta eventos de la interfaz, pinta todo por primera vez y
   * arranca los temporizadores del reloj y del rastreo GPS simulado.
   */
  iniciar() {
    this.mapa.dibujarDistritos(DISTRITOS);
    this.mapa.dibujarZonasCalor(ZONAS_CALOR);
    this.mapa.dibujarAlmacenes(ALMACENES);
    this.mapa.on("reporte", (folio) => this.seleccionarReporte(folio));
    this.mapa.on("cuadrilla", (id) => this.seleccionarCuadrilla(id));

    this.prepararEscenario();
    this.vincularEventos();
    this.llenarSitiosFormulario();
    this.renderizar();

    this.actualizarReloj();
    setInterval(() => this.actualizarReloj(), 1000);
    setInterval(() => this.tickGPS(), 1000);
    new ReproductorProtocolo();
  }

  /**
   * Despacha los reportes semilla críticos y estándar para que el tablero
   * arranque con operaciones en curso: una unidad en camino, otra en sitio y
   * otra asignada. Los reportes restantes se dejan pendientes a propósito.
   */
  prepararEscenario() {
    const min = (r, m) => new Date(r.tiempos.recepcion.getTime() + m * 60000);
    ["FS-1041", "FS-1046", "FS-1042", "FS-1043"].forEach((folio) => this.motor.despachar(this.buscarReporte(folio)));

    const r41 = this.buscarReporte("FS-1041");
    r41.tiempos.asignacion = min(r41, 2);
    this.cambiarEstatus(r41, "en-camino", min(r41, 6));
    r41.avance = 0.35;

    const r42 = this.buscarReporte("FS-1042");
    r42.tiempos.asignacion = min(r42, 3);
    this.cambiarEstatus(r42, "en-camino", min(r42, 7));
    this.cambiarEstatus(r42, "en-sitio", min(r42, 19));

    const r46 = this.buscarReporte("FS-1046");
    this.cambiarEstatus(r46, "en-camino", new Date());
    r46.avance = 0.05;
  }

  /* ------------------------------------------------------------------
     BÚSQUEDAS Y FILTROS
     ------------------------------------------------------------------ */

  /**
   * Devuelve el objeto ReporteFalla cuyo folio coincide con el recibido.
   * Encapsular la búsqueda permite cambiarla después por un Map indexado
   * o por una consulta al servidor sin modificar el resto del controlador.
   */
  buscarReporte(folio) {
    return this.reportes.find((r) => r.folio === folio);
  }

  /**
   * Devuelve la cuadrilla con el identificador indicado o undefined si no
   * existe. Se usa al pintar tablas, al seleccionar en el mapa y al cambiar
   * estatus, por lo que conviene tenerla como método reutilizable.
   */
  buscarCuadrilla(id) {
    return this.cuadrillas.find((c) => c.id === id);
  }

  /**
   * Evalúa si un reporte pasa los filtros activos de prioridad y especialidad
   * técnica. Los reportes solucionados se excluyen siempre porque el tablero
   * solo muestra incidentes activos, aunque siguen contando para los KPIs.
   */
  reporteVisible(r) {
    if (r.estatus === "solucionado") return false;
    if (this.filtros.prioridad !== "todas" && r.prioridad !== this.filtros.prioridad) return false;
    if (this.filtros.especialidad !== "todas" && r.categoria !== this.filtros.especialidad) return false;
    return true;
  }

  /**
   * Evalúa si una cuadrilla pasa los filtros de estatus (disponible, en centro,
   * en camino, en sitio) y de especialidad. El filtro de especialidad revisa
   * la lista de certificaciones, ya que una cuadrilla puede tener varias.
   */
  cuadrillaVisible(c) {
    if (this.filtros.estatus !== "todos" && c.estatus !== this.filtros.estatus) return false;
    if (this.filtros.especialidad !== "todas" && !c.certificaciones.includes(this.filtros.especialidad)) return false;
    return true;
  }

  /* ------------------------------------------------------------------
     EVENTOS DE INTERFAZ
     ------------------------------------------------------------------ */

  /**
   * Conecta todos los controles del HTML con sus acciones: chips de prioridad,
   * selects de estatus y especialidad, casillas de capas, botones de zoom,
   * pausa del GPS y apertura del formulario. Usa delegación en las tablas.
   */
  vincularEventos() {
    /* Filtro de prioridad: solo un chip activo a la vez */
    document.getElementById("filtro-prioridad").addEventListener("click", (e) => {
      const chip = e.target.closest(".chip");
      if (!chip) return;
      document.querySelectorAll("#filtro-prioridad .chip").forEach((c) => c.classList.toggle("activo", c === chip));
      this.filtros.prioridad = chip.dataset.prioridad;
      this.renderizar();
    });
    document.getElementById("filtro-estatus").addEventListener("change", (e) => { this.filtros.estatus = e.target.value; this.renderizar(); });
    document.getElementById("filtro-especialidad").addEventListener("change", (e) => { this.filtros.especialidad = e.target.value; this.renderizar(); });

    /* Capas del mapa */
    const capas = { "capa-cobertura": ["cobertura", "distritos"], "capa-calor": ["calor"], "capa-rutas": ["rutas", "radio"], "capa-almacenes": ["almacenes"] };
    Object.entries(capas).forEach(([id, nombres]) =>
      document.getElementById(id).addEventListener("change", (e) => nombres.forEach((n) => this.mapa.alternarCapa(n, e.target.checked))));

    /* Navegación del mapa */
    document.getElementById("btn-zoom-mas").addEventListener("click", () => this.mapa.zoom(1.4));
    document.getElementById("btn-zoom-menos").addEventListener("click", () => this.mapa.zoom(1 / 1.4));
    document.getElementById("btn-centrar").addEventListener("click", () => { this.limpiarSeleccion(); this.mapa.centrar(); });
    document.getElementById("btn-simulacion").addEventListener("click", (e) => {
      this.simulando = !this.simulando;
      e.target.textContent = this.simulando ? "⏸ Pausar GPS" : "▶ Reanudar GPS";
      e.target.setAttribute("aria-pressed", this.simulando);
      document.getElementById("estado-socket").textContent = this.simulando ? "● simulada (WebSocket)" : "○ en pausa";
    });

    /* Delegación: un solo oyente atiende todos los botones y filas generados dinámicamente */
    document.body.addEventListener("click", (e) => {
      const accion = e.target.closest("[data-accion]");
      if (accion) {
        e.stopPropagation();
        const folio = accion.dataset.folio;
        if (accion.dataset.accion === "despachar") this.despacharReporte(folio);
        if (accion.dataset.accion === "avanzar") this.avanzarEstatus(folio);
        return;
      }
      const filaR = e.target.closest("[data-folio]");
      if (filaR) return this.seleccionarReporte(filaR.dataset.folio);
      const filaC = e.target.closest("[data-cuadrilla]");
      if (filaC) return this.seleccionarCuadrilla(filaC.dataset.cuadrilla);
    });

    /* Formulario de registro */
    const dialogo = document.getElementById("dialogo-reporte");
    document.getElementById("btn-nuevo-reporte").addEventListener("click", () => {
      document.getElementById("error-form").textContent = "";
      dialogo.showModal();
    });
    document.getElementById("btn-cancelar").addEventListener("click", () => dialogo.close());
    document.getElementById("campo-severidad").addEventListener("input", (e) => {
      document.getElementById("valor-severidad").textContent = e.target.value;
    });
    document.getElementById("form-reporte").addEventListener("submit", (e) => {
      e.preventDefault();
      if (this.registrarReporte()) dialogo.close();
    });
  }

  /**
   * Llena el select de ubicación del formulario con los sitios conocidos,
   * simulando la geocodificación inversa: el operador elige una dirección
   * legible y el sistema conserva internamente su latitud y longitud.
   */
  llenarSitiosFormulario() {
    const sel = document.getElementById("campo-ubicacion");
    SITIOS.forEach((s, i) => sel.add(new Option(`${s.nombre} (${s.lat.toFixed(3)}, ${s.lng.toFixed(3)})`, i)));
  }

  /* ------------------------------------------------------------------
     ACCIONES DE NEGOCIO
     ------------------------------------------------------------------ */

  /**
   * Valida los tres campos obligatorios del caso, crea el ReporteFalla y lo
   * envía de inmediato al motor de despacho. Si ninguna cuadrilla es apta,
   * el reporte queda pendiente y se avisa al operador. Retorna éxito o fallo.
   */
  registrarReporte() {
    const ubic = document.getElementById("campo-ubicacion").value;
    const sev = Number(document.getElementById("campo-severidad").value);
    const cat = document.getElementById("campo-categoria").value;
    const pri = document.getElementById("campo-prioridad").value;
    const error = document.getElementById("error-form");

    if (ubic === "" || !cat) { error.textContent = "Ubicación y categoría son obligatorias."; return false; }
    if (!(sev >= 1 && sev <= 5)) { error.textContent = "La severidad debe estar entre 1 y 5."; return false; }

    const reporte = new ReporteFalla({
      folio: `FS-${this.siguienteFolio++}`, prioridad: pri, categoria: cat, severidad: sev, ubicacion: SITIOS[ubic]
    });
    this.reportes.push(reporte);
    this.despacharReporte(reporte.folio);
    document.getElementById("form-reporte").reset();
    document.getElementById("valor-severidad").textContent = "3";
    return true;
  }

  /**
   * Ejecuta el algoritmo de despacho para un folio pendiente. Si encuentra
   * cuadrilla, notifica unidad, distancia y ETA y selecciona el reporte en el
   * mapa; si no, informa que no hay recursos con certificación e inventario aptos.
   */
  despacharReporte(folio) {
    const r = this.buscarReporte(folio);
    if (!r || r.estatus !== "pendiente") return;
    const c = this.motor.despachar(r);
    if (c) {
      this.notificar(`${r.folio} asignado a ${c.unidad.id} · ${r.distanciaKm.toFixed(1)} km · ETA ${Math.round(r.etaMin)} min`);
      this.seleccionarReporte(folio);
    } else {
      this.notificar(`${r.folio}: sin cuadrilla disponible con herramienta y certificación. Queda en espera.`);
      this.renderizar();
    }
  }

  /**
   * Aplica un nuevo estatus al reporte y sincroniza la cuadrilla: registra la
   * marca de tiempo crítica correspondiente, mueve la unidad al sitio al
   * arribar y la libera al solucionar. Es la única vía para mutar estados.
   */
  cambiarEstatus(r, nuevo, cuando = new Date()) {
    const c = this.buscarCuadrilla(r.cuadrillaId);
    r.estatus = nuevo;
    if (nuevo === "en-camino") { r.tiempos.salida = cuando; if (c) c.estatus = "en-camino"; }
    if (nuevo === "en-sitio") {
      r.tiempos.arribo = cuando; r.avance = 1;
      if (c) { c.estatus = "en-sitio"; c.posicion = { lat: r.ubicacion.lat, lng: r.ubicacion.lng }; }
    }
    if (nuevo === "solucionado") {
      r.tiempos.solucion = cuando;
      if (c) { c.estatus = "disponible"; c.reporteFolio = null; c.base = { ...c.posicion }; }
    }
  }

  /**
   * Responde al botón de actualización de estatus del despachador: avanza el
   * reporte un paso en el flujo Asignado ➔ En Camino ➔ En Sitio ➔ Solucionado.
   * Los pendientes primero se despachan, porque aún no tienen cuadrilla.
   */
  avanzarEstatus(folio) {
    const r = this.buscarReporte(folio);
    if (!r) return;
    if (r.estatus === "pendiente") return this.despacharReporte(folio);
    const sig = r.siguienteEstatus();
    if (!sig) return;
    this.cambiarEstatus(r, sig);
    this.notificar(`${r.folio} → ${CATALOGO.estatusReporte[sig]}`);
    if (sig === "solucionado") this.limpiarSeleccion();
    this.renderizar();
  }

  /* ------------------------------------------------------------------
     SIMULACIÓN EN TIEMPO REAL (sustituye a socket.on('posicion', …))
     ------------------------------------------------------------------ */

  /**
   * Se ejecuta cada segundo. Avanza las unidades en camino sobre su ruta según
   * velocidad y tráfico, recalcula el ETA restante, marca el arribo automático
   * por geocerca, mueve ligeramente las disponibles y cada 40 s genera un reporte.
   */
  tickGPS() {
    if (!this.simulando) return;
    this.segundos++;
    const trafico = this.motor.factorTrafico();

    this.reportes.filter((r) => r.estatus === "en-camino").forEach((r) => {
      const c = this.buscarCuadrilla(r.cuadrillaId);
      const kmPorTick = (c.unidad.velocidadKmh / 3600) * VELOCIDAD_SIMULACION / trafico;
      r.avance = Math.min(1, r.avance + kmPorTick / r.distanciaKm);
      c.posicion = Geo.puntoEnRuta(r.ruta, r.avance);
      if (r.avance >= 1) {
        this.cambiarEstatus(r, "en-sitio");
        this.notificar(`${c.unidad.id} arribó a sitio (${r.folio}). Geocerca confirmada.`);
      }
    });

    /* Patrullaje: pequeña oscilación alrededor de la base para unidades libres */
    this.cuadrillas.filter((c) => c.estatus === "disponible").forEach((c) => {
      const t = this.segundos / 6 + c.id.charCodeAt(4);
      c.posicion = { lat: c.base.lat + 0.0025 * Math.sin(t), lng: c.base.lng + 0.0025 * Math.cos(t * 0.8) };
    });

    if (this.segundos % 40 === 0) this.reporteEntrante();
    this.renderizar(true);
  }

  /**
   * Simula la llegada de un reporte desde el canal en tiempo real (por
   * ejemplo, un cliente o un sensor IoT). Elige sitio, categoría y severidad
   * al azar, deriva la prioridad desde la severidad y lo despacha automáticamente.
   */
  reporteEntrante() {
    const abiertos = this.reportes.filter((r) => r.estatus !== "solucionado").length;
    if (abiertos >= 10) return;                    // evita saturar la demostración
    const cats = ["electrica", "hvac", "redes"];
    const sev = 1 + Math.floor(Math.random() * 5);
    const reporte = new ReporteFalla({
      folio: `FS-${this.siguienteFolio++}`,
      prioridad: sev >= 4 ? "critica" : sev >= 2 ? "estandar" : "programado",
      categoria: cats[Math.floor(Math.random() * cats.length)],
      severidad: sev,
      ubicacion: SITIOS[Math.floor(Math.random() * SITIOS.length)]
    });
    this.reportes.push(reporte);
    const c = this.motor.despachar(reporte);
    this.notificar(`Nuevo reporte ${reporte.folio} (sev. ${sev})${c ? " → " + c.unidad.id : " · en espera"}`);
  }

  /* ------------------------------------------------------------------
     SELECCIÓN
     ------------------------------------------------------------------ */

  /**
   * Selecciona un reporte: lo resalta en lista, tabla y mapa, centra la cámara
   * en el sitio de la falla, dibuja el radio de cobertura de 2 km de la cuadrilla
   * asignada y abre el panel de detalle del operativo.
   */
  seleccionarReporte(folio) {
    const r = this.buscarReporte(folio);
    if (!r) return;
    this.seleccion = { tipo: "reporte", id: folio };
    this.mapa.seleccion = { tipo: "reporte", id: folio };
    const c = this.buscarCuadrilla(r.cuadrillaId);
    this.mapa.mostrarRadio(c ? c.posicion : r.ubicacion, 2);
    this.mapa.centrar(r.ubicacion);
    document.getElementById("info-mapa").textContent =
      `${r.folio}: ${r.ubicacion.nombre}${c ? " · unidad " + c.unidad.id : " · sin asignar"}`;
    this.renderizar();
  }

  /**
   * Selecciona una cuadrilla desde el mapa o la tabla. Si atiende un reporte,
   * delega en seleccionarReporte para mostrar su operativo completo; si está
   * libre, centra la vista y muestra su radio de cobertura de 2 km.
   */
  seleccionarCuadrilla(id) {
    const c = this.buscarCuadrilla(id);
    if (!c) return;
    if (c.reporteFolio) return this.seleccionarReporte(c.reporteFolio);
    this.seleccion = { tipo: "cuadrilla", id };
    this.mapa.seleccion = { tipo: "cuadrilla", id };
    this.mapa.mostrarRadio(c.posicion, 2);
    this.mapa.centrar(c.posicion);
    document.getElementById("info-mapa").textContent =
      `${c.unidad.id} · ${c.supervisor} · ${CATALOGO.estatusCuadrilla[c.estatus]} · radio de respuesta 2 km`;
    this.renderizar();
  }

  /**
   * Quita cualquier selección activa, borra el radio de cobertura, oculta el
   * detalle del operativo y restaura el texto de ayuda bajo el mapa. Se llama
   * al centrar la vista o cuando el reporte seleccionado se soluciona.
   */
  limpiarSeleccion() {
    this.seleccion = null;
    this.mapa.seleccionar(null);
    this.mapa.mostrarRadio(null);
    document.getElementById("info-mapa").textContent = "Selecciona una unidad o un reporte para ver su ruta y radio de cobertura.";
    this.renderizar();
  }

  /* ------------------------------------------------------------------
     RENDERIZADO
     ------------------------------------------------------------------ */

  /**
   * Repinta todos los componentes desde el estado actual. Cuando viene del
   * tick GPS (ligero = true) conserva el scroll de las listas. Mantener un solo
   * punto de render garantiza que mapa, tablas y KPIs nunca se desincronicen.
   */
  renderizar(ligero = false) {
    const reportesVis = this.reportes.filter((r) => this.reporteVisible(r));
    const cuadrillasVis = this.cuadrillas.filter((c) => this.cuadrillaVisible(c));

    this.renderKPIs();
    this.renderPanelDespacho(reportesVis, ligero);
    this.renderTablaReportes(reportesVis);
    this.renderTablaCuadrillas(cuadrillasVis);
    this.renderDetalle();

    this.mapa.dibujarRutas(reportesVis);
    this.mapa.actualizarFallas(reportesVis);
    this.mapa.actualizarUnidades(cuadrillasVis);
    if (this.seleccion && this.seleccion.tipo === "reporte") {
      const r = this.buscarReporte(this.seleccion.id);
      const c = r && this.buscarCuadrilla(r.cuadrillaId);
      if (c && r.estatus === "en-camino") this.mapa.mostrarRadio(c.posicion, 2);
    }
  }

  /**
   * Calcula y muestra los KPIs del encabezado: tiempo promedio de atención en
   * minutos, reportes abiertos, porcentaje de cuadrillas activas (con reporte
   * asignado) y críticos abiertos. Las fórmulas son promedios y proporciones simples.
   */
  renderKPIs() {
    const abiertos = this.reportes.filter((r) => r.estatus !== "solucionado");
    const promedio = this.reportes.reduce((s, r) => s + r.minutosTranscurridos(), 0) / (this.reportes.length || 1);
    const activas = this.cuadrillas.filter((c) => c.reporteFolio).length;
    document.getElementById("kpi-tiempo").textContent = `${Math.round(promedio)} min`;
    document.getElementById("kpi-pendientes").textContent = abiertos.length;
    document.getElementById("kpi-activas").textContent = `${Math.round((activas / this.cuadrillas.length) * 100)} %`;
    document.getElementById("kpi-criticos").textContent = abiertos.filter((r) => r.prioridad === "critica").length;
  }

  /**
   * Pinta el panel lateral en dos listas: pendientes (sin cuadrilla, con botón
   * Despachar) y en curso (asignado, en camino o en sitio). Ordena por prioridad
   * y severidad para que lo más urgente siempre quede arriba.
   */
  renderPanelDespacho(reportes, ligero) {
    const peso = { critica: 0, estandar: 1, programado: 2 };
    const orden = (a, b) => peso[a.prioridad] - peso[b.prioridad] || b.severidad - a.severidad;
    const pendientes = reportes.filter((r) => r.estatus === "pendiente").sort(orden);
    const curso = reportes.filter((r) => r.estatus !== "pendiente").sort(orden);

    const item = (r) => {
      const c = this.buscarCuadrilla(r.cuadrillaId);
      const sel = this.seleccion && this.seleccion.id === r.folio ? " seleccionado" : "";
      const boton = r.estatus === "pendiente"
        ? `<button type="button" class="boton boton-primario" data-accion="despachar" data-folio="${r.folio}">Despachar</button>`
        : `<span class="insignia e-${r.estatus}">${CATALOGO.estatusReporte[r.estatus]}</span>`;
      return `<li class="pedido${sel}" data-folio="${r.folio}" data-prioridad="${r.prioridad}" tabindex="0">
          <strong>${r.folio}</strong>${boton}
          <span class="meta">${CATALOGO.categoria[r.categoria]} · Sev ${r.severidad} · ${r.ubicacion.nombre}${c ? " · " + c.unidad.id : ""}</span>
        </li>`;
    };
    const pintar = (id, lista) => {
      const el = document.getElementById(id);
      const scroll = el.scrollTop;
      el.innerHTML = lista.length ? lista.map(item).join("") : `<li class="vacio">Sin pedidos con los filtros actuales</li>`;
      if (ligero) el.scrollTop = scroll;
    };
    pintar("lista-pendientes", pendientes);
    pintar("lista-curso", curso);
    document.getElementById("conteo-pendientes").textContent = pendientes.length;
    document.getElementById("conteo-curso").textContent = curso.length;
  }

  /**
   * Genera las filas de la tabla de Reportes de Fallas Activos: folio,
   * prioridad, categoría, ubicación, severidad, cuadrilla, ETA restante y un
   * botón de acción que muestra el siguiente estatus permitido del flujo.
   */
  renderTablaReportes(reportes) {
    const tbody = document.querySelector("#tabla-reportes tbody");
    if (!reportes.length) { tbody.innerHTML = `<tr><td colspan="9" class="vacio">Sin reportes activos con los filtros actuales</td></tr>`; return; }
    tbody.innerHTML = reportes.map((r) => {
      const c = this.buscarCuadrilla(r.cuadrillaId);
      const sig = r.estatus === "pendiente" ? "Despachar" : `→ ${CATALOGO.estatusReporte[r.siguienteEstatus()]}`;
      const sel = this.seleccion && this.seleccion.id === r.folio ? ' class="seleccionado"' : "";
      return `<tr data-folio="${r.folio}"${sel}>
        <td class="mono">${r.folio}</td>
        <td><span class="insignia p-${r.prioridad}">${CATALOGO.prioridad[r.prioridad]}</span></td>
        <td>${CATALOGO.categoria[r.categoria]}</td>
        <td>${r.ubicacion.nombre}</td>
        <td class="mono">${"■".repeat(r.severidad)}${"□".repeat(5 - r.severidad)}</td>
        <td class="mono">${c ? c.unidad.id : "—"}</td>
        <td class="mono">${this.textoETA(r)}</td>
        <td><span class="insignia e-${r.estatus}">${CATALOGO.estatusReporte[r.estatus]}</span></td>
        <td><button type="button" class="boton" data-accion="avanzar" data-folio="${r.folio}">${sig}</button></td>
      </tr>`;
    }).join("");
  }

  /**
   * Genera las filas del Panel de Cuadrillas Técnicas: ícono SVG y matrícula
   * de la unidad, tipo, supervisor, certificaciones, barra de inventario a
   * bordo, turno y estatus. Permite identificar recursos de un vistazo.
   */
  renderTablaCuadrillas(cuadrillas) {
    const tbody = document.querySelector("#tabla-cuadrillas tbody");
    if (!cuadrillas.length) { tbody.innerHTML = `<tr><td colspan="7" class="vacio">Sin cuadrillas con los filtros actuales</td></tr>`; return; }
    tbody.innerHTML = cuadrillas.map((c) => {
      const inv = c.unidad.inventario;
      const colorInv = inv >= 70 ? "var(--disponible)" : inv >= 50 ? "var(--estandar)" : "var(--critica)";
      const sel = this.seleccion && this.seleccion.id === c.id ? ' class="seleccionado"' : "";
      return `<tr data-cuadrilla="${c.id}"${sel}>
        <td class="mono"><img src="assets/icons/${c.unidad.tipo}.svg" alt="" width="22" height="22">${c.unidad.id}</td>
        <td>${CATALOGO.tipoUnidad[c.unidad.tipo]}</td>
        <td>${c.supervisor} <small>(${c.calificacion.toFixed(1)}★)</small></td>
        <td>${c.certificaciones.map((x) => CATALOGO.categoria[x]).join(", ")}</td>
        <td><span class="inventario"><span style="width:${inv}%;background:${colorInv}"></span></span>${inv}%</td>
        <td>${c.turno}</td>
        <td><span class="insignia e-${c.estatus}">${CATALOGO.estatusCuadrilla[c.estatus]}</span></td>
      </tr>`;
    }).join("");
  }

  /**
   * Muestra el Panel de información del operativo seleccionado: resumen con
   * severidad, ETA y distancia; detalle con supervisor, unidad e inventario;
   * línea de tiempos críticos y el botón manual de actualización de estatus.
   */
  renderDetalle() {
    const caja = document.getElementById("detalle-operativo");
    const r = this.seleccion && this.seleccion.tipo === "reporte" ? this.buscarReporte(this.seleccion.id) : null;
    if (!r) { caja.hidden = true; return; }
    caja.hidden = false;
    const c = this.buscarCuadrilla(r.cuadrillaId);
    const t = r.tiempos;
    const hito = (etiqueta, fecha) => `<li class="${fecha ? "hecho" : ""}">${etiqueta}: <time>${fecha ? this.hora(fecha) : "—"}</time></li>`;
    const sig = r.siguienteEstatus();
    const textoBoton = r.estatus === "pendiente" ? "Despachar ahora" : sig ? `Cambiar a: ${CATALOGO.estatusReporte[sig]}` : "Cerrado";

    document.getElementById("detalle-contenido").innerHTML = `
      <div class="resumen-op">
        <div><span>Severidad</span><b>${r.severidad}/5</b></div>
        <div><span>ETA</span><b>${this.textoETA(r)}</b></div>
        <div><span>Distancia</span><b>${r.distanciaKm ? r.distanciaKm.toFixed(1) + " km" : "—"}</b></div>
      </div>
      <dl class="datos-op">
        <dt>Folio</dt><dd>${r.folio} · <span class="insignia p-${r.prioridad}">${CATALOGO.prioridad[r.prioridad]}</span></dd>
        <dt>Supervisor</dt><dd>${c ? c.supervisor : "Sin asignar"}</dd>
        <dt>Unidad</dt><dd>${c ? `${c.unidad.id} · ${CATALOGO.tipoUnidad[c.unidad.tipo]}` : "—"}</dd>
        <dt>Inventario</dt><dd>${c ? c.unidad.inventario + " % de refacciones a bordo" : "—"}</dd>
        <dt>Transcurrido</dt><dd>${Math.round(r.minutosTranscurridos())} min de 120 (SLA)</dd>
      </dl>
      <ol class="linea-tiempo">
        ${hito("Recepción del reporte", t.recepcion)}
        ${hito("Asignación de cuadrilla", t.asignacion)}
        ${hito("Salida del almacén", t.salida)}
        ${hito("Arribo a sitio", t.arribo)}
        ${hito("Solución final", t.solucion)}
      </ol>
      <button type="button" class="boton boton-primario" data-accion="avanzar" data-folio="${r.folio}" ${sig ? "" : "disabled"}>${textoBoton}</button>`;
  }

  /* ------------------------------------------------------------------
     UTILIDADES DE FORMATO Y AVISOS
     ------------------------------------------------------------------ */

  /**
   * Convierte el ETA del reporte en texto legible según su estado: guion si no
   * hay cuadrilla, minutos restantes proporcionales al avance si va en camino,
   * y "En sitio" o "Listo" cuando la unidad ya llegó o se cerró.
   */
  textoETA(r) {
    if (r.etaMin === null) return "—";
    if (r.estatus === "en-sitio") return "En sitio";
    if (r.estatus === "solucionado") return "Listo";
    return `${Math.max(1, Math.round(r.etaMin * (1 - r.avance)))} min`;
  }

  /**
   * Da formato de 24 horas (HH:MM) a una fecha usando la configuración regional
   * de México. Se emplea en la línea de tiempos críticos del operativo para
   * que el despachador lea los hitos del SLA de forma homogénea.
   */
  hora(fecha) {
    return fecha.toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit", hour12: false });
  }

  /**
   * Actualiza cada segundo el reloj operativo del encabezado con horas, minutos
   * y segundos. En una sala de control el reloj visible es esencial para medir
   * los tiempos de atención contra el compromiso de servicio.
   */
  actualizarReloj() {
    document.getElementById("reloj-operativo").textContent =
      new Date().toLocaleTimeString("es-MX", { hour12: false });
  }

  /**
   * Muestra una notificación emergente (toast) durante cuatro segundos en la
   * esquina inferior. Confirma acciones como despachos, arribos y cambios de
   * estatus sin interrumpir al operador con ventanas modales bloqueantes.
   */
  notificar(mensaje) {
    const aviso = document.getElementById("aviso");
    aviso.textContent = mensaje;
    aviso.classList.add("visible");
    clearTimeout(this._temporizadorAviso);
    this._temporizadorAviso = setTimeout(() => aviso.classList.remove("visible"), 4000);
  }
}

/* =====================================================================
   ARRANQUE: se espera a que el DOM esté listo antes de crear el controlador
   ===================================================================== */
document.addEventListener("DOMContentLoaded", () => {
  window.dashboard = new ControladorDashboard();   // expuesto para depuración en consola
  window.dashboard.iniciar();
});
