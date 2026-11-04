/*
 * Contacto-Cliente — Lógica de la plataforma (misma que tenía Code.gs en Apps Script)
 *   1. Acceso: inicio de sesión, sesiones, bloqueo por intentos, roles.
 *   2. Usuarios: crear, activar/desactivar, eliminar, restablecer y cambiar contraseña.
 *   3. Recuperación: "¿Olvidaste tu contraseña?" con código al correo general.
 *   4. Clientes · 5. Notas de voz · 6. Actividad · 7. Formularios e historial.
 */
import {
  CONFIG, ADMIN_INICIAL, HOJA_USUARIOS, HOJA_CLIENTES, HOJA_ACTIVIDAD, HOJA_FORMULARIOS, HOJA_RESPUESTAS,
  COLUMNAS, COL_CLI, CAMPOS_CLI, COL_ACT, COL_FORM, COL_RES, ROLES, NIVEL, PERMISOS, TIPOS_PREGUNTA, EXT_AUDIO,
  S, ErrorApp, norm, normCodigo, limpiarTexto, textoLibre, esVerdad, vacio, esc, hexAleatorio, nuevoId,
  formatoFecha, fecha, base64ABytes, sha256Hex, cacheGet, cachePut, cacheDel, bloquear, graph, enviarCorreo,
  hoja, asegurarHoja, bloquesDeFilas, carpetaNotas, carpetaReemplazadas, subirArchivo
} from './base.js';

/* =========================================================
 *  CONTRASEÑAS (mismo cifrado que Apps Script: las contraseñas migradas siguen sirviendo)
 * ========================================================= */

export async function hashClave(clave, salt) {
  let h = await sha256Hex(salt + ':' + clave);
  for (let i = 0; i < CONFIG.ITERACIONES; i++) h = await sha256Hex(h + salt);
  return h;
}
async function verificarClave(clave, u) {
  const a = await hashClave(clave, String(u.salt));
  const b = String(u.hash);
  if (a.length !== b.length) return false;
  let dif = 0;
  for (let i = 0; i < a.length; i++) dif |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return dif === 0;
}
export function validarClave(clave) {
  if (clave.length < CONFIG.LARGO_MIN_CLAVE) throw new ErrorApp('La contraseña debe tener al menos ' + CONFIG.LARGO_MIN_CLAVE + ' caracteres.');
  if (clave.length > 100) throw new ErrorApp('La contraseña es demasiado larga.');
}
export const nuevaSal = () => hexAleatorio(16);
function nuevoCodigo() {
  const b = new Uint32Array(1); crypto.getRandomValues(b);
  return String(b[0] % 1000000).padStart(6, '0');
}
async function asignarClave(u, clave, por) {
  const salt = nuevaSal();
  const hash = await hashClave(clave, salt);
  await guardarCampos(u.fila, { salt, hash, actualizado: new Date(), actualizadoPor: por });
  u.salt = salt; u.hash = hash;
  return u;
}

/* =========================================================
 *  USUARIOS (hoja Usuarios)
 * ========================================================= */

export async function leerUsuarios() {
  const sh = await hoja(HOJA_USUARIOS);
  const n = await sh.getLastRow();
  if (n < 2) return [];
  const filas = await sh.leer(2, 1, n - 1, COLUMNAS.length);
  return filas.map((fila, i) => {
    const u = { fila: i + 2 };
    COLUMNAS.forEach((col, j) => { u[col] = fila[j]; });
    u.usuario = String(u.usuario || '').trim().toLowerCase();
    u.nombre = String(u.nombre || '');
    u.rol = ROLES.indexOf(u.rol) >= 0 ? u.rol : 'usuario';
    u.activo = u.activo === true || String(u.activo).toUpperCase() === 'TRUE';
    return u;
  }).filter(u => u.usuario);
}
export async function buscarUsuario(usuario) {
  const u = norm(usuario);
  if (!u) return null;
  return (await leerUsuarios()).find(x => x.usuario === u) || null;
}
/** Cambia varios campos de un usuario escribiendo la fila completa una sola vez. */
export async function guardarCampos(fila, campos) {
  const sh = await hoja(HOJA_USUARIOS);
  const valores = (await sh.leer(fila, 1, 1, COLUMNAS.length))[0];
  Object.keys(campos).forEach(k => { valores[COLUMNAS.indexOf(k)] = campos[k]; });
  await sh.escribir(fila, 1, [valores]);
}
async function objetivoProtegido(usuario, admin) {
  const u = await buscarUsuario(usuario);
  if (!u) throw new ErrorApp('El usuario no existe.');
  if (u.usuario === ADMIN_INICIAL.usuario) throw new ErrorApp('El usuario principal "' + u.usuario + '" no se puede modificar así.');
  if (u.usuario === admin.usuario) throw new ErrorApp('No puedes cambiar el estado, el rol ni eliminar tu propio usuario.');
  return u;
}

/* =========================================================
 *  SESIONES Y ROLES
 * ========================================================= */

const segundosSesion = () => Math.min(CONFIG.DURACION_SESION_MIN, 360) * 60;

async function crearSesion(u) {
  const token = hexAleatorio(32);
  await cachePut('s_' + token, { u: u.usuario, h: String(u.hash).slice(0, 16), renovada: Date.now() }, segundosSesion());
  return token;
}

/** Valida el token y el rol mínimo. Una sesión deja de servir si cambia la contraseña o se desactiva el usuario. */
async function requerirSesion(d, rolMinimo) {
  const s = d.token ? await cacheGet('s_' + d.token) : null;
  if (!s) throw new ErrorApp('Tu sesión expiró. Inicia sesión de nuevo.', 'SESION');
  const u = await buscarUsuario(s.u);
  if (!u || !u.activo || String(u.hash).slice(0, 16) !== s.h) {
    await cacheDel('s_' + d.token);
    throw new ErrorApp('Tu sesión ya no es válida. Inicia sesión de nuevo.', 'SESION');
  }
  if (rolMinimo && NIVEL[u.rol] < NIVEL[rolMinimo]) {
    throw new ErrorApp(rolMinimo === 'admin' ? 'Solo un administrador puede hacer esto.' : 'Tu usuario no tiene permiso para hacer esto.');
  }
  if (Date.now() - (s.renovada || 0) > 5 * 60000) { // renueva el tiempo (como mucho cada 5 minutos)
    s.renovada = Date.now();
    await cachePut('s_' + d.token, s, segundosSesion());
  }
  return u;
}
export function permite(u, permiso) {
  const minimo = PERMISOS[permiso] || 'admin';
  return (NIVEL[u.rol] || 0) >= NIVEL[minimo];
}
async function requerirPermiso(d, permiso) {
  const u = await requerirSesion(d);
  if (!permite(u, permiso)) {
    const minimo = PERMISOS[permiso] || 'admin';
    throw new ErrorApp(minimo === 'admin' ? 'Solo un administrador puede hacer esto.'
      : 'Tu usuario no tiene permiso para hacer esto (se necesita rol ' + nombreRol(minimo) + ' o superior).');
  }
  return u;
}
const nombreRol = r => ({ usuario: 'usuario', editor: 'editor', supervisor: 'supervisor', admin: 'administrador' }[r] || r);
function perfil(u) {
  const permisos = {};
  Object.keys(PERMISOS).forEach(p => { if (permite(u, p)) permisos[p] = true; });
  return { usuario: u.usuario, nombre: u.nombre, rol: u.rol, permisos };
}

/* =========================================================
 *  ACTIVIDAD: se anota en memoria y se escribe en el Excel al final de cada petición, todo junto.
 * ========================================================= */

