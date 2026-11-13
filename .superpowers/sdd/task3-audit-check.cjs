/** 对比 HEAD 与工作区的 lib/blocks.ts 的「待迁移中文」条数，确认 Task 3 没新增。 */
const { execFileSync } = require('child_process');
const fs = require('fs');

const CJK = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/;
const QUOTED = /(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;
const JSX_TEXT = />\s*([^<>{}\n]*[\u4e00-\u9fff][^<>{}\n]*)\s*</g;

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
function stripTranslated(source) {
  return source
    .replace(/\bt\(\s*(['"`])(?:\\.|(?!\1)[^\\])*\1\s*(?:,[^)]*)?\)/g, 't()')
    .replace(/labelMap<[^>]*>\(\{[\s\S]*?\}\)/g, 'labelMap()');
}
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

const head = execFileSync('git', ['show', 'HEAD:apps/web/src/lib/blocks.ts'], {
  maxBuffer: 1 << 28,
}).toString('utf8');
const working = fs.readFileSync('apps/web/src/lib/blocks.ts', 'utf8');
const before = pendingIn(head);
const after = pendingIn(working);
console.log('HEAD pending:', before.length, 'working pending:', after.length);
const added = after.filter((item) => !before.includes(item));
console.log('new pending entries:', added.length, added.slice(0, 10));
