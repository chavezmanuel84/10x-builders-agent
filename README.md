# Agente personal (MVP)

Monorepo con **Next.js**, **Supabase**, **LangGraph** y **OpenRouter**. Incluye chat web, onboarding, ajustes y bot de **Telegram** (opcional), además de integraciones reales con GitHub y Google Calendar mediante OAuth.

## Quick Start (60 segundos)

Desde la raíz del repositorio:

```bash
npm install
test -f .env.example && cp .env.example apps/web/.env.local || true
npm run dev
```

Crea o edita `apps/web/.env.local` con las variables mínimas (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `OPENROUTER_API_KEY`). Opcional pero recomendable en despliegues: `AGENT_WORKSPACE_ROOT` apuntando al directorio de trabajo del agente. Luego abre `http://localhost:3000/signup` o `http://localhost:3000/login`.

## Capacidades principales
- Agente conversacional multicanal (web + Telegram)
- Integración con herramientas externas mediante OAuth
- Ejecución de comandos y rutas de archivo acotadas al *workspace* del agente (`AGENT_WORKSPACE_ROOT` o, si no se define, el directorio desde el que arranca el servidor)
- Ejecución de acciones desde lenguaje natural
- Confirmación de acciones sensibles (UI + Telegram)
- Soporte para fechas naturales ("hoy", "mañana", "próximo lunes")

## Integraciones
### GitHub
- Listar repositorios
- Listar issues
- Crear issues
- Crear repositorios
### Google Calendar
- Listar eventos (hoy, fechas específicas o lenguaje natural)
- Crear eventos
- Soporte para rangos de tiempo y fechas relativas
## Requisitos previos

