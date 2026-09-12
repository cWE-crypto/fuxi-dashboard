#!/usr/bin/env python3
"""
MES 加好友明细采集器（生产级）
============================
链路：market.baijia.com → 推广链接管理 → 企微获客链接 → 异步导出明细 → 下载 xlsx → 解析聚合

数据流：
  1) 加载 cookie(扫码一次后会持久化)
  2) 调 /wecom/customerAcquisitionLink/pageList 拿所有 linkId + linkName
  3) 对每个 linkId 触发 /export/asyncExportByCondition (type=6)
  4) 轮询 /export/record/list 直到 status=2 拿到 exportUrl
  5) 下载 xlsx,按 "企微好友明细" sheet 解析明细行
  6) parse_link_name() 拆 linkName → category/group/contentType/host
  7) 按 host/group/grade/date 聚合
  8) 写出 ../data/mes_data.json(同 fuxi_data.json 的字段结构,看板直接切换数据源)

输出字段(对齐 fuxi_data.json):
  meta, dates, today, yesterday, updateTime, dateRangeText,
  kpi{ today, todayDelta, total7d, yesterday, retainRate48h, ... },
  daily[ {date, count, addCount, retain48h, delete48h, retainRate48h} ],
  grade{ today, yesterday, todayAdd, yesterdayRetain, grades },
  anchor{ today, yesterday, todayAdd, yesterdayRetain, anchors },
  detail[ {date, channel, anchor, grade, plan, source, addCount, delete48h, retain48h, count} ]

环境：
  - 默认 Python: %USERPROFILE%\\.workbuddy\\binaries\\python\\envs\\default\\Scripts\\python.exe
  - 调用方:GAS 每小时 cron,执行:
      python mes_collector.py --output ../data/mes_data.json --days 14
"""
import argparse
import json
import os
import re
import sys
import time
import urllib.request
from pathlib import Path

import openpyxl
from playwright.sync_api import sync_playwright

BASE_DIR = Path(__file__).resolve().parent
LOG_DIR = BASE_DIR / "logs"
LOG_DIR.mkdir(exist_ok=True)
DOWNLOAD_DIR = LOG_DIR / "downloads"
DOWNLOAD_DIR.mkdir(exist_ok=True)
COOKIE_FILE = LOG_DIR / "mes_cookies.json"
PLAYWRIGHT_USER_DATA = BASE_DIR / ".playwright_chrome_profile"
PLAYWRIGHT_USER_DATA.mkdir(exist_ok=True)

MES_BASE = "https://market.baijia.com"
PAGE_LIST_URL = f"{MES_BASE}/xianzhi/backend/adnest/auth/promotion/link/wecom/customerAcquisitionLink/pageList"
EXPORT_TRIGGER_URL = f"{MES_BASE}/xianzhi/firefly/backend/auth/export/asyncExportByCondition"
EXPORT_RECORD_URL = f"{MES_BASE}/xianzhi/firefly/backend/auth/export/record/list"

EXPORT_TYPE_WECOM_LINK = 6  # 企微获客链接明细


# ------------------------- 链路名称解析(对齐老格式) -------------------------

def parse_link_name(name: str) -> dict:
    """解析链接名称 → {category, group, contentType, host}
    样本:自孵化-郑州五组(锦安)-入团资料-屈海连
    规则:用 - 切分,自动忽略空段;最后一段为主播
    """
    if not name:
        return {"category": "", "group": "", "contentType": "", "host": ""}
    parts = [p.strip() for p in name.split("-") if p.strip()]
    if not parts:
        return {"category": "", "group": "", "contentType": "", "host": ""}
    host = parts[-1]
    category = parts[0]
    if len(parts) == 1:
        return {"category": category, "group": "", "contentType": "", "host": host}
    if len(parts) == 2:
        return {"category": category, "group": parts[1], "contentType": "", "host": host}
    if len(parts) == 3:
        return {"category": category, "group": parts[1], "contentType": parts[2], "host": host}
    middle = parts[1:-1]
    if len(middle) == 1:
        return {"category": category, "group": middle[0], "contentType": "", "host": host}
    return {
        "category": category,
        "group": "-".join(middle[:-1]),
        "contentType": middle[-1],
        "host": host,
    }


# ------------------------- MES API 封装(在 browser context 里发 fetch) -------------------------

