// Quark UC TV 扫码登录辅助路由（补全上游只支持 refresh_token 缺失的扫码获取流程）
//
// 流程：
//   1) POST /create        -> { qr_data(PNG base64), query_token, device_id, variant }
//   2) POST /check         -> { status: "pending" | "done", code? }  轮询直至 done
//   3) POST /token         -> { status: "ok", access_token, refresh_token }
//   4) GET  /              -> 内置扫码页（引用同源 /qr.js，符合 CSP script-src 'self'）
//   5) GET  /qr.js         -> 扫码页前端脚本
//
// 说明：qr_data 由夸克服务端直接返回已渲染好的二维码 PNG(base64)，前端直接展示即可，
// 无需引入二维码生成库。device_id 在 authorize/code/token 三步必须保持一致。
import { Hono } from "hono"
import { md5 } from "../pkg/crypto"
import { ClientQuarkUcTv } from "../drivers/quark_uc_tv/util"
import type { DriverQuarkUcTvAddition } from "../drivers/quark_uc_tv/types"

export const quarkTvQrRouter = new Hono()

// 根路径挂载时需自行补充安全响应头（/api 子路由那层 CSP 不会生效到这里）
quarkTvQrRouter.use("*", async (c, next) => {
  await next()
  c.header(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
  )
  c.header("X-Frame-Options", "DENY")
  c.header("X-Content-Type-Options", "nosniff")
  c.header("Referrer-Policy", "no-referrer")
})

function makeClient(variant: string, deviceId: string): ClientQuarkUcTv {
  const addition: DriverQuarkUcTvAddition = {
    refresh_token: "",
    variant: variant === "uc" ? "uc" : "quark",
    device_id: deviceId,
  }
  return new ClientQuarkUcTv(addition)
}

quarkTvQrRouter.post("/create", async (c) => {
  const body = await c.req.json().catch(() => ({ variant: "quark" }))
  const variant = body.variant === "uc" ? "uc" : "quark"
  const deviceId = md5(String(Date.now()))
  const client = makeClient(variant, deviceId)
  const { qrData, queryToken } = await client.getLoginCode()
  return c.json({
    qr_data: qrData,
    query_token: queryToken,
    device_id: deviceId,
    variant,
  })
})

quarkTvQrRouter.post("/check", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const { variant, device_id, query_token } = body
  if (!query_token || !device_id) {
    return c.json(
      { status: "error", message: "query_token and device_id required" },
      400,
    )
  }
  const client = makeClient(variant, device_id)
  const code = await client.getCode(query_token)
  if (code) return c.json({ status: "done", code })
  return c.json({ status: "pending" })
})

quarkTvQrRouter.post("/token", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const { variant, device_id, code } = body
  if (!code || !device_id) {
    return c.json(
      { status: "error", message: "code and device_id required" },
      400,
    )
  }
  const client = makeClient(variant, device_id)
  const tokens = await client.getRefreshTokenByCode(code)
  return c.json({ status: "ok", ...tokens })
})

// 内置扫码页
quarkTvQrRouter.get("/", async (c) => {
  return c.body(HTML_PAGE, 200, {
    "Content-Type": "text/html; charset=utf-8",
  })
})

quarkTvQrRouter.get("/qr.js", async (c) => {
  return c.body(JS_CODE, 200, {
    "Content-Type": "application/javascript; charset=utf-8",
  })
})

const HTML_PAGE = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>夸克/UC TV 扫码登录</title>
<style>
  body{font-family:-apple-system,system-ui,sans-serif;max-width:480px;margin:48px auto;padding:0 16px;color:#222}
  h2{font-size:18px}
  select,button{padding:8px 14px;font-size:14px;border-radius:6px;border:1px solid #ccc;background:#fff}
  button{cursor:pointer;background:#1677ff;color:#fff;border-color:#1677ff}
  #qr{margin:16px 0;max-width:240px;display:none}
  #status{color:#666;min-height:20px;margin:12px 0}
  textarea{width:100%;height:90px;margin-top:8px;font-family:monospace;font-size:13px;padding:8px}
  .hint{font-size:12px;color:#999}
</style>
</head>
<body>
  <h2>夸克 / UC TV 扫码获取令牌</h2>
  <div>
    <label>类型：
      <select id="variant">
        <option value="quark">夸克</option>
        <option value="uc">UC</option>
      </select>
    </label>
    <button id="btn">获取二维码</button>
  </div>
  <div id="status"></div>
  <img id="qr" alt="请使用夸克/UC TV App 扫码">
  <p class="hint">扫码成功后将自动换取 refresh_token：</p>
  <textarea id="rt" readonly placeholder="扫码后自动填入"></textarea>
  <script src="qr.js"></script>
</body>
</html>`

const JS_CODE = `(function(){
  var state = { done: false };
  function el(id){ return document.getElementById(id); }
  function post(path, body){
    return fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }).then(function(r){ return r.json(); });
  }
  function showStatus(msg){ el("status").textContent = msg; }
  function start(){
    state.done = false;
    var variant = el("variant").value;
    showStatus("正在获取二维码...");
    post("create", { variant: variant }).then(function(res){
      if(res.qr_data){
        el("qr").src = "data:image/png;base64," + res.qr_data;
        el("qr").style.display = "block";
        state.query_token = res.query_token;
        state.device_id = res.device_id;
        state.variant = variant;
        showStatus("请用夸克 / UC TV App 扫描上方二维码...");
        poll();
      } else {
        showStatus("获取失败：" + JSON.stringify(res));
      }
    }).catch(function(e){ showStatus("请求出错：" + e); });
  }
  function poll(){
    if(state.done) return;
    post("check", {
      variant: state.variant,
      device_id: state.device_id,
      query_token: state.query_token
    }).then(function(res){
      if(res.status === "done"){
        state.done = true;
        showStatus("扫码成功，正在换取令牌...");
        post("token", {
          variant: state.variant,
          device_id: state.device_id,
          code: res.code
        }).then(function(t){
          if(t.refresh_token){
            el("rt").value = t.refresh_token;
            showStatus("完成！请复制 refresh_token 填到 OpenList 的 Quark UC TV 配置。");
          } else {
            showStatus("获取令牌失败：" + JSON.stringify(t));
          }
        }).catch(function(e){ showStatus("换取令牌出错：" + e); });
      } else {
        setTimeout(poll, 2000);
      }
    }).catch(function(e){ showStatus("轮询出错：" + e); });
  }
  window.addEventListener("DOMContentLoaded", function(){
    el("btn").addEventListener("click", start);
  });
})();`
