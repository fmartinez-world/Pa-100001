/*
 * Contacto-Cliente — Intermediario en Cloudflare Workers
 * Base: configuración, conexión con Microsoft 365, Excel en OneDrive, candado y utilidades.
 *
 * Todo corre dentro de UN Durable Object ("principal"): así hay una sola copia de los datos
 * en memoria y un solo candado para escribir, como el LockService de Apps Script.
 */

/* ------------------------- CONFIGURACIÓN ------------------------- */
// Los valores que no son secretos se cambian en wrangler.toml ([vars]).
export const CONFIG = {
  NOMBRE_SISTEMA: 'Contacto-Cliente',
  CARPETA_ONEDRIVE: 'Contacto-Cliente',
  INCLUIR_CLAVE_EN_CORREO: true,
  DURACION_SESION_MIN: 360,
  INTENTOS_MAX: 5,
  BLOQUEO_MIN: 15,
  CODIGO_MIN: 15,
  LARGO_MIN_CLAVE: 8,
  ITERACIONES: 1000,          // NO cambiar: es el mismo cifrado de la versión de Apps Script
  ZONA: 'America/Santo_Domingo',
  DESFASE_ZONA_MIN: -240,
  MAX_AUDIO_MB: 10,
  REGISTRAR_ESCUCHAS: true,
  MAX_IMPORTAR_POR_LOTE: 2000,
  CACHE_MIN: 10
};

export const ADMIN_INICIAL = { usuario: 'admin', nombre: 'Administrador' };

export const HOJA_USUARIOS = 'Usuarios';
export const HOJA_CLIENTES = 'Clientes';
export const HOJA_ACTIVIDAD = 'Actividad';
export const HOJA_FORMULARIOS = 'Formularios';
export const HOJA_RESPUESTAS = 'Respuestas';

export const COLUMNAS = ['usuario', 'nombre', 'rol', 'activo', 'salt', 'hash', 'creado', 'actualizado', 'ultimoAcceso', 'actualizadoPor'];
export const COL_CLI = ['codigo', 'nombre', 'direccion', 'sector', 'ruta', 'vendedor', 'telefono',
  'audioId', 'audioNombre', 'audioFecha', 'audioPor', 'actualizado', 'actualizadoPor', 'oculto'];
export const CAMPOS_CLI = ['codigo', 'nombre', 'direccion', 'sector', 'ruta', 'vendedor', 'telefono'];
export const COL_ACT = ['fecha', 'usuario', 'accion', 'detalle'];
export const COL_FORM = ['id', 'titulo', 'descripcion', 'activo', 'unaVez', 'preguntas', 'creado', 'creadoPor', 'actualizado', 'actualizadoPor'];
export const COL_RES = ['id', 'fecha', 'formularioId', 'formulario', 'codigo', 'cliente', 'usuario', 'resumen', 'datos'];

export const ROLES = ['usuario', 'editor', 'supervisor', 'admin'];
export const NIVEL = { usuario: 0, editor: 1, supervisor: 2, admin: 3 };

/* PERMISOS: rol mínimo para cada acción (usuario · editor · supervisor · admin). La app lee esta tabla. */
export const PERMISOS = {
  responderFormularios: 'usuario',
  editarClientes: 'editor',
  agregarAudio: 'editor',
  verHistorialCompleto: 'supervisor',
  verRespuestas: 'supervisor',
  verActividad: 'supervisor',
  reemplazarAudio: 'admin',
  eliminarAudio: 'admin',
  ocultarClientes: 'admin',
  disenarFormularios: 'admin',
  eliminarRespuestas: 'admin',
  eliminarClientes: 'admin',
  gestionarUsuarios: 'admin'
};

export const TIPOS_PREGUNTA = ['texto', 'parrafo', 'numero', 'sino', 'opcion', 'varias', 'fecha', 'calificacion'];
export const EXT_AUDIO = ['mp3', 'm4a', 'mp4', 'aac', 'ogg', 'oga', 'opus', 'wav', 'webm', 'amr', '3gp', 'flac'];
export const MS_ALCANCES = 'offline_access User.Read Files.ReadWrite Mail.Send';

