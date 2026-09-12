#!/usr/bin/env python3
"""
MES 探查 + 登录 + 下载 + 解析 一体化脚本

流程：
  1) 尝试加载已保存的 cookie
  2) 若仍处于登录页 → 打开浏览器窗口，用户用微信扫码
  3) 扫码成功后自动保存 cookie
  4) 进入「推广链接管理 → 企微获客链接」
  5) 全选 → 点击「批量导出明细」，拦截网络请求看真实导出机制
  6) 解析每条链接名称 → 输出小组/类型/主播拆分样本

运行：
  python mes_explore.py
"""
import os
import re
import sys
import json
import time
from pathlib import Path
import datetime as _dt_mod
from playwright.sync_api import sync_playwright

BASE_DIR = Path(__file__).resolve().parent
LOG_DIR = BASE_DIR / "logs"
LOG_DIR.mkdir(exist_ok=True)
COOKIE_FILE = LOG_DIR / "mes_cookies.json"
NETWORK_LOG = LOG_DIR / "mes_network_log.json"
# 独立的 Playwright User Data 目录(Chrome 默认目录不允许远程调试)
PLAYWRIGHT_USER_DATA = BASE_DIR / ".playwright_chrome_profile"
PLAYWRIGHT_USER_DATA.mkdir(exist_ok=True)

MES_URL = "https://market.baijia.com/dma/ca/info-feeds/promotion-link"


def is_logged_in(page) -> bool:
    """判断当前是否处于登录页（推广链接页面则视为已登录）"""
    try:
        url = page.url
        text = page.evaluate("() => document.body.innerText || ''")
        # 登录页特征
        has_qr = "扫码" in text or "二维码" in text
        has_pwd_input = page.evaluate("""
            () => !!document.querySelector('input[type=password]')
        """)
        # 已登录特征（推广链接管理页面）
        is_promotion_page = "promotion-link" in url and not has_qr and not has_pwd_input
        has_table = page.evaluate("""
            () => !!document.querySelector('table, .el-table, [class*=table], [role=grid]')
        """)
        return is_promotion_page or (not has_qr and not has_pwd_input and has_table)
    except Exception:
        return False


def wait_login(page, timeout_ms=300_000):
    """等待用户扫码完成登录"""
    print("[!] 检测到登录页,请用微信扫码登录...")
    print(f"[!] 等待登录完成 (最长 {timeout_ms // 60} 分钟)...")
    try:
        page.wait_for_function(
            """
            () => {
                const t = document.body.innerText || '';
                const hasQR = t.includes('扫码') || t.includes('二维码');
                const hasPwd = !!document.querySelector('input[type=password]');
                return !hasQR && !hasPwd;
            }
            """,
            timeout=timeout_ms,
        )
        print("[✓] 登录成功!")
    except Exception as e:
        print(f"[!] 等待登录超时: {e}")
        raise


def parse_link_name(name: str) -> dict:
    """解析链接名称 → {大类, 小组, 内容类型, 主播名称}

    样本：自孵化-郑州五组（锦安）-入团资料-屈海连
    解析规则：用 - 切分,自动忽略空段
    """
    if not name:
        return {"raw": "", "category": "", "group": "", "contentType": "", "host": "", "parts": []}
    parts = [p.strip() for p in name.split("-") if p.strip()]
    if len(parts) == 0:
        return {"raw": name, "category": "", "group": "", "contentType": "", "host": "", "parts": []}

    if len(parts) == 1:
        return {"raw": name, "category": parts[0], "group": "", "contentType": "", "host": "", "parts": parts}
    if len(parts) == 2:
        return {"raw": name, "category": parts[0], "group": parts[1], "contentType": "", "host": "", "parts": parts}
    if len(parts) == 3:
        return {"raw": name, "category": parts[0], "group": parts[1], "contentType": parts[2], "host": "", "parts": parts}

    host = parts[-1]
    category = parts[0]
    middle = parts[1:-1]
    if len(middle) == 1:
        group = middle[0]
        content_type = ""
    elif len(middle) == 2:
        group, content_type = middle[0], middle[1]
    else:
        group = "-".join(middle[:-1])
        content_type = middle[-1]
    return {"raw": name, "category": category, "group": group, "contentType": content_type, "host": host, "parts": parts}


