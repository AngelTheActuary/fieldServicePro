/* =====================================================================
   FieldService Pro · js/datos.js
   ---------------------------------------------------------------------
   CAPA DE MODELO. Define las clases del dominio (Geo, UnidadServicio,
   Cuadrilla, ReporteFalla, MotorDespacho) y los datos semilla que en
   producción vendrían del backend (Node.js + PostgreSQL/PostGIS) por
   una API REST y por WebSockets (Socket.IO).
   ===================================================================== */
"use strict";

/* ---------------------------------------------------------------------
   CATÁLOGOS: diccionarios de texto legible. Separan el valor interno
   (clave) de lo que ve el operador (etiqueta), igual que un ENUM en SQL.
   --------------------------------------------------------------------- */
const CATALOGO = {
  prioridad: { critica: "Crítica", estandar: "Estándar", programado: "Programado" },
  categoria: { electrica: "Eléctrica industrial", hvac: "HVAC", redes: "Redes / Fibra" },
  tipoUnidad: { moto: "Moto de inspección", camioneta: "Camioneta de servicio", van: "Van de herramientas" },
  estatusCuadrilla: { "disponible": "Disponible", "en-centro": "En Centro", "en-camino": "En Camino", "en-sitio": "En Sitio" },
  estatusReporte: { pendiente: "Pendiente", asignado: "Asignado", "en-camino": "En Camino", "en-sitio": "En Sitio", solucionado: "Solucionado" },
  /* Orden del flujo manual del caso: Asignado ➔ En Camino ➔ En Sitio ➔ Solucionado */
  flujoReporte: ["pendiente", "asignado", "en-camino", "en-sitio", "solucionado"]
};

/* =====================================================================
   CLASE Geo (utilidades estáticas de geometría terrestre)
   ===================================================================== */
class Geo {
  /**
   * Calcula la distancia en kilómetros entre dos coordenadas con la fórmula
   * de Haversine, que modela la Tierra como esfera de radio 6371 km. Es la
   * misma métrica que usaría PostGIS con ST_Distance sobre tipo geography.
   */
  static distanciaKm(a, b) {
    const R = 6371;                                   // radio medio terrestre (km)
    const rad = (g) => (g * Math.PI) / 180;           // grados → radianes
    const dLat = rad(b.lat - a.lat);
    const dLng = rad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 +
              Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  /**
   * Suma la longitud de una polilínea (lista ordenada de puntos) aplicando
   * Haversine tramo por tramo. Se usa para conocer la distancia total de
   * la ruta de atención y, con ella, estimar el tiempo de arribo (ETA).
   */
  static longitudRutaKm(puntos) {
    let total = 0;
    for (let i = 1; i < puntos.length; i++) total += Geo.distanciaKm(puntos[i - 1], puntos[i]);
    return total;
  }

  /**
   * Genera un polígono regular de n vértices que aproxima un círculo de
   * radio dado en km alrededor de un centro. Corrige la longitud con el
   * coseno de la latitud, porque un grado de longitud mide menos que uno de latitud.
   */
  static poligonoRadio(centro, radioKm, n = 36) {
    const kmPorGradoLat = 111.32;
    const kmPorGradoLng = 111.32 * Math.cos((centro.lat * Math.PI) / 180);
    const vertices = [];
    for (let i = 0; i < n; i++) {
      const t = (2 * Math.PI * i) / n;
      vertices.push({
        lat: centro.lat + (radioKm * Math.sin(t)) / kmPorGradoLat,
        lng: centro.lng + (radioKm * Math.cos(t)) / kmPorGradoLng
      });
    }
    return vertices;
  }

  /**
   * Interpola un punto intermedio sobre una polilínea según la fracción
   * recorrida (0 = inicio, 1 = destino). Permite simular el avance GPS de
   * una unidad sobre su ruta sin necesitar coordenadas reales del dispositivo.
   */
  static puntoEnRuta(puntos, fraccion) {
    const total = Geo.longitudRutaKm(puntos);
    let objetivo = Math.min(Math.max(fraccion, 0), 1) * total;
    for (let i = 1; i < puntos.length; i++) {
      const tramo = Geo.distanciaKm(puntos[i - 1], puntos[i]);
      if (objetivo <= tramo || i === puntos.length - 1) {
        const f = tramo === 0 ? 0 : Math.min(objetivo / tramo, 1);
        return {
          lat: puntos[i - 1].lat + (puntos[i].lat - puntos[i - 1].lat) * f,
          lng: puntos[i - 1].lng + (puntos[i].lng - puntos[i - 1].lng) * f
        };
      }
      objetivo -= tramo;
    }
    return { ...puntos[puntos.length - 1] };
  }
}

/* =====================================================================
   CLASE UnidadServicio (vehículo técnico)
   Atributos: id, tipo, velocidad, capacidad, autonomía, inventario y
   equipamiento (categorías de falla que puede atender con su herramienta).
   ===================================================================== */
class UnidadServicio {
  /**
   * Construye un vehículo técnico. La velocidad promedio urbana depende del
   * tipo: la moto es más ágil en tráfico, la van es lenta pero lleva más
   * herramienta. El inventario es el porcentaje de refacciones a bordo.
   */
  constructor({ id, tipo, capacidadKg, autonomiaKm, inventario, equipamiento }) {
    this.id = id;                          // matrícula interna, ej. "VAN-03"
    this.tipo = tipo;                      // "moto" | "camioneta" | "van"
    this.capacidadKg = capacidadKg;        // carga máxima de herramientas
    this.autonomiaKm = autonomiaKm;        // rango con tanque/batería llena
    this.inventario = inventario;          // 0–100 % de refacciones a bordo
    this.equipamiento = equipamiento;      // categorías atendibles
    this.velocidadKmh = { moto: 32, camioneta: 24, van: 20 }[tipo]; // promedio CDMX
  }