let pendiente = [];
export function registrar(usuario, accion, detalle) {
  pendiente.push([new Date(), String(usuario || ''), String(accion || ''), limpiarTexto(detalle || '', 300)]);
}
export async function guardarActividad() {
  if (!pendiente.length) return;
  const soltar = await bloquear();
  const filas = pendiente;
  pendiente = [];
  try {
    if (!filas.length) return;
    const sh = await hoja(HOJA_ACTIVIDAD);
    await sh.escribir(await sh.getLastRow() + 1, 1, filas);
  } catch (e) {
    console.error('No se pudo registrar actividad: ' + e.message);
  } finally { soltar(); }
}

async function listarActividad(d) {
  await requerirPermiso(d, 'verActividad');
  const sh = await hoja(HOJA_ACTIVIDAD);
  const n = await sh.getLastRow() - 1;
  if (n < 1) return { actividad: [], total: 0 };
  const leer = Math.min(n, 5000);
  const filas = (await sh.leer(n - leer + 2, 1, leer, COL_ACT.length)).reverse();
  const q = String(d.filtro || '').trim().toLowerCase();
  const limite = Math.min(Number(d.limite) || 300, 1000);
  const out = [];
  for (let i = 0; i < filas.length && out.length < limite; i++) {
    const f = filas[i];
    const texto = (f[1] + ' ' + f[2] + ' ' + f[3]).toLowerCase();
    if (q && texto.indexOf(q) < 0) continue;
    out.push([fecha(f[0]), String(f[1]), String(f[2]), String(f[3])]);
  }
  return { actividad: out, total: n };
}

/* =========================================================
 *  CORREOS DE AVISO
 * ========================================================= */

async function notificar(accion, u, clave, por) {
  const filas = [['Usuario', u.usuario], ['Nombre', u.nombre], ['Acción', accion], ['Realizado por', por], ['Fecha', fecha(new Date())]];
  if (CONFIG.INCLUIR_CLAVE_EN_CORREO && clave) filas.push(['Contraseña', clave]);
  const tabla = '<table cellpadding="8" style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:14px">' +
    filas.map(f => {
      const valor = f[0] === 'Contraseña' ? '<code style="font-size:16px;background:#f1f5f9;padding:2px 6px">' + esc(f[1]) + '</code>' : esc(f[1]);
      return '<tr><td style="border:1px solid #ddd;background:#f7f7f7"><b>' + esc(f[0]) + '</b></td><td style="border:1px solid #ddd">' + valor + '</td></tr>';
    }).join('') + '</table>';
  await enviarCorreo(accion + ' — ' + u.usuario, '<p>Aviso automático de cambios de acceso.</p>' + tabla, false);
}
function ocultarCorreo(correo) {
  const p = String(correo || '').split('@');
  return p.length === 2 ? p[0].slice(0, 4) + '•••@' + p[1] : 'correo general';
}

/* =========================================================
 *  MÓDULO 1-3: ACCESO, USUARIOS Y RECUPERACIÓN
 * ========================================================= */

async function login(d) {
  const usuario = norm(d.usuario);
  const clave = String(d.clave || '');
  if (!usuario || !clave) throw new ErrorApp('Escribe tu usuario y contraseña.');
  if (await cacheGet('bloq_' + usuario)) {
    throw new ErrorApp('Demasiados intentos fallidos. Espera ' + CONFIG.BLOQUEO_MIN + ' minutos e intenta de nuevo.');
  }
  const u = await buscarUsuario(usuario);
  if (!u || !(await verificarClave(clave, u))) {
    const fallos = Number(await cacheGet('fallos_' + usuario) || 0) + 1;
    if (fallos >= CONFIG.INTENTOS_MAX) {
      await cachePut('bloq_' + usuario, 1, CONFIG.BLOQUEO_MIN * 60);
      await cacheDel('fallos_' + usuario);
      registrar(usuario, 'Usuario bloqueado', CONFIG.INTENTOS_MAX + ' intentos fallidos');
      throw new ErrorApp('Demasiados intentos fallidos. El usuario quedó bloqueado ' + CONFIG.BLOQUEO_MIN + ' minutos.');
    }
    await cachePut('fallos_' + usuario, fallos, CONFIG.BLOQUEO_MIN * 60);
    throw new ErrorApp('Usuario o contraseña incorrectos.');
  }
  if (!u.activo) throw new ErrorApp('Este usuario está desactivado. Contacta al administrador.');
  await cacheDel('fallos_' + usuario);
  const soltar = await bloquear();
  try {
    const u2 = await buscarUsuario(usuario);
    if (u2) await guardarCampos(u2.fila, { ultimoAcceso: new Date() });
  } finally { soltar(); }
  registrar(u.usuario, 'Inicio de sesión', '');
  return { token: await crearSesion(u), usuario: perfil(u) };
}

async function sesion(d) { return { usuario: perfil(await requerirSesion(d)) }; }
async function salir(d) { if (d.token) await cacheDel('s_' + d.token); return {}; }

async function cambiarClave(d) {
  const soltar = await bloquear();
  try {
    const u = await requerirSesion(d);
    const actual = String(d.actual || ''), nueva = String(d.nueva || '');
    if (!(await verificarClave(actual, u))) throw new ErrorApp('La contraseña actual no es correcta.');
    validarClave(nueva);
    if (nueva === actual) throw new ErrorApp('La nueva contraseña debe ser diferente a la actual.');
    await asignarClave(u, nueva, u.usuario);
    await cacheDel('s_' + d.token);
    await notificar('Cambio de contraseña hecho por el propio usuario', u, nueva, u.usuario);
    registrar(u.usuario, 'Cambió su contraseña', '');
    return { token: await crearSesion(u), mensaje: 'Contraseña actualizada.' };
  } finally { soltar(); }
}

async function listarUsuarios(d) {
  await requerirSesion(d, 'admin');
  return { usuarios: (await leerUsuarios()).map(u => ({
    usuario: u.usuario, nombre: u.nombre, rol: u.rol, activo: u.activo,
    creado: fecha(u.creado), ultimoAcceso: fecha(u.ultimoAcceso), principal: u.usuario === ADMIN_INICIAL.usuario
  })) };
}

async function crearUsuario(d) {
  const soltar = await bloquear();
  try {
    const admin = await requerirSesion(d, 'admin');
    const usuario = norm(d.usuario);
    if (!/^[a-z0-9._-]{3,30}$/.test(usuario)) {
      throw new ErrorApp('El usuario debe tener de 3 a 30 caracteres: letras sin acento, números, punto, guion o guion bajo.');
    }
    if (await buscarUsuario(usuario)) throw new ErrorApp('Ya existe un usuario "' + usuario + '".');
    const nombre = limpiarTexto(d.nombre, 60);
    if (!nombre) throw new ErrorApp('Escribe el nombre de la persona.');
    const rol = ROLES.indexOf(d.rol) >= 0 ? d.rol : 'usuario';
    const clave = String(d.clave || '');
    validarClave(clave);
    const salt = nuevaSal();
    const ahora = new Date();
    await (await hoja(HOJA_USUARIOS)).appendRow([usuario, nombre, rol, true, salt, await hashClave(clave, salt), ahora, ahora, '', admin.usuario]);
    const nuevo = { usuario, nombre, rol };
    await notificar('Usuario creado (contraseña ' + (d.generada ? 'generada' : 'escrita por el administrador') + ')', nuevo, clave, admin.usuario);
    registrar(admin.usuario, 'Creó usuario', usuario + ' (' + rol + ')');
    return { usuario: nuevo, mensaje: 'Usuario creado.' };
  } finally { soltar(); }
}

