/* Página de configuración: /configurar (la sirve el Worker). Protegida con CLAVE_CONFIGURACION. */
export const PAGINA_CONFIGURAR = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Configuración · Contacto-Cliente</title>
<style>
  :root{--azul:#0d3c7a;--azul2:#1565c0;--borde:#dbe3ee;--suave:#5b6b82;--fondo:#f4f7fb;--ok:#15803d;--err:#b91c1c}
  *{box-sizing:border-box}
  body{margin:0;font-family:Roboto,Segoe UI,Arial,sans-serif;background:var(--fondo);color:#1f2937}
  header{background:linear-gradient(120deg,#0b2e5e,var(--azul2));color:#fff;padding:18px 16px}
  header .in{max-width:760px;margin:0 auto;display:flex;align-items:center;gap:12px}
  .logo{width:40px;height:40px;border-radius:10px;background:rgba(255,255,255,.18);display:grid;place-items:center;font-weight:700}
  header small{display:block;opacity:.8}
  main{max-width:760px;margin:0 auto;padding:16px}
  .tarjeta{background:#fff;border:1px solid var(--borde);border-radius:14px;padding:18px;margin:14px 0}
  h2{font-size:17px;margin:0 0 6px}
  p{margin:6px 0;line-height:1.5}
  .suave{color:var(--suave);font-size:14px}
  input[type=password],input[type=text]{width:100%;height:42px;border:1px solid var(--borde);border-radius:10px;padding:0 12px;font-size:15px}
  button{height:40px;border:0;border-radius:10px;background:var(--azul2);color:#fff;font-weight:600;padding:0 16px;font-size:14px;cursor:pointer}
  button.sec{background:#e8eef7;color:var(--azul)}
  button:disabled{opacity:.6;cursor:default}
  .fila{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:10px}
  .fila input{flex:1;min-width:180px}
  .msg{margin-top:10px;padding:10px 12px;border-radius:10px;font-size:14px;display:none;white-space:pre-wrap}
  .msg.ok{display:block;background:#e8f6ee;color:var(--ok)}
  .msg.err{display:block;background:#fdecec;color:var(--err)}
  .msg.info{display:block;background:#e8f0fb;color:var(--azul)}
  code{background:#eef2f7;padding:2px 6px;border-radius:6px;font-size:13px;word-break:break-all}
  dl{display:grid;grid-template-columns:auto 1fr;gap:6px 12px;margin:8px 0;font-size:14px}
  dt{color:var(--suave)} dd{margin:0;word-break:break-all}
  .paso{display:inline-grid;place-items:center;width:24px;height:24px;border-radius:50%;background:var(--azul2);color:#fff;font-size:13px;margin-right:6px}
  .oculto{display:none}
  a{color:var(--azul2)}
</style>
</head>
<body>
<header><div class="in"><div class="logo">CC</div><div><strong>Contacto-Cliente</strong><small>Configuración del servidor</small></div></div></header>
<main>
  <div class="tarjeta" id="t-clave">
    <h2>Clave de configuración</h2>
    <p class="suave">Es el secreto <code>CLAVE_CONFIGURACION</code> que guardaste en Cloudflare. Solo la usa quien administra el sistema.</p>
    <div class="fila"><input id="clave" type="password" autocomplete="current-password" placeholder="Clave de configuración"><button id="entrar">Entrar</button></div>
    <div class="msg" id="m-clave"></div>
  </div>

  <div id="panel" class="oculto">
    <div class="tarjeta">
      <h2>Estado</h2>
      <dl id="estado"></dl>
      <div class="msg" id="m-estado"></div>
    </div>

    <div class="tarjeta">
      <h2><span class="paso">1</span>Conectar OneDrive</h2>
      <p class="suave">Entra con la <strong>cuenta corporativa</strong> dueña del OneDrive donde se guardarán los datos (carpeta <code>Contacto-Cliente</code>). Solo se hace una vez, o si cambias de cuenta.</p>
      <p class="suave">En Microsoft Entra ID, la URI de redirección (plataforma Web) debe ser exactamente: <code id="redirect"></code></p>
      <div class="fila"><button id="conectar">Conectar OneDrive</button></div>
      <div class="msg" id="m-conectar"></div>
    </div>

    <div class="tarjeta">
      <h2><span class="paso">2</span>Instalar</h2>
      <p class="suave">Crea en el OneDrive la carpeta <code>Contacto-Cliente</code>, el Excel de datos, la carpeta <code>Notas de voz</code> y el usuario <code>admin</code>. Se puede repetir sin perder datos.</p>
      <div class="fila"><input id="claveAdmin" type="password" autocomplete="new-password" placeholder="Contraseña para el usuario admin (mín. 8)"><button id="instalar">Instalar</button></div>
      <div class="msg" id="m-instalar"></div>
    </div>

    <div class="tarjeta">
      <h2><span class="paso">3</span>Migrar desde Google (opcional, una vez)</h2>
      <p class="suave">Abre la hoja de Google <em>Contacto-Cliente — Datos</em> → <strong>Archivo → Descargar → Microsoft Excel (.xlsx)</strong> y elige ese archivo aquí. Se copian usuarios (con sus contraseñas de siempre), clientes, formularios, respuestas y actividad.</p>
      <div class="fila"><input id="archivo" type="file" accept=".xlsx"><button id="migrar">Migrar</button></div>
      <label class="suave"><input type="checkbox" id="forzar"> Reemplazar aunque el Excel de OneDrive ya tenga clientes</label>
      <div class="msg" id="m-migrar"></div>
      <p class="suave">Después copia los audios a la carpeta <code>Contacto-Cliente/Notas de voz</code> y en la plataforma usa <strong>Cargar → 3. Sincronizar ahora</strong>.</p>
    </div>

    <div class="tarjeta">
      <h2>Herramientas</h2>
      <div class="fila"><button class="sec" id="correo">Enviar correo de prueba</button></div>
      <div class="msg" id="m-correo"></div>
      <p class="suave" style="margin-top:14px">Emergencia: poner una contraseña nueva al usuario <code>admin</code> y reactivarlo.</p>
      <div class="fila"><input id="claveEmerg" type="password" autocomplete="new-password" placeholder="Nueva contraseña del admin"><button class="sec" id="restablecer">Restablecer admin</button></div>
      <div class="msg" id="m-restablecer"></div>
    </div>
  </div>
</main>
<script>
(function () {
  var clave = '';
  function $(id) { return document.getElementById(id); }
  function msg(id, texto, tipo) { var el = $(id); el.textContent = texto || ''; el.className = 'msg' + (texto ? ' ' + (tipo || 'err') : ''); }
  function llamar(paso, cuerpo, extra) {
    return fetch('/configurar?paso=' + paso + (extra || ''), { method: 'POST', headers: { 'X-Clave': clave },
      body: cuerpo instanceof ArrayBuffer ? cuerpo : JSON.stringify(cuerpo || {}) })
      .then(function (r) { return r.json(); })
      .catch(function () { return { ok: false, error: 'No hay conexión con el servidor.' }; });
  }
  function ocupado(b, si, t) { if (si) { b.dataset.t = b.textContent; b.textContent = t || 'Procesando…'; b.disabled = true; } else { b.textContent = b.dataset.t; b.disabled = false; } }
  function fila(dl, k, v, enlace) {
    var dt = document.createElement('dt'); dt.textContent = k;
    var dd = document.createElement('dd');
    if (enlace && v) { var a = document.createElement('a'); a.href = v; a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'abrir'; dd.appendChild(a); }
    else dd.textContent = v;
    dl.appendChild(dt); dl.appendChild(dd);
  }
  function estado() {
    return llamar('estado').then(function (r) {
      if (!r.ok) { msg('m-clave', r.error); $('panel').className = 'oculto'; return r; }
      $('t-clave').className = 'oculto'; $('panel').className = '';
      $('redirect').textContent = r.redirect;
      var dl = $('estado'); dl.innerHTML = '';
      fila(dl, 'API para assets/config.js', r.api);
      fila(dl, 'OneDrive', r.conectado ? 'Conectado: ' + r.cuenta : (r.cuenta ? 'Desconectado (era ' + r.cuenta + ')' : 'Sin conectar'));
      if (r.excel) fila(dl, 'Excel de datos', r.excel, true);
      if (r.carpeta) fila(dl, 'Notas de voz', r.carpeta, true);
      if (r.clientes !== undefined) fila(dl, 'Clientes / usuarios', r.clientes + ' / ' + r.usuarios);
      if (r.faltan && r.faltan.length) msg('m-estado', 'Falta configurar en Cloudflare: ' + r.faltan.join(', '));
      else if (r.error) msg('m-estado', r.error); else msg('m-estado', '');
      return r;
    });
  }
  $('entrar').onclick = function () { clave = $('clave').value; msg('m-clave', ''); estado(); };
  $('clave').onkeydown = function (e) { if (e.key === 'Enter') $('entrar').click(); };
  $('conectar').onclick = function () {
    var b = this; ocupado(b, true);
    llamar('conectar').then(function (r) { ocupado(b, false); if (!r.ok) return msg('m-conectar', r.error); location.href = r.enlace; });
  };
  $('instalar').onclick = function () {
    var b = this; ocupado(b, true, 'Instalando…'); msg('m-instalar', 'Esto puede tardar un minuto…', 'info');
    llamar('instalar', { claveAdmin: $('claveAdmin').value }).then(function (r) {
      ocupado(b, false); msg('m-instalar', r.ok ? r.mensaje : r.error, r.ok ? 'ok' : 'err'); if (r.ok) estado();
    });
  };
  $('migrar').onclick = function () {
    var b = this, f = $('archivo').files[0];
    if (!f) return msg('m-migrar', 'Elige el archivo .xlsx descargado de Google.');
    ocupado(b, true, 'Migrando…'); msg('m-migrar', 'Subiendo ' + f.name + '…', 'info');
    f.arrayBuffer().then(function (buf) { return llamar('migrar', buf, $('forzar').checked ? '&forzar=1' : ''); }).then(function (r) {
      ocupado(b, false); msg('m-migrar', r.ok ? r.mensaje : r.error, r.ok ? 'ok' : 'err'); if (r.ok) estado();
    });
  };
  $('correo').onclick = function () {
    var b = this; ocupado(b, true);
    llamar('probarCorreo').then(function (r) { ocupado(b, false); msg('m-correo', r.ok ? r.mensaje : r.error, r.ok ? 'ok' : 'err'); });
  };
  $('restablecer').onclick = function () {
    if (!confirm('¿Cambiar la contraseña del usuario admin?')) return;
    var b = this; ocupado(b, true);
    llamar('restablecerAdmin', { claveAdmin: $('claveEmerg').value }).then(function (r) { ocupado(b, false); msg('m-restablecer', r.ok ? r.mensaje : r.error, r.ok ? 'ok' : 'err'); });
  };
})();
</script>
</body>
</html>`;
