# 部署说明（DEPLOY.md）

本文面向**不需要懂运维**的读者，照着从上往下做即可。全部内容对应需求文档 §9.3：
「通过朋友的服务器提供在线网址 / 服务器必须配置 HTTPS / 只支持 Windows、macOS 电脑 / 重点是运行流畅」。

---

## 0. 先把结论说清楚（三件事）

| 事项 | 结论 |
| --- | --- |
| 需要什么 | 一台能放静态文件的服务器 + 一个域名 + **HTTPS 证书**（免费即可） |
| 上传什么 | **`dist/` 目录里的内容**（不是 `dist` 这个目录本身）→ 传到网站根目录或子目录 |
| 为什么要 HTTPS | **硬依赖**：浏览器只在「安全上下文」下才给摄像头。用 `http://` 打开，点「开启星光」拿不到摄像头，手势功能直接不可用 |

构建产物体积（`npm run build` 之后）：

```
dist/   共 11 个文件，20.79 MB
├── index.html                                  0.6 KB
├── favicon.svg                                9.5 KB
├── assets/                                        （带内容哈希，可长期缓存）
│   ├── index-<hash>.js                       429.5 KB
│   ├── index-<hash>.css                       19.6 KB
│   ├── manrope-latin-var-<hash>.woff2         24.8 KB
│   ├── dm-mono-latin-400-<hash>.woff2         14.8 KB
│   └── pink-pig-reference-<hash>.png         831.9 KB
└── mediapipe/                                    （文件名没有哈希，更新时注意缓存）
    ├── gesture_recognizer.task                 7.99 MB
    ├── LICENSE.txt                            12.3 KB   ← 必须一起上传，不要删
    └── wasm/
        ├── vision_wasm_internal.js           315.8 KB
        └── vision_wasm_internal.wasm          11.21 MB
```

> 页面**不依赖任何外网资源**：字体已自托管在 `assets/`，MediaPipe 的 wasm 与模型都在 `mediapipe/`。
> 也就是说，只要上面这些文件传上去了，网站就能独立运行，不需要额外的 CDN 或第三方接口。

---

## 1. 前置条件

在开始之前确认四件事：

1. **一台服务器**，能放静态文件即可（Nginx / Apache / 面板自带的网站功能都行），并且能 SSH 或通过面板文件管理器上传文件。
2. **一个域名**，并把解析指向服务器 IP。
   - 在域名服务商处添加一条 **A 记录**：主机记录填 `birthday`（或 `@`），记录值填服务器公网 IP。
   - 解析生效后，用 `ping birthday.你的域名` 应该能 ping 到服务器 IP。
   - ⚠️ **如果服务器在中国大陆**：域名必须先完成 **ICP 备案**，否则 80/443 端口会被拦截，证书也申请不下来。没有备案的话，用香港/境外服务器即可（这个网站在境外服务器上访问速度也够用）。
3. **服务器防火墙 / 云安全组放行 80 和 443 端口**。
   - 80 端口是申请证书时校验用的，**申请证书期间必须能访问**，之后可以只保留 443。
4. **一个 HTTPS 证书**。不需要花钱，用 Let's Encrypt 免费证书即可，见第 3 节。

### 为什么必须 HTTPS（不是「最好有」，是「必须有」）

浏览器的摄像头 API（`navigator.mediaDevices.getUserMedia`）只在**安全上下文**（Secure Context）中可用，也就是：

- `https://` 打开的页面 ✅
- `http://localhost` / `http://127.0.0.1`（本机调试）✅
- **`http://` 打开的公网页面 ❌**

如果直接用 `http://域名/` 访问，点「开启星光」时**不会弹出摄像头授权框**，页面会落到「摄像头不可用」的降级提示。
这不是代码 bug，是浏览器的安全策略，配置好 HTTPS 就正常了。
（好消息：即使摄像头不可用，键盘 `1/2/3/4`、空格、`R` 与四个鼠标入口都能走完整段祝福 —— 见第 6 节自检清单最后一条。）

---

## 2. 上传哪些文件

### 2.1 先本地构建

在项目目录执行：

```bash
npm ci            # 第一次部署时执行，安装依赖
npm run build     # 产出 dist/
npm run check:dist   # 可选但推荐：检查产物是否完整（11 项全 PASS 才算 OK）
```

### 2.2 上传 `dist/` 里的**内容**

**关键点：上传的是 `dist/` 里面的东西，不要把 `dist` 这一层目录本身也传上去。**

❌ 错误（多了一层 `dist/`，网址会变成 `https://域名/dist/`）：

