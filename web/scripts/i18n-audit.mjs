#!/usr/bin/env node
/**
 * 双语覆盖率审计。
 *
 * 迁移「中文原文作键」的 i18n 时，需要知道还有多少界面文案没有包进 `t()`。
 * 这个脚本做三件事：
 *
 * 1. 把源码里已经被 `t('…')` 包裹的片段先抠掉；
 * 2. 在剩下的代码里找带中日韩字符的字符串字面量与 JSX 文本节点；
 * 3. 按文件输出待迁移数量与总覆盖率。
 *
 * 它是**近似**统计：正则不认识语法树，注释与测试夹具会被排除，但复杂表达式
 * （模板字符串拼接、三元里各写一段中文）可能少算。用途是排进度与找遗漏，
 * 最终判定以人工走查 + 双语截图为准。
 *
 * 用法：
 *   node scripts/i18n-audit.mjs            # 汇总 + 最需要处理的 20 个文件
 *   node scripts/i18n-audit.mjs --all      # 列出所有仍有待迁移文案的文件
 *   node scripts/i18n-audit.mjs --json     # 机器可读，便于 CI 卡阈值
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');

const CJK = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/;

/**
 * 演示站点的示例内容。
 *
 * 这两个文件里是演示用的示例文章、评论与成员（标题、正文、简介），属于**数据**而不是
 * 界面文案：英文站点上保留中文示例内容，等价于用户自己写的中文文章，不应该自动翻译。
 */
const DEMO_CONTENT_FILES = new Set(['lib/demo.ts', 'lib/demoSeed.ts']);

/** 字典与内核自身不参与统计；测试夹具里的中文是断言数据，不是界面文案。 */
function isExcluded(rel) {
  if (rel.startsWith('lib/i18n/')) return true;
  if (/\.test\.tsx?$/.test(rel)) return true;
  if (DEMO_CONTENT_FILES.has(rel)) return true;
  return false;
}

async function walk(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** 去掉注释，避免把中文注释算成待迁移文案。 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * 把 `t('…')` / `t("…")` / t(`…`) 整段替换成空字符串。
 * 只处理字面量参数：变量参数本来就没有中文可包裹。
 */
function stripTranslated(source) {
  return source
    .replace(/\bt\(\s*(['"`])(?:\\.|(?!\1)[^\\])*\1\s*(?:,[^)]*)?\)/g, 't()')
    // `labelMap<K>({ 中文: '…' })` 里的中文是键，不是漏译的文案。
    .replace(/labelMap<[^>]*>\(\{[\s\S]*?\}\)/g, 'labelMap()');
}

/** 引号里的中文字面量。 */
const QUOTED = /(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;

/** JSX 文本节点：`>中文<`。 */
const JSX_TEXT = />\s*([^<>{}\n]*[\u4e00-\u9fff][^<>{}\n]*)\s*</g;

function pendingIn(source) {
  const cleaned = stripTranslated(stripComments(source));
  const hits = [];
  for (const match of cleaned.matchAll(QUOTED)) {
    if (CJK.test(match[2])) hits.push(match[2].trim().slice(0, 40));
  }
  for (const match of cleaned.matchAll(JSX_TEXT)) {
    const text = match[1].trim();
    if (text && CJK.test(text)) hits.push(text.slice(0, 40));
  }
  return hits;
}

const args = new Set(process.argv.slice(2));

const files = (await walk(SRC))
  .map((full) => path.relative(SRC, full).replaceAll('\\', '/'))
  .filter((rel) => !isExcluded(rel))
  .sort();

const rows = [];
let pendingTotal = 0;
let doneTotal = 0;

for (const rel of files) {
  const source = await readFile(path.join(SRC, rel), 'utf8');
  const pending = pendingIn(source);
  const translated = (stripComments(source).match(/\bt\(\s*['"`]/g) ?? []).length;
  pendingTotal += pending.length;
  doneTotal += translated;
  rows.push({ file: rel, pending: pending.length, translated, samples: pending.slice(0, 3) });
}

const touched = rows.filter((row) => row.pending > 0);
const cleaned = rows.filter((row) => row.pending === 0 && row.translated > 0);
const percent = doneTotal + pendingTotal === 0 ? 100 : (doneTotal / (doneTotal + pendingTotal)) * 100;

if (args.has('--json')) {
  console.log(
    JSON.stringify(
      {
        files: files.length,
        translated: doneTotal,
        pending: pendingTotal,
        percent: Number(percent.toFixed(1)),
        rows,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const shown = args.has('--all') ? touched : touched.slice(0, 20);

console.log('中英双语覆盖率审计');
console.log('─'.repeat(64));
console.log(`扫描文件      ${files.length}`);
console.log(`已包裹文案    ${doneTotal}`);
console.log(`待迁移文案    ${pendingTotal}`);
console.log(`覆盖率        ${percent.toFixed(1)}%`);
console.log(`完全双语文件  ${cleaned.length} / ${files.length}`);
console.log('─'.repeat(64));

if (!touched.length) {
  console.log('没有待迁移的中文界面文案。');
  process.exit(0);
}

console.log('\n待迁移最多的文件：');
for (const row of shown) {
  console.log(`  ${String(row.pending).padStart(4)}  ${row.file}`);
  for (const sample of row.samples) console.log(`        · ${sample}`);
}
if (!args.has('--all') && touched.length > shown.length) {
  console.log(`\n其余 ${touched.length - shown.length} 个文件用 --all 查看。`);
}