def api_post(page, url: str, payload: dict) -> dict:
    """通过 page.context() 发出 POST,自动带 cookie"""
    body = json.dumps(payload, ensure_ascii=False)
    js = """
        async ({url, body}) => {
            const r = await fetch(url, {
                method: 'POST',
                credentials: 'include',
                headers: {'Content-Type': 'application/json', 'Accept': 'application/json'},
                body,
            });
            const txt = await r.text();
            try { return {ok: r.ok, status: r.status, json: JSON.parse(txt)}; }
            catch(e) { return {ok: r.ok, status: r.status, text: txt}; }
        }
    """
    return page.evaluate(js, {"url": url, "body": body})


# ------------------------- 采集主流程 -------------------------

def collect_links(page) -> list:
    """调 pageList 接口拿所有 link"""
    resp = api_post(page, PAGE_LIST_URL, {"pageNum": 1, "pageSize": 50})
    if not resp.get("ok") or not isinstance(resp.get("json"), dict):
        raise RuntimeError(f"pageList 失败: {resp}")
    data = resp["json"].get("data") or []
    if isinstance(data, dict):
        data = data.get("records") or data.get("list") or []
    links = []
    for r in data:
        link_id = r.get("linkId")
        link_name = r.get("linkName") or ""
        if link_id and link_name:
            links.append({"linkId": link_id, "linkName": link_name})
    return links


def trigger_export(page, link_id: str, start_date: str, end_date: str) -> str:
    """触发单 link 明细导出,返回 trigger 时间戳(YYYY.MM.DD HH:MM:SS)"""
    cond = {"linkId": link_id, "startDate": start_date, "endDate": end_date}
    payload = {"type": EXPORT_TYPE_WECOM_LINK, "conditionJsonStr": json.dumps(cond, ensure_ascii=False)}
    resp = api_post(page, EXPORT_TRIGGER_URL, payload)
    if not resp.get("ok"):
        raise RuntimeError(f"trigger_export HTTP fail: {resp}")
    j = resp.get("json") or {}
    if j.get("code") != 200:
        raise RuntimeError(f"trigger_export API fail: {j}")
    # 返回一个精确的 trigger 时间,后续按它匹配 record
    from datetime import datetime
    return datetime.now().strftime("%Y.%m.%d %H:%M:%S")


def wait_one_export(page, since_operate_time: str, start_date: str, end_date: str,
                    max_wait_s: int = 60) -> str | None:
    """轮询 record/list 直到出现 status=2 且 operateTime >= since_operate_time 且日期匹配的 exportUrl
    返回:exportUrl 或 None
    注意:record 里 addFriendStartTime 是 "YYYY.MM.DD" 点分隔,不是 ISO 横线
    """
    from datetime import datetime
    deadline = time.time() + max_wait_s
    # 标准化日期成 record 用的 "YYYY.MM.DD" 格式
    sd = start_date.replace("-", ".")
    ed = end_date.replace("-", ".")
    since_dt = datetime.strptime(since_operate_time, "%Y.%m.%d %H:%M:%S")
    while time.time() < deadline:
        resp = api_post(page, EXPORT_RECORD_URL,
                        {"exportTypeList": [EXPORT_TYPE_WECOM_LINK], "pageNum": 1, "pageSize": 50})
        j = resp.get("json") if isinstance(resp, dict) else {}
        if isinstance(j, dict) and j.get("code") == 200:
            for r in (j.get("data") or []):
                if r.get("exportStatus") != 2:
                    continue
                if r.get("addFriendStartTime") != sd:
                    continue
                if r.get("addFriendEndTime") != ed:
                    continue
                op_t = r.get("operateTime")
                if not op_t:
                    continue
                try:
                    op_dt = datetime.strptime(op_t, "%Y.%m.%d %H:%M:%S")
                except Exception:
                    continue
                if op_dt < since_dt:
                    continue
                return r.get("exportUrl")
        time.sleep(2)
    return None


def download_xlsx(url: str, out_path: Path) -> Path:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        out_path.write_bytes(resp.read())
    return out_path