```
网站目录/dist/index.html
网站目录/dist/assets/...
```

✅ 正确（`index.html` 直接位于网站目录下）：

```
网站目录/index.html
网站目录/favicon.svg
网站目录/assets/index-<hash>.js
网站目录/assets/index-<hash>.css
网站目录/assets/manrope-latin-var-<hash>.woff2
网站目录/assets/dm-mono-latin-400-<hash>.woff2
网站目录/assets/pink-pig-reference-<hash>.png
网站目录/mediapipe/gesture_recognizer.task
网站目录/mediapipe/LICENSE.txt
网站目录/mediapipe/wasm/vision_wasm_internal.js
网站目录/mediapipe/wasm/vision_wasm_internal.wasm
```

**目录层级必须保持原样**：`assets/`、`mediapipe/` 必须和 `index.html` 在同一层。改名或调整层级会导致 404 / 白屏。

### 2.3 部署在根路径 vs 子路径

| 目标网址 | 上传位置 |
| --- | --- |
| `https://域名/` | 直接传到网站根目录 |
| `https://域名/kexin/` | 在网站根目录下新建 `kexin/`，把内容传进去（最后是 `网站根目录/kexin/index.html`） |

**两种方式都不需要改任何代码或重新构建。** 产物里所有资源的引用都是相对路径（`./assets/...`、`./mediapipe/...`），会跟着页面所在的地址自动解析，所以放在哪一层都能正常加载。
（本次已经实测：把同一份产物分别挂在根路径 `/` 和子路径 `/sub/` 下，页面渲染、资源状态码、摄像头与手势识别全部通过，见项目验收记录。）

子路径访问时记得**带上结尾的斜杠**：`https://域名/kexin/`（nginx 一般会自动补上，不带斜杠也可能被 301 跳转过去）。

### 2.4 上传方式（任选一种）

- **面板文件管理器**：把 `dist` 目录里的文件全选 → 上传到目标目录（宝塔、aaPanel 等都有这个功能）。
- **SSH / scp**（在本地项目目录执行）：

  ```bash
  # 根路径部署
  scp -r dist/* user@服务器IP:/var/www/birthday/

  # 子路径部署
  ssh user@服务器IP "mkdir -p /var/www/birthday/kexin"
  scp -r dist/* user@服务器IP:/var/www/birthday/kexin/
  ```

- **rsync**（更新时更好用，只传变化的文件）：

  ```bash
  rsync -av --delete dist/ user@服务器IP:/var/www/birthday/
  ```

上传后确认 nginx 用户能读到这些文件：

```bash
sudo chown -R www-data:www-data /var/www/birthday     # CentOS 上是 nginx:nginx
sudo find /var/www/birthday -type d -exec chmod 755 {} \;
sudo find /var/www/birthday -type f -exec chmod 644 {} \;
```

---

## 3. HTTPS 证书怎么来

### 路线 ①：用面板一键申请（推荐给不想碰命令行的人）

以**宝塔面板**为例（其他面板类似）：

1. 面板 → **网站** → 添加站点，域名填 `birthday.你的域名`，根目录设为第 2 节里放文件的目录（例如 `/var/www/birthday`）。
2. 进入该站点 → **设置** → **SSL** → 选 **Let's Encrypt**。
3. 勾选域名 → 点 **申请**。等待十几秒，显示「已部署」即成功。
4. 打开 **强制 HTTPS** 开关（相当于把 `http://` 的访问 301 跳到 `https://`）。
5. 顺手勾选/确认 **自动续期**（Let's Encrypt 证书 90 天有效，面板会自动续）。

> 申请前请再确认一次：域名已解析到这台服务器，且 80 端口能从公网访问。Let's Encrypt 需要通过 80 端口验证域名归属。

### 路线 ②：Nginx + certbot 命令行

适用于自己管服务器、没有面板的情况（以 Debian / Ubuntu 为例）：

```bash
sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx

# 先让 nginx 能提供 HTTP 服务（站点目录按第 2 节放置）
sudo nano /etc/nginx/sites-available/birthday
sudo ln -s /etc/nginx/sites-available/birthday /etc/nginx/sites-enabled/birthday
sudo nginx -t && sudo systemctl reload nginx

# 一条命令申请证书并自动改写上面的 nginx 配置（自动加 443 监听 + http→https 跳转）
sudo certbot --nginx -d birthday.你的域名
```

certbot 会自动完成：申请证书、写入 `ssl_certificate` 配置、加上 80→443 跳转、安装自动续期定时任务。

