# 部署文档

本文档面向把「月满博饼」放到真实环境运行的人。项目是**有状态单实例**应用：房间、回合、奖池和匿名凭证都存在进程使用的 SQLite 文件里，
因此部署的核心是三件事——**只跑一个副本**、**数据卷持久化并正确备份**、**公网走 HTTPS 且 WebSocket 能升级**。

---

## 1. 运行形态与硬性约束

| 项目 | 说明 |
| --- | --- |
| 进程 | 单个 Node.js ≥ 24 进程，HTTP + Socket.IO 同源同端口（默认 3001） |
| 存储 | `DATA_DIR` 下的 SQLite 文件（默认 `./data`），使用 WAL 模式 |
| 房间状态 | 进程内缓存 + SQLite 落库；写库成功后才广播 |
| 副本数 | **必须为 1**。多副本会导致各自持有不同房间状态、SQLite 写冲突，且 Socket.IO 未配置跨进程适配器 |
| 水平扩容 | 本版本不支持。需要扩容请先改造为外部数据库 + Socket.IO Redis 适配器，并重新设计权威时钟归属 |
| 反向代理 | 需要，负责 TLS、`Upgrade` 转发与 `X-Forwarded-For` |
| 静态资源 | 生产模式下由同一个 Node 进程提供 `dist/`，并回退到 `index.html`（深链刷新可用） |

`GET /api/health` 返回 `{"ok":true}`，可作为存活探针。
`GET /api/config` 只读返回 `{"publicBaseUrl": string|null}`，供前端生成分享链接，**不含任何密钥或凭证**。

---

## 2. 三种部署范围（差别很大，别混用）

### 2.1 仅本机（localhost）

```bash
npm ci && npm run build && npm start
# http://localhost:3001
```

- 只对本机有效。**不要把 `http://localhost:3001/room/XXXXXX` 发给别人**，对方打开是自己的机器。
- 不配置 `PUBLIC_BASE_URL` 时，分享弹层里的链接就是访问者当前地址，也就是 `localhost`。
- 适合自己验收、跑 E2E、演示录屏。

### 2.2 同一局域网（LAN）

```bash
PORT=3001 PUBLIC_BASE_URL=http://192.168.1.23:3001 npm start
# 服务默认监听 0.0.0.0；将示例 IP 换成这台电脑的局域网 IP
```

- 手机和电脑连同一个 Wi-Fi 时可用 `http://<局域网IP>:3001` 访问，用 `PUBLIC_BASE_URL` 固定成这个地址后，分享链接和二维码才可直接被对方打开。
- **明文 HTTP 的限制**：局域网 HTTP 属于非安全上下文，浏览器不提供 `crypto.randomUUID`，项目已用 `crypto.getRandomValues` 兜底；
  但剪贴板写入可能被拒绝（界面会退化为「长按/选中链接复制」），`navigator.share` 可能不存在（按钮不会出现）。
- 局域网地址是私网地址，出了这个网络就失效；要发给互联网上的朋友，必须走 2.3。

### 2.3 公网（需要域名 + HTTPS）

- 必须有域名与 TLS 证书，`PUBLIC_BASE_URL=https://your.domain`。
- WebSocket 必须能升级（见第 4 节），否则只能靠 HTTP 轮询兜底，实时性明显下降。
- 公网 HTTP（非 HTTPS）下浏览器同样受限，且凭证在明文链路上传输，不允许。
- **本项目不会自动对外开放**：不会申请证书、不会创建隧道、不会改动防火墙。是否需要公网、用哪个域名由部署者决定。

---

## 3. Docker 部署（推荐）

```bash
# 1) 配置对外地址（必须与浏览器实际访问的地址一致）
export PUBLIC_BASE_URL=https://bobing.example.com

# 2) 构建并启动（compose.yaml 已固定单实例 + 命名数据卷 + 健康检查）
docker compose up -d --build

# 3) 查看状态与日志
docker compose ps
docker compose logs -f bobing
```

要点：