async function restablecerClave(d) {
  const soltar = await bloquear();
  try {
    const admin = await requerirSesion(d, 'admin');
    const u = await buscarUsuario(d.usuario);
    if (!u) throw new ErrorApp('El usuario no existe.');
    if (u.usuario === ADMIN_INICIAL.usuario && admin.usuario !== ADMIN_INICIAL.usuario) {
      throw new ErrorApp('Solo el propio usuario "' + ADMIN_INICIAL.usuario + '" puede cambiar su contraseña.');
    }
    const clave = String(d.clave || '');
    validarClave(clave);
    await asignarClave(u, clave, admin.usuario);
    await cacheDel('bloq_' + u.usuario);
    await notificar('Contraseña restablecida por el administrador (' + (d.generada ? 'generada' : 'escrita') + ')', u, clave, admin.usuario);
    registrar(admin.usuario, 'Restableció contraseña', u.usuario);
    const res = { mensaje: 'Contraseña actualizada.' };
    if (u.usuario === admin.usuario) { await cacheDel('s_' + d.token); res.token = await crearSesion(u); }
    return res;
  } finally { soltar(); }
}

async function cambiarEstado(d) {
  const soltar = await bloquear();
  try {
    const admin = await requerirSesion(d, 'admin');
    const u = await objetivoProtegido(d.usuario, admin);
    const activo = d.activo === true;
    await guardarCampos(u.fila, { activo, actualizado: new Date(), actualizadoPor: admin.usuario });
    registrar(admin.usuario, activo ? 'Activó usuario' : 'Desactivó usuario', u.usuario);
    return { mensaje: activo ? 'Usuario activado.' : 'Usuario desactivado.' };
  } finally { soltar(); }
}

async function cambiarRol(d) {
  const soltar = await bloquear();
  try {
    const admin = await requerirSesion(d, 'admin');
    const u = await objetivoProtegido(d.usuario, admin);
    if (ROLES.indexOf(d.rol) < 0) throw new ErrorApp('Rol no válido.');
    await guardarCampos(u.fila, { rol: d.rol, actualizado: new Date(), actualizadoPor: admin.usuario });
    registrar(admin.usuario, 'Cambió rol', u.usuario + ': ' + u.rol + ' → ' + d.rol);
    return { mensaje: 'Rol actualizado.' };
  } finally { soltar(); }
}

async function eliminarUsuario(d) {
  const soltar = await bloquear();
  try {
    const admin = await requerirSesion(d, 'admin');
    const u = await objetivoProtegido(d.usuario, admin);
    await (await hoja(HOJA_USUARIOS)).deleteRow(u.fila);
    await notificar('Usuario eliminado', u, '', admin.usuario);
    registrar(admin.usuario, 'Eliminó usuario', u.usuario);
    return { mensaje: 'Usuario eliminado.' };
  } finally { soltar(); }
}

async function olvideClave(d) {
  const usuario = norm(d.usuario);
  if (!usuario) throw new ErrorApp('Escribe tu usuario.');
  if (await cacheGet('rcesp_' + usuario)) throw new ErrorApp('Ya se envió un código. Espera un minuto antes de pedir otro.');
  const u = await buscarUsuario(usuario);
  if (u && u.activo) {
    const codigo = nuevoCodigo();
    await cachePut('rc_' + usuario, { c: codigo, i: 0 }, CONFIG.CODIGO_MIN * 60);
    await cachePut('rcesp_' + usuario, 1, 60);
    await enviarCorreo('Código para restablecer la contraseña de ' + u.usuario,
      '<p>Se solicitó restablecer la contraseña del usuario <b>' + esc(u.usuario) + '</b> (' + esc(u.nombre) + ').</p>' +
      '<p style="font-size:28px;letter-spacing:6px;font-family:monospace;margin:16px 0"><b>' + codigo + '</b></p>' +
      '<p>El código vence en ' + CONFIG.CODIGO_MIN + ' minutos. Entrégaselo solo a esa persona.</p>' +
      '<p style="color:#777">Si nadie lo solicitó, ignora este correo; la contraseña no cambia.</p>', true);
    registrar(u.usuario, 'Pidió código de recuperación', '');
  }
  return { mensaje: 'Si el usuario existe, se envió un código de recuperación al correo general (' +
                    ocultarCorreo(S.env.CORREO_GENERAL) + '). Pídeselo al encargado.' };
}

async function restablecerConCodigo(d) {
  const soltar = await bloquear();
  try {
    const usuario = norm(d.usuario);
    const reg = await cacheGet('rc_' + usuario);
    if (!reg) throw new ErrorApp('El código venció o no es válido. Solicita uno nuevo.');
    if (reg.c !== String(d.codigo || '').trim()) {
      reg.i += 1;
      if (reg.i >= 5) { await cacheDel('rc_' + usuario); throw new ErrorApp('Demasiados intentos con código incorrecto. Solicita un código nuevo.'); }
      await cachePut('rc_' + usuario, reg, CONFIG.CODIGO_MIN * 60);
      throw new ErrorApp('El código no es correcto.');
    }
    const nueva = String(d.nueva || '');
    validarClave(nueva);
    const u = await buscarUsuario(usuario);
    if (!u || !u.activo) throw new ErrorApp('El usuario no existe o está desactivado.');
    await asignarClave(u, nueva, u.usuario + ' (código de recuperación)');
    await cacheDel('rc_' + usuario); await cacheDel('bloq_' + usuario); await cacheDel('fallos_' + usuario);
    await notificar('Contraseña restablecida con "¿Olvidaste tu contraseña?"' + (d.generada ? ' (generada)' : ''), u, nueva, u.usuario);
    registrar(u.usuario, 'Restableció su contraseña con código', '');
    return { mensaje: 'Contraseña restablecida. Ya puedes iniciar sesión.' };
  } finally { soltar(); }
}

/* =========================================================
 *  MÓDULO 4: CLIENTES
 * ========================================================= */

const ci = campo => COL_CLI.indexOf(campo);
const COMPACTO = ['codigo', 'nombre', 'direccion', 'sector', 'ruta', 'vendedor', 'telefono', 'audio', 'audioFecha', 'audioPor', 'oculto'];
const clienteVisible = (u, fila) => !esVerdad(fila[ci('oculto')]) || permite(u, 'ocultarClientes');

function limpiarCliente(c) {
  const out = {};
  CAMPOS_CLI.forEach(k => { out[k] = k === 'codigo' ? normCodigo(c[k]) : limpiarTexto(c[k], k === 'direccion' ? 250 : 120); });
  out.telefono = String(c.telefono == null ? '' : c.telefono).replace(/[^\d+\-() \/]/g, '').trim().slice(0, 40);
  return out;
}

/** Lee la hoja Clientes completa e indexa por código. */
async function tablaClientes() {
  const sh = await hoja(HOJA_CLIENTES);
  const n = await sh.getLastRow() - 1;
  const valores = n > 0 ? await sh.leer(2, 1, n, COL_CLI.length) : [];
  const indice = {};
  valores.forEach((f, i) => {
    const c = normCodigo(f[0]);
    f[0] = c;
    if (c && indice[c] === undefined) indice[c] = i;
  });
  return { hoja: sh, valores, indice, cambiadas: {} };
}

function compactar(f) {
  return [String(f[ci('codigo')]), String(f[ci('nombre')]), String(f[ci('direccion')]), String(f[ci('sector')]),
    String(f[ci('ruta')]), String(f[ci('vendedor')]), String(f[ci('telefono')]),
    f[ci('audioId')] ? 1 : 0, fecha(f[ci('audioFecha')]), String(f[ci('audioPor')] || ''), esVerdad(f[ci('oculto')]) ? 1 : 0];
}

