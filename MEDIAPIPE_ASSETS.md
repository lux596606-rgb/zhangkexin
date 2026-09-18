# MediaPipe 运行时资源（`public/mediapipe/`）

这里的文件与网站**同源**分发，运行时**不依赖任何第三方 CDN**（验收要求：页面不得有外网请求）。

```
public/mediapipe/
├── gesture_recognizer.task                 7.99 MB  手势识别模型（float16, v1）
├── LICENSE.txt                            12.3 KB   Apache License 2.0 全文（必须随产物分发）
└── wasm/
    ├── vision_wasm_internal.js           315.8 KB   实际使用的 wasm 加载器
    └── vision_wasm_internal.wasm          11.21 MB  实际使用的 wasm 二进制（SIMD 版）
```

合计约 19.5 MB，其中 MediaPipe 部分（wasm + 模型）19.5 MB，是产物的绝大部分体积；
`dist/` 全量见 `DEPLOY.md` 的体积对照表。

## 保留了哪些 wasm 变体、为什么

上游 `@mediapipe/tasks-vision@1.0.1` 的 `wasm/` 目录里一共有 **3 组**变体：

| 变体 | 上游大小 | 是否分发 | 原因 |
| --- | --- | --- | --- |
| `vision_wasm_internal.js` + `.wasm` | 315.8 KB + 11.21 MB | ✅ **保留** | 浏览器实测真正请求的就是这一组 |
| `vision_wasm_module_internal.js` + `.wasm` | 315.8 KB + 11.21 MB | ❌ **已删除** | 本项目调用方式**永远不会**产出这个文件名（见下方源码依据） |
| `vision_wasm_nosimd_internal.js` + `.wasm` | 315.6 KB + 10.45 MB | ❌ **已删除（有意取舍）** | 仅在浏览器不支持 WASM SIMD 时才会用到；目标平台不需要，见「取舍」 |

删除两组共减少 **22.28 MB（23,363,809 字节）**。

### 源码依据：MediaPipe 到底会拼出哪几个文件名

出处：`node_modules/@mediapipe/tasks-vision/vision_bundle.mjs.map` 的 `sourcesContent[0]`
（即 `vision_bundle.mjs` / `vision_bundle.js` / `vision_bundle.cjs` 三个 bundle 共用的去混淆源码，
三份文件的对应逻辑完全一致）。关键片段：

```js
// 1) SIMD 能力探测：用一个只含 SIMD 指令的小 wasm 模块试实例化
var jj,
  kj = new Uint8Array([0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,10,1,8,0,65,0,253,15,253,98,11]);
async function lj(a) {                       // isSimdSupported(useModule)
  if (a) return !0;                          // ← useModule 为真时直接当成「支持」
  if (jj === void 0) try { await WebAssembly.instantiate(kj), jj = !0 } catch { jj = !1 }
  return jj
}

// 2) 拼文件名
async function mj(a, b, c) {                 // (任务前缀, basePath, useModule)
  var d = await lj(c) ? "" : "_nosimd";
  c = `wasm${c ? "_module" : ""}${d}_internal`;
  return { wasmLoaderPath: `${b}/${a}_${c}.js`, wasmBinaryPath: `${b}/${a}_${c}.wasm` }
}

// 3) 公开入口
nj.forVisionTasks = function (a, b = !1) { return mj("vision", a ?? eh``, b) };
nj.isSimdSupported = function (a = !1) { return lj(a) };
```

对应的压缩产物（可直接在 `vision_bundle.mjs` 里检索到）：

```js
async function sh(t){if(t)return!0;if(void 0===nh)try{await WebAssembly.instantiate(ih),nh=!0}catch{nh=!1}return nh}
async function oh(t,e,r){return{wasmLoaderPath:`${e}/${t}_${r=`wasm${r?"_module":""}${await sh(r)?"":"_nosimd"}_internal`}.js`,wasmBinaryPath:`${e}/${t}_${r}.wasm`}}
ah.forVisionTasks=function(t,e=!1){return oh("vision",t??Xs``,e)}
```

结论（三段拼装逻辑）：