验证续期是否正常：

```bash
sudo certbot renew --dry-run
```

### 可直接抄的 Nginx 配置片段

下面是**根路径部署**的完整配置（`/etc/nginx/sites-available/birthday`）。
`certbot --nginx` 运行后会自动补上 SSL 相关行，你也可以直接用下面这份（把域名和证书路径换成自己的）：

```nginx
# ---------- HTTP：只用来跳转到 HTTPS ----------
server {
    listen 80;
    listen [::]:80;
    server_name birthday.你的域名;

    # 让 Let's Encrypt 的 HTTP-01 校验能通过（certbot 会自动加，留着无害）
    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    # 其余一律跳 HTTPS：摄像头只在安全上下文可用，http 进来必须跳走
    location / {
        return 301 https://$host$request_uri;
    }
}

# ---------- HTTPS：真正的站点 ----------
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;                       # nginx < 1.25.1 请改成：listen 443 ssl http2;

    server_name birthday.你的域名;

    ssl_certificate     /etc/letsencrypt/live/birthday.你的域名/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/birthday.你的域名/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_session_cache   shared:SSL:10m;
    ssl_session_timeout 1h;

    # 第 2 节里上传的内容放在这里，index.html 直接位于该目录下
    root  /var/www/birthday;
    index index.html;

    # ---------- gzip 压缩（wasm 与模型压缩收益很大）----------
    gzip              on;
    gzip_vary         on;
    gzip_comp_level   5;
    gzip_min_length   1024;
    gzip_proxied      any;
    gzip_types
        text/plain text/css text/xml
        application/javascript application/json application/xml
        image/svg+xml
        application/wasm                 # ← 关键：不加这行 wasm 不会被压缩
        application/octet-stream;        # 覆盖 gesture_recognizer.task

    # ---------- 关键：.wasm 的 MIME 类型必须是 application/wasm ----------
    # 不设置的话 nginx 会回 application/octet-stream，MediaPipe 的
    # WebAssembly.instantiateStreaming 会失败并退回内存编译（控制台报错、加载更慢）。
    location ~* \.wasm$ {
        default_type application/wasm;
        add_header Cache-Control "public, max-age=604800";
        try_files $uri =404;
    }

    # ---------- 缓存策略（详见第 5 节）----------
    location /assets/ {
        # 文件名带内容哈希，内容一变文件名就变，可以放心长缓存
        add_header Cache-Control "public, max-age=31536000, immutable";
        try_files $uri =404;
    }

    location /mediapipe/ {
        # 文件名没有哈希，缓存短一点，方便将来替换 MediaPipe 版本
        add_header Cache-Control "public, max-age=604800";
        try_files $uri =404;
    }

    location = /index.html {
        # 入口文件绝不长缓存，否则更新后用户拿到的还是旧版本
        add_header Cache-Control "no-cache, must-revalidate";
        expires -1;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

改完执行 `sudo nginx -t` 检查语法，再 `sudo systemctl reload nginx`。

> **如果站点是子路径**（例如 `https://域名/kexin/`）：把上面 `root /var/www/birthday;` 换成
> `root /var/www;`，并把内容放到 `/var/www/kexin/` 即可，其它都不用改。产物本身已经兼容子路径。

> **如果你在面板里编辑站点配置**：面板生成的配置已经包含了 `include mime.types;`，
> 请**不要**在 `server { }` 里再写一个 `types { ... }` 块 —— nginx 在 server 层的 `types` 会**替换**继承来的类型表，
> 可能把 `.css` / `.js` 的 MIME 一起弄坏。用上面 `location ~* \.wasm$ { default_type application/wasm; }` 这种写法最安全。

---

## 4. 部署后自检清单

按顺序走一遍，全部打勾才算部署成功。建议用 **Chrome 或 Edge** 打开，按 `F12` 打开开发者工具。

- [ ] **1. 页面能打开**：`https://域名/`（或 `https://域名/kexin/`）能打开，标题是「张珂欣 · 生日星图」，能看到落地页大字和「开启星光」按钮，**不是白屏**。
- [ ] **2. 地址栏有锁形图标**：点一下能看到证书有效、域名匹配。若显示「不安全」，HTTPS 没配好，先回到第 3 节。
- [ ] **3. 字体正常、没有外网请求**：打开 `F12` → **Network** 面板 → 刷新页面 → 过滤 `fonts`。
      字体应当来自 `你的域名/assets/...woff2`；**不应该出现 `fonts.googleapis.com` 或 `fonts.gstatic.com`**。
      Console 里不应有红色报错（MediaPipe 打印的那几行 `W0918...` 是它自己的信息日志，可以忽略）。
