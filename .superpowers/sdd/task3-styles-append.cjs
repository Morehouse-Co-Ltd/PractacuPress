/**
 * Task 3 的 styles.css 分两步落盘：
 * 1. 工作区文件追加自己的 CSS 段（CRLF，与其它会话的改动共存）；
 * 2. 用「HEAD blob + 自己那段」拼出要入库的版本（LF，仓库形态），
 *    交给 `git hash-object -w --path` + `git update-index --cacheinfo`，
 *    这样暂存区里只有我这一段，别人的 hunk 留在工作区。
 */
const fs = require('fs');
const { execFileSync } = require('child_process');

const PATH = 'apps/web/src/styles.css';
const section = fs
  .readFileSync('.superpowers/sdd/task3-styles-section.css', 'utf8')
  .replace(/\r\n/g, '\n');
const marker = '.pp-mediablock';

const working = fs.readFileSync(PATH, 'utf8');
if (working.includes(marker)) {
  console.error('工作区已经有这一段了，先确认是不是重复执行');
  process.exit(1);
}
fs.appendFileSync(PATH, section.replace(/\n/g, '\r\n'));

const head = execFileSync('git', ['show', `HEAD:${PATH}`], { maxBuffer: 1 << 28 }).toString('utf8');
fs.writeFileSync('.superpowers/sdd/task3-styles-composed.css', head + section);

const sha = execFileSync('git', [
  'hash-object',
  '-w',
  '--path',
  PATH,
  '.superpowers/sdd/task3-styles-composed.css',
])
  .toString()
  .trim();
console.log(sha);