/* ------------------------- estado del Durable Object ------------------------- */
// Lo llena el Durable Object al arrancar (ver index.js).
export const S = { env: null, storage: null, mem: {} };

export class ErrorApp extends Error {
  constructor(mensaje, codigo) { super(mensaje); this.codigo = codigo || ''; }
}

/* ------------------------- utilidades ------------------------- */

export const esperar = ms => new Promise(ok => setTimeout(ok, ms));
export const norm = s => String(s || '').trim().toLowerCase();
export const normCodigo = s => String(s == null ? '' : s).trim().replace(/\s+/g, ' ').toUpperCase();
export const limpiarTexto = (s, max) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max);
export function textoLibre(s, max) {
  return String(s == null ? '' : s).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '')
    .replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
}
export const esVerdad = v => v === true || String(v).toUpperCase() === 'TRUE' || v === 1 || v === '1';
export const vacio = v => v === '' || v === null || v === undefined || (Array.isArray(v) && !v.length);
export const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

export function hexAleatorio(bytes) {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return [...b].map(x => x.toString(16).padStart(2, '0')).join('');
}
export const nuevoId = (prefijo, largo) => prefijo + hexAleatorio(16).slice(0, largo).toUpperCase();

const FMT = new Intl.DateTimeFormat('en-GB', { timeZone: CONFIG.ZONA, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
export function formatoFecha(d, patron) {
  const p = {};
  FMT.formatToParts(d).forEach(x => { p[x.type] = x.value; });
  return patron.replace('yyyy', p.year).replace('MM', p.month).replace('dd', p.day).replace('HH', p.hour).replace('mm', p.minute);
}
export const fecha = d => (d instanceof Date && !isNaN(d)) ? formatoFecha(d, 'dd/MM/yyyy HH:mm') : '';

export function base64ABytes(b64) {
  const bin = atob(String(b64)), n = bin.length, out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function sha256Hex(texto) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(texto));
  return [...new Uint8Array(h)].map(x => x.toString(16).padStart(2, '0')).join('');
}

/* ------------------------- almacenamiento persistente ------------------------- */
// Equivale a PropertiesService (permanente) y CacheService (con vencimiento).

export const prop = k => S.storage.get('p_' + k);
export const setProp = (k, v) => S.storage.put('p_' + k, v);
export const delProp = k => S.storage.delete('p_' + k);

export async function cacheGet(k) {
  const v = await S.storage.get('c_' + k);
  if (!v) return null;
  if (v.vence < Date.now()) { await S.storage.delete('c_' + k); return null; }
  return v.valor;
}
export const cachePut = (k, valor, segundos) => S.storage.put('c_' + k, { valor, vence: Date.now() + segundos * 1000 });
export const cacheDel = k => S.storage.delete('c_' + k);

/* ------------------------- candado (una escritura a la vez) ------------------------- */

let cola = Promise.resolve();
/** Espera su turno y devuelve la función para soltar el candado. No es reentrante. */
export function bloquear() {
  let soltar;
  const turno = new Promise(ok => { soltar = ok; });
  const antes = cola;
  cola = antes.then(() => turno);
  return antes.then(() => soltar);
}

/* ------------------------- Microsoft 365 ------------------------- */

const urlGraph = () => (S.env.GRAPH_URL || 'https://graph.microsoft.com/v1.0');
const urlLogin = () => (S.env.LOGIN_URL || 'https://login.microsoftonline.com');

export function enlaceMicrosoft(estado, redirect) {
  return urlLogin() + '/' + S.env.MS_TENANT_ID + '/oauth2/v2.0/authorize' +
    '?client_id=' + encodeURIComponent(S.env.MS_CLIENT_ID) + '&response_type=code&response_mode=query' +
    '&redirect_uri=' + encodeURIComponent(redirect) + '&scope=' + encodeURIComponent(MS_ALCANCES) +
    '&state=' + estado + '&prompt=select_account';
}

/** Pide un token a Microsoft y guarda el de actualización. */
export async function pedirToken(datos) {
  if (!S.env.MS_TENANT_ID || !S.env.MS_CLIENT_ID || !S.env.MS_CLIENT_SECRET) {
    throw new ErrorApp('Falta configurar MS_TENANT_ID, MS_CLIENT_ID o MS_CLIENT_SECRET en Cloudflare.');
  }
  const cuerpo = new URLSearchParams(Object.assign({ client_id: S.env.MS_CLIENT_ID, client_secret: S.env.MS_CLIENT_SECRET, scope: MS_ALCANCES }, datos));
  const r = await fetch(urlLogin() + '/' + S.env.MS_TENANT_ID + '/oauth2/v2.0/token', { method: 'POST', body: cuerpo });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    console.error('Token de Microsoft', r.status, JSON.stringify(j).slice(0, 300));
    const vencido = /AADSTS7000222|AADSTS7000215/.test(j.error_description || '');
    throw new ErrorApp(vencido
      ? 'El secreto de la app de Microsoft venció o es incorrecto. El administrador debe crear uno nuevo y actualizarlo en GitHub.'
      : 'Se perdió la conexión con OneDrive. El administrador debe entrar a /configurar y pulsar "Conectar OneDrive".');
  }
  if (j.refresh_token) await setProp('MS_REFRESH', j.refresh_token);
  S.mem.token = { valor: j.access_token, vence: Date.now() + ((Number(j.expires_in) || 3600) - 300) * 1000 };
  return j.access_token;
}

