/*
 * Contacto-Cliente — Intermediario en Cloudflare Workers
 *
 *   POST /            API de la plataforma (la usa la página de GitHub; mismo formato que Apps Script)
 *   GET  /            prueba rápida: {"ok":true,"mensaje":"API activa."}
 *   GET  /configurar  página de configuración (protegida con CLAVE_CONFIGURACION)
 *   GET  /callback    vuelta del inicio de sesión de Microsoft (al conectar OneDrive)
 *
 * Configuración: wrangler.toml ([vars]) y secretos en Cloudflare (MS_CLIENT_SECRET, CLAVE_CONFIGURACION).
 */
import {
  CONFIG, ADMIN_INICIAL, HOJA_USUARIOS, HOJA_CLIENTES, HOJA_ACTIVIDAD, HOJA_FORMULARIOS, HOJA_RESPUESTAS,
  COLUMNAS, COL_CLI, COL_ACT, COL_FORM, COL_RES, S, ErrorApp, esc, hexAleatorio, prop, setProp, cacheGet, cachePut, cacheDel,
  bloquear, graph, pedirToken, enlaceMicrosoft, enviarCorreo, hoja, asegurarHoja, invalidarHojas, olvidarLibro,
  carpetaRaiz, carpetaNotas, carpetaReemplazadas, subirArchivo, reemplazarContenido, letraCol
} from './base.js';
import { ACCIONES, registrar, guardarActividad, buscarUsuario, guardarCampos, hashClave, nuevaSal, validarClave, invalidarClientes } from './logica.js';
import { PLANTILLA_XLSX } from './plantilla.js';
import { PAGINA_CONFIGURAR } from './configurar.js';

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(env, request) });
    const stub = env.CC.get(env.CC.idFromName('principal'));
    return stub.fetch(request);
  }
};

function cors(env, request) {
  const origen = request.headers.get('Origin') || '';
  const permitidos = String(env.ORIGENES_PERMITIDOS || '*').split(',').map(s => s.trim()).filter(Boolean);
  const ok = permitidos.indexOf('*') >= 0 || permitidos.indexOf(origen) >= 0;
  return { 'Access-Control-Allow-Origin': ok ? (origen || '*') : 'null', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
           'Access-Control-Allow-Headers': 'Content-Type', 'Vary': 'Origin' };
}
const json = (obj, headers, status) => new Response(JSON.stringify(obj), { status: status || 200, headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, headers || {}) });
const html = (texto, status) => new Response(texto, { status: status || 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });

export class ContactoCliente {
  constructor(ctx, env) {
    this.ctx = ctx;
    S.env = env;
    S.storage = ctx.storage;
  }