def run():
    with sync_playwright() as p:
        print(f"[i] Playwright profile: {PLAYWRIGHT_USER_DATA}")
        print("[i] 启动 Chrome(独立 profile,首次扫码登录后 cookie 会持久化到这里)")

        browser = None
        try:
            ctx = p.chromium.launch_persistent_context(
                user_data_dir=str(PLAYWRIGHT_USER_DATA),
                executable_path=r"C:\Program Files\Google\Chrome\Application\chrome.exe",
                headless=False,
                slow_mo=200,
                viewport={"width": 1440, "height": 900},
                accept_downloads=True,
            )
        except Exception as e:
            print(f"[!] 启动 Chrome 失败: {e}")
            print("[i] 回退:用临时 profile")
            browser = p.chromium.launch(channel="chrome", headless=False, slow_mo=200)
            ctx = browser.new_context(
                viewport={"width": 1440, "height": 900},
                accept_downloads=True,
            )

        # 加载已保存 cookie
        if COOKIE_FILE.exists():
            try:
                cookies = json.loads(COOKIE_FILE.read_text(encoding="utf-8"))
                ctx.add_cookies(cookies)
                print(f"[i] 已加载 {len(cookies)} 项 cookie")
            except Exception as e:
                print(f"[!] 加载 cookie 失败: {e}")

        page = ctx.pages[0] if ctx.pages else ctx.new_page()

        # 网络请求拦截
        network_entries = []
        response_bodies = {}  # url -> body(json or text)

        def log_request(req):
            entry = {
                "type": "request",
                "time": _dt_mod.datetime.now().isoformat(),
                "method": req.method,
                "url": req.url,
                "headers": dict(req.headers),
            }
            try:
                entry["post_data"] = req.post_data
            except Exception:
                pass
            network_entries.append(entry)

        def log_response(resp):
            entry = {
                "type": "response",
                "time": _dt_mod.datetime.now().isoformat(),
                "status": resp.status,
                "url": resp.url,
                "headers": dict(resp.headers),
            }
            # 抓 body(json 优先)
            try:
                body_text = resp.text()
                entry["body_len"] = len(body_text)
                # 只截前 2000 字,避免日志爆炸
                entry["body_preview"] = body_text[:2000]
                # 尝试解析 json
                if "json" in (resp.headers.get("content-type", "").lower()):
                    try:
                        entry["body_json"] = resp.json()
                        response_bodies[resp.url] = entry["body_json"]
                    except Exception:
                        pass
                else:
                    # 非 json 也存一份(下载文件流等可能用得到)
                    response_bodies[resp.url] = body_text[:50000]
            except Exception as e:
                entry["body_err"] = str(e)
            network_entries.append(entry)

        page.on("request", log_request)
        page.on("response", log_response)

        print(f"[i] 打开 {MES_URL}")
        page.goto(MES_URL, wait_until="domcontentloaded", timeout=30000)
        page.wait_for_timeout(3000)

        page.screenshot(path=str(LOG_DIR / "01_mes_initial.png"), full_page=True)

        # 检测登录态
        if not is_logged_in(page):
            try:
                wait_login(page)
            except Exception:
                print("[!] 登录失败,中止")
                if browser:
                    browser.close()
                else:
                    ctx.close()
                return
            page.wait_for_timeout(2000)
            page.goto(MES_URL, wait_until="domcontentloaded", timeout=30000)
            page.wait_for_timeout(3000)

        # 保存 cookie
        cookies = ctx.cookies()
        COOKIE_FILE.write_text(json.dumps(cookies, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"[✓] Cookie 已保存: {COOKIE_FILE} ({len(cookies)} 项)")

        page.screenshot(path=str(LOG_DIR / "02_promotion_page.png"), full_page=True)
        print(f"[i] 当前 URL: {page.url}")
        print(f"[i] 页面 title: {page.title()}")

        # 点击「企微获客链接」tab
        try:
            qw_tab = page.locator("text=企微获客链接").first
            if qw_tab.count() > 0:
                print("[i] 点击「企微获客链接」tab...")
                qw_tab.click()
                page.wait_for_timeout(3000)
                page.screenshot(path=str(LOG_DIR / "03_qw_page.png"), full_page=True)
            else:
                print("[!] 未找到「企微获客链接」tab")
        except Exception as e:
            print(f"[!] 点击 tab 失败: {e}")

        # 收集 UI 信息
        ui_info = page.evaluate("""
            () => {
                const btns = Array.from(document.querySelectorAll('button, a, [role=button]'))
                    .map(el => (el.innerText || '').trim())
                    .filter(t => t.length > 0 && t.length < 60);
                const inputs = Array.from(document.querySelectorAll('input, select'))
                    .map(el => ({
                        tag: el.tagName.toLowerCase(),
                        type: el.type || '',
                        placeholder: el.placeholder || '',
                        name: el.name || '',
                    }))
                    .filter(x => x.tag === 'input' || x.tag === 'select');
                const headers = Array.from(document.querySelectorAll('table th, .el-table th, [class*=header]'))
                    .map(el => (el.innerText || '').trim())
                    .filter(t => t.length > 0 && t.length < 30);
                return {btns: [...new Set(btns)], inputs, headers};
            }
        """)
        print(f"[i] UI 元素:\n{json.dumps(ui_info, ensure_ascii=False, indent=2)}")

        # 收集表格数据
        rows_sample = page.evaluate("""
            () => {
                const rows = Array.from(document.querySelectorAll('table tr, .el-table__row, [role=row]'));
                return rows.slice(0, 40).map(r => {
                    const cells = Array.from(r.querySelectorAll('td, .cell, [role=cell]'))
                        .map(c => (c.innerText || '').trim().replace(/\\s+/g, ' '));
                    return cells;
                });
            }
        """)
        print(f"[i] 表格前 40 行样本:\n{json.dumps(rows_sample, ensure_ascii=False, indent=2)}")

        # 1) 先点击表头全选 checkbox(Element UI 的 checkbox 实际可点击的是 .el-checkbox__inner)
        try:
            print("[i] 点击表头全选 checkbox...")
            header_checkbox_inner = page.locator('.el-table__header .el-checkbox__inner').first
            if header_checkbox_inner.count() > 0:
                header_checkbox_inner.click()
                print("[✓] 已点击全选")
            else:
                print("[!] 未找到表头全选 checkbox")
        except Exception as e:
            print(f"[!] 点击全选失败: {e}")
        page.wait_for_timeout(2000)
        page.screenshot(path=str(LOG_DIR / "04_after_select_all.png"), full_page=True)

        # 2) 点击「批量导出明细」
        try:
            print("[i] 点击「批量导出明细」按钮...")
            bulk_export = page.locator("button").filter(has_text=re.compile(r"批量导出明细")).first
            # 等待按钮启用
            try:
                bulk_export.wait_for(state="enabled", timeout=10000)
                print("[i] 批量导出明细按钮已启用")
            except Exception:
                print("[!] 批量导出明细按钮未在 10s 内启用,继续尝试点击")
            if bulk_export.count() > 0:
                bulk_export.click()
                page.wait_for_timeout(2000)
                page.screenshot(path=str(LOG_DIR / "05_after_bulk_export_click.png"), full_page=True)
                modal_text = page.evaluate("() => document.body.innerText || ''")
                print(f"[i] 点击批量导出后页面文本:\n{modal_text[:1500]}")
            else:
                print("[!] 未找到「批量导出明细」按钮")
        except Exception as e:
            print(f"[!] 点击批量导出明细失败: {e}")

        # 3) 如果弹出了日期选择框,填写日期并确认
        try:
            if "请选择加好友时间" in page.evaluate("() => document.body.innerText || ''"):
                print("[i] 检测到加好友时间选择弹窗,填写日期范围...")
                # 默认填最近 14 天
                end = _dt_mod.datetime.now()
                start = end - _dt_mod.timedelta(days=13)
                start_str = start.strftime("%Y-%m-%d")
                end_str = end.strftime("%Y-%m-%d")

                # Element UI 日期范围输入框通常是两个 input
                date_inputs = page.locator('.ep-date-editor input, .el-date-editor input').all()
                if len(date_inputs) >= 2:
                    date_inputs[0].fill(start_str)
                    date_inputs[1].fill(end_str)
                    print(f"[i] 日期范围: {start_str} 至 {end_str}")
                else:
                    print("[!] 未找到日期输入框")

                # 点击确认
                confirm_btn = page.locator("button, span").filter(has_text=re.compile(r"^确认$|^确定$")).first
                if confirm_btn.count() > 0:
                    confirm_btn.click()
                    print("[i] 已点击确认")
                    page.wait_for_timeout(5000)
                    page.screenshot(path=str(LOG_DIR / "06_after_confirm.png"), full_page=True)
                else:
                    print("[!] 未找到确认按钮")
        except Exception as e:
            print(f"[!] 填写日期/确认失败: {e}")

        # 4) 再尝试点第一行的「导出明细」看触发什么(如果批量没成功)
        try:
            print("[i] 点击第一行的「导出明细」按钮...")
            row_exports = page.locator("table tbody button, table tbody a, table tbody span").filter(has_text=re.compile(r"导出明细"))
            if row_exports.count() > 0:
                row_exports.first.click()
                page.wait_for_timeout(2000)
                page.screenshot(path=str(LOG_DIR / "07_after_row_export_click.png"), full_page=True)
                modal_text2 = page.evaluate("() => document.body.innerText || ''")
                print(f"[i] 点击行导出明细后页面文本:\n{modal_text2[:1500]}")
            else:
                print("[!] 未找到行级「导出明细」按钮")
        except Exception as e:
            print(f"[!] 点击行导出明细失败: {e}")

        # 4.5) 在日期对话框里填入日期范围 + 点确认,捕获真实导出 API
        try:
            print("\n[i] === 第二轮:点击行级导出明细 → 填日期 → 点确认,捕获真实导出 API ===")
            # 先关掉之前的对话框(如果有)
            try:
                page.locator("button, span").filter(has_text=re.compile(r"^取消$")).first.click(timeout=2000)
                page.wait_for_timeout(1000)
            except Exception:
                pass
            # 再点一次行级导出明细
            row_exports = page.locator("table tbody button, table tbody a, table tbody span").filter(has_text=re.compile(r"导出明细"))
            if row_exports.count() > 0:
                row_exports.first.click()
                page.wait_for_timeout(2500)
                page.screenshot(path=str(LOG_DIR / "08_dialog_opened.png"), full_page=True)

                # 检测对话框是否存在
                dialog_visible = "请选择加好友时间" in page.evaluate("() => document.body.innerText || ''")
                print(f"[i] 日期对话框打开: {dialog_visible}")

                if dialog_visible:
                    end = _dt_mod.datetime.now()
                    start = end - _dt_mod.timedelta(days=13)
                    start_str = start.strftime("%Y-%m-%d")
                    end_str = end.strftime("%Y-%m-%d")
                    print(f"[i] 准备填日期范围: {start_str} 至 {end_str}")

                    # 找日期输入框
                    date_inputs = page.locator('.ep-date-editor input, .el-date-editor input').all()
                    print(f"[i] 找到 {len(date_inputs)} 个日期输入框")
                    if len(date_inputs) >= 2:
                        # Element UI date-picker:直接 fill + Enter
                        date_inputs[0].click()
                        page.wait_for_timeout(500)
                        date_inputs[0].fill(start_str)
                        page.wait_for_timeout(500)
                        date_inputs[0].press("Enter")
                        page.wait_for_timeout(500)
                        date_inputs[1].click()
                        page.wait_for_timeout(500)
                        date_inputs[1].fill(end_str)
                        page.wait_for_timeout(500)
                        date_inputs[1].press("Enter")
                        page.wait_for_timeout(500)
                        page.screenshot(path=str(LOG_DIR / "09_dates_filled.png"), full_page=True)

                        # 点确认
                        confirm_btn = page.locator("button, span").filter(has_text=re.compile(r"^确认$")).first
                        if confirm_btn.count() > 0:
                            # 记录点击前 network_entries 的数量,便于定位新增请求
                            pre_count = len(network_entries)
                            confirm_btn.click()
                            print("[i] 已点击「确认」")
                            page.wait_for_timeout(8000)  # 等异步请求/下载
                            page.screenshot(path=str(LOG_DIR / "10_after_confirm.png"), full_page=True)
                            # 打印新增请求
                            new_reqs = network_entries[pre_count:]
                            print(f"\n[i] 点击「确认」后新增 {len(new_reqs)} 条网络事件:")
                            for e in new_reqs:
                                if e.get("type") == "request":
                                    pd = e.get("post_data")
                                    print(f"  REQ {e.get('method')} {e.get('url')[:160]}")
                                    if pd:
                                        print(f"    body: {str(pd)[:400]}")
                                elif e.get("type") == "response":
                                    bl = e.get("body_len", 0)
                                    bj = e.get("body_json")
                                    print(f"  RES {e.get('status')} {e.get('url')[:160]} body_len={bl}")
                                    if bj:
                                        print(f"    body: {json.dumps(bj, ensure_ascii=False)[:800]}")
                        else:
                            print("[!] 未找到「确认」按钮")
                    else:
                        print("[!] 找不到日期输入框")
                else:
                    print("[!] 日期对话框未弹出,可能前面已处理过")
        except Exception as e:
            print(f"[!] 第二轮日期流程失败: {e}")

        # 保存网络请求日志
        NETWORK_LOG.write_text(json.dumps(network_entries, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"[✓] 网络请求日志已保存: {NETWORK_LOG} ({len(network_entries)} 条)")

        # 保存 response body 索引
        BODY_LOG = LOG_DIR / "mes_response_bodies.json"
        try:
            BODY_LOG.write_text(
                json.dumps(response_bodies, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            print(f"[✓] 响应体已保存: {BODY_LOG} ({len(response_bodies)} 项)")
        except Exception as e:
            print(f"[!] 保存响应体失败: {e}")

        # 解析 pageList 响应,导出链接元数据
        page_list_url = next(
            (u for u in response_bodies if "pageList" in u and "wecom/customerAcquisitionLink" in u),
            None,
        )
        if page_list_url:
            body = response_bodies[page_list_url]
            print(f"\n[i] pageList 响应结构:")
            print(json.dumps(body, ensure_ascii=False, indent=2)[:3000])
            # 抽取 data / records / list 字段
            data = body.get("data") if isinstance(body, dict) else None
            if isinstance(data, dict):
                records = data.get("records") or data.get("list") or data.get("rows") or []
                total = data.get("total") or data.get("totalCount")
                print(f"\n[i] pageList.total={total}, records len={len(records)}")
                if records:
                    print("[i] 首条记录字段:")
                    print(json.dumps(records[0], ensure_ascii=False, indent=2)[:2000])
                    # 保存完整 records
                    records_file = LOG_DIR / "pageList_records.json"
                    records_file.write_text(
                        json.dumps(records, ensure_ascii=False, indent=2),
                        encoding="utf-8",
                    )
                    print(f"[✓] 完整 records 已保存: {records_file} ({len(records)} 条)")

        # 解析链接名称样本
        print("\n[i] 链接名称解析样本:")
        parsed_samples = []
        for r in rows_sample:
            for cell in r:
                if "-" in cell and "自孵化" in cell:
                    parsed = parse_link_name(cell)
                    parsed_samples.append(parsed)
                    print(f"   {cell!r}")
                    print(f"     → {parsed}")
                    break

        # 保存解析样本
        sample_file = LOG_DIR / "parsed_samples.json"
        sample_file.write_text(
            json.dumps(parsed_samples, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        print(f"[✓] 解析样本已保存: {sample_file}")

        print("\n[i] 浏览器保持打开,60 秒后自动关闭,可手动操作")
        try:
            page.wait_for_timeout(60_000)
        except Exception:
            pass
        if browser:
            browser.close()
        else:
            ctx.close()


if __name__ == "__main__":
    run()