async function tokenMicrosoft() {
  if (S.mem.token && S.mem.token.vence > Date.now()) return S.mem.token.valor;
  const refresh = await prop('MS_REFRESH');
  if (!refresh) throw new ErrorApp('OneDrive no está conectado. El administrador debe entrar a /configurar y pulsar "Conectar OneDrive".');
  return pedirToken({ grant_type: 'refresh_token', refresh_token: refresh });
}

/**
 * Llama a Microsoft Graph. op: { crudo: true (cuerpo binario), tipo, rango, sinToken, token }
 * Reintenta cuando Microsoft pide esperar (429/503/504) o cuando el Excel está ocupado.
 */
export async function graph(metodo, ruta, cuerpo, op) {
  op = op || {};
  const url = /^https?:/.test(ruta) ? ruta : urlGraph() + ruta;
  for (let intento = 0; intento < 6; intento++) {
    const headers = {};
    if (!op.sinToken) headers.Authorization = 'Bearer ' + (op.token || await tokenMicrosoft());
    if (op.rango) headers['Content-Range'] = op.rango;
    let body;
    if (op.crudo) { body = cuerpo; headers['Content-Type'] = op.tipo || 'application/octet-stream'; }
    else if (cuerpo !== undefined && cuerpo !== null) { body = JSON.stringify(cuerpo); headers['Content-Type'] = 'application/json'; }
    let r;
    try { r = await fetch(url, { method: metodo, headers, body }); }
    catch (e) { if (intento < 3) { await esperar(1000 * (intento + 1)); continue; } throw new ErrorApp('No hay conexión con OneDrive. Intenta de nuevo.'); }
    const texto = await r.text();
    let j = null;
    try { j = texto ? JSON.parse(texto) : null; } catch (e) { j = null; }
    if (r.ok) return j;
    const detalle = (j && j.error && (j.error.message || j.error.code)) || ('HTTP ' + r.status);
    if (r.status === 401 && !op.sinToken && !op.token && intento === 0) { S.mem.token = null; continue; }
    if ((r.status === 429 || r.status === 503 || r.status === 504 || (r.status === 409 && /busy|EditModeCannotAcquireLock/i.test(texto))) && intento < 5) {
      const s = Number(r.headers.get('Retry-After')) || Math.pow(2, intento + 1);
      await esperar(Math.min(20, s) * 1000);
      continue;
    }
    if (r.status === 404) throw new ErrorApp('No se encontró en OneDrive.', 'NO_EXISTE');
    console.error('Graph ' + metodo + ' ' + url + ' → ' + r.status + ': ' + texto.slice(0, 400));
    if (r.status === 401 || r.status === 403) throw new ErrorApp('OneDrive no dio permiso (' + detalle + '). El administrador debe revisar la conexión en /configurar.');
    throw new ErrorApp('OneDrive respondió con un error: ' + detalle);
  }
  throw new ErrorApp('OneDrive está muy ocupado en este momento. Intenta de nuevo en un minuto.');
}

