// 毎日の収集のあとに、結果がおかしくないかを点検する。
// 結果は Markdown で書き出し（HEALTH_OUT。無ければ画面）、問題があれば終了コード 1 を返す。
// 使い方: node scripts/health.mjs [前回の beans.json]
import { readFile, writeFile } from 'node:fs/promises';

const BEANS = process.env.BEANS_FILE || 'data/beans.json';
const SHOPS = process.env.SHOPS_FILE || 'data/shops.json';
const MAX_AGE_H = 30;          // これより古ければ、収集が止まっている
const PRICE_MIN = 300;         // 円としてありえない安さ（ドルなどで載っている疑い）
const PRICE_MAX = 60000;
const DROP_RATIO = 0.5;        // 前回から半分以下に減ったら、読み取りが壊れている疑い

const readJ = async (f) => JSON.parse(await readFile(f, 'utf8'));
const prevFile = process.argv[2];

const beans = await readJ(BEANS);
const conf = await readJ(SHOPS);
let prev = null;
if (prevFile) {
  try { prev = await readJ(prevFile); } catch { /* 前回のデータが無いときは比べない */ }
}

const problems = [];
const notes = [];
const list = beans.beans || [];
const count = (b, shop) => (b?.beans || []).filter((x) => x.shop === shop).length;

const ageH = (Date.now() - Date.parse(beans.generatedAt)) / 36e5;
if (!(ageH <= MAX_AGE_H)) problems.push(`データが ${Number.isFinite(ageH) ? Math.round(ageH) + '時間' : '日時不明で'}更新されていません（収集が止まっている疑い）`);

for (const e of beans.errors || []) problems.push(`**${e.shop}**: ${e.message}`);

for (const shop of conf.shops || []) {
  if (!shop.enabled) continue;
  const skipped = (beans.skipped || []).find((s) => s.shop === shop.id);
  if (skipped) { notes.push(`${shop.name}: 対象外（${skipped.reason}）`); continue; }
  const n = count(beans, shop.id);
  const before = prev ? count(prev, shop.id) : null;
  const hasError = (beans.errors || []).some((e) => e.shop === shop.id);
  if (n === 0 && !hasError) problems.push(`**${shop.id}**（${shop.name}）: 豆が1つも載っていません`);
  else if (!hasError && before && before >= 4 && n <= before * DROP_RATIO) problems.push(`**${shop.id}**（${shop.name}）: 豆が ${before} → ${n} に減りました（読み取りが壊れている疑い）`);
  notes.push(`${shop.name}: ${n}件${before != null && before !== n ? `（前回 ${before}件）` : ''}`);
}

const odd = list.filter((x) => typeof x.price === 'number' && (x.price < PRICE_MIN || x.price > PRICE_MAX));
for (const x of odd.slice(0, 10)) problems.push(`**${x.shop}**: 「${x.name}」の価格が ¥${x.price}（円として不自然）`);
if (odd.length > 10) problems.push(`ほかにも不自然な価格が ${odd.length - 10}件`);

const ok = problems.length === 0;
const md = [
  ok ? '## ✅ 収集の点検: 問題なし' : '## ⚠️ 収集の点検: 問題あり',
  '',
  `- 豆: ${list.length}件 / データの日時: ${beans.generatedAt}`,
  ...(ok ? [] : ['', '### 問題', ...problems.map((p) => `- ${p}`)]),
  '', '### お店ごと', ...notes.map((n) => `- ${n}`),
].join('\n') + '\n';

if (process.env.HEALTH_OUT) await writeFile(process.env.HEALTH_OUT, md);
else process.stdout.write(md);
process.exit(ok ? 0 : 1);