  /**
   * Indica si el vehículo lleva la herramienta y suficiente inventario para
   * una categoría y severidad. Regla de negocio: a mayor severidad se exige
   * más refacción a bordo (severidad × 12 %), evitando despachos inútiles.
   */
  puedeAtender(categoria, severidad) {
    return this.equipamiento.includes(categoria) && this.inventario >= severidad * 12;
  }
}

/* =====================================================================
   CLASE Cuadrilla (equipo de ingenieros + su unidad)
   ===================================================================== */
class Cuadrilla {
  /**
   * Crea una cuadrilla técnica con su supervisor, certificaciones, turno,
   * calificación de desempeño, vehículo asignado, posición GPS y estatus.
   * El campo reporteFolio enlaza la cuadrilla con el incidente que atiende.
   */
  constructor({ id, supervisor, integrantes, certificaciones, turno, calificacion, unidad, posicion, estatus }) {
    this.id = id;
    this.supervisor = supervisor;
    this.integrantes = integrantes;
    this.certificaciones = certificaciones;   // ["electrica", "hvac", "redes"]
    this.turno = turno;                       // "Matutino" | "Vespertino" | "Nocturno"
    this.calificacion = calificacion;         // 1.0 – 5.0
    this.unidad = unidad;                     // instancia de UnidadServicio
    this.posicion = { ...posicion };          // {lat, lng} actual (GPS)
    this.base = { ...posicion };              // punto de patrullaje / retorno
    this.estatus = estatus;                   // disponible | en-centro | en-camino | en-sitio
    this.reporteFolio = null;                 // folio del reporte asignado
  }

  /**
   * Determina si la cuadrilla es elegible para un reporte: debe estar libre,
   * contar con la certificación de la categoría y su vehículo debe tener
   * herramienta e inventario suficientes. Es el filtro previo al cálculo de distancia.
   */
  esElegible(reporte) {
    const libre = !this.reporteFolio && (this.estatus === "disponible" || this.estatus === "en-centro");
    return libre &&
           this.certificaciones.includes(reporte.categoria) &&
           this.unidad.puedeAtender(reporte.categoria, reporte.severidad);
  }
}

/* =====================================================================
   CLASE ReporteFalla (incidente reportado)
   ===================================================================== */
class ReporteFalla {
  /**
   * Registra un incidente con los campos obligatorios del caso: ubicación,
   * severidad 1-5 y categoría de infraestructura. Inicia en estatus pendiente
   * y guarda la marca de recepción como primer tiempo crítico del SLA.
   */
  constructor({ folio, prioridad, categoria, severidad, ubicacion, recepcion }) {
    this.folio = folio;
    this.prioridad = prioridad;
    this.categoria = categoria;
    this.severidad = severidad;
    this.ubicacion = ubicacion;               // {nombre, lat, lng}
    this.estatus = "pendiente";
    this.cuadrillaId = null;
    this.ruta = [];                           // polilínea origen → sitio
    this.distanciaKm = 0;
    this.etaMin = null;
    this.avance = 0;                          // fracción recorrida 0..1
    /* Registro de tiempos críticos exigido por el caso */
    this.tiempos = { recepcion: recepcion || new Date(), asignacion: null, salida: null, arribo: null, solucion: null };
  }