/** Envía un correo desde la cuenta corporativa (reemplaza MailApp). */
export async function enviarCorreo(asunto, html, obligatorio) {
  const para = S.env.CORREO_GENERAL;
  try {
    if (!para) throw new Error('falta CORREO_GENERAL');
    await graph('POST', '/me/sendMail', { saveToSentItems: false, message: {
      subject: '[' + CONFIG.NOMBRE_SISTEMA + '] ' + asunto,
      body: { contentType: 'HTML', content: '<div style="font-family:Arial,sans-serif;font-size:14px;color:#222">' + html + '</div>' },
      toRecipients: [{ emailAddress: { address: para } }] } });
  } catch (e) {
    console.error('No se pudo enviar el correo: ' + e.message);
    if (obligatorio) throw new ErrorApp('No se pudo enviar el correo. Intenta más tarde.');
  }
}

/* =========================================================
 *  EXCEL EN ONEDRIVE
 *   - Usuarios, Clientes y Formularios se tienen completas en memoria (se releen del Excel
 *     cada CACHE_MIN minutos, por si alguien lo editó a mano).
 *   - Actividad y Respuestas (que crecen mucho) se leen por partes, solo lo necesario.
 *   - El texto se escribe con apóstrofo para que Excel no lo convierta (ceros a la izquierda,
 *     teléfonos, fórmulas). Las fechas se guardan como fechas de Excel.
 * ========================================================= */

const HOJAS_COMPLETAS = [HOJA_USUARIOS, HOJA_CLIENTES, HOJA_FORMULARIOS];
const COLS_FECHA = ['creado', 'actualizado', 'ultimoAcceso', 'audioFecha', 'fecha'];
const FILAS_POR_ENVIO = 1000;
const FORMATO_FECHA = 'dd/mm/yyyy hh:mm';

export function letraCol(n) { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }
const fechaAExcel = d => (d.getTime() + CONFIG.DESFASE_ZONA_MIN * 60000) / 86400000 + 25569;
const excelAFecha = n => new Date(Math.round(((n - 25569) * 86400000 - CONFIG.DESFASE_ZONA_MIN * 60000) / 1000) * 1000);

function aExcel(v) {
  if (v instanceof Date) return isNaN(v.getTime()) ? ['', 'General'] : [fechaAExcel(v), FORMATO_FECHA];
  if (v === null || v === undefined || v === '') return ['', 'General'];
  if (typeof v === 'boolean' || typeof v === 'number') return [v, 'General'];
  return ["'" + String(v), 'General'];
}
function aCrudo(v) {
  if (v instanceof Date) return isNaN(v.getTime()) ? '' : fechaAExcel(v);
  if (v === null || v === undefined) return '';
  return v;
}

const memHojas = {};   // nombre -> { datos, cargada, version }
const versiones = {};  // nombre -> número que sube con cada escritura

export function invalidarHojas() { Object.keys(memHojas).forEach(k => delete memHojas[k]); }

export async function excelId() {
  const id = await prop('EXCEL_ID');
  if (!id) throw new ErrorApp('El sistema no está instalado. El administrador debe entrar a /configurar y pulsar "Instalar".');
  return id;
}

