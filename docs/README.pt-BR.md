# dsh-agy-link — Português (Brasil)

Integre modelos Google Antigravity ao DeepSeek Harness (DSH) por meio do CLI oficial e não modificado `agy`. O plugin oferece streaming, thinking, atividade de ferramentas, medição de tokens, login OAuth pela interface, monitoramento oficial de quotas e tradução para linguagem natural com `/tsl`.

## Requisitos

| Requisito | Verificação |
| --- | --- |
| DSH | `dsh --version` |
| Node.js >= 24 | `node --version` |
| Google Antigravity CLI | `agy --version` |
| Conectividade com Google | proxy/VPN/TUN quando necessário |

Em regiões onde o Google não é acessível diretamente, use o modo TUN/proxy do sistema. Se o terminal não herdar o proxy, exporte antes de iniciar o DSH:

```bash
export HTTPS_PROXY=http://127.0.0.1:7890 HTTP_PROXY=http://127.0.0.1:7890 ALL_PROXY=socks5://127.0.0.1:7890
```

Substitua a porta pelo proxy local correto. Também é possível configurar um proxy HTTP(S) ou SOCKS por conta no painel Antigravity do DSH.

## Instalação e início rápido

```bash
# Instale o plugin no profile web
dsh plugin --profile web add dsh-agy-link

# Inicie o DSH Web
dsh web
```

No DSH, clique no selo `AGY (n)` e selecione **Add Account** para concluir o login Google no navegador. Como alternativa, execute `/agy auth` para iniciar o login da conta principal. Em seguida, selecione um modelo Antigravity no seletor `/model` e comece a conversar. Use `/agy status` para verificar o estado.

## Recursos

- Pool de contas com ambientes HOME e credenciais isolados.
- Failover sequencial quando uma conta recebe HTTP 429 ou esgota a quota.
- Quotas oficiais de 5 horas, 7 dias e Argon com barras e contagem regressiva.
- Streaming de texto, thinking e atividade de ferramentas em componentes nativos do DSH.
- Conversas DSH vinculadas às conversas do `agy` por `--conversation`.
- Modelos Gemini, Claude e GPT-OSS selecionáveis no provider `antigravity`.
- Responsividade web móvel: gaveta em tela cheia (`100dvh`) abaixo de 680px e botões de largura uniforme.
- Tradução para linguagem natural (`/tsl`): cartão estilo Gemini ancorado sob a resposta, conversa 1:1 dedicada.
- Aprendizado de `--effort`: detecta recusas do parâmetro de esforço e reexecuta com sucesso sem falhas.
- Imagens multimodais armazenadas localmente e autorizadas ao `agy` por `--add-dir`.
- Ferramenta `agy_ask` para delegar uma tarefa pontual a um modelo Antigravity.

## Configuração

| Chave | Variável de ambiente | Padrão | Descrição |
| --- | --- | --- | --- |
| `enabled` | `DSH_AGY_ENABLED` | `true` | Liga/desliga o plugin |
| `agyBin` | `DSH_AGY_BIN` | autodetectado | Caminho do executável `agy` |
| `permissionMode` | `DSH_AGY_MODE` | `skip` | `skip`, `plan` ou `accept-edits` (fixo em `skip` no painel; config/env ainda podem sobrescrever) |
| `defaultModel` | `DSH_AGY_DEFAULT_MODEL` | padrão do agy | Slug do modelo padrão |
| `defaultEffort` | `DSH_AGY_DEFAULT_EFFORT` | `high` | `low`, `medium`, `high` ou `auto`; valor inicial do seletor de modelos |
| `timeoutMs` | `DSH_AGY_TIMEOUT_MS` | `600000` | Timeout do watchdog, em ms |
| `longToolIdleMinutes` | `DSH_AGY_LONG_TOOL_IDLE_MINUTES` | `240` | Orçamento de inatividade (minutos) enquanto um passo de ferramenta está aberto; `0` = manter `timeoutMs` |
| `workspaceRoot` | `DSH_AGY_WORKSPACE_ROOT` | cwd da sessão | Raiz do workspace |
| `suppressAgyAutoUpdate` | `DSH_AGY_SUPPRESS_AUTOUPDATE` | `true` no Windows | Atualiza timestamp para evitar flashes do terminal |
| `autoWarmup` | `DSH_AGY_AUTO_WARMUP` | `false` | Sonda de pré-aquecimento para quota semanal de 7 dias |
| `autoTranslate` | `DSH_AGY_AUTO_TRANSLATE` | `false` | Tradução automática para linguagem natural a cada turno |
| `translateModel` | `DSH_AGY_TRANSLATE_MODEL` | `gemini-3.8-flash` | Modelo usado para traduções `/tsl` |

> Para consultar a lista completa de opções, consulte [docs/CONFIGURATION.md](./CONFIGURATION.md).

## Comandos

`/agy`: `status`, `pool`, `auth`, `models`, `mode`, `effort`, `workspace`, `goal`, `session`, `enable-account`, `disable-account`, `clear`, `doctor` e `help`.  
`/tsl`: traduz o último turno ou texto arbitrário com `--full`, `--text`, `--model` ou `auto on|off`.

## Segurança e termos

O plugin chama somente o binário `agy` oficial e não modificado instalado localmente. Use-o em conformidade com os Termos de Serviço do Google Antigravity. Preserve literalmente comandos, variáveis, IDs de modelo e caminhos ao adaptar esta documentação.

## Licença

MIT License.
