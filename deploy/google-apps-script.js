/**
 * 加好友看板 - GitHub Actions 定时触发器（Google Apps Script）
 *
 * 用途：定时调用 GitHub API 触发「伏羲数据采集」workflow，
 *       解决 GitHub 免费计划 cron 定时任务不可靠（被静默丢弃）的问题。
 *
 * 配置步骤（详见仓库根目录《GoogleAppsScript配置教程.md》）：
 *   1. 打开 https://script.google.com 新建项目
 *   2. 把本文件内容全部粘贴进去，替换下方 GITHUB_TOKEN
 *   3. 保存后先运行 testConnection() 验证 Token
 *   4. 在「触发器」里添加定时触发器，函数选 triggerCollect，按小时执行
 */

// ================= 配置区（只需改这一块） =================
var GITHUB_OWNER = 'cWE-crypto';            // GitHub 用户名
var GITHUB_REPO = 'fuxi-dashboard';         // 仓库名
var WORKFLOW_FILE = 'fuxi-scheduler.yml';   // workflow 文件名（记得和仓库里一致）
var GITHUB_TOKEN = '在此粘贴你的TOKEN';       // GitHub Token（repo + workflow 权限）
var MIN_INTERVAL_MIN = 30;                  // 防重复：距上次触发少于该分钟数则跳过

// =========================================================

/**
 * 【主函数】定时触发采集任务
 * 在 Apps Script 触发器里选择这个函数，建议按小时执行。
 * 触发成功（HTTP 204）后会记录时间，防止手动+定时重复触发。
 */
function triggerCollect() {
  var props = PropertiesService.getScriptProperties();
  var lastRun = Number(props.getProperty('lastRun') || 0);
  var now = Date.now();
  var elapsedMin = (now - lastRun) / 60000;

  // 防重复触发：30 分钟内已触发过则跳过
  if (lastRun > 0 && elapsedMin < MIN_INTERVAL_MIN) {
    Logger.log('⏭️ 距上次触发仅 ' + elapsedMin.toFixed(1) + ' 分钟，跳过（防重复）');
    return 0;
  }

  var url = 'https://api.github.com/repos/' + GITHUB_OWNER + '/' + GITHUB_REPO +
            '/actions/workflows/' + WORKFLOW_FILE + '/dispatches';

  var options = {
    method: 'post',
    headers: {
      'Authorization': 'Bearer ' + GITHUB_TOKEN,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'GoogleAppsScript',
      'X-GitHub-Api-Version': '2022-11-28'
    },
    payload: JSON.stringify({ ref: 'main' }),
    muteHttpExceptions: true
  };

  var res = UrlFetchApp.fetch(url, options);
  var code = res.getResponseCode();

  if (code === 204) {
    props.setProperty('lastRun', String(now));
    var bj = Utilities.formatDate(new Date(now), 'Asia/Shanghai', 'yyyy-MM-dd HH:mm');
    Logger.log('✅ 触发成功（HTTP 204），GitHub 已开始采集。北京时间 ' + bj);
  } else {
    Logger.log('❌ 触发失败 HTTP ' + code + '：' + res.getContentText());
  }
  return code;
}

/**
 * 【测试函数】验证 Token 是否有效、能否读取 workflow
 * 在编辑器里选择这个函数点「运行」，然后查看「执行记录」里的日志。
 */
function testConnection() {
  var url = 'https://api.github.com/repos/' + GITHUB_OWNER + '/' + GITHUB_REPO +
            '/actions/workflows';

  var options = {
    method: 'get',
    headers: {
      'Authorization': 'Bearer ' + GITHUB_TOKEN,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'GoogleAppsScript'
    },
    muteHttpExceptions: true
  };

  var res = UrlFetchApp.fetch(url, options);
  var code = res.getResponseCode();

  if (code === 200) {
    var data = JSON.parse(res.getContentText());
    var list = data.workflows.map(function (w) {
      return w.name + '(' + w.state + ')';
    }).join('、');
    Logger.log('✅ Token 有效！仓库内定时任务：' + list);
  } else {
    Logger.log('❌ HTTP ' + code + '：' + res.getContentText());
    Logger.log('提示：请检查 TOKEN 是否填写正确、是否勾选了 repo 权限、是否已过期');
  }
  return code;
}
