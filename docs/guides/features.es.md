# Funciones

[Volver al README](../../README.es.md)

## Animaciones e interacción

- **Estado en tiempo real** — los hooks de los agentes y el sondeo de logs controlan automáticamente las animaciones de Clawd
- **12 estados animados** — inactivo, pensando, escribiendo, construyendo, movimiento de subagente, malabares con varios subagentes, error, feliz, notificación, compactación, transporte y sueño
- **Importación de Codex Pet** — importa paquetes zip de Codex Pet desde `Ajustes…` → `Tema`; Clawd adapta las animaciones de su atlas a temas administrados
- **Seguimiento ocular** — Clawd sigue el cursor mientras está inactivo, inclinando el cuerpo y estirando la sombra
- **Secuencia de sueño** — bosteza, cabecea, se desploma y se duerme tras 60 segundos de inactividad; mover el mouse activa una animación de despertar sobresaltado
- **Reacciones a clics** — doble clic para darle un toque y 4 clics para que se agite
- **Arrastre desde cualquier estado** — agarra a Clawd cuando quieras (Pointer Capture evita que se suelte al moverlo rápido) y suéltalo para continuar
- **Modo mini** — arrástralo al borde derecho o haz clic derecho en «Modo mini»; Clawd se esconde en el borde, asoma al pasar el cursor, muestra alertas y celebraciones mini y usa transiciones de salto parabólicas

## Globo de permisos