def parse_xlsx(xlsx_path: Path, link_meta: dict) -> list:
    """解析 xlsx → [{date, host, group, contentType, category, linkName, client, accepter, accepterAccount, dept}]"""
    wb = openpyxl.load_workbook(xlsx_path, data_only=True)
    rows = []
    for sn in wb.sheetnames:
        if "明细" not in sn:
            continue
        ws = wb[sn]
        header = None
        for r in ws.iter_rows(values_only=True):
            if header is None:
                header = list(r)
                continue
            if not any(r):
                continue
            d = dict(zip(header, r))
            add_time = str(d.get("添加时间") or "")
            date = add_time[:10] if add_time else ""
            link_name = d.get("链接名称") or link_meta["linkName"]
            parsed = parse_link_name(link_name)
            rows.append({
                "date": date,
                "linkName": link_name,
                "category": parsed["category"],
                "group": parsed["group"],
                "contentType": parsed["contentType"],
                "host": parsed["host"],
                "client": d.get("用户昵称") or "",
                "accepter": d.get("添加人") or "",
                "accepterAccount": d.get("添加人账号") or "",
                "dept": d.get("添加人所属部门") or "",
                "flowId": str(d.get("流量id") or ""),
                "leadId": str(d.get("线索id") or ""),
            })
        break
    return rows


# ------------------------- 聚合(对齐 fuxi_data.json 字段) -------------------------

def aggregate(rows: list, days: int = 14) -> dict:
    """rows: 解析后的明细列表,返回看板需要的 dict"""
    from datetime import datetime, timedelta

    today = datetime.now().date()
    yesterday = today - timedelta(days=1)
    start_date = today - timedelta(days=days - 1)

    # 按 (date, group, host) 聚合加好友数
    daily_map = {}  # date -> {host, group, addCount}
    anchor_today = {}  # host -> count(today)
    anchor_yesterday = {}
    all_anchors = set()
    all_groups = set()
    detail = []

    # MES 没有 grade(年级)字段!需要从 contentType 或 linkName 推断,或固定为"未分类"
    # 看 fuxi 时代有 grade,这里先用 contentType 替代,后期手工标注
    for r in rows:
        d = r["date"]
        if not d:
            continue
        try:
            d_obj = datetime.strptime(d, "%Y-%m-%d").date()
        except Exception:
            continue
        if d_obj < start_date or d_obj > today:
            continue
        host = r["host"]
        group = r["group"]
        content_type = r["contentType"]
        all_anchors.add(host)
        all_groups.add(group)
        key = (d, host, group)
        daily_map[key] = daily_map.get(key, 0) + 1
        if d_obj == today:
            anchor_today[host] = anchor_today.get(host, 0) + 1
        elif d_obj == yesterday:
            anchor_yesterday[host] = anchor_yesterday.get(host, 0) + 1
        detail.append({
            "date": d_obj.strftime("%m-%d"),
            "channel": f"MES-{group}-{content_type}-{host}",
            "anchor": host,
            "group": group,
            "contentType": content_type,
            "plan": "",
            "source": "MES",
            "addCount": 1,
            "delete48h": 0,
            "retain48h": 1,  # MES 无 48h 字段,按 100% 留存占位(看板显示时再校正)
            "count": 1,
        })

    # 按天汇总
    dates_list = [(start_date + timedelta(days=i)).strftime("%m-%d") for i in range(days)]
    daily_out = []
    for d_obj_label in dates_list:
        d_full = (today - timedelta(days=days - 1 - dates_list.index(d_obj_label))).isoformat() if False else None
        # 重新构造完整 date
        # 简化:从 detail 里挑
        pass

    # 按天聚合(用 ISO 日期字符串)
    daily_map_iso = {}  # iso_date -> count
    for (d, host, group), cnt in daily_map.items():
        daily_map_iso[d] = daily_map_iso.get(d, 0) + cnt

    # 生成 daily[]
    daily_out = []
    for i in range(days):
        d_obj = start_date + timedelta(days=i)
        iso = d_obj.isoformat()
        count = daily_map_iso.get(iso, 0)
        daily_out.append({
            "date": d_obj.strftime("%m-%d"),
            "count": count,
            "addCount": count,
            "retain48h": count,  # 占位,看板显示时再校正
            "delete48h": 0,
            "retainRate48h": 100.0 if count else 0.0,
        })

    today_count = sum(anchor_today.values())
    yesterday_count = sum(anchor_yesterday.values())
    last7_iso = [(today - timedelta(days=i)).isoformat() for i in range(7)]
    total7d = sum(cnt for d, cnt in daily_map_iso.items() if d in last7_iso)
    avg7d = round(total7d / 7, 1) if total7d else 0
    # total7d 昨日对比(以运行时刻昨天的"前 7 天" 为基准,这里简化)
    prior7_iso = [(today - timedelta(days=i)).isoformat() for i in range(7, 14)]
    total7d_prior = sum(cnt for d, cnt in daily_map_iso.items() if d in prior7_iso)
    total7d_delta = total7d - total7d_prior
    total7d_delta_pct = f"{(total7d_delta / total7d_prior * 100):.1f}" if total7d_prior else "0.0"

    return {
        "meta": {
            "source": "mes_api",
            "updateTime": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "dateRange": f"{start_date.strftime('%m-%d')} 至 {today.strftime('%m-%d')}",
            "days": days,
            "totalRecords": len(detail),
            "channelFilter": "MES",
        },
        "dates": dates_list,
        "today": today.strftime("%m-%d"),
        "yesterday": yesterday.strftime("%m-%d"),
        "updateTime": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "dateRangeText": f"{start_date.strftime('%m-%d')} 至 {today.strftime('%m-%d')}（{days} 天）",
        "kpi": {
            "today": today_count,
            "todayDelta": today_count - yesterday_count,
            "todayDeltaPct": f"{((today_count - yesterday_count) / yesterday_count * 100):.1f}" if yesterday_count else "0.0",
            "total7d": total7d,
            "total7dDelta": total7d_delta,
            "total7dDeltaPct": total7d_delta_pct,
            "yesterday": yesterday_count,
            "ytdDelta": today_count - yesterday_count,
            "ytdDeltaPct": f"{((today_count - yesterday_count) / yesterday_count * 100):.1f}" if yesterday_count else "0.0",
            "avg7d": avg7d,
            "todayRetain48h": today_count,  # 占位
            "totalRetain48h": total7d,
            "totalDelete48h": 0,
            "retainRate48h": 100.0,
            "todayRetainRate48h": 100.0 if today_count else 0.0,
        },
        "daily": daily_out,
        "grade": {
            "today": {}, "yesterday": {}, "todayAdd": {}, "yesterdayAdd": {},
            "todayRetain": {}, "yesterdayRetain": {}, "grades": [],
        },
        "anchor": {
            "today": anchor_today,
            "yesterday": anchor_yesterday,
            "todayAdd": anchor_today,
            "yesterdayAdd": anchor_yesterday,
            "todayRetain": anchor_today,  # 占位
            "yesterdayRetain": anchor_yesterday,
            "anchors": sorted(all_anchors),
        },
        "detail": detail,
    }