function clientesCompactos(t) {
  if (S.mem.compactos && Date.now() - S.mem.compactos.t < CONFIG.CACHE_MIN * 60000) return S.mem.compactos.lista;
  const lista = t.valores.filter(f => f[0]).map(compactar);
  S.mem.compactos = { lista, t: Date.now() };
  return lista;
}
const invalidarClientes = () => { S.mem.compactos = null; };

async function escribirNuevos(t, filas) {
  await t.hoja.escribir(t.valores.length + 2, 1, filas);
}
/** Escribe solo las filas de clientes que cambiaron (columnas desde..desde+ancho). */
async function escribirFilasCambiadas(t, desde, ancho) {
  const idxs = Object.keys(t.cambiadas).map(Number).sort((a, b) => a - b);
  for (const b of bloquesDeFilas(idxs, 20)) {
    const bloque = t.valores.slice(b[0], b[1] + 1).map(f => f.slice(desde, desde + ancho));
    await t.hoja.escribir(b[0] + 2, desde + 1, bloque);
  }
}
async function escribirAudio(t, idx) {
  const desde = ci('audioId');
  await t.hoja.escribir(idx + 2, desde + 1, [t.valores[idx].slice(desde, desde + 4)]);
}

async function listarClientes(d) {
  const u = await requerirSesion(d);
  let lista;
  if (S.mem.compactos && Date.now() - S.mem.compactos.t < CONFIG.CACHE_MIN * 60000) lista = S.mem.compactos.lista;
  else lista = clientesCompactos(await tablaClientes());
  const iOculto = COMPACTO.indexOf('oculto');
  if (!permite(u, 'ocultarClientes')) lista = lista.filter(f => !f[iOculto]);
  const res = { campos: COMPACTO, clientes: lista };
  if (permite(u, 'agregarAudio')) {
    const c = await carpetaNotas(false);
    if (c) res.carpeta = { nombre: CONFIG.CARPETA_ONEDRIVE + '/' + c.name, url: c.webUrl };
  }
  return res;
}

async function guardarCliente(d) {
  const soltar = await bloquear();
  try {
    const u = await requerirPermiso(d, 'editarClientes');
    const datos = limpiarCliente(d.cliente || {});
    if (!datos.codigo) throw new ErrorApp('Escribe el código del cliente.');
    if (!/^[A-Z0-9][A-Z0-9 ._\/-]{0,39}$/.test(datos.codigo)) throw new ErrorApp('El código solo puede tener letras, números, espacio, punto, guion o barra (máximo 40).');
    if (!datos.nombre) throw new ErrorApp('Escribe el nombre del cliente.');
    const t = await tablaClientes();
    const original = d.codigoOriginal ? normCodigo(d.codigoOriginal) : '';
    const idxNuevo = t.indice[datos.codigo];
    let fila;
    if (!original) {
      if (idxNuevo !== undefined) throw new ErrorApp('Ya existe un cliente con el código "' + datos.codigo + '".');
      fila = COL_CLI.map(() => '');
      CAMPOS_CLI.forEach(k => { fila[ci(k)] = datos[k]; });
      fila[ci('actualizado')] = new Date();
      fila[ci('actualizadoPor')] = u.usuario;
      await escribirNuevos(t, [fila]);
      registrar(u.usuario, 'Creó cliente', datos.codigo + ' — ' + datos.nombre);
    } else {
      const idx = t.indice[original];
      if (idx === undefined || !clienteVisible(u, t.valores[idx])) throw new ErrorApp('El cliente "' + original + '" ya no existe.');
      if (datos.codigo !== original && idxNuevo !== undefined) throw new ErrorApp('Ya existe otro cliente con el código "' + datos.codigo + '".');
      fila = t.valores[idx];
      CAMPOS_CLI.forEach(k => { fila[ci(k)] = datos[k]; });
      fila[ci('actualizado')] = new Date();
      fila[ci('actualizadoPor')] = u.usuario;
      await t.hoja.escribir(idx + 2, 1, [fila]);
      registrar(u.usuario, 'Editó cliente', datos.codigo + (datos.codigo !== original ? ' (antes ' + original + ')' : ''));
    }
    invalidarClientes();
    return { cliente: compactar(fila), mensaje: original ? 'Cliente actualizado.' : 'Cliente creado.' };
  } finally { soltar(); }
}

async function eliminarCliente(d) {
  const soltar = await bloquear();
  try {
    const u = await requerirPermiso(d, 'eliminarClientes');
    const codigo = normCodigo(d.codigo);
    const t = await tablaClientes();
    const idx = t.indice[codigo];
    if (idx === undefined) throw new ErrorApp('El cliente no existe.');
    const fila = t.valores[idx];
    if (fila[ci('audioId')]) await papelera(fila[ci('audioId')]);
    await t.hoja.deleteRow(idx + 2);
    invalidarClientes();
    registrar(u.usuario, 'Eliminó cliente', codigo + ' — ' + fila[ci('nombre')]);
    return { mensaje: 'Cliente eliminado.' };
  } finally { soltar(); }
}

/** Importa clientes. Si el código existe, actualiza solo las columnas que vienen con valor. Nunca toca la nota de voz. */
async function importarClientes(d) {
  const soltar = await bloquear();
  try {
    const u = await requerirPermiso(d, 'editarClientes');
    const filas = Array.isArray(d.filas) ? d.filas : [];
    if (!filas.length) throw new ErrorApp('No llegaron filas para importar.');
    if (filas.length > CONFIG.MAX_IMPORTAR_POR_LOTE) throw new ErrorApp('Máximo ' + CONFIG.MAX_IMPORTAR_POR_LOTE + ' filas por envío.');
    const t = await tablaClientes();
    const nuevos = [], indiceNuevos = {}, omitidos = [];
    let actualizados = 0, sinCambios = 0;
    const ahora = new Date();
    filas.forEach((bruto, i) => {
      const c = limpiarCliente(bruto || {});
      const n = Number(d.desde || 0) + i + 1;
      if (!c.codigo) { omitidos.push('Fila ' + n + ': sin código'); return; }
      const idx = t.indice[c.codigo];
      if (idx !== undefined) {
        const fila = t.valores[idx];
        let cambio = false;
        CAMPOS_CLI.forEach(k => { if (k !== 'codigo' && c[k] && String(fila[ci(k)]) !== c[k]) { fila[ci(k)] = c[k]; cambio = true; } });
        if (cambio) {
          fila[ci('actualizado')] = ahora;
          fila[ci('actualizadoPor')] = u.usuario + ' (importación)';
          t.cambiadas[idx] = true;
          actualizados++;
        } else sinCambios++;
      } else if (indiceNuevos[c.codigo] !== undefined) {
        const f = nuevos[indiceNuevos[c.codigo]];
        CAMPOS_CLI.forEach(k => { if (c[k]) f[ci(k)] = c[k]; });
        omitidos.push('Fila ' + n + ': código ' + c.codigo + ' repetido en el archivo (se unieron los datos)');
      } else {
        if (!c.nombre) { omitidos.push('Fila ' + n + ': cliente nuevo ' + c.codigo + ' sin nombre'); return; }
        const f = COL_CLI.map(() => '');
        CAMPOS_CLI.forEach(k => { f[ci(k)] = c[k]; });
        f[ci('actualizado')] = ahora;
        f[ci('actualizadoPor')] = u.usuario + ' (importación)';
        indiceNuevos[c.codigo] = nuevos.length;
        nuevos.push(f);
      }
    });
    await escribirFilasCambiadas(t, 0, COL_CLI.length);
    if (nuevos.length) await escribirNuevos(t, nuevos);
    invalidarClientes();
    registrar(u.usuario, 'Importó clientes', 'nuevos ' + nuevos.length + ', actualizados ' + actualizados + ', sin cambios ' + sinCambios + ', omitidos ' + omitidos.length);
    return { nuevos: nuevos.length, actualizados, sinCambios, omitidos: omitidos.slice(0, 50), totalOmitidos: omitidos.length };
  } finally { soltar(); }
}