  /**
   * Devuelve el siguiente estatus del flujo Asignado ➔ En Camino ➔ En Sitio ➔
   * Solucionado, o null si el reporte ya se cerró. Centralizar la secuencia
   * evita que la interfaz permita saltos de estado inválidos.
   */
  siguienteEstatus() {
    const i = CATALOGO.flujoReporte.indexOf(this.estatus);
    return i >= 0 && i < CATALOGO.flujoReporte.length - 1 ? CATALOGO.flujoReporte[i + 1] : null;
  }

  /**
   * Calcula los minutos transcurridos desde la recepción hasta la solución o
   * hasta ahora si sigue abierto. Este valor alimenta el KPI de tiempo promedio
   * y permite medir el cumplimiento del SLA de dos horas.
   */
  minutosTranscurridos(ahora = new Date()) {
    const fin = this.tiempos.solucion || ahora;
    return (fin - this.tiempos.recepcion) / 60000;
  }
}

/* =====================================================================
   CLASE MotorDespacho (algoritmo core: asignación + ruta + ETA)
   ===================================================================== */
class MotorDespacho {
  /**
   * Recibe las colecciones de cuadrillas y almacenes. El radio preferente de
   * 2 km replica la consulta espacial ST_DWithin de PostGIS descrita en el
   * caso; si nadie está dentro, se amplía la búsqueda a toda la flota.
   */
  constructor(cuadrillas, almacenes) {
    this.cuadrillas = cuadrillas;
    this.almacenes = almacenes;
    this.radioPreferenteKm = 2;
  }

  /**
   * Factor de congestión según la hora del día (simula la API de tráfico en
   * tiempo real). Valores mayores a 1 reducen la velocidad efectiva; las horas
   * pico de CDMX (7-10 y 18-21 h) penalizan hasta un 80 %.
   */
  factorTrafico(fecha = new Date()) {
    const h = fecha.getHours();
    if ((h >= 7 && h < 10) || (h >= 18 && h < 21)) return 1.8;
    if (h >= 10 && h < 18) return 1.35;
    return 1.0;
  }

  /**
   * Selecciona la cuadrilla óptima: filtra elegibles, prioriza las ubicadas
   * dentro de 2 km y elige la de menor distancia; en empate gana la mejor
   * calificación. Retorna null si ninguna cumple herramientas y certificaciones.
   */
  seleccionarCuadrilla(reporte) {
    const candidatos = this.cuadrillas
      .filter((c) => c.esElegible(reporte))
      .map((c) => ({ c, d: Geo.distanciaKm(c.posicion, reporte.ubicacion) }));
    if (!candidatos.length) return null;

    const cercanos = candidatos.filter((x) => x.d <= this.radioPreferenteKm);
    const universo = cercanos.length ? cercanos : candidatos;
    universo.sort((a, b) => a.d - b.d || b.c.calificacion - a.c.calificacion);
    return universo[0].c;
  }

  /**
   * Construye una ruta tipo "cuadrícula urbana" en forma de escalón: avanza
   * por avenidas horizontales y verticales en lugar de línea recta. Así la
   * distancia se acerca a la métrica Manhattan, más realista dentro de la ciudad.
   */
  trazarRuta(origen, destino) {
    const medioLng = origen.lng + (destino.lng - origen.lng) * 0.55;
    const medioLat = origen.lat + (destino.lat - origen.lat) * 0.45;
    return [
      { lat: origen.lat, lng: origen.lng },
      { lat: origen.lat, lng: medioLng },
      { lat: medioLat, lng: medioLng },
      { lat: medioLat, lng: destino.lng },
      { lat: destino.lat, lng: destino.lng }
    ];
  }

