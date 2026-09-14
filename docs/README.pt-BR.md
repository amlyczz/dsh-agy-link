# dsh-agy-link — Português (Brasil)

Integre modelos Google Antigravity ao DeepSeek Harness (DSH) por meio do CLI oficial e não modificado `agy`. O plugin oferece streaming, thinking, atividade de ferramentas, medição de tokens, login OAuth pela interface e painel de quota.

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
- Quotas oficiais de 5 horas e 7 dias, com barras e contagem regressiva.
- Streaming de texto, thinking e atividade de ferramentas em componentes nativos do DSH.
- Conversas DSH vinculadas às conversas do `agy` por `--conversation`.
- Modelos Gemini, Claude e GPT-OSS selecionáveis no provider `antigravity`.
- Imagens multimodais armazenadas localmente e autorizadas ao `agy` por `--add-dir`.
- Ferramenta `agy_ask` para delegar uma tarefa pontual a um modelo Antigravity.

## Configuração

| Chave | Variável de ambiente | Padrão | Descrição |
| --- | --- | --- | --- |
| `enabled` | `DSH_AGY_ENABLED` | `true` | Liga/desliga o plugin |
| `agyBin` | `DSH_AGY_BIN` | autodetectado | Caminho do executável `agy` |
| `permissionMode` | `DSH_AGY_MODE` | `skip` | `skip`, `plan` ou `accept-edits` |
| `defaultModel` | `DSH_AGY_DEFAULT_MODEL` | padrão do agy | Slug do modelo padrão |
| `defaultEffort` | `DSH_AGY_DEFAULT_EFFORT` | padrão do modelo | `low`, `medium` ou `high` |
| `timeoutMs` | `DSH_AGY_TIMEOUT_MS` | `600000` | Timeout do watchdog, em ms |
| `workspaceRoot` | `DSH_AGY_WORKSPACE_ROOT` | cwd da sessão | Raiz do workspace |

## Comandos `/agy`

`status`, `auth`, `models`, `mode`, `effort`, `workspace`, `clear`, `doctor` e `help`.

## Segurança e termos

O plugin chama somente o binário `agy` oficial e não modificado instalado localmente. Use-o em conformidade com os Termos de Serviço do Google Antigravity. Preserve literalmente comandos, variáveis, IDs de modelo e caminhos ao adaptar esta documentação.

## Licença

MIT License.