- [ ] **4. 点「开启星光」弹出摄像头授权**：浏览器左上角弹出「是否允许使用摄像头」。**如果没有弹窗、直接提示不可用，说明当前不是 HTTPS**。
- [ ] **5. 授权后手势状态变成「未识别到手势」**：页面右上角的手势状态先显示「手势识别加载中」，随后变成 **「未识别到手势」**（把手放进画面就会开始识别）。
      如果一直停在 **「手势识别不可用 · 可用键盘或鼠标」**，去 Network 面板确认这两个请求都是 **200**：
      `mediapipe/wasm/vision_wasm_internal.wasm`、`mediapipe/gesture_recognizer.task`。
- [ ] **6. 四个样式都能切换**：按键盘 **`1` / `2` / `3` / `4`**，依次看到「银河态 / 生日快乐 / 猪头卡通 / 祝福收束」；也可以鼠标点页面下方的四个入口。
- [ ] **7. 键盘辅助键可用**：空格暂停/恢复动画，`R` 回到银河态。
- [ ] **8. 手势识别真的生效**：对着摄像头分别做「张开手掌 / 拇指食指捏合 / 握拳 / 竖起大拇指」，四个样式会跟着切换（每个手势需要保持约 0.7 秒）。
- [ ] **9. 运行流畅**：右上角会显示画质档位与实时帧率（例如 `HIGH · 108 FPS`）；页面长时间开着不卡、不闪退。
- [ ] **10. 无摄像头也能走完**：在浏览器设置里拒绝摄像头权限后刷新，页面顶部应给出「摄像头未开启 · …」的友好提示条，且**键盘和鼠标仍能完整切换四个样式**（需求 §3.1 的降级路径）。
- [ ] **11.（可选）** 换一台电脑或换 Chrome / Edge / Safari 各试一次，确认表现一致。

---

## 5. 缓存建议

原则只有两条：

| 目录 / 文件 | 是否带内容哈希 | 建议缓存 | 原因 |
| --- | --- | --- | --- |
| `assets/**` | ✅ 带哈希（`index-BoxuNEwy.js`） | **1 年 + immutable** | 内容一变文件名就变，不可能拿到旧内容 |
| `index.html` | ❌ | **不缓存**（`no-cache`） | 它是入口，缓存住就永远发现不了新版本 |
| `mediapipe/**` | ❌ | **7 天** | 文件大、不常变；但文件名固定，缓存太长将来换版本会拿到旧的 |
| `favicon.svg` | ❌ | 1 天 | 无所谓 |

对应的 nginx 片段（已包含在第 3 节的完整配置里）：

```nginx
location /assets/ {
    add_header Cache-Control "public, max-age=31536000, immutable";
    try_files $uri =404;
}

location /mediapipe/ {
    add_header Cache-Control "public, max-age=604800";
    try_files $uri =404;
}

location = /index.html {
    add_header Cache-Control "no-cache, must-revalidate";
    expires -1;
}
```

> 只有 `index.html` 不缓存是不够的 —— 页面里的 JS/CSS 引用带着哈希，`index.html` 一更新，浏览器自然会去取新的哈希文件。
> 所以**千万不要**把 `index.html` 也设成长缓存。

---

## 6. 更新流程（重新构建并覆盖上线）

```bash
# 1) 本地改完代码后，先跑门禁
npm run lint
npm test
npm run build
npm run check:dist        # 产物完整性 11 项检查

# 2) 覆盖上传（rsync 会自动删掉旧哈希文件，最省心）
rsync -av --delete dist/ user@服务器IP:/var/www/birthday/
#    子路径部署就换成：rsync -av --delete dist/ user@服务器IP:/var/www/birthday/kexin/
```

用面板的话：先把旧目录改名备份（例如 `birthday_20251011`），再把新的 `dist` 内容传上去，确认没问题后再删备份。

更新后：

- `index.html` 已设为不缓存，用户**刷新一次**（或强刷 `Ctrl+F5`）就能拿到新版本。
- 如果这次更新**替换了 `mediapipe/` 下的文件**（例如升级 MediaPipe），因为文件名没变，用户浏览器可能还在用 7 天的旧缓存 —— 让用户强刷一次，或者临时把 `location /mediapipe/` 的 `max-age` 调成 0，一天后再调回来。
- 不需要重启 nginx（静态文件直接生效）；如果改了 nginx 配置，记得 `sudo nginx -t && sudo systemctl reload nginx`。

---

