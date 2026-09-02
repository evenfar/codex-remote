# 服务器部署（Linux）

> 场景：桥接服务跑在服务器上（跟服务器上的 codex 同机），手机直接访问服务器。
> 服务器无法直连 OpenAI 时，借道你 Windows 电脑上的梯子（见下文「代理出海」）。

## 1. 安装依赖

```bash
# Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs
# Codex CLI
sudo npm i -g @openai/codex
# 登录（服务器无浏览器，用设备码模式，按提示在任意设备打开链接授权一次）
codex login --device-auth
```

## 2. 部署本项目

```bash
git clone https://github.com/evenfar/codex-remote.git && cd codex-remote
npm install
```

## 3. 配置（公网必须用强 token！）

```bash
mkdir -p data
cat > data/config.json <<'EOF'
{
  "host": "0.0.0.0",
  "port": 3010,
  "workspace": "/root/your-projects",
  "tokenMode": "strong",
  "proxy": "http://127.0.0.1:7890"
}
EOF
```

| 字段 | 说明 |
|---|---|
| `host` | `0.0.0.0` 监听公网；仅本机测试用 `127.0.0.1` |
| `tokenMode` | **公网必须 `strong`**（43 位随机 token，首次启动生成于 `data/token.json`） |
| `proxy` | 服务器借道 Windows 梯子时填 `http://127.0.0.1:7890`（SSH 反向隧道落在服务器本地 7890）；服务器能直连 OpenAI 就留空 |
| `workspace` | codex 的默认工作目录 |

## 4. 代理出海（梯子在 Windows 上时）

在 **Windows 电脑** 上编辑并运行本项目 `scripts/tunnel-guard.vbs`
（改文件头部的 `SERVER` / `SERVER_PORT` / `LOCAL_PROXY_PORT` 三个变量后双击），
它会建立并守护 SSH 反向隧道，断线 5 秒后自动重连：

```
服务器 127.0.0.1:7890  <==SSH 反向隧道==>  Windows 127.0.0.1:7897(Clash)  ==>  OpenAI
```

注意：**Windows 关机或梯子没开时，服务器上的 codex 会请求超时**——这是该拓扑的固有约束。

## 5. systemd 常驻

```bash
sudo tee /etc/systemd/system/codex-remote.service <<'EOF'
[Unit]
Description=codex-remote bridge
After=network-online.target

[Service]
WorkingDirectory=/root/codex-remote
ExecStart=/usr/bin/node server/index.mjs
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload && sudo systemctl enable --now codex-remote
sudo journalctl -u codex-remote -f   # 看日志（含配对 token）
```

## 6. 强烈建议：HTTPS 反代

公网明文 HTTP 会泄露 token 和对话内容。用 Caddy 最省事（自动签证书）：

```
codex.yourdomain.com {
    reverse_proxy 127.0.0.1:3010
}
```

配好后手机访问 `https://codex.yourdomain.com`，首次输入 `data/token.json` 里的强 token。