- **Revisión de permisos en la aplicación** — cuando una integración con permisos envía una solicitud compatible, Clawd puede mostrar una tarjeta flotante en lugar de esperar en la terminal; los agentes de solo estado conservan su flujo de permisos nativo
- **Permitir / denegar / acciones propias del agente** — aprueba o rechaza con un clic, además de usar reglas de permisos o acciones `Always` cuando el agente de origen las admite
- **Modos de gestión de permisos** — elige **Preguntar siempre**, **Solo preguntas** con confirmación (solicitudes con forma de herramienta de agentes explícitamente compatibles) o **Aprobar automáticamente**. La aprobación automática gestiona cualquier solicitud que el adaptador marque como apta para automatización —incluidos nombres de solicitudes no vacíos y no reconocidos de Claude/Qwen—, pero los nombres ausentes, las formas de decisión no compatibles y las preguntas o planes de CodeBuddy vuelven al flujo nativo. El modo se rebaja tras reiniciar, y cada sesión activa apta puede elegir de forma independiente Preguntar siempre o solo herramientas. Consulta la [guía de configuración](setup-guide.md#permission-handling-automation)
- **Aprobación remota opcional** — Telegram y Feishu/Lark pueden reflejar solicitudes pendientes aptas mientras el globo local sigue disponible. Un fallo del canal no produce ninguna decisión remota ni una denegación: la solicitud de escritorio permanece pendiente, y las solicitudes solo remotas vuelven al agente únicamente después de que todos los clientes disponibles regresen sin decisión
- **Atajos globales** — `Ctrl+Shift+Y` permite y `Ctrl+Shift+N` deniega el globo de permisos más reciente (solo se registran mientras hay globos visibles)
- **Diseño apilado** — varias solicitudes de permisos se apilan hacia arriba desde la esquina inferior derecha
- **Cierre automático** — si respondes primero en la terminal, el globo desaparece automáticamente
- **Interruptor por agente** — abre `Ajustes…` → `Herramientas de IA para código`, elige un agente y desactiva `Mostrar globos emergentes` para conservar las solicitudes en la terminal/TUI del propio agente

## Notificaciones remotas

- **Telegram / Feishu (Lark)** — aprobación remota interactiva: envía solicitudes de permisos al teléfono y permite aprobarlas o denegarlas sin tocar el escritorio
- **Slack** — **solo notificaciones**: envía tareas **terminadas**, **errores** y **solicitudes de permisos** mediante un Incoming Webhook de Slack (o, de forma opcional, un token de bot `xoxb-` y un id. de canal) como tarjetas Block Kit. Slack no puede aprobar ni denegar en esta versión: los mensajes de permisos son avisos y la decisión se toma en la aplicación de escritorio. Configúralo junto a Telegram/Feishu en los canales de aprobación remota. Los secretos se guardan localmente en un archivo de entorno fuera de las preferencias (`0600` en macOS/Linux; en Windows se usa la ACL de AppData), y el canal se degrada de forma segura si no está configurado o no tiene conexión. Los mensajes pueden incluir el título de la sesión, la carpeta y el nombre del equipo, por lo que se recomienda un **canal privado**. Consulta [slack-notifications.md](slack-notifications.md)

## Información de sesiones

- **Seguimiento de varias sesiones** — las sesiones de todos los agentes se resuelven al estado de mayor prioridad
- **Detección de subagentes** — movimiento con auriculares para 1 subagente y malabares con tres pelotas para 2 o más
- **Panel de sesiones + HUD** — haz clic derecho o usa la bandeja → `Abrir panel` para revisar sesiones activas, eventos recientes y alias, y saltar a una terminal; un HUD compacto junto a Clawd mantiene visibles las sesiones activas
- **Cuota de suscripción de un vistazo** — los anillos Orbit opcionales junto a la mascota y las barras detalladas del panel muestran las ventanas de cuota informadas por los agentes compatibles. La recopilación local de Claude está desactivada de forma predeterminada y usa el [payload oficial `rate_limits` de la statusline](https://code.claude.com/docs/en/statusline) de Claude Code; no realiza ninguna solicitud adicional a Anthropic. Consulta las [notas sobre flujo de datos y propiedad](setup-guide.md#claude-code-subscription-quota-official-status-line-not-scraping).
- **Enfoque de terminal** — las acciones del panel/HUD saltan a la ventana de terminal de una sesión concreta; los estados de notificación o atención enfocan automáticamente la terminal correspondiente
- **Detección de procesos activos** — detecta los procesos compatibles que terminaron o fallaron y limpia las sesiones huérfanas
- **Recuperación al inicio** — si Clawd se reinicia mientras sigue ejecutándose algún agente compatible, permanece despierto en lugar de dormirse

## Aplicación móvil complementaria (PWA)

- **Espejo en vivo en tu teléfono** — activa `Ajustes…` → `Móvil / PWA` y abre en el teléfono la URL de emparejamiento; la aplicación web Clawd Mobile muestra en tiempo real las sesiones de tus agentes y sus estados
- **Solo lectura por diseño** — el puente LAN solo transmite el estado; nada de la PWA puede modificar tu equipo (la aprobación desde la PWA LAN está en la hoja de ruta; Telegram y Feishu/Lark son canales compatibles independientes)
- **Solo LAN y protegido por token** — el emparejamiento requiere un token, los tokens rotan automáticamente con un periodo de gracia y el acceso puede regenerarse o restablecerse con un clic
- **Instalable** — es una PWA: añádela a la pantalla de inicio para usarla como una aplicación
> La línea de la aplicación móvil complementaria —desde el primer prototipo hasta la rotación de tokens— está construida y liderada por el colaborador principal [@Bynlk](https://github.com/Bynlk), que también mantiene [clawd-on-mobile](https://github.com/Bynlk/clawd-on-mobile), un fork hermano con una aplicación Android nativa.

## Sistema

- **Clic transparente** — las áreas transparentes pasan los clics a las ventanas inferiores; solo el cuerpo de Clawd es interactivo
- **Memoria de posición** — Clawd recuerda dónde lo dejaste después de reiniciar (incluido el modo mini)
- **Bloqueo de instancia única** — evita ventanas duplicadas de Clawd
- **Inicio automático** — el hook SessionStart de Claude Code puede iniciar Clawd automáticamente si no está en ejecución
- **No molestar** — haz clic derecho o usa la bandeja para entrar en modo de sueño; todos los eventos de hooks quedan silenciados hasta que despiertes a Clawd. Los globos de permisos se suprimen durante No molestar: Codex, opencode y MiMo Code vuelven a sus solicitudes nativas, mientras Claude Code y CodeBuddy vuelven a su flujo de permisos integrado. WorkBuddy usa solo Estado + Notificación; Antigravity y Pi son integraciones de solo estado.
- **Efectos de sonido** — avisos de audio breves al terminar tareas y recibir solicitudes de permisos (se activan desde la bandeja o Ajustes; espera de 10 s y silencio automático durante No molestar)
- **Bandeja del sistema** — modo No molestar, inicio automático y búsqueda de actualizaciones
- **i18n** — interfaz en inglés, chino simplificado, chino tradicional, coreano, japonés, portugués de Brasil y español; cambia el idioma en Ajustes → General
- **Actualización automática** — busca releases de GitHub; Windows instala actualizaciones NSIS al salir y macOS/Linux ejecutan `git pull` + reinicio cuando se usa un repositorio clonado

## Varias pantallas

Clawd se adapta a configuraciones con varios monitores: el tamaño proporcional usa la pantalla donde se inicia Clawd, los monitores verticales reciben un aumento limitado para que la mascota siga viéndose bien en pantallas altas y estrechas, y puedes arrastrar a Clawd entre pantallas.

<p align="center"><sub>¿Quieres ver el comportamiento real con varios monitores? <a href="../../assets/videos/clawd-multi-monitor-demo.mp4">Mira el video de demostración de este repositorio</a>.</sub></p>

## Temas personalizados

Clawd admite temas personalizados: sustituye el cangrejo predeterminado por tu propio personaje y animaciones. Si ya tienes un paquete Codex Pet, importa su zip desde `Ajustes…` → `Tema` → `Importar zip de mascota`; Clawd convierte automáticamente el atlas en un tema administrado.

**Inicio rápido:**
1. Crea la estructura de un tema:
   ```bash
   node scripts/create-theme.js my-theme
   # o
   npm run create-theme -- my-theme
   ```
   También funciona sin argumentos: crea la siguiente estructura `my-theme` disponible en tu directorio de temas de usuario.
2. Edita `theme.json` y crea tus recursos (SVG, GIF, APNG, WebP, PNG, JPG o JPEG)
3. Reinicia Clawd o abre `Ajustes…` → `Tema` → selecciona tu tema

**Tema mínimo viable:** 1 SVG (inactividad con seguimiento ocular) + 7 archivos GIF/APNG (pensando, trabajando, error, feliz, notificación, durmiendo y despertando). Puedes desactivar el seguimiento ocular para usar cualquier formato en todos los estados.

Valida tu tema antes de distribuirlo:
```bash
node scripts/validate-theme.js path/to/your-theme
```

Las tarjetas de temas en `Ajustes…` → `Tema` muestran insignias de capacidades como `Inactividad con seguimiento`, `Tema estático`, `Mini`, `Sueño directo` y `Sin reacciones`, para que los usuarios sepan qué admite cada tema antes de cambiar.

Consulta [docs/guides/guide-theme-creation.md](guide-theme-creation.md) para ver la guía completa de creación con rutas por niveles (principiante → avanzado), referencia de campos de `theme.json` y pautas para los recursos.

> Los archivos SVG de terceros se sanitizan automáticamente por seguridad.

## Hoja de ruta

Algunas ideas que nos gustaría explorar en el futuro:

- Enfoque de la terminal de Codex mediante búsqueda en el árbol de procesos a partir del PID de `codex.exe`
- Script de desinstalación de hooks para eliminar la aplicación limpiamente
- Aplicación móvil PWA por LAN: aprobación de permisos desde el navegador (en desarrollo, liderada por [@Bynlk](https://github.com/Bynlk)); Telegram y Feishu/Lark son canales de aprobación compatibles independientes