1. 第二参数是 `useModule`，默认 `false`。**只有显式传 `true` 才会拼出 `_module` 后缀**。
   本项目唯一的调用点是 `src/components/GestureController.tsx:100`：
   `await FilesetResolver.forVisionTasks(WASM_PATH)` —— 只传了 1 个参数，
   所以 `useModule === false`，`vision_wasm_module_internal.*` **在本项目里不可达**，删它不影响任何路径。
   同时 `vision_bundle.mjs` 的 `_module` 分支里 `lj(true)` 恒为 `true`，也说明 module 版**不存在** nosimd 组合，
   即 module 组与 nosimd 组互斥，不可能被同一个调用同时需要。
2. `useModule === false` 时执行真实 SIMD 探测，文件名落在
   `vision_wasm_internal`（支持 SIMD）或 `vision_wasm_nosimd_internal`（不支持 SIMD）二者之一。
3. 文件名由 `${basePath}/${prefix}_${suffix}.js` 与 `.wasm` 直接拼接，没有其它隐藏分支。

浏览器抓包复核（改动前，`node tools/networkCheck.mjs http://127.0.0.1:5180/`）：

```
实际请求的 wasm 变体:
  /mediapipe/wasm/vision_wasm_internal.js
  /mediapipe/wasm/vision_wasm_internal.wasm
```

三组变体只请求了一组，与源码结论一致。

### 取舍：为什么连 `nosimd` 回退也删掉

- 需求文档 §6 / §9.3 的目标平台是 **Windows / macOS 上的 Chrome、Edge、Safari 近期版本**，
  这些版本（Chrome/Edge 91+、Safari 16.4+）都支持 WASM SIMD，`nosimd` 分支不会被走到。
- 需求 §3.1 / §9.2.3 明确要求「摄像头不可用或不想授权时，键盘和鼠标仍然可以独立完成整段祝福」，
  所以即使出现不支持 SIMD 的极老浏览器，手势不可用也只是**降级**：页面照常打开，
  键盘 `1/2/3/4`、空格、`R` 与四个鼠标入口都能走完全部四种样式。
- 代价：极老浏览器下 `FilesetResolver` 会去取 `vision_wasm_nosimd_internal.js` 得到 404，
  手势状态回落为「不可用」并显示降级提示（`GestureController` 的 `catch` 分支），**不会白屏、不会崩**。
- 收益：少传 10.76 MB，产物从 43.07 MB 降到 20.79 MB。

**如果需要恢复 `nosimd` 回退**：从 npm 包原样拷回两个文件再重新构建即可，无需改任何代码：

```powershell
Copy-Item node_modules\@mediapipe\tasks-vision\wasm\vision_wasm_nosimd_internal.* public\mediapipe\wasm\
npm run build
```

## 上游来源与许可

- 上游项目：[google-ai-edge/mediapipe](https://github.com/google-ai-edge/mediapipe)
- npm 包：`@mediapipe/tasks-vision@1.0.1`，`wasm/` 下的文件即为该包 `wasm/` 目录的原样拷贝
  （本地对照路径：`node_modules/@mediapipe/tasks-vision/wasm/`）。
- 模型 `gesture_recognizer.task`：官方 MediaPipe 模型库的 Gesture Recognizer float16 / version 1，
  SHA-256 `97952348CF6A6A4915C2EA1496B4B37EBABC50CBBF80571435643C455F2B0482`。
- 许可：MediaPipe 及其官方示例采用 **Apache License 2.0**，全文见 `public/mediapipe/LICENSE.txt`，
  该文件会随构建产物一同分发到 `dist/mediapipe/LICENSE.txt`，**不得删除或修改**。

## 维护提示

- 升级 `@mediapipe/tasks-vision` 后必须重新做一次三件事：
  1. 从新版本的 `wasm/` 目录重新拷贝**全部**变体；
  2. 按上面的方法重新确认「哪些变体真的会被请求」；
  3. 再按需删掉不可达/不使用的变体，并同步更新本文件。
- 校验产物是否完整（含 wasm、模型、LICENSE、无外网字体引用）：`npm run check:dist`。
