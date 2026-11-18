# Qoder 共享额度自动领取工具

自动监控 https://id.ustc.edu.cn/tokenworks/credits/ 的额度用量,当总额度用到 90%(服务端判定)、任务按钮变为可领时,自动调用领取接口,无需手动点击。

## 使用

1. 双击 `1-设置账号.bat`,输入学工号和统一身份认证密码(密码经 Windows DPAPI 加密保存,仅本机当前用户可解密,不会明文落盘)。
2. 双击 `2-启动监控.bat`。首次会弹出一个 Edge 窗口自动登录,登录后窗口自动最小化,之后保持后台运行即可。
3. 双击 `3-查看统计.bat` 打开统计页(也可随时直接双击 `stats.html`):用量曲线、90% 门槛线、领取记录、失败原因,每 30 秒自动刷新。
4. 想停止:关闭监控的黑色命令行窗口。Edge 窗口可以随意关闭,bot 需要续期会话时会自动重开。

## 工作原理

- **浏览器只负责登录**:用独立 profile 的 Edge(不影响你日常浏览器)通过 CDP 协议自动填写 CAS 登录表单。若学校风控弹出验证码/二次认证,窗口会保持可见并等你手动完成一次(日志会提示)。
- **监控和领取走纯 HTTP API**:登录后提取 Cookie,直接轮询页面 HTML 解析用量,直接 POST `/tokenworks/credits/api/claim` 领取。不依赖 DOM 点击,页面是否刷新都不影响。
- **会话过期自动重登**:Cookie 失效时自动唤起浏览器重新登录、刷新 Cookie,循环继续。
- 领取失败按原因智能冷却(如「今日已签到」等到明天,「服务暂不可用」2 分钟后重试),不会盲目重试。

## 配置(config.json)

首次运行 `1-设置账号.bat` 会自动从 `config.example.json` 生成 `config.json`。

| 字段 | 默认 | 说明 |
|---|---|---|
| `pollIntervalSec` | 30 | 轮询间隔(秒) |
| `headless` | false | true=无窗口模式(触发验证码时无法手动处理,不建议) |
| `debugPort` | 9333 | Edge 调试端口(也用于防止重复启动) |
| `edgePath` | Edge 默认安装路径 | Edge 可执行文件位置 |

## 文件说明

- `bot.js` 主程序 / `cdp.js` 浏览器控制 / `secret.js` DPAPI 加解密 / `setup.ps1` 账号录入(PowerShell 原生交互)
- `stats.js` + `dashboard.html` 统计模块:每次轮询把数据注入模板生成自包含的 `stats.html`(无需服务器),历史保留最近 24 小时
- `bot.log` 运行日志(含每次领取记录)/ `stats-data.json` 统计原始数据
- `edge-profile/` 专用浏览器数据(含登录会话,勿删,删了要重新登录)
- `research/` 逆向过程的分析材料,可删除

## 注意

- 阈值计算完全由服务端执行(席位 3000 + 已领共享额度,用到 90% 才放行),本工具不绕过任何校验,只是替你点击本来就可领的按钮。
- 需要本机装有 Edge,以及 Qoder CN(借用其内置 Node 运行时)或独立 Node.js。

## 隐私与安全

- 密码仅以 Windows DPAPI 加密形式存于本机 `secret.dat`,绑定当前 Windows 用户,不可移植、不明文落盘。
- 登录会话保存在本地 `edge-profile/`,与日常浏览器完全隔离。
- `secret.dat`、`config.json`(含学工号)、`edge-profile/`、`bot.log`、统计数据均已通过 `.gitignore` 排除,不会进入版本库。

## 许可证

MIT