# Contacto-Cliente — Instalación sin Apps Script

## Cómo queda

```
Personas (usuario y contraseña creados en la plataforma, sin correo)
        ↓
Página en GitHub Pages             index.html, assets/        (igual que antes)
        ↓
Intermediario en Cloudflare        worker/                    (reemplaza a Apps Script)
  · login, roles, sesiones, recuperación de contraseña, reglas
  · /configurar  → página para conectar OneDrive, instalar y migrar
        ↓  (permiso dado UNA vez por la cuenta corporativa)
OneDrive de la cuenta corporativa
  └─ Contacto-Cliente/
       ├─ Contacto-Cliente — Datos.xlsx   (hojas Usuarios, Clientes, Actividad, Formularios, Respuestas)
       └─ Notas de voz/
            └─ Notas reemplazadas/
```

- **Nada depende de Google.** No hay Apps Script, ni Google Sheets, ni Drive, ni Gmail. Los correos de aviso y los códigos de recuperación salen desde la cuenta corporativa.
- **Nadie necesita cuenta Microsoft para entrar.** El administrador crea los usuarios en la plataforma.
- **El intermediario se publica solo.** Cada vez que subes cambios de la carpeta `worker/` a GitHub, GitHub Actions lo publica en Cloudflare. Nunca abres un editor de código en otro sitio.
- **¿Por qué hace falta un intermediario?** La página de GitHub es pública. Si la llave del OneDrive estuviera ahí, cualquiera podría copiarla. El intermediario la guarda en secreto.

**Costo:** el plan gratis de Cloudflare Workers alcanza para unos 100 usuarios. Si algún día se queda corto, el plan pagado cuesta USD 5 al mes.

---

## 1. Cuenta de Cloudflare (gratis)

1. Crea una cuenta en <https://dash.cloudflare.com/sign-up>. No pide tarjeta.
2. Entra a **Workers y Pages**. La primera vez te pide elegir un subdominio (por ejemplo `planetaazul`). Tu intermediario quedará en:
   `https://contacto-cliente.planetaazul.workers.dev`
3. Copia el **Account ID**: está en la columna derecha de **Workers y Pages** (o en la página de inicio de la cuenta).
4. Crea un token: **Mi perfil → Tokens de API → Crear token → plantilla "Editar Cloudflare Workers" → Continuar → Crear token**. Copia el token (solo se muestra una vez).

## 2. Registrar la app en Microsoft Entra ID

1. Entra a <https://entra.microsoft.com> → **Aplicaciones → Registros de aplicaciones → Nuevo registro**.
2. Nombre: `Contacto-Cliente`. Tipos de cuenta: **Solo las cuentas de este directorio organizativo**.
3. URI de redirección: plataforma **Web**, y escribe tu dirección del paso 1 terminada en `/callback`:
   `https://contacto-cliente.planetaazul.workers.dev/callback`
4. **Registrar.** En **Información general** copia:
   - **Id. de directorio (inquilino)** → `MS_TENANT_ID`
   - **Id. de aplicación (cliente)** → `MS_CLIENT_ID`
5. **Certificados y secretos → Nuevo secreto de cliente** (24 meses). Copia el **Valor** → `MS_CLIENT_SECRET`. **Anota la fecha en que vence.**
6. **Permisos de API → Agregar un permiso → Microsoft Graph → Permisos delegados.** Marca:
   - `offline_access`
   - `User.Read`
   - `Files.ReadWrite`
   - `Mail.Send`

   Solo dan acceso al OneDrive y al correo **de la cuenta que se conecte** en el paso 5, no a toda la empresa. Si al conectar sale "Se necesita aprobación del administrador", TI pulsa **Conceder consentimiento de administrador**.

Si TI lo hace por ti, pásales esta sección tal cual.

## 3. Configurar el repositorio en GitHub

1. Sube el contenido de este proyecto a tu repositorio `contacto-cliente` (rama `main`). Ya no hace falta la carpeta `apps-script`.
2. Edita `worker/wrangler.toml`:

   ```toml
   MS_TENANT_ID = "el Id. de directorio"
   MS_CLIENT_ID = "el Id. de aplicación"
   CORREO_GENERAL = "distribucion.planetaazul@gmail.com"
   ORIGENES_PERMITIDOS = "https://TU-USUARIO.github.io"
   ```

   - `CORREO_GENERAL`: recibe los avisos y los códigos de recuperación.
   - `ORIGENES_PERMITIDOS`: la dirección de tu página de GitHub, sin `/contacto-cliente`. Así la API solo responde a tu página.
3. En GitHub: **Settings → Secrets and variables → Actions → New repository secret**. Crea estos 4:

   | Nombre | Valor |
   |---|---|
   | `CLOUDFLARE_API_TOKEN` | el token del paso 1.4 |
   | `CLOUDFLARE_ACCOUNT_ID` | el Account ID del paso 1.3 |
   | `MS_CLIENT_SECRET` | el Valor del secreto del paso 2.5 |
   | `CLAVE_CONFIGURACION` | una clave larga que inventes (mínimo 12 caracteres), para entrar a `/configurar` |