## 7. 常见问题

**Q：页面白屏，Console 里一堆 404。**
A：多半是上传层级错了。确认 `index.html` 就在网站目录（或子目录）下，且 `assets/`、`mediapipe/` 与它同级。用 `npm run check:dist` 在本地核对产物结构。

**Q：页面能打开，但点「开启星光」没有任何反应、也不弹授权框。**
A：九成是没走 HTTPS。看地址栏是不是 `https://`，锁形图标是否正常。

**Q：摄像头授权成功，但手势状态一直是「手势识别不可用 · 可用键盘或鼠标」。**
A：去 Network 面板看 `mediapipe/wasm/vision_wasm_internal.wasm` 和 `mediapipe/gesture_recognizer.task` 的状态码。
- 404 → 文件没传全，或目录层级不对；
- 200 但仍不可用 → 看 Console 报错。若提示 wasm 编译失败，检查 `.wasm` 的响应头 `Content-Type` 是否为 `application/wasm`（第 3 节的 `location ~* \.wasm$` 片段）。

**Q：要不要配 COOP / COEP 之类的跨域头？**
A：不需要。所有资源（含 wasm 与模型）都与页面同源，实测在同源、无任何额外响应头的环境下工作正常。唯一的硬性要求就是 `.wasm` 的 MIME 类型。

**Q：需要装 Node.js 到服务器上吗？**
A：不需要。`dist/` 是纯静态文件，服务器只要能把文件按原样发出去就行，Node 只在本地构建时用。

**Q：手机上能看吗？**
A：首版只针对 Windows / macOS 电脑（需求 §9.3.3）。手机浏览器可能布局错乱或无法使用摄像头，属于已知范围。

---

## 8. 另一条路：GitHub Pages（已配好，推送即上线）

> 这条路**不需要服务器、不需要域名、不需要自己申请证书**，而且天生就是 HTTPS（摄像头能直接授权）。
> 如果只是想先有个能打开、能发给别人看的网址，用这条最省事；第 1~7 节是「放到朋友服务器上」的做法，两者可以并存。

| 事项 | 说明 |
| --- | --- |
| 线上地址 | <https://lux596606-rgb.github.io/zhangkexin/> |
| 仓库地址 | <https://github.com/lux596606-rgb/zhangkexin> |
| 发布方式 | 推送到 `main` → GitHub Actions 自动 `npm ci` / `npm run build` / `npm run check:dist` → 发布 `dist/` |
| 工作流文件 | `.github/workflows/deploy-pages.yml` |
| 查看构建 | 仓库 **Actions** 页 → 左侧「部署到 GitHub Pages」 |

### 8.1 为什么不能直接把分支根目录当站点（白屏的真正原因）

仓库根目录的 `index.html` 是 **Vite 的开发入口**，第 13 行是：

```html
<script type="module" src="/src/main.tsx"></script>
```

把分支根目录直接当站点发布时，浏览器会去请求 `/src/main.tsx`：线上没有这个文件 → **404 → 白屏**。
（DevTools 的 Network 里就是一条 `main.tsx 404`，`Initiator` 指向 `index.html` 第 13 行。）

真正能跑的是 `npm run build` 产出的 `dist/`，所以发布源**必须**是 GitHub Actions：

> 仓库 **Settings → Pages → Build and deployment → Source** 选 **`GitHub Actions`**（一个下拉框）。
> 这个设置只能用管理员的网页改：工作流里的 `GITHUB_TOKEN` 调用 `PUT /repos/{owner}/{repo}/pages` 会返回
> `403 Resource not accessible by integration`，所以自动切换做不到，必须手点一次。

### 8.2 日常更新（改完代码怎么上线）

```bash
git add -A
git commit -m "这次改了什么"
git push                 # 推上去即自动重新构建并发布，通常 1~2 分钟
```

- **手动重跑**：Actions → 选中「部署到 GitHub Pages」→ **Re-run all jobs**（工作流也支持 `workflow_dispatch`）。
- **缓存**：`index.html` 在 Pages CDN 上约 10 分钟缓存；页面里的 JS/CSS 带内容哈希，更新时文件名会变，不受影响。刚发完版看不到变化，先 Ctrl+Shift+R 强刷。
- **绑自己的域名**：Settings → Pages → Custom domain 填域名，再去域名服务商加一条 CNAME 指向 `lux596606-rgb.github.io`。
- **产物不会进仓库**：`dist/` 在 `.gitignore` 里，Pages 用的是 Actions 上传的构建产物（artifact），不会让仓库体积膨胀。
