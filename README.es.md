<p align="center">
  <img src="assets/icon.png" width="128" alt="Clawd">
</p>

<div align="center">
  <h1>Clawd on Desk</h1>
  <p><b>Una mascota de escritorio pixelada que reacciona en tiempo real a tu agente de programación con IA.</b></p>
  <p><a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.zh-TW.md">繁體中文</a> · <a href="README.ko-KR.md">한국어</a> · <a href="README.ja-JP.md">日本語</a> · Español</p>
  <a href="https://github.com/rullerzhou-afk/clawd-on-desk/stargazers"><img src="https://img.shields.io/github/stars/rullerzhou-afk/clawd-on-desk?style=flat-square" alt="Stars"></a>
  <a href="https://github.com/rullerzhou-afk/clawd-on-desk/releases"><img src="https://img.shields.io/github/v/release/rullerzhou-afk/clawd-on-desk?label=version&style=flat-square" alt="Version"></a>
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey?style=flat-square" alt="Platform">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue?style=flat-square" alt="License"></a>
  <a href="https://github.com/hesreallyhim/awesome-claude-code"><img src="https://awesome.re/mentioned-badge-flat.svg" alt="Mentioned in Awesome Claude Code"></a>
  <a href="https://discord.gg/VQsQZbZCPx"><img src="https://img.shields.io/badge/Discord-Join%20us-5865F2?style=flat-square&amp;logo=discord&amp;logoColor=white" alt="Discord"></a>
</div>

<p align="center">
  <img src="assets/hero.gif" alt="Clawd on Desk: una mascota de escritorio pixelada que reacciona en tiempo real a tu agente de programación con IA. La demostración animada muestra al cangrejo durmiendo, pensando mientras el modelo lee el código, escribiendo cuando se ejecutan herramientas, moviéndose con un subagente, haciendo malabares con varios subagentes, mostrando un globo de permisos y celebrando al completar 14 archivos y 312 pruebas. Funciona con Claude Code, Codex, Cursor, Copilot, Gemini, Antigravity, Qwen, CodeWhale, Pi, OMP, OpenClaw y más.">
</p>

Lanza una tarea larga, aléjate y vuelve cuando el cangrejo te avise de que terminó. Clawd piensa mientras escribes el prompt, teclea mientras se ejecutan herramientas, hace malabares cuando se acumulan subagentes, muestra una tarjeta cuando una herramienta necesita tu aprobación y se duerme cuando te vas.

## Funciones

- **Estado en vivo**: 12 estados animados impulsados por hooks y logs del agente, con seguimiento de la mirada, secuencia de sueño, reacciones al clic y un modo mini que asoma desde el borde de la pantalla
- **Funciona con tus herramientas**: Claude Code, Codex, Copilot, Gemini, Cursor, opencode, Kiro, Qwen y más de 20 más, con cada sesión seguida en paralelo
- **Globos de permisos**: permite o deniega solicitudes desde una tarjeta flotante o un atajo global, o cambia a aprobación automática
- **Sesiones de un vistazo**: un HUD junto a la mascota, un panel con cada sesión activa y salto directo a su terminal, anillos de cuota y un resumen privado local
- **Lejos del escritorio**: aprueba desde Telegram o Feishu/Lark, recibe notificaciones en Slack o sigue tus sesiones en el móvil con la PWA de solo lectura
- **A tu manera**: Clawd, Calico y Cloudling incluidos, temas oficiales para descargar, importación de Codex Pet o un tema propio
- **Donde programes**: Windows (x64 y ARM64), macOS y Linux, además de Remote SSH y WSL, con la interfaz en 7 idiomas

Todas las funciones en detalle: **[docs/guides/features.es.md](docs/guides/features.es.md)**

## Inicio rápido