4. Ve a **Actions → "Publicar intermediario en Cloudflare" → Run workflow**. Cuando termine en verde, abre `https://contacto-cliente.TU-SUBDOMINIO.workers.dev`: debe decir `"API activa."`.

## 4. Apuntar la página al intermediario

En `assets/config.js` pon la dirección del intermediario, con la barra final:

```js
apiUrl: 'https://contacto-cliente.planetaazul.workers.dev/',
```

Sube el cambio. GitHub Pages publica la página como siempre.

## 5. Conectar OneDrive e instalar (desde el navegador)

Abre `https://contacto-cliente.TU-SUBDOMINIO.workers.dev/configurar` y escribe la `CLAVE_CONFIGURACION`.

1. **Conectar OneDrive:** entra con la cuenta corporativa dueña del OneDrive y acepta los permisos. Vuelve a la configuración.
2. **Instalar:** escribe la contraseña que tendrá el usuario `admin` y pulsa **Instalar**. Crea la carpeta `Contacto-Cliente` con el Excel y las carpetas de notas de voz.
3. **Enviar correo de prueba:** confirma que los avisos llegan a `CORREO_GENERAL`.

Listo: ya puedes entrar a la plataforma con `admin` y crear los demás usuarios en **Gestionar usuarios**.

## 6. Migrar los datos de Google (si ya usabas la plataforma)

1. Abre la hoja de Google **Contacto-Cliente — Datos** → **Archivo → Descargar → Microsoft Excel (.xlsx)**.
2. En `/configurar` → **3. Migrar desde Google**, elige ese archivo y pulsa **Migrar**. Se copian:
   - usuarios, que siguen entrando con su contraseña de siempre;
   - clientes, con su estado de oculto;
   - formularios, respuestas y actividad.

   Si el Excel de OneDrive ya tiene clientes, te pide marcar "Reemplazar" para no borrar nada sin querer.
3. **Notas de voz:**
   1. En Google Drive, clic derecho en la carpeta "Contacto-Cliente — Notas de voz" → **Descargar** (llega en .zip) y descomprime.
   2. Copia los audios directamente dentro de `Contacto-Cliente/Notas de voz` del OneDrive corporativo. Con miles de archivos, lo más fácil es OneDrive para escritorio con esa cuenta: arrastras y se suben solos.
   3. En la plataforma: **Cargar → 3. Sincronizar ahora**. Cada audio vuelve a su cliente y conserva la fecha y quién lo grabó.
4. Revisa unos clientes al azar. Cuando todo esté bien, puedes archivar el proyecto de Apps Script. La hoja y la carpeta de Google quedan como respaldo.

---

## Día a día

- **Usuarios:** menú (arriba a la derecha) → **Gestionar usuarios**. Usuario, nombre, rol y contraseña; no hace falta correo.
- **Excel:** lo puedes abrir o conectar a Power BI. Si lo editas a mano:
  - No cambies el orden de las columnas ni renombres las hojas.
  - La plataforma ve tus cambios en máximo 10 minutos.
  - Mejor ábrelo en Excel en el navegador; si queda abierto en Excel de escritorio, OneDrive puede bloquearlo un rato.
- **Audios:** para escuchar, Microsoft da un enlace temporal (alrededor de una hora) solo a quien inició sesión. Los archivos no quedan compartidos.
- **Borrados:** van a la papelera de reciclaje del OneDrive (se pueden recuperar).
- **Emergencia:** si nadie puede entrar como `admin`, en `/configurar` → **Restablecer admin**.

## Lo que vence y cómo renovarlo

- **El secreto de Microsoft** (máximo 24 meses). Cuando venza, la plataforma dirá "El secreto de la app de Microsoft venció". Para renovarlo:
  1. Crea uno nuevo en Entra ID (paso 2.5).
  2. Cámbialo en GitHub (`MS_CLIENT_SECRET`).
  3. Vuelve a ejecutar el workflow del paso 3.4.
- **Si cambia la contraseña de la cuenta corporativa** o TI cierra sus sesiones, entra a `/configurar` y pulsa **Conectar OneDrive** otra vez.
- **Para cambiar de cuenta de OneDrive:** pulsa **Conectar OneDrive** con la otra cuenta y luego **Instalar**. Crea todo de nuevo en ese OneDrive; los datos de la cuenta anterior no se mueven solos.

## Dónde cambiar cosas

| Qué | Dónde |
|---|---|
| Permisos por rol, tiempos de sesión, tamaño máximo de audio | `worker/src/base.js` → `CONFIG` y `PERMISOS` |
| Correo general, páginas permitidas, datos de Microsoft | `worker/wrangler.toml` |
| Secretos | GitHub → Settings → Secrets (y volver a ejecutar el workflow) |
| Dirección del intermediario en la página | `assets/config.js` |

Ver errores del intermediario: Cloudflare → Workers y Pages → `contacto-cliente` → **Registros**.