- `compose.yaml` 默认把端口绑定在 `127.0.0.1:3001`，由反向代理对外；要局域网直连可改成 `"3001:3001"`。
- 数据卷 `bobing-data` 挂载到 `/app/data`。**删除该卷等于清空所有房间与凭证。**
- 镜像使用 `node:24-bookworm-slim`，以非 root 用户 `node` 运行，`node:sqlite` 是 Node 24 内置模块，无需编译原生依赖。
- 容器 `CMD` 直接运行 `dist-server/server/index.js`；宿主机的 `npm start` 会先跑 `prestart` 编译后端。
- 需要绑定挂载到宿主目录时：

  ```yaml
  volumes:
    - ./data:/app/data
  ```

  容器内用户 uid 为 1000，宿主目录需要先 `chown 1000:1000 ./data`，否则启动时会因权限不足无法建库。

### 3.1 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `3001` | 监听端口 |
| `DATA_DIR` | `./data` | SQLite 目录；容器内建议 `/app/data` |
| `PUBLIC_BASE_URL` | 空 | 分享地址。使用根域名的 http(s) 地址，例如 `https://bobing.example.com`；不含用户名、密码、查询串或片段。非法值会被忽略，结尾斜杠会去掉。当前应用不支持子路径部署 |
| `TRUST_PROXY` | `0` | 前置代理时设为 `1`，按 `X-Forwarded-For` 计限流；直连公网时保持 `0`，否则客户端可伪造 IP 绕过限流 |

限流：创建/加入房间按 IP 每分钟 30 次，其余写操作按身份每分钟 120 次。

---

## 4. 反向代理示例

### 4.1 nginx（HTTPS + WebSocket）

```nginx
map $http_upgrade $connection_upgrade {
  default upgrade;
  ''      close;
}

server {
  listen 443 ssl;
  http2 on;
  server_name bobing.example.com;

  ssl_certificate     /etc/letsencrypt/live/bobing.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/bobing.example.com/privkey.pem;

  # 分享链接里出现的地址就是这个域名
  location / {
    proxy_pass http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # Socket.IO 升级必需
    proxy_set_header Upgrade    $http_upgrade;
    proxy_set_header Connection $connection_upgrade;

    # 长连接不要被过早掐断
    proxy_read_timeout  3600s;
    proxy_send_timeout  3600s;
    proxy_buffering     off;
  }
}

server {
  listen 80;
  server_name bobing.example.com;
  return 301 https://$host$request_uri;
}
```

### 4.2 Caddy（自动证书）

```caddyfile
bobing.example.com {
  reverse_proxy 127.0.0.1:3001
}
```

Caddy 默认已处理 `Upgrade` 头与 HTTP/2，无需额外配置。启动服务时设置 `PUBLIC_BASE_URL=https://bobing.example.com`、`TRUST_PROXY=1`。

### 4.3 使用独立域名的根路径

当前路由、静态资源、`/api` 与 `/socket.io` 都使用根路径，未实现 `/bobing/` 一类的子路径部署。请使用 `https://bobing.example.com` 这样的独立域名，将其根路径代理到应用。`PUBLIC_BASE_URL` 只决定邀请链接，不会改写应用路由或资源路径；即使配置校验接受了带路径的地址，也不能据此认为支持子路径部署。

---

## 5. 数据、备份与恢复

### 5.1 数据文件

```text
$DATA_DIR/
├── bobing.sqlite        主库（房间、成员、投掷回执、奖池明细）
├── bobing.sqlite-wal    预写日志：最近提交可能只在这里
└── bobing.sqlite-shm    共享内存索引
```

**只复制 `bobing.sqlite` 会丢最近的事务**，这是这类备份最常见的翻车方式。

### 5.2 在线备份（推荐，不用停服）

`node:sqlite` 提供模块级 `backup(sourceDb, path)`（**不是** `db.backup()` 方法），得到一致性快照：