# ------------------------- 主流程 -------------------------

def is_logged_in_via_api(page) -> bool:
    """用 pageList 接口能否成功判断登录态"""
    try:
        resp = api_post(page, PAGE_LIST_URL, {"pageNum": 1, "pageSize": 1})
        j = resp.get("json") if isinstance(resp, dict) else None
        return isinstance(j, dict) and j.get("code") == 200 and isinstance(j.get("data"), list) and len(j["data"]) > 0
    except Exception:
        return False


def ensure_logged_in(ctx) -> object:
    """确保有登录页;返回 page"""
    page = ctx.pages[0] if ctx.pages else ctx.new_page()
    page.goto(f"{MES_BASE}/dma/ca/info-feeds/promotion-link", wait_until="domcontentloaded", timeout=30000)
    page.wait_for_timeout(2000)
    if is_logged_in_via_api(page):
        return page
    # 等扫码
    print("[!] MES cookie 已失效,请在浏览器中扫码登录...", flush=True)
    page.wait_for_function(
        """
        async () => {
            try {
                const r = await fetch('https://market.baijia.com/xianzhi/backend/adnest/auth/promotion/link/wecom/customerAcquisitionLink/pageList', {
                    method: 'POST', credentials: 'include',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({pageNum:1, pageSize:1})
                });
                const j = await r.json();
                return j && j.code === 200 && Array.isArray(j.data) && j.data.length > 0;
            } catch (e) { return false; }
        }
        """,
        timeout=300_000,
    )
    # 刷新一下 page 拿 cookie
    page.reload(wait_until="domcontentloaded")
    page.wait_for_timeout(2000)
    return page


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--output", default=str(BASE_DIR.parent / "data" / "mes_data.json"))
    ap.add_argument("--days", type=int, default=14)
    ap.add_argument("--reuse-only", action="store_true",
                    help="不触发新导出,只用 record/list 里 status=2 的最近记录")
    args = ap.parse_args()

    from datetime import datetime, timedelta
    today = datetime.now().date()
    start_date = (today - timedelta(days=args.days - 1)).isoformat()
    end_date = today.isoformat()
    print(f"[i] 采集范围: {start_date} 至 {end_date}")

    with sync_playwright() as p:
        print(f"[i] 启动 Chrome(profile: {PLAYWRIGHT_USER_DATA})")
        ctx = p.chromium.launch_persistent_context(
            user_data_dir=str(PLAYWRIGHT_USER_DATA),
            executable_path=r"C:\Program Files\Google\Chrome\Application\chrome.exe",
            headless=False,
            slow_mo=0,
            viewport={"width": 1440, "height": 900},
        )

        page = ensure_logged_in(ctx)

        # 保存最新 cookie
        cookies = ctx.cookies()
        COOKIE_FILE.write_text(json.dumps(cookies, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"[i] 已保存 {len(cookies)} 项 cookie")

        # 1) 拉链接列表
        links = collect_links(page)
        print(f"[i] 共 {len(links)} 个企微获客链接:")
        for l in links:
            print(f"  - {l['linkId']}  {l['linkName']}")

        all_rows = []
        # 2) 串行触发 + 串行等待(每个 link 完成后再下一个,精确对应)
        for i, l in enumerate(links):
            link_id = l["linkId"]
            link_name = l["linkName"]
            print(f"\n[{i+1}/{len(links)}] {link_name[:40]}")
            if args.reuse_only:
                # 复用模式:从 record/list 找最近一条匹配日期范围的(不做 linkId 区分,会用同一个 URL 覆盖)
                resp = api_post(page, EXPORT_RECORD_URL,
                                {"exportTypeList": [EXPORT_TYPE_WECOM_LINK], "pageNum": 1, "pageSize": 5})
                j = resp.get("json") if isinstance(resp, dict) else {}
                eu = None
                sd = start_date.replace("-", ".")
                ed = end_date.replace("-", ".")
                if isinstance(j, dict) and j.get("code") == 200:
                    for r in (j.get("data") or []):
                        if r.get("exportStatus") == 2 and r.get("addFriendStartTime") == sd and r.get("addFriendEndTime") == ed:
                            eu = r.get("exportUrl")
                            break
                if not eu:
                    print(f"  [!] 复用失败:无可用 record,跳过")
                    continue
                t_op = "0000.00.00 00:00:00"
            else:
                t_op = trigger_export(page, link_id, start_date, end_date)
                print(f"  trigger ok @ {t_op}")
                eu = wait_one_export(page, t_op, start_date, end_date, max_wait_s=60)
                if not eu:
                    print(f"  [!] 等待 60s 未就绪,跳过此 link")
                    continue
            # 下载 + 解析
            xlsx_path = DOWNLOAD_DIR / f"mes_{link_id}_{start_date}_{end_date}.xlsx"
            try:
                download_xlsx(eu, xlsx_path)
                rows = parse_xlsx(xlsx_path, l)
                all_rows.extend(rows)
                print(f"  [✓] 解析 {len(rows)} 条")
            except Exception as e:
                print(f"  [!] 下载/解析失败: {e}")

        ctx.close()

    # 5) 按 leadId 去重(reuse-only 模式 / 同一链接被多次触发的脏数据)
    seen_leads = set()
    unique_rows = []
    for r in all_rows:
        lid = r.get("leadId") or r.get("flowId")
        if lid and lid in seen_leads:
            continue
        if lid:
            seen_leads.add(lid)
        unique_rows.append(r)
    if len(unique_rows) != len(all_rows):
        print(f"[i] 去重: {len(all_rows)} → {len(unique_rows)} (按 leadId/flowId)")

    # 6) 聚合
    if not unique_rows:
        print("[!] 去重后无明细,保留已有数据文件")
        sys.exit(2)

    data = aggregate(unique_rows, days=args.days)
    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n[✓] 已写入 {out_path}")
    print(f"    total={data['meta']['totalRecords']}, today={data['kpi']['today']}, 7d={data['kpi']['total7d']}")


if __name__ == "__main__":
    main()