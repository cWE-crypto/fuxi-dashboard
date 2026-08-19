# 投放加好友数据看板（QC渠道）

从妙搭迁移到 GitHub Pages 的免费版看板。整合 QC 渠道近 7 天加好友数据，分年级 / 主播维度统计与趋势曲线，每小时自动更新。

## 目录结构

```
├── index.html          # 看板页面（GitHub Pages 入口）
├── app.js              # 前端逻辑（含每 2 分钟自动刷新）
├── data.js             # 示例数据（真实数据缺失时的回退）
├── style.css           # 样式
├── data/
│   └── fuxi_data.json  # 采集脚本产出的真实数据（每小时自动更新）
├── deploy/
│   ├── fuxi_collector.py   # 伏羲数据采集脚本（requests 版，轻量）
│   └── requirements.txt    # Python 依赖
└── .github/workflows/
    └── fuxi-collect.yml    # 每小时定时采集 → 更新 JSON → 自动推送
```

## 更新机制（完全免费）

```
GitHub Actions（每小时 cron 定时，免费 2000 分钟/月）
    ↓ 运行 deploy/fuxi_collector.py 登录伏羲拉取数据
    ↓ 生成 data/fuxi_data.json 并 git commit + push
GitHub Pages（静态托管，免费无限流量）
    ↓ 页面打开后每 2 分钟自动重新拉取 JSON
```

不再依赖妙搭 AI / Codex 定时发消息，纯定时任务自动完成。

## 配置 Secrets（首次部署时）

在仓库 Settings → Secrets and variables → Actions 添加：

| Name | 说明 |
|---|---|
| `FUXI_USERNAME` | 伏羲系统账号 |
| `FUXI_PASSWORD` | 伏羲系统密码 |

不配置则使用脚本内置默认值（仅限测试环境）。

## 手动触发采集

GitHub 仓库 Actions 页面 → 左侧「伏羲数据定时采集」→ Run workflow。