async function ocultarCliente(d) {
  const soltar = await bloquear();
  try {
    const u = await requerirPermiso(d, 'ocultarClientes');
    const codigo = normCodigo(d.codigo);
    const t = await tablaClientes();
    const idx = t.indice[codigo];
    if (idx === undefined) throw new ErrorApp('El cliente no existe.');
    const oculto = d.oculto === true;
    const fila = t.valores[idx];
    fila[ci('oculto')] = oculto ? true : '';
    fila[ci('actualizado')] = new Date();
    fila[ci('actualizadoPor')] = u.usuario;
    await t.hoja.escribir(idx + 2, 1, [fila]);
    invalidarClientes();
    registrar(u.usuario, oculto ? 'Ocultó cliente' : 'Mostró cliente', codigo + ' — ' + fila[ci('nombre')]);
    return { cliente: compactar(fila), mensaje: oculto ? 'Cliente oculto.' : 'El cliente vuelve a estar visible.' };
  } finally { soltar(); }
}

/* =========================================================
 *  MÓDULO 5: NOTAS DE VOZ (carpeta Contacto-Cliente/Notas de voz del OneDrive)
 * ========================================================= */

function extension(nombre, mime) {
  const m = String(nombre || '').toLowerCase().match(/\.([a-z0-9]{2,5})$/);
  if (m && EXT_AUDIO.indexOf(m[1]) >= 0) return m[1];
  const t = String(mime || '').toLowerCase();
  if (t.indexOf('webm') >= 0) return 'webm';
  if (t.indexOf('ogg') >= 0 || t.indexOf('opus') >= 0) return 'ogg';
  if (t.indexOf('mp4') >= 0 || t.indexOf('m4a') >= 0 || t.indexOf('aac') >= 0) return 'm4a';
  if (t.indexOf('wav') >= 0) return 'wav';
  if (t.indexOf('amr') >= 0) return 'amr';
  return 'mp3';
}
function tipoAudio(nombre, mime) {
  const ext = (String(nombre || '').toLowerCase().match(/\.([a-z0-9]{2,5})$/) || [])[1];
  const mapa = { mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg',
    opus: 'audio/ogg', wav: 'audio/wav', webm: 'audio/webm', amr: 'audio/amr', '3gp': 'audio/3gpp', flac: 'audio/flac' };
  if (ext && mapa[ext]) return mapa[ext];
  const m = String(mime || '');
  return m.indexOf('audio/') === 0 ? m.split(';')[0] : 'audio/mpeg';
}
function esAudio(nombre, mime) {
  const ext = (String(nombre || '').toLowerCase().match(/\.([a-z0-9]{2,5})$/) || [])[1];
  return String(mime || '').indexOf('audio/') === 0 || (ext && EXT_AUDIO.indexOf(ext) >= 0);
}

/** Nota reemplazada: se mueve a "Notas reemplazadas" con la fecha en el nombre (no se borra). */
async function archivar(id) {
  try {
    const f = await graph('GET', '/me/drive/items/' + encodeURIComponent(id) + '?$select=id,name');
    const m = f.name.match(/^(.*?)(\.[a-z0-9]{2,5})?$/i);
    await graph('PATCH', '/me/drive/items/' + f.id + '?@microsoft.graph.conflictBehavior=rename', {
      name: m[1] + ' (reemplazada ' + formatoFecha(new Date(), 'yyyy-MM-dd HHmm') + ')' + (m[2] || ''),
      parentReference: { id: (await carpetaReemplazadas()).id } });
  } catch (e) {
    console.error('No se pudo archivar la nota anterior, va a la papelera: ' + e.message);
    await papelera(id);
  }
}
/** Borra el archivo: queda en la papelera de reciclaje de OneDrive. */
async function papelera(id) {
  try { await graph('DELETE', '/me/drive/items/' + encodeURIComponent(id)); }
  catch (e) { console.error('No se pudo mover a la papelera: ' + e.message); }
}
function exigirReemplazo(u, codigo, reemplazar) {
  if (!permite(u, 'reemplazarAudio')) {
    throw new ErrorApp('El cliente ' + codigo + ' ya tiene nota de voz. Solo un ' + nombreRol(PERMISOS.reemplazarAudio) + ' puede cambiarla por otra.', 'SIN_PERMISO');
  }
  if (!reemplazar) throw new ErrorApp('El cliente ' + codigo + ' ya tiene nota de voz.', 'YA_TIENE');
}

/** Enlace temporal de Microsoft (~1 hora) para escuchar el audio. Solo con sesión válida. */
async function audio(d) {
  const u = await requerirSesion(d);
  const codigo = normCodigo(d.codigo);
  const t = await tablaClientes();
  const idx = t.indice[codigo];
  if (idx === undefined || !clienteVisible(u, t.valores[idx])) throw new ErrorApp('El cliente no existe.');
  const fila = t.valores[idx];
  const id = fila[ci('audioId')];
  if (!id) throw new ErrorApp('Este cliente no tiene nota de voz.');
  let f;
  try { f = await graph('GET', '/me/drive/items/' + encodeURIComponent(id)); }
  catch (e) {
    if (e.codigo === 'NO_EXISTE') throw new ErrorApp('No se encontró el archivo de audio en OneDrive. Puede que lo hayan borrado.');
    throw e;
  }
  if (CONFIG.REGISTRAR_ESCUCHAS) registrar(u.usuario, 'Escuchó nota de voz', codigo + ' — ' + fila[ci('nombre')]);
  return { mime: tipoAudio(f.name, f.file && f.file.mimeType), nombre: f.name, url: f['@microsoft.graph.downloadUrl'] };
}