let nombresHojas = null;
export function olvidarLibro() { nombresHojas = null; invalidarHojas(); }

async function baseLibro() { return '/me/drive/items/' + await excelId() + '/workbook'; }

export async function hoja(nombre) {
  const base = await baseLibro();
  if (!nombresHojas) {
    const r = await graph('GET', base + '/worksheets?$select=name');
    nombresHojas = (r.value || []).map(w => w.name);
  }
  if (nombresHojas.indexOf(nombre) < 0) throw new ErrorApp('No se encontró la hoja "' + nombre + '" en el Excel. Pulsa "Instalar" en /configurar.');
  return new Hoja(base, nombre);
}

/** Crea la hoja si falta y le pone los títulos. */
export async function asegurarHoja(nombre, columnas) {
  const base = await baseLibro();
  if (!nombresHojas) {
    const r = await graph('GET', base + '/worksheets?$select=name');
    nombresHojas = (r.value || []).map(w => w.name);
  }
  if (nombresHojas.indexOf(nombre) < 0) {
    await graph('POST', base + '/worksheets/add', { name: nombre });
    nombresHojas.push(nombre);
  }
  const sh = new Hoja(base, nombre);
  if (await sh.getLastRow() === 0) await sh.appendRow(columnas);
  return sh;
}

export class Hoja {
  constructor(base, nombre) {
    this.nombre = nombre;
    this.base = base + "/worksheets('" + encodeURIComponent(nombre) + "')";
    this.completa = HOJAS_COMPLETAS.indexOf(nombre) >= 0;
    this.ultima = null;
  }

  async ultimaExcel() {
    const r = await graph('GET', this.base + '/usedRange(valuesOnly=true)?$select=address');
    const m = String(r.address || '').match(/!?[A-Z]+(\d+)(?::[A-Z]+(\d+))?$/);
    if (!m) return 0;
    const ult = Number(m[2] || m[1]);
    if (ult === 1) {
      const a = await graph('GET', this.base + "/range(address='A1:Z1')?$select=values");
      if (((a.values || [[]])[0] || []).every(v => v === '')) return 0;
    }
    return ult;
  }

  async cargar() {
    const m = memHojas[this.nombre];
    if (m && Date.now() - m.cargada < CONFIG.CACHE_MIN * 60000) return m.datos;
    for (let intento = 0; intento < 3; intento++) {
      const version = versiones[this.nombre] || 0;
      const ult = await this.ultimaExcel();
      const datos = [];
      if (ult > 0) {
        const ancho = Math.max(Number((await graph('GET', this.base + '/usedRange?$select=columnCount')).columnCount) || 1, 1);
        for (let desde = 1; desde <= ult; desde += 3000) {
          const hasta = Math.min(ult, desde + 2999);
          const r = await graph('GET', this.base + "/range(address='A" + desde + ':' + letraCol(ancho) + hasta + "')?$select=values");
          (r.values || []).forEach(f => datos.push(f));
        }
      }
      while (datos.length && datos[datos.length - 1].every(v => v === '')) datos.pop();
      // Si alguien escribió mientras se leía, se vuelve a leer para no quedarse con datos viejos.
      if ((versiones[this.nombre] || 0) !== version) continue;
      memHojas[this.nombre] = { datos, cargada: Date.now() };
      return datos;
    }
    throw new ErrorApp('El Excel está cambiando mucho en este momento. Intenta de nuevo.');
  }

  async titulos() {
    if (this.completa) return ((await this.cargar())[0] || []).map(String);
    const k = 'tit_' + this.nombre;
    if (S.mem[k]) return S.mem[k];
    const r = await graph('GET', this.base + "/range(address='A1:Z1')?$select=values");
    S.mem[k] = ((r.values || [[]])[0] || []).map(String);
    return S.mem[k];
  }

  async getLastRow() {
    if (this.completa) return (await this.cargar()).length;
    if (this.ultima === null) this.ultima = await this.ultimaExcel();
    return this.ultima;
  }