  async fetch(request) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/configurar' && request.method === 'GET') return html(PAGINA_CONFIGURAR);
      if (url.pathname === '/configurar' && request.method === 'POST') return await this.configurar(request, url);
      if (url.pathname === '/callback') return await this.callback(url);
      if (request.method === 'GET') return json({ ok: true, sistema: CONFIG.NOMBRE_SISTEMA, mensaje: 'API activa.' }, cors(S.env, request));
      if (request.method === 'POST') return await this.api(request);
    } catch (e) {
      console.error(e && e.stack || e);
      return json({ ok: false, error: e instanceof ErrorApp ? e.message : 'Error interno del servidor.' }, cors(S.env, request), 500);
    }
    return new Response('No encontrado', { status: 404 });
  }

  /* ---------- API de la plataforma ---------- */
  async api(request) {
    let res;
    try {
      const d = JSON.parse(await request.text() || '{}');
      const accion = ACCIONES[d.accion];
      if (!accion) throw new ErrorApp('Acción no válida.');
      res = Object.assign({ ok: true }, (await accion(d)) || {});
    } catch (err) {
      if (err instanceof ErrorApp) res = { ok: false, error: err.message, codigo: err.codigo || '' };
      else { console.error(err && err.stack || err); res = { ok: false, error: 'Error interno del servidor. Intenta de nuevo.' }; }
    }
    this.ctx.waitUntil(guardarActividad());
    return json(res, cors(S.env, request));
  }

  /* ---------- vuelta de Microsoft ---------- */
  async callback(url) {
    const p = Object.fromEntries(url.searchParams);
    const pagina = (titulo, texto, ok) => html('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' +
      CONFIG.NOMBRE_SISTEMA + '</title><div style="font-family:Arial,sans-serif;max-width:520px;margin:60px auto;padding:24px;border:1px solid #ddd;border-radius:12px">' +
      '<h2 style="color:' + (ok ? '#15803d' : '#b91c1c') + '">' + esc(titulo) + '</h2><p>' + esc(texto) + '</p><p><a href="/configurar">Volver a la configuración</a></p></div>');
    if (p.error) return pagina('No se conectó', p.error_description || p.error, false);
    if (!p.state || !(await cacheGet('ms_estado_' + p.state))) return pagina('Enlace vencido', 'Vuelve a pulsar "Conectar OneDrive" en la configuración.', false);
    await cacheDel('ms_estado_' + p.state);
    try {
      const t = await pedirToken({ grant_type: 'authorization_code', code: p.code, redirect_uri: url.origin + '/callback' });
      const yo = await graph('GET', '/me?$select=displayName,userPrincipalName,mail', null, { token: t });
      const correo = yo.mail || yo.userPrincipalName;
      const anterior = await prop('MS_CUENTA');
      await setProp('MS_CUENTA', correo);
      if (anterior && anterior !== correo) { // otra cuenta: se olvida dónde estaban los archivos de la anterior
        for (const k of ['EXCEL_ID', 'EXCEL_URL', 'CARPETA_RAIZ_ID', 'CARPETA_ID', 'CARPETA_REEMPLAZADAS_ID']) await S.storage.delete('p_' + k);
        S.mem = {}; olvidarLibro();
      }
      return pagina('OneDrive conectado', 'Los datos se guardarán en el OneDrive de ' + correo + ' (' + yo.displayName + '), carpeta "' +
        CONFIG.CARPETA_ONEDRIVE + '". Vuelve a la configuración y pulsa "Instalar".', true);
    } catch (e) {
      return pagina('No se conectó', e.message, false);
    }
  }

  /* ---------- página de configuración ---------- */
  async configurar(request, url) {
    const clave = request.headers.get('X-Clave') || '';
    if (!S.env.CLAVE_CONFIGURACION || S.env.CLAVE_CONFIGURACION.length < 12) {
      return json({ ok: false, error: 'Falta el secreto CLAVE_CONFIGURACION en Cloudflare (mínimo 12 caracteres).' });
    }
    const intentos = Number(await cacheGet('cfg_fallos') || 0);
    if (intentos >= 10) return json({ ok: false, error: 'Demasiados intentos con clave incorrecta. Espera 15 minutos.' });
    if (!igual(clave, S.env.CLAVE_CONFIGURACION)) {
      await cachePut('cfg_fallos', intentos + 1, 900);
      return json({ ok: false, error: 'Clave de configuración incorrecta.' });
    }
    const paso = url.searchParams.get('paso');
    try {
      if (paso === 'estado') return json(Object.assign({ ok: true }, await this.estado(url)));
      if (paso === 'conectar') {
        const estado = hexAleatorio(16);
        await cachePut('ms_estado_' + estado, 1, 900);
        return json({ ok: true, enlace: enlaceMicrosoft(estado, url.origin + '/callback') });
      }
      if (paso === 'instalar') return json(Object.assign({ ok: true }, await this.instalar(await request.json())));
      if (paso === 'restablecerAdmin') return json(Object.assign({ ok: true }, await this.restablecerAdmin(await request.json())));
      if (paso === 'migrar') return json(Object.assign({ ok: true }, await this.migrar(new Uint8Array(await request.arrayBuffer()), url.searchParams.get('forzar') === '1')));
      if (paso === 'probarCorreo') { await enviarCorreo('Prueba de correo', '<p>Si lees esto, los avisos y códigos de recuperación funcionan.</p>', true); return json({ ok: true, mensaje: 'Correo enviado a ' + S.env.CORREO_GENERAL + '.' }); }
      return json({ ok: false, error: 'Paso no válido.' });
    } catch (e) {
      if (!(e instanceof ErrorApp)) console.error(e && e.stack || e);
      return json({ ok: false, error: e.message || 'Error interno.' });
    } finally {
      await guardarActividad();
    }
  }

  async estado(url) {
    const faltan = ['MS_TENANT_ID', 'MS_CLIENT_ID', 'MS_CLIENT_SECRET', 'CORREO_GENERAL'].filter(k => !S.env[k]);
    const r = { redirect: url.origin + '/callback', api: url.origin + '/', faltan, cuenta: await prop('MS_CUENTA'), excel: await prop('EXCEL_URL'), conectado: false };
    if (!(await prop('MS_REFRESH'))) return r;
    try {
      const yo = await graph('GET', '/me?$select=displayName,userPrincipalName,mail');
      r.conectado = true; r.cuenta = yo.mail || yo.userPrincipalName;
      if (await prop('EXCEL_ID')) {
        const sh = await hoja(HOJA_CLIENTES);
        r.clientes = Math.max(0, await sh.getLastRow() - 1);
        r.usuarios = Math.max(0, await (await hoja(HOJA_USUARIOS)).getLastRow() - 1);
        const c = await carpetaNotas(false);
        if (c) r.carpeta = c.webUrl;
      }
    } catch (e) { r.error = e.message; }
    return r;
  }

  /** Crea (o completa) la carpeta, el Excel, las carpetas de notas y el usuario admin. Se puede repetir. */
  async instalar(d) {
    const soltar = await bloquear();
    try {
      const cuenta = await graph('GET', '/me?$select=displayName,userPrincipalName,mail');
      const raiz = await carpetaRaiz();
      let id = await prop('EXCEL_ID'), ok = false;
      if (id) { try { await graph('GET', '/me/drive/items/' + id + '?$select=id'); ok = true; } catch (e) { ok = false; } }
      if (!ok) {
        const nombre = CONFIG.NOMBRE_SISTEMA + ' — Datos.xlsx';
        let item = null;
        try { item = await graph('GET', '/me/drive/items/' + raiz.id + ':/' + encodeURIComponent(nombre) + '?$select=id,webUrl'); } catch (e) { item = null; }
        if (!item) {
          const bytes = Uint8Array.from(atob(PLANTILLA_XLSX), c => c.charCodeAt(0));
          item = await graph('PUT', '/me/drive/items/' + raiz.id + ':/' + encodeURIComponent(nombre) + ':/content?@microsoft.graph.conflictBehavior=fail',
            bytes, { crudo: true, tipo: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        }
        await setProp('EXCEL_ID', item.id);
        await setProp('EXCEL_URL', item.webUrl || '');
      }
      olvidarLibro();
      for (const x of [[HOJA_USUARIOS, COLUMNAS], [HOJA_CLIENTES, COL_CLI], [HOJA_ACTIVIDAD, COL_ACT], [HOJA_FORMULARIOS, COL_FORM], [HOJA_RESPUESTAS, COL_RES]]) {
        await asegurarHoja(x[0], x[1]);
      }
      let mensajeAdmin = 'El usuario admin ya existía (no se cambió su contraseña).';
      if (!(await buscarUsuario(ADMIN_INICIAL.usuario))) {
        const clave = String((d && d.claveAdmin) || '');
        validarClave(clave);
        const salt = nuevaSal(), ahora = new Date();
        await (await hoja(HOJA_USUARIOS)).appendRow([ADMIN_INICIAL.usuario, ADMIN_INICIAL.nombre, 'admin', true, salt, await hashClave(clave, salt), ahora, ahora, '', 'instalación']);
        mensajeAdmin = 'Usuario admin creado con la contraseña que escribiste.';
      }
      const notas = await carpetaNotas(true);
      await carpetaReemplazadas();
      invalidarClientes();
      const correo = cuenta.mail || cuenta.userPrincipalName;
      registrar('sistema', 'Instalación', 'OneDrive de ' + correo);
      return { mensaje: 'Instalación completa en el OneDrive de ' + correo + '. ' + mensajeAdmin, carpeta: raiz.webUrl, excel: await prop('EXCEL_URL'), notas: notas.webUrl };
    } finally { soltar(); }
  }

  async restablecerAdmin(d) {
    const clave = String((d && d.claveAdmin) || '');
    validarClave(clave);
    const soltar = await bloquear();
    try {
      const u = await buscarUsuario(ADMIN_INICIAL.usuario);
      if (!u) throw new ErrorApp('No existe el usuario admin. Pulsa "Instalar".');
      const salt = nuevaSal();
      await guardarCampos(u.fila, { salt, hash: await hashClave(clave, salt), activo: true, rol: 'admin', actualizado: new Date(), actualizadoPor: 'configuración' });
      await cacheDel('bloq_' + u.usuario);
      registrar('sistema', 'Admin restablecido', 'Desde /configurar');
      return { mensaje: 'Listo: el usuario admin tiene la contraseña nueva y está activo.' };
    } finally { soltar(); }
  }

  /**
   * MIGRACIÓN: recibe el Excel descargado de la hoja de Google anterior (Archivo → Descargar → .xlsx),
   * reemplaza con él el Excel de datos (mismas hojas y columnas) y limpia los audioId de Google
   * para que "Sincronizar" vuelva a asociar las notas con los archivos de OneDrive.
   */
  async migrar(bytes, forzar) {
    if (bytes.length < 1000 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new ErrorApp('El archivo no es un Excel (.xlsx).');
    const soltar = await bloquear();
    try {
      const sh = await hoja(HOJA_CLIENTES);
      const clientes = (await sh.getLastRow()) - 1;
      if (clientes > 0 && !forzar) throw new ErrorApp('El Excel de OneDrive ya tiene ' + clientes + ' clientes. Si de verdad quieres reemplazarlo todo, marca "Reemplazar aunque tenga datos".', 'TIENE_DATOS');
      await reemplazarContenido(await prop('EXCEL_ID'), bytes);
      olvidarLibro();
      for (const x of [[HOJA_USUARIOS, COLUMNAS], [HOJA_CLIENTES, COL_CLI], [HOJA_ACTIVIDAD, COL_ACT], [HOJA_FORMULARIOS, COL_FORM], [HOJA_RESPUESTAS, COL_RES]]) {
        await asegurarHoja(x[0], x[1]);
      }
      // Revisa que los títulos sean los de Contacto-Cliente
      const tit = (await (await hoja(HOJA_CLIENTES)).leer(1, 1, 1, COL_CLI.length))[0].map(String);
      if (tit[0] !== 'codigo' || tit[7] !== 'audioId') throw new ErrorApp('La hoja Clientes del archivo no tiene las columnas esperadas (codigo, nombre, …, audioId). ¿Es el Excel de Contacto-Cliente?');
      const cli = await hoja(HOJA_CLIENTES);
      const n = (await cli.getLastRow()) - 1;
      if (n > 0) await cli.escribir(2, COL_CLI.indexOf('audioId') + 1, Array.from({ length: n }, () => ['']));
      const usuarios = Math.max(0, await (await hoja(HOJA_USUARIOS)).getLastRow() - 1);
      invalidarClientes();
      registrar('sistema', 'Migración desde Google', n + ' clientes, ' + usuarios + ' usuarios');
      return { mensaje: 'Migración lista: ' + n + ' clientes y ' + usuarios + ' usuarios (entran con su contraseña de siempre). ' +
        'Ahora copia los audios a la carpeta "Notas de voz" y pulsa "Sincronizar" en la plataforma (Cargar → 3).' };
    } finally { soltar(); }
  }
}

function igual(a, b) {
  a = String(a); b = String(b);
  let dif = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) dif |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return dif === 0;
}