Descarga el instalador más reciente desde **[GitHub Releases](https://github.com/rullerzhou-afk/clawd-on-desk/releases/latest)**:

| Plataforma | Descarga |
|---|---|
| Windows | `Clawd-on-Desk-Setup-<version>-x64.exe` o `-arm64.exe` |
| macOS | `.dmg`, o `brew install --cask clawd-on-desk` |
| Linux | `.AppImage` o `.deb` (Homebrew también funciona en x86_64) |

Abre Clawd y empieza a reaccionar de inmediato: Claude Code y Codex se conectan en el primer arranque. Cualquier otro agente se instala con un clic en **Ajustes → Herramientas de IA para código**.

<details>
<summary><strong>Ejecutar desde el código fuente</strong></summary>
<br/>

Solo hace falta para contribuir, probar código sin publicar o depurar integraciones. La instalación desde el código descarga Electron y herramientas de compilación, así que `node_modules` ocupa bastante.

```bash
# Clona el repositorio
git clone https://github.com/rullerzhou-afk/clawd-on-desk.git
cd clawd-on-desk

# Instala las dependencias
npm install

# Inicia Clawd (registra automáticamente los hooks de Claude Code y Codex)
npm start
```

Requisitos, Remote SSH, WSL y notas para macOS / Linux: **[guía de configuración](docs/guides/setup-guide.md)**

</details>

## Agentes compatibles

> **Claude Code** · **Codex CLI** · **Copilot CLI** · **Gemini CLI** · **Antigravity CLI (agy)** · **Cursor Agent** · **CodeBuddy** · **WorkBuddy** · **Grok Build** · **Kiro CLI** · **KiroCrew** · **Kimi Code CLI (Kimi-CLI)** · **Qwen Code** · **ZCode** · **CodeWhale** · **opencode** · **MiMo Code** · **Pi** · **OMP** · **OpenClaw** · **Hermes Agent** · **Qoder** · **QoderWork** · **QwenWork (千问办公)** · **Reasonix CLI** · **DeepSeek Harness** · **TraeCode (Trae CN)** · **MiniMax Code**

Claude Code y Codex CLI se configuran en el primer arranque; instala cualquier otra integración desde **Ajustes → Herramientas de IA para código** y Clawd la mantiene sincronizada. Otras herramientas locales pueden informar a través del endpoint de [agentes HTTP personalizados](docs/guides/custom-agent-http.md). Los detalles de cada agente están en **[agentes compatibles](docs/guides/supported-agents.es.md)**, y las diferencias, como agentes sin globo de permisos, en **[limitaciones conocidas](docs/guides/known-limitations.md)**.

## Temas

<table>
  <tr>
    <td align="center"><img src="assets/gif/clawd-idle.gif" width="100"><br><sub>Inactivo</sub></td>
    <td align="center"><img src="assets/gif/clawd-thinking.gif" width="100"><br><sub>Burbuja de pensamiento</sub></td>
    <td align="center"><img src="assets/gif/clawd-typing.gif" width="100"><br><sub>Escribiendo</sub></td>
    <td align="center"><img src="assets/gif/clawd-building.gif" width="100"><br><sub>Construyendo</sub></td>
    <td align="center"><img src="assets/gif/clawd-headphones-groove.gif" width="100"><br><sub>1 subagente</sub></td>
    <td align="center"><img src="assets/gif/clawd-juggling.gif" width="100"><br><sub>2+ subagentes</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="assets/gif/calico-idle.gif" width="80"><br><sub>Calico inactivo</sub></td>
    <td align="center"><img src="assets/gif/calico-thinking.gif" width="80"><br><sub>Calico pensando</sub></td>
    <td align="center"><img src="assets/gif/calico-typing.gif" width="80"><br><sub>Calico escribiendo</sub></td>
    <td align="center"><img src="assets/gif/calico-building.gif" width="80"><br><sub>Calico construyendo</sub></td>
    <td align="center"><img src="assets/gif/calico-juggling.gif" width="80"><br><sub>Calico haciendo malabares</sub></td>
    <td align="center"><img src="assets/gif/calico-conducting.gif" width="80"><br><sub>Calico dirigiendo</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="assets/gif/cloudling-idle.gif" width="120"><br><sub>Cloudling inactivo</sub></td>
    <td align="center"><img src="assets/gif/cloudling-thinking.gif" width="120"><br><sub>Cloudling pensando</sub></td>
    <td align="center"><img src="assets/gif/cloudling-typing.gif" width="120"><br><sub>Cloudling escribiendo</sub></td>
    <td align="center"><img src="assets/gif/cloudling-building.gif" width="120"><br><sub>Cloudling construyendo</sub></td>
    <td align="center"><img src="assets/gif/cloudling-juggling.gif" width="120"><br><sub>Cloudling haciendo malabares</sub></td>
    <td align="center"><img src="assets/gif/cloudling-conducting.gif" width="120"><br><sub>Cloudling dirigiendo</sub></td>
  </tr>
</table>

Clawd incluye **Clawd** (cangrejo pixelado), **Calico** (三花猫) y **Cloudling** (云宝). **Hash Sage** (哈希仙人) y **Whale-chan** (鲸鱼娘) son temas oficiales opcionales en **Ajustes → Tema**, donde también puedes importar un zip de Codex Pet. Para dibujar el tuyo, ejecuta `npm run create-theme -- my-theme` y sigue la **[guía de creación de temas](docs/guides/guide-theme-creation.md)**. Qué evento reproduce cada animación: [mapa de estados](docs/guides/state-mapping.md).

Herramienta de la comunidad: [Live2Pet](https://github.com/receyuki/live2pet), de @receyuki, convierte modelos Live2D en temas de Clawd.

## Guías

| Guía | Contenido |
|---|---|
| [Funciones](docs/guides/features.es.md) | Todas las funciones en detalle |
| [Guía de configuración](docs/guides/setup-guide.md) | Compilación desde el código, agentes y notas para Windows / macOS / Linux |
| [Gestión de permisos](docs/guides/setup-guide.md#permission-handling-automation) | Preguntar siempre, solo preguntas o aprobación automática |
| [Remote SSH](docs/guides/guide-remote-ssh.md) | Estado y globos de permisos de agentes en un servidor remoto |
| [Codex + WSL](docs/guides/codex-wsl-clarification.md) | Qué admite Clawd para Codex dentro de WSL |
| [Aprobación remota](docs/guides/telegram-approval.md) | Telegram, más [Feishu / Lark](docs/guides/feishu-lark-remote-approval.md) y [notificaciones de Slack](docs/guides/slack-notifications.md) |
| [Resumen](docs/guides/recap.md) | Revisión privada y local de la actividad |
| [Agentes HTTP personalizados](docs/guides/custom-agent-http.md) | Conecta una herramienta que Clawd aún no integra |
| [Limitaciones conocidas](docs/guides/known-limitations.md) | Diferencias de funciones por agente |
| [Creación de temas](docs/guides/guide-theme-creation.md) | Crea y valida tu propio tema |

## Comunidad

Únete a nuestra [comunidad de Discord](https://discord.gg/VQsQZbZCPx) para pedir ayuda, compartir temas y configuraciones de escritorio o intercambiar ideas. Puedes participar en inglés o chino. Informa de los errores en [GitHub Issues](https://github.com/rullerzhou-afk/clawd-on-desk/issues) para que podamos darles seguimiento.

## Contribuir

Clawd on Desk es un proyecto impulsado por la comunidad. Los informes de errores, las ideas de funciones y los pull requests son bienvenidos: abre un [issue](https://github.com/rullerzhou-afk/clawd-on-desk/issues) para conversar o envía directamente un PR.

### Responsables del mantenimiento

<p align="center">
  <img src="assets/readme/maintainers.svg" width="660" alt="Maintainers: @rullerzhou-afk (creator), @YOIMIYA66, @Bynlk (Mobile / PWA)">
</p>

### Colaboradores

Gracias a todas las personas que han ayudado a mejorar Clawd:

<a href="https://github.com/rullerzhou-afk/clawd-on-desk/graphs/contributors">
  <img src="assets/readme/contributors.svg" width="900" alt="Clawd on Desk contributors">
</a>

## Agradecimientos

- Referencia del pixel art de Clawd tomada de [clawd-tank](https://github.com/marciogranzotto/clawd-tank), de [@marciogranzotto](https://github.com/marciogranzotto)
- Compartido en la comunidad [LINUX DO](https://linux.do/)

## Licencia

El código fuente se distribuye bajo la [GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0).

**Las ilustraciones y los recursos de temas incluidos (entre ellos `assets/` y `themes/*/assets/`) NO están cubiertos por AGPL-3.0.** Sus respectivos titulares conservan todos los derechos. Consulta [assets/LICENSE](assets/LICENSE) y los avisos siguientes para obtener más información.

- El personaje **Clawd** es propiedad de [Anthropic](https://www.anthropic.com). Este es un proyecto no oficial creado por fans, sin afiliación ni respaldo de Anthropic.
- Ilustración del **gato Calico (三花猫)** por 鹿鹿 ([@rullerzhou-afk](https://github.com/rullerzhou-afk)). Todos los derechos reservados.
- Ilustración de **Cloudling (云宝)** por 鹿鹿 ([@rullerzhou-afk](https://github.com/rullerzhou-afk)). Todos los derechos reservados. La dirección visual de Cloudling incluye un homenaje al logotipo de OpenAI Codex; las marcas Codex/OpenAI siguen siendo propiedad de OpenAI y este proyecto no está afiliado ni respaldado por OpenAI.
- **Whale-chan (鲸鱼娘)** se distribuye por separado como tema oficial opcional desde [`rullerzhou-afk/clawd-themes`](https://github.com/rullerzhou-afk/clawd-themes). Los derechos del personaje, su historia y los materiales originales pertenecen a sus autores; el tema acredita a ZipZipPipe y 上善无形 según [Neko3000/deepseek-whalechan](https://github.com/Neko3000/deepseek-whalechan). Las nuevas animaciones y efectos de 鹿鹿 ([@rullerzhou-afk](https://github.com/rullerzhou-afk)) usan CC BY-NC-SA 4.0; consulta el paquete del tema para conocer todos los términos. Es una obra de fans no oficial y no comercial, sin afiliación, autorización ni respaldo de DeepSeek, y no está cubierta por la licencia AGPL-3.0 del código fuente de este proyecto.
- **Contribuciones de terceros**: los respectivos artistas conservan los derechos de autor.

**Sin criptomonedas.** Este proyecto no tiene token, moneda, NFT ni airdrop, y no está afiliado a ningún proyecto de criptomonedas.