async function subirAudio(d) {
  const u = await requerirPermiso(d, 'agregarAudio');
  const codigo = normCodigo(d.codigo);
  if (!d.base64) throw new ErrorApp('No llegó el audio.');
  const bytes = base64ABytes(d.base64);
  if (bytes.length > CONFIG.MAX_AUDIO_MB * 1024 * 1024) throw new ErrorApp('El audio pesa más de ' + CONFIG.MAX_AUDIO_MB + ' MB.');
  const ext = extension(d.nombreArchivo, d.mime);
  const soltar = await bloquear();
  try {
    const t = await tablaClientes();
    const idx = t.indice[codigo];
    if (idx === undefined || !clienteVisible(u, t.valores[idx])) throw new ErrorApp('No existe un cliente con el código "' + codigo + '".');
    const fila = t.valores[idx];
    const anterior = fila[ci('audioId')];
    if (anterior) exigirReemplazo(u, codigo, d.reemplazar);
    const nombreArchivo = codigo.replace(/[\/\\:*?"<>|#%]/g, '-') + '.' + ext;
    if (anterior) await archivar(anterior);
    const archivo = await subirArchivo((await carpetaNotas(true)).id, nombreArchivo, bytes, tipoAudio(nombreArchivo, d.mime));
    fila[ci('audioId')] = archivo.id;
    fila[ci('audioNombre')] = archivo.name;
    fila[ci('audioFecha')] = new Date();
    fila[ci('audioPor')] = u.usuario + (d.grabado ? ' (grabado en la app)' : '');
    await escribirAudio(t, idx);
    invalidarClientes();
    registrar(u.usuario, anterior ? 'Reemplazó nota de voz' : (d.grabado ? 'Grabó nota de voz' : 'Subió nota de voz'),
      codigo + ' — ' + fila[ci('nombre')] + (d.grabado && anterior ? ' (grabada en la app)' : ''));
    return { cliente: compactar(fila),
      mensaje: anterior ? 'Nota de voz reemplazada. La anterior quedó en la carpeta "Notas reemplazadas".' : 'Nota de voz guardada.' };
  } finally { soltar(); }
}

async function eliminarAudio(d) {
  const soltar = await bloquear();
  try {
    const u = await requerirPermiso(d, 'eliminarAudio');
    const codigo = normCodigo(d.codigo);
    const t = await tablaClientes();
    const idx = t.indice[codigo];
    if (idx === undefined) throw new ErrorApp('El cliente no existe.');
    const fila = t.valores[idx];
    if (!fila[ci('audioId')]) throw new ErrorApp('Este cliente no tiene nota de voz.');
    await papelera(fila[ci('audioId')]);
    ['audioId', 'audioNombre', 'audioFecha', 'audioPor'].forEach(k => { fila[ci(k)] = ''; });
    await escribirAudio(t, idx);
    invalidarClientes();
    registrar(u.usuario, 'Eliminó nota de voz', codigo + ' — ' + fila[ci('nombre')]);
    return { cliente: compactar(fila), mensaje: 'Nota de voz eliminada (quedó en la papelera de reciclaje de OneDrive).' };
  } finally { soltar(); }
}

function mapasCodigo(t) {
  const exacto = {}, sinCeros = {}, repetido = {};
  Object.keys(t.indice).forEach(c => {
    exacto[c] = t.indice[c];
    const s = c.replace(/^0+(?=.)/, '');
    if (sinCeros[s] !== undefined && sinCeros[s] !== t.indice[c]) repetido[s] = true; else sinCeros[s] = t.indice[c];
  });
  Object.keys(repetido).forEach(s => { delete sinCeros[s]; });
  return { exacto, sinCeros };
}
/** "C00123.mp3", "00123 Juan Perez.ogg", "Ruta 5 - C00123 - colmado.m4a" → C00123 */
function buscarCodigoEnNombre(nombre, mapas) {
  const base = String(nombre).replace(/\.[^.]+$/, '').trim().toUpperCase();
  if (mapas.exacto[base] !== undefined) return mapas.exacto[base];
  const partes = base.split(/[^A-Z0-9]+/).filter(Boolean);
  for (const p of partes) if (mapas.exacto[p] !== undefined) return mapas.exacto[p];
  for (const p of partes) { const s = p.replace(/^0+(?=.)/, ''); if (/\d/.test(s) && mapas.sinCeros[s] !== undefined) return mapas.sinCeros[s]; }
  return null;
}

/** Recorre "Notas de voz" y asocia cada audio al cliente cuyo código aparece en el nombre. Trabaja por tandas. */
async function sincronizarAudios(d) {
  const u = await requerirPermiso(d, 'agregarAudio');
  if (d.reemplazar && !permite(u, 'reemplazarAudio')) throw new ErrorApp('Solo un ' + nombreRol(PERMISOS.reemplazarAudio) + ' puede reemplazar notas de voz que ya existen.');
  const inicio = Date.now();
  const carpeta = await carpetaNotas(true);
  let enlace = d.continuar ? String(d.continuar) : '/me/drive/items/' + carpeta.id + '/children?$top=200&$select=id,name,file,folder,createdDateTime';
  if (d.continuar && !/^https:\/\//.test(enlace)) throw new ErrorApp('Token de continuación no válido.');
  const t = await tablaClientes();
  const mapas = mapasCodigo(t);
  const vinculados = {};
  t.valores.forEach(f => { if (f[ci('audioId')]) vinculados[f[ci('audioId')]] = true; });
  const cambios = {}, sinAsociar = [], conAudio = [];
  let procesados = 0, asociados = 0, yaAsociados = 0, ignorados = 0;
  while (enlace && Date.now() - inicio < 20000) {
    const pagina = await graph('GET', enlace);
    (pagina.value || []).forEach(f => {
      if (f.folder) return;
      procesados++;
      if (vinculados[f.id]) { yaAsociados++; return; }
      if (!esAudio(f.name, f.file && f.file.mimeType)) { ignorados++; return; }
      const idx = buscarCodigoEnNombre(f.name, mapas);
      if (idx === null) { if (sinAsociar.length < 1000) sinAsociar.push({ id: f.id, nombre: f.name }); return; }
      const codigo = String(t.valores[idx][ci('codigo')]);
      if ((t.valores[idx][ci('audioId')] || cambios[codigo]) && !d.reemplazar) {
        if (conAudio.length < 1000) conAudio.push({ id: f.id, nombre: f.name, codigo });
        return;
      }
      cambios[codigo] = { id: f.id, nombre: f.name, fecha: new Date(f.createdDateTime) };
      vinculados[f.id] = true;
      asociados++;
    });
    enlace = pagina['@odata.nextLink'] || null;
  }
  if (asociados) {
    const soltar = await bloquear();
    try {
      const t2 = await tablaClientes();
      for (const codigo of Object.keys(cambios)) {
        const idx = t2.indice[codigo];
        if (idx === undefined) continue;
        const fila = t2.valores[idx], c = cambios[codigo];
        if (fila[ci('audioId')] && fila[ci('audioId')] !== c.id) {
          if (!d.reemplazar) continue;
          await archivar(fila[ci('audioId')]);
        }
        // Migración: si es el mismo archivo que tenía en Google (mismo nombre), conserva fecha y autor.
        const mismo = !fila[ci('audioId')] && fila[ci('audioNombre')] === c.nombre && fila[ci('audioFecha')];
        fila[ci('audioId')] = c.id;
        fila[ci('audioNombre')] = c.nombre;
        if (!mismo) { fila[ci('audioFecha')] = c.fecha; fila[ci('audioPor')] = u.usuario + ' (sincronización)'; }
        t2.cambiadas[idx] = true;
      }
      await escribirFilasCambiadas(t2, ci('audioId'), 4);
    } finally { soltar(); }
    invalidarClientes();
  }
  registrar(u.usuario, 'Sincronizó carpeta de audios', 'revisados ' + procesados + ', asociados ' + asociados + ', sin asociar ' + sinAsociar.length + (enlace ? ' (continúa)' : ''));
  return { procesados, asociados, yaAsociados, ignorados, sinAsociar, conAudio, continuar: enlace };
}

async function asignarAudio(d) {
  const soltar = await bloquear();
  try {
    const u = await requerirPermiso(d, 'agregarAudio');
    const codigo = normCodigo(d.codigo);
    const t = await tablaClientes();
    const idx = t.indice[codigo];
    if (idx === undefined || !clienteVisible(u, t.valores[idx])) throw new ErrorApp('No existe un cliente con el código "' + codigo + '".');
    let archivo;
    try { archivo = await graph('GET', '/me/drive/items/' + encodeURIComponent(String(d.fileId)) + '?$select=id,name,createdDateTime'); }
    catch (e) { throw new ErrorApp('No se encontró el archivo en OneDrive.'); }
    const fila = t.valores[idx];
    const anterior = fila[ci('audioId')];
    if (anterior && anterior !== archivo.id) { exigirReemplazo(u, codigo, d.reemplazar); await archivar(anterior); }
    fila[ci('audioId')] = archivo.id;
    fila[ci('audioNombre')] = archivo.name;
    fila[ci('audioFecha')] = new Date(archivo.createdDateTime);
    fila[ci('audioPor')] = u.usuario + ' (asignado a mano)';
    await escribirAudio(t, idx);
    invalidarClientes();
    registrar(u.usuario, 'Asignó nota de voz', codigo + ' ← ' + archivo.name);
    return { cliente: compactar(fila), mensaje: 'Audio asignado al cliente ' + codigo + '.' };
  } finally { soltar(); }
}

/* =========================================================
 *  MÓDULO 7: FORMULARIOS E HISTORIAL DEL CLIENTE
 * ========================================================= */

const hojaFormularios = () => asegurarHoja(HOJA_FORMULARIOS, COL_FORM);
const hojaRespuestas = () => asegurarHoja(HOJA_RESPUESTAS, COL_RES);

async function leerFormularios() {
  const sh = await hojaFormularios();
  const n = await sh.getLastRow() - 1;
  if (n < 1) return [];
  return (await sh.leer(2, 1, n, COL_FORM.length)).map((f, i) => {
    let preguntas = [];
    try { preguntas = JSON.parse(f[5] || '[]'); } catch (e) { preguntas = []; }
    return { fila: i + 2, id: String(f[0]), titulo: String(f[1] || ''), descripcion: String(f[2] || ''),
      activo: esVerdad(f[3]), unaVez: esVerdad(f[4]), preguntas, actualizado: fecha(f[8]) };
  }).filter(f => f.id);
}

async function listarFormularios(d) {
  const u = await requerirSesion(d);
  let lista = await leerFormularios();
  if (!permite(u, 'disenarFormularios')) lista = lista.filter(f => f.activo);
  if (permite(u, 'verRespuestas')) {
    const conteo = {};
    const sh = await hojaRespuestas();
    const n = await sh.getLastRow() - 1;
    if (n > 0) (await sh.leer(2, COL_RES.indexOf('formularioId') + 1, n, 1)).forEach(f => { conteo[f[0]] = (conteo[f[0]] || 0) + 1; });
    lista.forEach(f => { f.respuestas = conteo[f.id] || 0; });
  }
  return { formularios: lista.map(f => { delete f.fila; return f; }) };
}

async function guardarFormulario(d) {
  const soltar = await bloquear();
  try {
    const u = await requerirPermiso(d, 'disenarFormularios');
    const f = d.formulario || {};
    const titulo = limpiarTexto(f.titulo, 100);
    if (!titulo) throw new ErrorApp('Escribe el título del formulario.');
    const descripcion = textoLibre(f.descripcion, 500);
    const brutas = Array.isArray(f.preguntas) ? f.preguntas : [];
    if (!brutas.length) throw new ErrorApp('Agrega al menos una pregunta.');
    if (brutas.length > 50) throw new ErrorApp('Máximo 50 preguntas por formulario.');
    const usados = {};
    const preguntas = brutas.map((p, i) => {
      const texto = textoLibre(p && p.texto, 200).replace(/\s+/g, ' ');
      if (!texto) throw new ErrorApp('La pregunta ' + (i + 1) + ' no tiene texto.');
      const tipo = TIPOS_PREGUNTA.indexOf(p.tipo) >= 0 ? p.tipo : 'texto';
      let id = /^[a-z0-9]{4,12}$/.test(String(p.id || '')) ? String(p.id) : nuevoId('', 6).toLowerCase();
      while (usados[id]) id = nuevoId('', 6).toLowerCase();
      usados[id] = true;
      const q = { id, texto, tipo, requerida: p.requerida === true };
      if (tipo === 'opcion' || tipo === 'varias') {
        const vistas = {};
        const ops = (Array.isArray(p.opciones) ? p.opciones : String(p.opciones || '').split('\n'))
          .map(o => textoLibre(o, 100).replace(/\s+/g, ' '))
          .filter(o => { if (!o || vistas[o.toLowerCase()]) return false; vistas[o.toLowerCase()] = true; return true; });
        if (ops.length < 2) throw new ErrorApp('La pregunta "' + texto + '" necesita al menos 2 opciones (una por línea).');
        if (ops.length > 30) throw new ErrorApp('La pregunta "' + texto + '" tiene más de 30 opciones.');
        q.opciones = ops;
      }
      return q;
    });
    const json = JSON.stringify(preguntas);
    if (json.length > 32000) throw new ErrorApp('El formulario es demasiado largo (una celda de Excel admite 32.000 caracteres).');
    const sh = await hojaFormularios();
    const ahora = new Date();
    const existentes = await leerFormularios();
    const previo = f.id ? existentes.find(x => x.id === String(f.id)) : null;
    if (f.id && !previo) throw new ErrorApp('El formulario ya no existe.');
    if (existentes.find(x => x.titulo.toLowerCase() === titulo.toLowerCase() && (!previo || x.id !== previo.id))) throw new ErrorApp('Ya existe un formulario llamado "' + titulo + '".');
    const activo = f.activo !== false, unaVez = f.unaVez === true;
    let id;
    if (previo) {
      id = previo.id;
      await sh.escribir(previo.fila, 2, [[titulo, descripcion, activo, unaVez, json]]);
      await sh.escribir(previo.fila, COL_FORM.indexOf('actualizado') + 1, [[ahora, u.usuario]]);
      registrar(u.usuario, 'Editó formulario', titulo);
    } else {
      id = nuevoId('F', 8);
      await sh.appendRow([id, titulo, descripcion, activo, unaVez, json, ahora, u.usuario, ahora, u.usuario]);
      registrar(u.usuario, 'Creó formulario', titulo + ' (' + preguntas.length + ' preguntas)');
    }
    return { formulario: { id, titulo, descripcion, activo, unaVez, preguntas, actualizado: fecha(ahora) },
      mensaje: previo ? 'Formulario actualizado.' : 'Formulario creado.' };
  } finally { soltar(); }
}

async function eliminarFormulario(d) {
  const soltar = await bloquear();
  try {
    const u = await requerirPermiso(d, 'disenarFormularios');
    const f = (await leerFormularios()).find(x => x.id === String(d.id || ''));
    if (!f) throw new ErrorApp('El formulario no existe.');
    await (await hojaFormularios()).deleteRow(f.fila);
    registrar(u.usuario, 'Eliminó formulario', f.titulo);
    return { mensaje: 'Formulario eliminado. Sus respuestas siguen en el historial de los clientes.' };
  } finally { soltar(); }
}

function convertirRespuesta(f, fila) {
  if (!f || !f[0]) return null;
  let datos = [];
  try { datos = JSON.parse(f[8] || '[]'); } catch (e) { datos = []; }
  return { id: String(f[0]), fecha: fecha(f[1]), _t: f[1] instanceof Date ? f[1].getTime() : 0, _f: fila || 0,
    formularioId: String(f[2]), formulario: String(f[3]), codigo: normCodigo(f[4]), cliente: String(f[5]),
    usuario: String(f[6]), respuestas: datos };
}
const porRecientes = (a, b) => (b._t - a._t) || (b._f - a._f);

/** Lee varias filas de Respuestas agrupando las que están cerca (sin traer la hoja entera). */
async function leerRespuestas(sh, filas) {
  if (!filas.length) return [];
  const orden = filas.slice().sort((a, b) => a - b);
  const leidas = {};
  for (const b of bloquesDeFilas(orden, 30)) {
    (await sh.leer(b[0], 1, b[1] - b[0] + 1, COL_RES.length)).forEach((v, i) => { leidas[b[0] + i] = v; });
  }
  return filas.map(n => convertirRespuesta(leidas[n], n)).filter(Boolean);
}

async function respuestasDe(codigo) {
  const sh = await hojaRespuestas();
  const n = await sh.getLastRow() - 1;
  if (n < 1 || !codigo) return [];
  const filas = await sh.buscar(COL_RES.indexOf('codigo') + 1, codigo, 2, n);
  const lista = (await leerRespuestas(sh, filas)).filter(r => r.codigo === codigo).sort(porRecientes);
  lista.forEach(r => { delete r._t; delete r._f; });
  return lista;
}

function validarRespuesta(q, v) {
  let out = '';
  switch (q.tipo) {
    case 'parrafo': out = textoLibre(v, 2000); break;
    case 'numero': {
      const s = String(v == null ? '' : v).trim().replace(/\s/g, '').replace(',', '.');
      if (s) { const num = Number(s); if (!isFinite(num)) throw new ErrorApp('"' + q.texto + '" debe ser un número.'); out = num; }
      break;
    }
    case 'sino': { const s = norm(v); out = s === 'si' || s === 'sí' ? 'si' : (s === 'no' ? 'no' : ''); break; }
    case 'opcion': {
      const s = String(v == null ? '' : v);
      if (s && q.opciones.indexOf(s) < 0) throw new ErrorApp('Opción no válida en "' + q.texto + '".');
      out = s; break;
    }
    case 'varias': {
      const arr = Array.isArray(v) ? v.map(String) : [];
      arr.forEach(s => { if (q.opciones.indexOf(s) < 0) throw new ErrorApp('Opción no válida en "' + q.texto + '".'); });
      out = q.opciones.filter(o => arr.indexOf(o) >= 0); break;
    }
    case 'fecha': {
      const s = String(v == null ? '' : v).trim();
      if (s && !/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new ErrorApp('"' + q.texto + '" debe ser una fecha.');
      out = s; break;
    }
    case 'calificacion': {
      const s = String(v == null ? '' : v).trim();
      if (s) { const num = Number(s); if ([1, 2, 3, 4, 5].indexOf(num) < 0) throw new ErrorApp('"' + q.texto + '" debe ser de 1 a 5.'); out = num; }
      break;
    }
    default: out = textoLibre(v, 300).replace(/\s+/g, ' ');
  }
  if (q.requerida && vacio(out)) throw new ErrorApp('Falta responder: "' + q.texto + '".');
  return out;
}
function valorTexto(tipo, v) {
  if (vacio(v)) return '';
  if (tipo === 'sino') return v === 'si' ? 'Sí' : 'No';
  if (tipo === 'varias') return v.join(', ');
  if (tipo === 'calificacion') return v + '/5';
  if (tipo === 'fecha') { const p = String(v).split('-'); return p[2] + '/' + p[1] + '/' + p[0]; }
  return String(v);
}

async function responderFormulario(d) {
  const soltar = await bloquear();
  try {
    const u = await requerirPermiso(d, 'responderFormularios');
    const codigo = normCodigo(d.codigo);
    const t = await tablaClientes();
    const idx = t.indice[codigo];
    if (idx === undefined || !clienteVisible(u, t.valores[idx])) throw new ErrorApp('El cliente no existe.');
    const nombreCliente = String(t.valores[idx][ci('nombre')] || '');
    const form = (await leerFormularios()).find(x => x.id === String(d.formularioId || ''));
    if (!form || !form.activo) throw new ErrorApp('Este formulario ya no está disponible. Actualiza la página.');
    if (form.unaVez && (await respuestasDe(codigo)).some(r => r.formularioId === form.id)) {
      throw new ErrorApp('Este cliente ya respondió el formulario "' + form.titulo + '" (solo se responde una vez).');
    }
    const entrada = d.respuestas || {};
    const datos = form.preguntas.map(q => ({ id: q.id, p: q.texto, t: q.tipo, v: validarRespuesta(q, entrada[q.id]) }));
    if (!datos.some(x => !vacio(x.v))) throw new ErrorApp('Responde al menos una pregunta.');
    const json = JSON.stringify(datos);
    if (json.length > 32000) throw new ErrorApp('Las respuestas son demasiado largas.');
    const resumen = datos.filter(x => !vacio(x.v)).map(x => x.p + ': ' + valorTexto(x.t, x.v)).join(' | ');
    const ahora = new Date();
    const id = nuevoId('R', 10);
    const sh = await hojaRespuestas();
    await sh.escribir(await sh.getLastRow() + 1, 1, [[id, ahora, form.id, form.titulo, codigo, nombreCliente, u.usuario, limpiarTexto(resumen, 32000), json]]);
    registrar(u.usuario, 'Llenó formulario', form.titulo + ' — ' + codigo + ' ' + nombreCliente);
    return { respuesta: { id, fecha: fecha(ahora), formularioId: form.id, formulario: form.titulo, usuario: u.usuario, respuestas: datos, propia: true },
      mensaje: 'Respuestas guardadas en el historial del cliente.' };
  } finally { soltar(); }
}

async function historialCliente(d) {
  const u = await requerirSesion(d);
  const codigo = normCodigo(d.codigo);
  const t = await tablaClientes();
  const idx = t.indice[codigo];
  if (idx === undefined || !clienteVisible(u, t.valores[idx])) throw new ErrorApp('El cliente no existe.');
  const todas = await respuestasDe(codigo);
  const completo = permite(u, 'verHistorialCompleto');
  const respondidos = {};
  todas.forEach(r => { respondidos[r.formularioId] = r.fecha; });
  const visibles = todas.filter(r => completo || r.usuario === u.usuario);
  visibles.forEach(r => { r.propia = r.usuario === u.usuario; });
  return { historial: visibles, respondidos, completo, ocultas: todas.length - visibles.length };
}

async function respuestasFormulario(d) {
  const u = await requerirPermiso(d, 'verRespuestas');
  const id = String(d.id || '');
  if (!id) throw new ErrorApp('Falta el formulario.');
  const sh = await hojaRespuestas();
  const n = await sh.getLastRow() - 1;
  if (n < 1) return { respuestas: [] };
  const filas = await sh.buscar(COL_RES.indexOf('formularioId') + 1, id, 2, n);
  const ocultos = {};
  if (!permite(u, 'ocultarClientes')) (await tablaClientes()).valores.forEach(f => { if (esVerdad(f[ci('oculto')])) ocultos[f[0]] = true; });
  const lista = (await leerRespuestas(sh, filas)).filter(r => !ocultos[r.codigo]).sort(porRecientes);
  lista.forEach(r => { delete r._t; delete r._f; });
  registrar(u.usuario, 'Consultó respuestas de formulario', (lista[0] && lista[0].formulario) || id);
  return { respuestas: lista };
}

async function eliminarRespuesta(d) {
  const soltar = await bloquear();
  try {
    const u = await requerirPermiso(d, 'eliminarRespuestas');
    const sh = await hojaRespuestas();
    const n = await sh.getLastRow() - 1;
    const filas = n > 0 && d.id ? await sh.buscar(1, String(d.id), 2, n) : [];
    if (!filas.length) throw new ErrorApp('La respuesta ya no existe.');
    const datos = (await leerRespuestas(sh, [filas[0]]))[0];
    await sh.deleteRow(filas[0]);
    registrar(u.usuario, 'Eliminó respuesta de formulario', datos ? datos.formulario + ' — ' + datos.codigo : d.id);
    return { mensaje: 'Respuesta eliminada del historial.' };
  } finally { soltar(); }
}

/* =========================================================
 *  DESPACHADOR
 * ========================================================= */

export const ACCIONES = {
  login, sesion, salir, cambiarClave, listarUsuarios, crearUsuario, restablecerClave, cambiarEstado, cambiarRol,
  eliminarUsuario, olvideClave, restablecerConCodigo,
  listarClientes, guardarCliente, eliminarCliente, importarClientes, ocultarCliente,
  listarFormularios, guardarFormulario, eliminarFormulario, responderFormulario, historialCliente, respuestasFormulario, eliminarRespuesta,
  audio, subirAudio, eliminarAudio, sincronizarAudios, asignarAudio,
  listarActividad
};

export { invalidarClientes, tablaClientes };