  /**
   * Ejecuta el despacho completo: elige cuadrilla, traza la ruta, calcula
   * distancia y ETA (distancia ÷ velocidad × factor de tráfico), registra la
   * hora de asignación y vincula ambos objetos. Devuelve la cuadrilla o null.
   */
  despachar(reporte) {
    const cuadrilla = this.seleccionarCuadrilla(reporte);
    if (!cuadrilla) return null;

    reporte.ruta = this.trazarRuta(cuadrilla.posicion, reporte.ubicacion);
    reporte.distanciaKm = Geo.longitudRutaKm(reporte.ruta);
    reporte.etaMin = (reporte.distanciaKm / cuadrilla.unidad.velocidadKmh) * 60 * this.factorTrafico();
    reporte.cuadrillaId = cuadrilla.id;
    reporte.estatus = "asignado";
    reporte.tiempos.asignacion = new Date();

    cuadrilla.reporteFolio = reporte.folio;
    cuadrilla.estatus = "en-centro";          // carga refacciones antes de salir
    return cuadrilla;
  }
}

/* =====================================================================
   DATOS SEMILLA (simulan la respuesta inicial del backend)
   ===================================================================== */

/* Límites geográficos del área de operación (Valle de México) */
const LIMITES = { latMin: 19.30, latMax: 19.55, lngMin: -99.30, lngMax: -98.98 };

/* Distritos industriales y comerciales: polígonos aproximados */
const DISTRITOS = [
  { nombre: "Tlalnepantla Ind.", tipo: "industrial", vertices: [[19.545,-99.245],[19.545,-99.185],[19.515,-99.180],[19.515,-99.240]] },
  { nombre: "Vallejo Ind.",       tipo: "industrial", vertices: [[19.515,-99.170],[19.515,-99.120],[19.480,-99.125],[19.482,-99.172]] },
  { nombre: "Azcapotzalco",       tipo: "industrial", vertices: [[19.505,-99.225],[19.508,-99.178],[19.470,-99.176],[19.468,-99.222]] },
  { nombre: "Polanco",            tipo: "comercial",  vertices: [[19.450,-99.225],[19.452,-99.178],[19.420,-99.180],[19.418,-99.222]] },
  { nombre: "Centro / Cuauhtémoc",tipo: "comercial",  vertices: [[19.455,-99.170],[19.455,-99.120],[19.410,-99.122],[19.412,-99.172]] },
  { nombre: "Santa Fe",           tipo: "comercial",  vertices: [[19.385,-99.290],[19.390,-99.240],[19.350,-99.238],[19.348,-99.285]] },
  { nombre: "Coyoacán",           tipo: "comercial",  vertices: [[19.365,-99.185],[19.365,-99.130],[19.320,-99.132],[19.322,-99.183]] },
  { nombre: "Iztapalapa Ind.",    tipo: "industrial", vertices: [[19.395,-99.110],[19.392,-99.030],[19.340,-99.032],[19.343,-99.108]] }
].map((d) => ({ ...d, vertices: d.vertices.map(([lat, lng]) => ({ lat, lng })) }));

/* Zonas de alta incidencia (heatmap): centro + intensidad 0..1 + radio km */
const ZONAS_CALOR = [
  { lat: 19.498, lng: -99.148, intensidad: 1.0, radioKm: 2.2 },
  { lat: 19.366, lng: -99.070, intensidad: 0.85, radioKm: 2.6 },
  { lat: 19.432, lng: -99.140, intensidad: 0.6, radioKm: 1.6 },
  { lat: 19.530, lng: -99.210, intensidad: 0.55, radioKm: 1.8 },
  { lat: 19.367, lng: -99.262, intensidad: 0.4, radioKm: 1.4 }
];

/* Almacenes técnicos de refacciones (centros de suministro) */
const ALMACENES = [
  { id: "ALM-N", nombre: "Almacén Norte Vallejo", lat: 19.492, lng: -99.160 },
  { id: "ALM-C", nombre: "Almacén Central Doctores", lat: 19.418, lng: -99.148 },
  { id: "ALM-O", nombre: "Almacén Iztapalapa", lat: 19.360, lng: -99.085 }
];

/* Sitios frecuentes para el formulario (geocodificación inversa simulada) */
const SITIOS = [
  { nombre: "Planta química Vallejo, Norte 45", lat: 19.502, lng: -99.142 },
  { nombre: "Centro de datos Santa Fe, Torre B", lat: 19.364, lng: -99.258 },
  { nombre: "Hospital General, Col. Doctores", lat: 19.412, lng: -99.153 },
  { nombre: "Nave 7 Parque Ind. Tlalnepantla", lat: 19.533, lng: -99.205 },
  { nombre: "Central de Abasto, Iztapalapa", lat: 19.372, lng: -99.088 },
  { nombre: "Corporativo Polanco, Ejército Nal.", lat: 19.438, lng: -99.196 },
  { nombre: "Subestación Azcapotzalco", lat: 19.487, lng: -99.205 },
  { nombre: "Plaza comercial Coyoacán", lat: 19.343, lng: -99.160 },
  { nombre: "Bodega frigorífica Iztapalapa", lat: 19.352, lng: -99.050 }
];

/**
 * Fábrica de datos iniciales. Crea vehículos, cuadrillas y reportes con
 * instancias de las clases del modelo para que toda la aplicación trabaje
 * con objetos coherentes. En producción esto sería un fetch('/api/estado-inicial').
 */
function crearEstadoInicial() {
  const U = (o) => new UnidadServicio(o);
  const flota = [
    new Cuadrilla({ id: "CU-01", supervisor: "Ing. Bruno Díaz",      integrantes: 3, certificaciones: ["electrica", "hvac"],  turno: "Matutino",   calificacion: 4.9, estatus: "disponible", posicion: { lat: 19.495, lng: -99.155 }, unidad: U({ id: "VAN-01", tipo: "van", capacidadKg: 900, autonomiaKm: 420, inventario: 92, equipamiento: ["electrica", "hvac"] }) }),
    new Cuadrilla({ id: "CU-02", supervisor: "Ing. Bárbara Gordon",  integrantes: 2, certificaciones: ["redes"],              turno: "Matutino",   calificacion: 4.8, estatus: "disponible", posicion: { lat: 19.372, lng: -99.248 }, unidad: U({ id: "MOT-02", tipo: "moto", capacidadKg: 40, autonomiaKm: 180, inventario: 60, equipamiento: ["redes"] }) }),
    new Cuadrilla({ id: "CU-03", supervisor: "Ing. Lucio Fox",       integrantes: 3, certificaciones: ["electrica", "redes"], turno: "Matutino",   calificacion: 4.7, estatus: "en-centro",  posicion: { lat: 19.418, lng: -99.148 }, unidad: U({ id: "CAM-03", tipo: "camioneta", capacidadKg: 600, autonomiaKm: 500, inventario: 78, equipamiento: ["electrica", "redes"] }) }),
    new Cuadrilla({ id: "CU-04", supervisor: "Ing. Selina Kyle",     integrantes: 2, certificaciones: ["hvac"],               turno: "Vespertino", calificacion: 4.4, estatus: "disponible", posicion: { lat: 19.345, lng: -99.150 }, unidad: U({ id: "CAM-04", tipo: "camioneta", capacidadKg: 550, autonomiaKm: 460, inventario: 70, equipamiento: ["hvac"] }) }),
    new Cuadrilla({ id: "CU-05", supervisor: "Ing. James Gordon",    integrantes: 4, certificaciones: ["electrica", "hvac"],  turno: "Vespertino", calificacion: 4.6, estatus: "disponible", posicion: { lat: 19.368, lng: -99.070 }, unidad: U({ id: "VAN-05", tipo: "van", capacidadKg: 1000, autonomiaKm: 400, inventario: 85, equipamiento: ["electrica", "hvac"] }) }),
    new Cuadrilla({ id: "CU-06", supervisor: "Ing. Alfred Pennyworth", integrantes: 1, certificaciones: ["electrica"],        turno: "Vespertino", calificacion: 5.0, estatus: "disponible", posicion: { lat: 19.440, lng: -99.205 }, unidad: U({ id: "MOT-06", tipo: "moto", capacidadKg: 35, autonomiaKm: 160, inventario: 45, equipamiento: ["electrica"] }) }),
    new Cuadrilla({ id: "CU-07", supervisor: "Ing. Dick Grayson",    integrantes: 3, certificaciones: ["redes", "electrica"], turno: "Nocturno",   calificacion: 4.3, estatus: "disponible", posicion: { lat: 19.528, lng: -99.222 }, unidad: U({ id: "CAM-07", tipo: "camioneta", capacidadKg: 620, autonomiaKm: 480, inventario: 66, equipamiento: ["redes", "electrica"] }) }),
    new Cuadrilla({ id: "CU-08", supervisor: "Ing. Harvey Dent",     integrantes: 3, certificaciones: ["hvac", "redes"],      turno: "Nocturno",   calificacion: 4.1, estatus: "en-centro",  posicion: { lat: 19.360, lng: -99.085 }, unidad: U({ id: "VAN-08", tipo: "van", capacidadKg: 950, autonomiaKm: 410, inventario: 88, equipamiento: ["hvac", "redes"] }) })
  ];

  /* Reportes de ejemplo con recepción escalonada en el pasado reciente */
  const hace = (min) => new Date(Date.now() - min * 60000);
  const R = (folio, prioridad, categoria, severidad, sitio, min) =>
    new ReporteFalla({ folio, prioridad, categoria, severidad, ubicacion: SITIOS[sitio], recepcion: hace(min) });

  const reportes = [
    R("FS-1041", "critica",    "electrica", 5, 0, 38),
    R("FS-1042", "critica",    "redes",     4, 1, 26),
    R("FS-1043", "estandar",   "hvac",      3, 7, 18),
    R("FS-1044", "estandar",   "electrica", 2, 5, 12),
    R("FS-1045", "programado", "hvac",      1, 8, 9),
    R("FS-1046", "critica",    "hvac",      4, 2, 5)
  ];

  return { flota, reportes };
}
