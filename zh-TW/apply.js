#!/usr/bin/env node
/* 繁中版套用腳本
 * 用法：node apply.js <原版資料夾> <輸出資料夾>
 *       node apply.js <原版資料夾> --check [檔名...]   只檢查，不輸出
 *
 * patches/ 下每個 .patch 檔對應一個原始檔：路徑中的 / 換成 __
 * （例如 js__engine.js.patch → js/engine.js）。
 *
 * 修補檔格式（標記必須獨佔一行）：
 *   <<<<            原文出現幾次就全部替換（至少要 1 次）
 *   <<<< once       原文必須剛好出現 1 次
 *   <<<< 3          原文必須剛好出現 3 次
 *   原文（可多行，與原始碼一字不差）
 *   ====
 *   譯文
 *   >>>>
 * 區塊之外的文字視為註解。修補依檔案內順序套用。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const here = __dirname;
const args = process.argv.slice(2);
const src = args[0];
const check = args[1] === '--check';
const out = check ? null : args[1];
const only = check ? args.slice(2) : [];
if (!src || (!check && !out)) {
  console.error('用法：node apply.js <原版資料夾> <輸出資料夾>  或  node apply.js <原版資料夾> --check [檔名...]');
  process.exit(2);
}

function parse(text, file) {
  const lines = text.split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const m = /^<<<<(?:\s+(once|\d+))?\s*$/.exec(lines[i]);
    if (!m) { i++; continue; }
    const startLine = i + 1;
    const from = [];
    const to = [];
    i++;
    while (i < lines.length && lines[i] !== '====') from.push(lines[i++]);
    if (i >= lines.length) throw new Error(`${file}:${startLine} 缺少 ====`);
    i++;
    while (i < lines.length && lines[i] !== '>>>>') to.push(lines[i++]);
    if (i >= lines.length) throw new Error(`${file}:${startLine} 缺少 >>>>`);
    i++;
    const expect = m[1] === 'once' ? 1 : m[1] ? Number(m[1]) : null;
    blocks.push({ from: from.join('\n'), to: to.join('\n'), expect, line: startLine });
  }
  return blocks;
}

function count(hay, needle) {
  let n = 0;
  for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + needle.length)) n++;
  return n;
}

function copyDir(a, b) {
  fs.mkdirSync(b, { recursive: true });
  for (const e of fs.readdirSync(a, { withFileTypes: true })) {
    if (e.name === '.git') continue;
    const pa = path.join(a, e.name);
    const pb = path.join(b, e.name);
    if (e.isDirectory()) copyDir(pa, pb);
    else fs.copyFileSync(pa, pb);
  }
}

if (!check) {
  fs.rmSync(out, { recursive: true, force: true });
  copyDir(src, out);
  // 額外檔案（例如中文字型設定）原樣複製
  const extra = path.join(here, 'extra');
  if (fs.existsSync(extra)) copyDir(extra, out);
}

const patchDir = path.join(here, 'patches');
let problems = 0;
let applied = 0;
for (const name of fs.readdirSync(patchDir).filter((f) => f.endsWith('.patch')).sort()) {
  const rel = name.slice(0, -'.patch'.length).split('__').join('/');
  if (only.length && !only.includes(rel) && !only.includes(name)) continue;
  const target = path.join(check ? src : out, rel);
  if (!fs.existsSync(target)) {
    console.log(`✗ ${name}: 找不到原始檔 ${rel}`);
    problems++;
    continue;
  }
  let text = fs.readFileSync(target, 'utf8');
  let blocks;
  try {
    blocks = parse(fs.readFileSync(path.join(patchDir, name), 'utf8'), name);
  } catch (e) {
    console.log(`✗ ${e.message}`);
    problems++;
    continue;
  }
  let ok = 0;
  for (const b of blocks) {
    if (!b.from) {
      console.log(`✗ ${name}:${b.line} 原文是空的`);
      problems++;
      continue;
    }
    const n = count(text, b.from);
    if (n === 0 || (b.expect !== null && n !== b.expect)) {
      const preview = b.from.length > 90 ? b.from.slice(0, 90) + '…' : b.from;
      console.log(`✗ ${name}:${b.line} 原文出現 ${n} 次${b.expect !== null ? `（應為 ${b.expect}）` : ''}：${JSON.stringify(preview)}`);
      problems++;
      continue;
    }
    text = text.split(b.from).join(b.to);
    ok++;
  }
  applied += ok;
  if (!check) fs.writeFileSync(target, text);
  console.log(`✓ ${rel}: ${ok}/${blocks.length} 段`);
}
console.log(problems ? `\n共 ${applied} 段套用成功，${problems} 段有問題（見上方 ✗）` : `\n全部 ${applied} 段套用成功`);
process.exit(problems ? 1 : 0);
