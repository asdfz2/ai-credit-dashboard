// 为「同步 Release」workflow 生成发布说明，并返回该发布的 tag。
//
// 放在仓库里而不是写成 workflow 里的内联 shell，是因为这段逻辑有分支（版本号校验、
// CHANGELOG 小节的边界、小节缺失时的兜底），内联进 YAML 就只能靠「推到 main 上看
// 它跑不跑得对」来验证了。做成脚本可以在本地直接对真实文件跑。
//
// 用法：node .github/scripts/release-notes.mjs [--userscript 路径] [--changelog 路径] [--out 路径]
// 输出：把说明写到 --out（缺省 notes.md），把 tag（如 v1.13.1）打到 stdout。

import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
    const i = args.indexOf('--' + name);
    return (i !== -1 && args[i + 1]) ? args[i + 1] : fallback;
};

const userscriptPath = arg('userscript', 'trae-dashboard-enhancer.user.js');
const changelogPath = arg('changelog', 'CHANGELOG.md');
const outPath = arg('out', 'notes.md');

const fail = (msg) => {
    console.error('错误：' + msg);
    process.exit(1);
};

const userscript = fs.readFileSync(userscriptPath, 'utf8');
const changelog = fs.readFileSync(changelogPath, 'utf8');

// 版本号在脚本里有两处：元数据块的 @version（脚本管理器据此判断升级）与
// const VERSION（面板徽标上显示的那个）。二者不一致时面板会写着 A、管理器却按
// B 升级，这类问题在页面上一眼看不出来，所以在这里直接拦下，不发这个 release。
const metaVersion = (userscript.match(/^\/\/ @version\s+(\S+)\s*$/m) || [])[1];
const constVersion = (userscript.match(/const VERSION = '([^']+)'/) || [])[1];

if (!metaVersion) fail('在 ' + userscriptPath + ' 里找不到 // @version');
if (!constVersion) fail('在 ' + userscriptPath + ' 里找不到 const VERSION');
if (metaVersion !== constVersion) {
    fail('版本号两处不一致：@version = ' + metaVersion + '，const VERSION = ' + constVersion +
        '。先对齐再发版，否则面板显示的版本与脚本管理器识别的版本会对不上。');
}

const tag = 'v' + metaVersion;

// CHANGELOG 里该版本的小节：从 `## [x.y.z]` 起，到下一个 `## ` 为止
const lines = changelog.split(/\r?\n/);
const startRe = new RegExp('^## \\[' + metaVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\]');
const start = lines.findIndex((l) => startRe.test(l));

let section = '';
if (start === -1) {
    // 兜底：缺小节不该让 workflow 静默建出一个空白 release，那样发布页上会是一条
    // 什么都没有的记录。写一句明确的待办，让 draft 里就能看出少了什么。
    section = '> **待补写**：`CHANGELOG.md` 里没有 `## [' + metaVersion + ']` 小节，' +
        '发布说明暂缺。请补好本节后编辑本 release。\n';
} else {
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((l) => /^## /.test(l));
    section = rest.slice(0, end === -1 ? rest.length : end).join('\n').trim();
}

// 安装说明全篇一致，固化成模板，省得每次手写
const install = '安装方式：将下方 `trae-dashboard-enhancer.user.js` 下载后在 Tampermonkey / ' +
    'ScriptCat 中导入即可。脚本管理器以 `@namespace` + `@name` 识别脚本，会自动覆盖已安装的' +
    '旧版本，本地数据不丢失。';

const notes = [section, '---', install].join('\n\n');

fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
fs.writeFileSync(outPath, notes + '\n');

// 只把 tag 打到 stdout，方便 workflow 直接接进 $GITHUB_OUTPUT
process.stdout.write(tag + '\n');