  async convertir(filas, col) {
    const tit = await this.titulos();
    return filas.map(f => f.map((v, j) => {
      if (COLS_FECHA.indexOf(tit[col - 1 + j]) >= 0 && typeof v === 'number' && v > 0) return excelAFecha(v);
      return v === null || v === undefined ? '' : v;
    }));
  }

  /** Valores de un rango (fila y columna empiezan en 1), con fechas como Date. */
  async leer(fila, col, nf, nc) {
    let crudo = [];
    if (nf <= 0) return [];
    if (this.completa) {
      const datos = await this.cargar();
      for (let i = 0; i < nf; i++) {
        const f = datos[fila - 1 + i] || [], out = [];
        for (let j = 0; j < nc; j++) { const v = f[col - 1 + j]; out.push(v === undefined || v === null ? '' : v); }
        crudo.push(out);
      }
    } else {
      for (let desde = 0; desde < nf; desde += 5000) {
        const n = Math.min(5000, nf - desde);
        const a = letraCol(col) + (fila + desde) + ':' + letraCol(col + nc - 1) + (fila + desde + n - 1);
        const r = await graph('GET', this.base + "/range(address='" + a + "')?$select=values");
        crudo = crudo.concat(r.values || []);
      }
    }
    return this.convertir(crudo, col);
  }

  async escribir(fila, col, valores) {
    if (!valores.length) return;
    const nc = valores[0].length;
    versiones[this.nombre] = (versiones[this.nombre] || 0) + 1;
    for (let desde = 0; desde < valores.length; desde += FILAS_POR_ENVIO) {
      const parte = valores.slice(desde, desde + FILAS_POR_ENVIO);
      const vals = [], fmts = [];
      parte.forEach(f => {
        const v = [], fm = [];
        for (let j = 0; j < nc; j++) { const x = aExcel(f[j]); v.push(x[0]); fm.push(x[1]); }
        vals.push(v); fmts.push(fm);
      });
      const a = letraCol(col) + (fila + desde) + ':' + letraCol(col + nc - 1) + (fila + desde + parte.length - 1);
      await graph('PATCH', this.base + "/range(address='" + a + "')", { values: vals, numberFormat: fmts });
    }
    const ultimaEscrita = fila + valores.length - 1;
    if (this.completa) {
      const m = memHojas[this.nombre];
      if (m) {
        const datos = m.datos;
        for (let i = 0; i < valores.length; i++) {
          const r = fila - 1 + i;
          while (datos.length <= r) datos.push([]);
          for (let j = 0; j < nc; j++) {
            while (datos[r].length < col - 1 + j) datos[r].push('');
            datos[r][col - 1 + j] = aCrudo(valores[i][j]);
          }
        }
      }
    } else if (this.ultima !== null && ultimaEscrita > this.ultima) {
      this.ultima = ultimaEscrita;
    }
    if (fila === 1) delete S.mem['tit_' + this.nombre];
  }

  async appendRow(fila) { await this.escribir(await this.getLastRow() + 1, 1, [fila]); }

  async deleteRow(fila) {
    versiones[this.nombre] = (versiones[this.nombre] || 0) + 1;
    await graph('POST', this.base + "/range(address='" + fila + ':' + fila + "')/delete", { shift: 'Up' });
    if (this.completa) { const m = memHojas[this.nombre]; if (m) m.datos.splice(fila - 1, 1); }
    else if (this.ultima !== null) this.ultima = Math.max(0, this.ultima - 1);
  }

  /** Filas (número de fila) cuyo valor en la columna "col" es exactamente "texto". */
  async buscar(col, texto, desdeFila, nf) {
    const vals = await this.leer(desdeFila, col, nf, 1);
    const out = [];
    vals.forEach((f, i) => { if (String(f[0]) === String(texto)) out.push(desdeFila + i); });
    return out;
  }
}

