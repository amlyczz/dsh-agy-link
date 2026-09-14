# dsh-agy-link — Español

Integra modelos de Google Antigravity en DeepSeek Harness (DSH) mediante el CLI oficial y sin modificar `agy`. El plugin ofrece streaming, thinking, actividad de herramientas, uso de tokens, login OAuth desde la interfaz y monitor de cuota.

## Requisitos

| Requisito | Verificación |
| --- | --- |
| DSH | `dsh --version` |
| Node.js >= 24 | `node --version` |
| Google Antigravity CLI | `agy --version` |
| Conectividad con Google | proxy/VPN/TUN cuando sea necesario |

En regiones donde Google no sea accesible directamente, habilite TUN/proxy del sistema. Si la terminal no hereda el proxy, expórtelo antes de iniciar DSH:

```bash
export HTTPS_PROXY=http://127.0.0.1:7890 HTTP_PROXY=http://127.0.0.1:7890 ALL_PROXY=socks5://127.0.0.1:7890
```

Sustituya el puerto por el de su proxy local. También puede configurar un proxy HTTP(S) o SOCKS por cuenta desde el panel Antigravity de DSH.

## Instalación e inicio rápido

```bash
# Instale el plugin en el profile web
dsh plugin --profile web add dsh-agy-link

# Inicie DSH Web
dsh web
```

En DSH, haga clic en la insignia `AGY (n)` y seleccione **Add Account** para completar el login Google en el navegador. También puede ejecutar `/agy auth` para iniciar el login de la cuenta principal. Después seleccione un modelo Antigravity en `/model` y empiece a conversar. Use `/agy status` para comprobar el estado.

## Funciones

- Pool de cuentas con entornos HOME y credenciales aislados.
- Failover secuencial cuando una cuenta recibe HTTP 429 o agota su cuota.
- Cuotas oficiales de 5 horas y 7 días con barras y cuenta regresiva.
- Streaming de texto, thinking y actividad de herramientas en tarjetas nativas de DSH.
- Sesiones DSH vinculadas a conversaciones `agy` mediante `--conversation`.
- Modelos Gemini, Claude y GPT-OSS elegibles desde el provider `antigravity`.
- Imágenes multimodales guardadas localmente y autorizadas a `agy` con `--add-dir`.
- Herramienta `agy_ask` para delegar una tarea puntual a un modelo Antigravity.

## Configuración

| Clave | Variable de entorno | Predeterminado | Descripción |
| --- | --- | --- | --- |
| `enabled` | `DSH_AGY_ENABLED` | `true` | Activa/desactiva el plugin |
| `agyBin` | `DSH_AGY_BIN` | detección automática | Ruta al ejecutable `agy` |
| `permissionMode` | `DSH_AGY_MODE` | `skip` | `skip`, `plan` o `accept-edits` |
| `defaultModel` | `DSH_AGY_DEFAULT_MODEL` | predeterminado de agy | Slug del modelo predeterminado |
| `defaultEffort` | `DSH_AGY_DEFAULT_EFFORT` | predeterminado del modelo | `low`, `medium` o `high` |
| `timeoutMs` | `DSH_AGY_TIMEOUT_MS` | `600000` | Timeout del watchdog en ms |
| `workspaceRoot` | `DSH_AGY_WORKSPACE_ROOT` | cwd de la sesión | Raíz del workspace |

## Comandos `/agy`

`status`, `auth`, `models`, `mode`, `effort`, `workspace`, `clear`, `doctor` y `help`.

## Seguridad y términos

El plugin invoca solamente el binario `agy` oficial y sin modificar instalado localmente. Úselo conforme a los Términos de Servicio de Google Antigravity. Mantenga literales los comandos, variables, IDs de modelo y rutas al adaptar esta documentación.

## Licencia

MIT License.