```bash
docker compose exec bobing node -e '
const { DatabaseSync, backup } = require("node:sqlite");
(async () => {
  const dir = process.env.DATA_DIR;
  const src = new DatabaseSync(dir + "/bobing.sqlite");
  const target = dir + "/backup-" + Date.now() + ".sqlite";
  await backup(src, target);
  src.close();
  console.log("备份完成:", target);
})();
'
docker compose cp bobing:/app/data/backup-<时间戳>.sqlite ./backup.sqlite
```

实测（本仓库容器内，一局 E2E 之后）：

```text
$ docker exec bobing-verify ls -la /app/data
-rw-r--r-- 1 node node     4096  bobing.sqlite          ← 主库只有 4KiB
-rw-r--r-- 1 node node  1194832  bobing.sqlite-wal      ← 1.1MiB 数据还在 WAL 里
$ docker exec bobing-verify node -e '...backup...'
备份文件: /app/data/backup-1790347732562.sqlite
表: completed_games, expired_rooms, receipts, rooms
房间数: 8
```

主库 4KiB、WAL 1.1MiB 是**正常运行状态**（WAL 模式下事务先写日志），这也正说明「只复制 `bobing.sqlite`」会丢掉几乎所有数据。
备份接口产出的快照是自洽的，关闭备份连接后复制该 `.sqlite` 文件即可。不要把备份文件作为在线数据库继续写入；如已发生写入，应重新使用备份接口生成一致性快照。

若使用 SQLite CLI（`sqlite3` ≥ 3.27，镜像内没有预装）：

```bash
docker compose exec bobing sqlite3 /app/data/bobing.sqlite ".backup '/app/data/backup.sqlite'"
```

### 5.3 停服冷备（简单可靠）

```bash
docker compose stop bobing
docker compose cp bobing:/app/data ./data-backup-$(date +%F)
docker compose start bobing
```

停服并确认进程退出后，复制整个目录即可。运行中依次复制主库、WAL、SHM不能保证一致性，请使用5.2的备份接口。

### 5.4 恢复

```bash
docker compose stop bobing
docker compose run --rm --no-deps --user root --entrypoint sh \
  -v "$PWD/backup.sqlite:/backup.sqlite:ro" bobing \
  -c 'rm -f /app/data/bobing.sqlite-wal /app/data/bobing.sqlite-shm; cp /backup.sqlite /app/data/bobing.sqlite; chown 1000:1000 /app/data/bobing.sqlite'
docker compose start bobing
```

恢复前确认 `backup.sqlite` 是已验证的备份，并保留当前数据备份；此操作会覆盖当前数据库。使用 `docker compose run` 可挂载与正式服务相同的数据卷，避免把 Compose 自动加项目前缀的卷名误写成另一个卷。恢复后打开备份内的房间链接验证原身份和进度；超过24小时有效期的房间仍会过期。

### 5.5 保留策略与自动清理

- **有效期**：等待室从创建起 24 小时；对局进行中只要还有成员在线就不过期（不受创建时间截断）；全员离线立刻暂停并从离线那一刻起算 24 小时，第一位成员重连即取消，重复断开或进程重启都不会顺延；完成、中止、全员离席、回到等待室都从那次状态转换起重新计算 24 小时。过期访问返回「房间已过期」（410）。
- 过期时在**一个事务**里写入本局未完成归档、删除房间详情与成员凭证、投掷回执，并写最小墓碑；事务成功后才清理内存缓存与在线引用，失败不产生内存与数据库分裂，留到下次 tick 重试。仅保留房码与过期时间的最小墓碑 **7 天**，用于区分“已过期”和“不存在”；投掷记录上限每局240条，玩家累计投掷/超时次数单独保存、不受该窗口影响。
- **归档不随房间清理删除**：每局结束（正常结算、房主中止、全员离席、离线过期）都会在 `room_archives` 留一条白名单公共快照（`(房码, 建房时间, 局号)` 为主键，不含凭证）。旧版本的 `completed_games` 在启动时归一化迁入归档并原样保留。
- **数据库升级**：旧库的 `rooms.expires_at` 是 `NOT NULL`，启动时会检测表结构并在事务中重建为可空后拷贝全部旧行，可重复启动（幂等）。旧房间快照缺少的新字段（配置、规则快照、收尾轮次、离线起点、累计次数）由 `server/room-migrations.ts` 归一化补齐：旧固定轮数房间保持原轮数，初始奖池按默认配置，状元不锁定，累计次数从历史重建；新格式快照损坏会明确报错，不会被当作旧数据静默兜底。
- 旧备份仍可能包含备份时尚未过期的数据，备份保留期需要单独设置（例如按天保留7份）。