/** Agrupa números de fila ordenados en bloques [desde, hasta] uniendo huecos de hasta "hueco" filas. */
export function bloquesDeFilas(orden, hueco) {
  const bloques = [];
  orden.forEach(n => {
    const ult = bloques[bloques.length - 1];
    if (ult && n - ult[1] <= hueco) ult[1] = Math.max(ult[1], n); else bloques.push([n, n]);
  });
  return bloques;
}

/* ------------------------- carpetas de OneDrive ------------------------- */

async function carpetaEn(propiedad, madre, nombre, crear) {
  if (S.mem['carp_' + propiedad]) return S.mem['carp_' + propiedad];
  let f = null;
  const id = await prop(propiedad);
  if (id) { try { f = await graph('GET', '/me/drive/items/' + id + '?$select=id,name,webUrl'); } catch (e) { f = null; } }
  if (!f) {
    const base = madre === 'root' ? '/me/drive/root' : '/me/drive/items/' + madre;
    try { f = await graph('GET', base + ':/' + encodeURIComponent(nombre) + '?$select=id,name,webUrl'); } catch (e) { f = null; }
    if (!f) {
      if (!crear) return null;
      f = await graph('POST', base + '/children', { name: nombre, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' });
    }
    await setProp(propiedad, f.id);
  }
  S.mem['carp_' + propiedad] = { id: f.id, name: f.name, webUrl: f.webUrl };
  return S.mem['carp_' + propiedad];
}

export const carpetaRaiz = () => carpetaEn('CARPETA_RAIZ_ID', 'root', CONFIG.CARPETA_ONEDRIVE, true);
export async function carpetaNotas(crear) {
  if (!crear && !(await prop('CARPETA_ID'))) return null;
  return carpetaEn('CARPETA_ID', (await carpetaRaiz()).id, 'Notas de voz', crear);
}
export async function carpetaReemplazadas() {
  return carpetaEn('CARPETA_REEMPLAZADAS_ID', (await carpetaNotas(true)).id, 'Notas reemplazadas', true);
}

/** Sube un archivo a una carpeta: directo hasta 4 MB, por partes si es más grande. */
export async function subirArchivo(carpetaId, nombre, bytes, mime) {
  const ruta = '/me/drive/items/' + carpetaId + ':/' + encodeURIComponent(nombre) + ':';
  if (bytes.length <= 4 * 1024 * 1024) {
    return graph('PUT', ruta + '/content?@microsoft.graph.conflictBehavior=rename', bytes, { crudo: true, tipo: mime });
  }
  const sesion = await graph('POST', ruta + '/createUploadSession', { item: { '@microsoft.graph.conflictBehavior': 'rename' } });
  const TROZO = 320 * 1024 * 10;
  let res = null;
  for (let desde = 0; desde < bytes.length; desde += TROZO) {
    const hasta = Math.min(desde + TROZO, bytes.length);
    res = await graph('PUT', sesion.uploadUrl, bytes.slice(desde, hasta),
      { crudo: true, sinToken: true, rango: 'bytes ' + desde + '-' + (hasta - 1) + '/' + bytes.length });
  }
  return res;
}

/** Reemplaza el contenido de un archivo existente (lo usa la migración del Excel). */
export async function reemplazarContenido(itemId, bytes) {
  if (bytes.length <= 4 * 1024 * 1024) {
    return graph('PUT', '/me/drive/items/' + itemId + '/content', bytes, { crudo: true, tipo: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }
  const sesion = await graph('POST', '/me/drive/items/' + itemId + '/createUploadSession', { item: { '@microsoft.graph.conflictBehavior': 'replace' } });
  const TROZO = 320 * 1024 * 10;
  let res = null;
  for (let desde = 0; desde < bytes.length; desde += TROZO) {
    const hasta = Math.min(desde + TROZO, bytes.length);
    res = await graph('PUT', sesion.uploadUrl, bytes.slice(desde, hasta),
      { crudo: true, sinToken: true, rango: 'bytes ' + desde + '-' + (hasta - 1) + '/' + bytes.length });
  }
  return res;
}