- **Node.js** 20 o superior (recomendado LTS).
- **npm** 10+ (incluido con Node.js 20+).
- Cuenta en **[Supabase](https://supabase.com)** (gratis).
- Cuenta en **[OpenRouter](https://openrouter.ai)** para la API del modelo (clave de API).
- *(Opcional)* Bot de Telegram creado con [@BotFather](https://t.me/BotFather) y una URL **HTTPS** pública para el webhook (en local suele usarse **ngrok** o similar).

---

## Paso 1 — Clonar e instalar dependencias

Desde la **raíz** del repositorio:

```bash
npm install
```

---

## Paso 2 — Crear proyecto en Supabase

1. Entra en el [dashboard de Supabase](https://supabase.com/dashboard) y crea un **nuevo proyecto**.
2. Espera a que termine el aprovisionamiento.
3. En **Project Settings → API** anota:
   - **Project URL** → será `NEXT_PUBLIC_SUPABASE_URL`
   - **`anon` public** → será `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - **`service_role` secret** → será `SUPABASE_SERVICE_ROLE_KEY` (no la expongas al cliente ni la subas a repositorios públicos).

---

## Paso 3 — Aplicar el esquema SQL (tablas + RLS + semillas)

En Supabase, abre **SQL Editor** y ejecuta **en orden** (cada archivo, completo, con **Run**):

| Orden | Archivo | Qué hace |
|-------|---------|----------|
| 1 | `packages/db/supabase/migrations/00001_initial_schema.sql` | Tablas, RLS, trigger `handle_new_user` (perfil al registrarse) |
| 2 | `packages/db/supabase/migrations/00002_seed_get_current_path_tool.sql` | Rellena `user_tool_settings` con `get_current_path` para usuarios ya existentes |
| 3 | `packages/db/supabase/migrations/00003_seed_default_tools_on_signup.sql` | Sustituye `handle_new_user` para que cada **nuevo** usuario tenga `get_current_path` y `change_directory` activados; además hace *backfill* idempotente |

Si algo falla (por ejemplo, el trigger `on_auth_user_created` en un proyecto ya modificado), revisa el mensaje de error; en la mayoría de proyectos nuevos los tres scripts aplican sin conflictos.

---

## Paso 4 — Configurar autenticación (email)

1. En Supabase: **Authentication → Providers** → habilita **Email** (por defecto suele estar activo).
2. **Authentication → URL configuration**:
   - **Site URL**: para desarrollo local usa `http://localhost:3000`
   - **Redirect URLs**: añade al menos:
     - `http://localhost:3000/auth/callback`
     - `http://localhost:3000/**` (o la variante que permita tu versión del dashboard para desarrollo)

Así el flujo de login/signup y el intercambio de código en `/auth/callback` funcionan en local.

---

## Paso 5 — Variables de entorno

Next.js carga `.env*` desde el directorio de la app **`apps/web`**, no desde la raíz del monorepo.

1. Crea `apps/web/.env.local`. Si existe `.env.example` en la raíz del monorepo:

   ```bash
   test -f .env.example && cp .env.example apps/web/.env.local || true
   ```

   *(Si ya tienes `.env.local` en la raíz, mueve o copia ese archivo a `apps/web/.env.local`.)*

2. Edita `apps/web/.env.local` y completa:

   | Variable | Descripción |
   |----------|-------------|
   | `NEXT_PUBLIC_SUPABASE_URL` | URL del proyecto Supabase |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Clave `anon` |
   | `SUPABASE_SERVICE_ROLE_KEY` | Clave `service_role` (solo servidor; la usa la API del agente y Telegram contra Postgres) |
   | `OPENROUTER_API_KEY` | Clave de OpenRouter |
   | `TELEGRAM_BOT_TOKEN` | *(Opcional)* Token del bot |
   | `TELEGRAM_WEBHOOK_SECRET` | *(Opcional)* Secreto que Telegram enviará en cabecera; debe coincidir con el configurado al registrar el webhook |
   | `OAUTH_ENCRYPTION_KEY` | Clave usada para cifrar/desencriptar tokens OAuth en servidor (requerida para integraciones como GitHub/Google Calendar) |
   | `AGENT_WORKSPACE_ROOT` | *(Recomendado en servidor)* Ruta absoluta del directorio donde el agente puede ejecutar bash y operar con archivos. Si no está definida, se usa `process.cwd()` (útil en local si arrancas `npm run dev` desde la raíz del repo). Los `cwd` relativos y las rutas de herramientas se resuelven y contienen respecto a este directorio. |
   | `GOOGLE_CLIENT_ID`              | OAuth Client ID de Google      |
   | `GOOGLE_CLIENT_SECRET`          | OAuth Client Secret de Google  |

---

## Paso 6 — Arrancar la aplicación web

Desde la **raíz** del repo:

```bash
npm run dev
```

Por defecto Turbo ejecuta el `dev` de cada paquete; la app suele quedar en **http://localhost:3000**.

Flujo esperado:

1. **Registro** en `/signup` o **login** en `/login`.
2. **Onboarding** (perfil, agente, herramientas, revisión).
3. **Chat** en `/chat` y **ajustes** en `/settings`.

---

## Paso 7 — Probar el chat con el modelo

1. Confirma que `OPENROUTER_API_KEY` está en `apps/web/.env.local`.
2. Tras aplicar las migraciones SQL, los usuarios nuevos tienen ya activadas por defecto `get_current_path` y `change_directory` (navegación segura dentro del *workspace*). Para más *tool calling*, activa en onboarding otras herramientas (p. ej. `get_user_preferences`, `list_enabled_tools`).
3. Escribe un mensaje en `/chat`. Si la clave o el modelo fallan, revisa la consola del servidor (terminal donde corre `npm run dev`).

El modelo por defecto está definido en `packages/agent/src/model.ts` (OpenRouter, `openai/gpt-4o-mini`). Puedes cambiarlo ahí si lo necesitas.

---

## Paso 8 — Telegram (opcional)

Telegram **exige HTTPS** para webhooks. En local:

1. Crea el bot con BotFather y copia el token → `TELEGRAM_BOT_TOKEN` en `apps/web/.env.local`.
2. Elige un secreto aleatorio → `TELEGRAM_WEBHOOK_SECRET` (mismo valor usarás al registrar el webhook).
3. Expón tu app local con un túnel HTTPS, por ejemplo:

   ```bash
   ngrok http 3000
   ```

   Usa la URL HTTPS que te dé ngrok (p. ej. `https://abc123.ngrok-free.app`).

4. Con la app en marcha, visita en el navegador (sustituye la URL base):

   `https://TU_URL_NGROK/api/telegram/setup`

   Eso llama a `setWebhook` de Telegram apuntando a `/api/telegram/webhook` y, si definiste secreto, lo asocia al webhook.

5. En la web, entra a **Ajustes** → **Telegram** → **Generar código de vinculación**.
6. En Telegram, envía al bot: `/link TU_CODIGO` (el código que te muestra la web).

Después de vincular, los mensajes al bot usan el mismo pipeline que el chat web.

---

## Paso 9 — Google Calendar (opcional)

1. En Google Cloud Console, crea un **OAuth Client** (tipo Web Application).
   - Scopes requeridos: `https://www.googleapis.com/auth/calendar.readonly` y `https://www.googleapis.com/auth/calendar.events`.
   - Sin estos scopes, la integración puede fallar con errores `403` al listar o crear eventos.
2. Configura este redirect URI:

   ```
   http://localhost:3000/api/integrations/google-calendar/callback
   ```

3. Define en `apps/web/.env.local`:
   - `GOOGLE_CLIENT_ID`
   - `GOOGLE_CLIENT_SECRET`
   - `OAUTH_ENCRYPTION_KEY`
4. Inicia sesión en la app y conecta Google Calendar desde **Settings**.

---

## Comandos útiles

| Comando | Descripción |
|---------|-------------|
| `npm run dev` | Desarrollo (monorepo) |
| `npm run build` | Build de todos los paquetes que definan `build` |
| `npm run lint` | Lint |
| `cd apps/web && npx next build` | Build solo de la app Next (útil para comprobar tipos antes de desplegar) |

---

## Documentación adicional

- [docs/brief.md](docs/brief.md) — visión y brief original.
- [docs/architecture.md](docs/architecture.md) — arquitectura técnica del MVP.
- [docs/plan.md](docs/plan.md) — fases y decisiones de implementación.

---

## Problemas frecuentes

- **Redirecciones infinitas o “no auth”**: revisa `Site URL` y `Redirect URLs` en Supabase y que `.env.local` esté en **`apps/web`**.
- **Errores al guardar perfil o mensajes**: confirma que ejecutaste la migración SQL y que RLS no bloquea por falta de sesión (debes estar logueado con el mismo usuario).
- **Chat sin respuesta / 500 en `/api/chat`**: `OPENROUTER_API_KEY`, cuota en OpenRouter o modelo en `model.ts`.
- **Error de arranque por `AGENT_WORKSPACE_ROOT`**: la variable debe apuntar a un directorio que exista y sea legible; si la defines en producción, usa la ruta absoluta del *checkout* o del volumen aislado del agente.
- **Telegram no responde**: webhook debe ser HTTPS; token y secreto correctos; visita de nuevo `/api/telegram/setup` si cambias la URL pública.

---

## Próximos pasos (mejoras futuras)

- Soporte para eliminación de eventos
- Renderizado mejorado en Telegram
- Mejor enrutamiento entre herramientas (GitHub vs Calendar)

---

Si quieres, el siguiente paso natural es desplegar **Vercel** (o similar) para `apps/web`, definir las mismas variables de entorno en el panel del proveedor y usar la URL de producción en Supabase y en el webhook de Telegram.