---

## 6. 升级与回滚

```bash
# 先获取并检查新版本源码；若来自 Git 仓库可使用对应的更新流程
docker compose up -d --build     # 重新构建并替换单实例，期间会短暂断开连接
docker compose logs -f bobing    # 确认启动日志中的监听地址与分享地址
```

- 当前版本在启动时幂等建表，并把旧库的 `rooms.expires_at` 从 `NOT NULL` 迁移为可空（事务内重建表、拷贝旧行，可重复执行）；更早版本的旧房间与旧 `completed_games` 会在启动时归一化后迁入归档。
- 回滚：切回上一个镜像 tag，并**同时**回滚对应时间点的数据备份（新版本可能已写入新字段，旧版本读到不认识的列时行为未定义）。
- 升级前先按 5.2 做一次在线备份。

---

## 7. 健康检查、监控与日志

- 存活探针：`GET /api/health` → `200 {"ok":true}`。容器已内置 `HEALTHCHECK`。
- 启动日志会打印监听地址与分享地址（`分享地址：https://...`），这是确认 `PUBLIC_BASE_URL` 生效最快的方法。
- 进程退出码非 0 通常是端口占用或 `DATA_DIR` 不可写，先看 `docker compose logs`。
- 建议监控：容器重启次数、健康检查失败次数、`/api/health` 响应时间、磁盘剩余空间（SQLite 文件与 WAL 会持续增长，归档清理后回收）。

---

## 8. 安全清单

- [ ] 公网只暴露 443，3001 只监听 127.0.0.1 或容器网络内部。
- [ ] `PUBLIC_BASE_URL` 使用 https 域名，且与实际访问地址一致。
- [ ] 反代设置 `X-Forwarded-For` 且 `TRUST_PROXY=1`；直连公网时 `TRUST_PROXY=0`。
- [ ] 数据卷有备份且**演练过一次恢复**。
- [ ] 确认分享链接形如 `https://域名/room/ABC123`：只有 6 位房码，**没有 token、playerId 等查询参数**。
- [ ] 不要在生产环境长期开启 `npm run dev`（Vite 开发服务器不具备生产性能与安全配置）。

---

## 9. 已知限制

1. **重启恢复**：正常关闭会断开成员并暂停对局，保存剩余时间；启动后所有成员先离线，原身份重连后继续。主代理已实际重启两个独立进程验证记录、奖池和回合保留。若进程异常退出且未写入暂停状态，停机时间可能耗尽已保存的截止时间，恢复后的当前机会可能超时；这不等于每次重启必然丢掉机会。
2. **单实例**：无水平扩容能力，进程重启期间的新建/加入请求会失败（前端会提示网络错误，可重试）。
3. **匿名凭证**：换浏览器、清空站点数据或换设备后无法恢复原身份，会被视为新玩家（房间满或已开局时无法再加入）。
   凭证按房间保存在浏览器本地，不随分享链接传播。
4. **无账号体系**：没有上传头像、好友、聊天与跨房间账号；同一房间的在席玩家不能重名，不同房间可使用相同昵称。
5. **特殊牌型归一**：状元插金花、六杯红、遍地锦等特殊牌型的排序和同分比较采用 [线上统一房规 v1](rules-research.md)，与部分线下玩法不同。
6. **HTTP 轮询兜底**：反向代理未正确转发 `Upgrade` 时会退化为轮询，倒计时与掷骰动画会比正常情况迟钝。
7. **限流是无状态的进程内计数**：重启后清零；多实例场景下不共享（本版本本来也只支持单实例）。
