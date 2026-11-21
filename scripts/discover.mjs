#!/usr/bin/env node
/*
  新しいお店を探す
    node scripts/discover.mjs              候補を data/candidates.json に書き出す（shops.json は変えない）
    node scripts/discover.mjs --auto-add   読み取れることを確かめた Shopify のお店を shops.json に追加する
    node scripts/discover.mjs --max 20     探す件数（既定 15）
  Claude API の Web 検索を使います。組織の設定で Web 検索を有効にしておく必要がある場合があります。
  Claude が挙げたURLは、実際にアクセスして商品一覧が読めたものだけを残します。
  追加したお店は、利用規約の確認（node scripts/terms.mjs）が済むまで収集されません。
*/
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { claude, toolInput, isShopify, listShopify, readJSON, writeJSON, today, slug, stepSummary } from './lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
// Web 検索で調べる作業は、たまにしか動かさないので精度を優先して Sonnet を使う
const MODEL = process.env.CLAUDE_DISCOVER_MODEL || 'claude-sonnet-5-5';
const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const MAX = Number(opt('--max') || 15);
const AUTO_ADD = args.includes('--auto-add');

const SUBMIT_TOOL = {
  name: 'submit_shops',
  description: '見つけたお店を報告する。',
  input_schema: {
    type: 'object',
    properties: {
      shops: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'お店の名前' },
            url: { type: 'string', description: 'オンラインストアのトップページのURL（検索結果で確認できたもの）' },
            area: { type: ['string', 'null'], description: '拠点の地域（例: 東京・蔵前、福岡）' },
          },
          required: ['name', 'url', 'area'],
        },
      },
    },
    required: ['shops'],
  },
};

async function askClaude(known) {
  const prompt = `日本国内のスペシャルティコーヒーのロースターで、自社のオンラインストアでシングルオリジンのコーヒー豆を売っているお店を最大${MAX}件探してください。
- 北海道から沖縄まで、地域が偏らないようにしてください。
- 大手チェーン、モール（楽天・Amazon・Yahoo!）の店舗ページ、生豆の卸は除きます。
- すでに登録済みのお店は除きます: ${known.join('、') || 'なし'}
- URLは検索結果で実際に確認できたものだけにしてください。
見つけ終わったら submit_shops ツールで報告してください。`;
  const tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 8 }, SUBMIT_TOOL];
  const messages = [{ role: 'user', content: prompt }];
  for (let turn = 0; turn < 4; turn++) {
    const resp = await claude({ model: MODEL, max_tokens: 16000, tools, messages });
    const got = toolInput(resp, SUBMIT_TOOL.name);
    if (got) return got.shops || [];
    messages.push({ role: 'assistant', content: resp.content });
    if (resp.stop_reason !== 'pause_turn') messages.push({ role: 'user', content: 'submit_shops ツールで結果を報告してください。' });
  }
  throw new Error('お店の候補を受け取れませんでした');
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('お店探しは Claude の Web 検索を使うので、ANTHROPIC_API_KEY が必要です。キーを使わない場合は、「お店の管理」→「お店を足す」で足してください');
  const shopsFile = path.join(DATA, 'shops.json');
  const conf = await readJSON(shopsFile);
  const knownOrigins = new Set(conf.shops.map((s) => new URL(s.url).origin.replace('://www.', '://')));
  const found = await askClaude(conf.shops.map((s) => s.name));
  console.log(`Claude の候補: ${found.length}件`);

  const candidates = [];
  for (const f of found) {
    let origin;
    try { origin = new URL(f.url).origin; } catch { continue; }
    if (knownOrigins.has(origin.replace('://www.', '://'))) continue;
    const shopify = await isShopify(origin);
    let beansLike = 0;
    if (shopify) {
      try {
        const items = await listShopify({ id: 'candidate', url: origin });
        beansLike = items.filter((i) => i.variants.some((v) => v.available)).length;
      } catch { /* 読めなければ 0 のまま */ }
    }
    candidates.push({ name: f.name, url: origin + '/', area: f.area || null, shopify, items: beansLike });
    console.log(`  ${shopify ? '○' : '－'} ${f.name} ${origin}${shopify ? `（商品 ${beansLike}件）` : '（Shopify 以外: listUrls の設定が必要）'}`);
  }
  await writeJSON(path.join(DATA, 'candidates.json'), { checkedAt: new Date().toISOString(), candidates });

  if (AUTO_ADD) {
    const ids = new Set(conf.shops.map((s) => s.id));
    let added = 0;
    for (const c of candidates.filter((x) => x.shopify && x.items > 0)) {
      let id = slug(new URL(c.url).hostname);
      while (ids.has(id)) id += '-2';
      ids.add(id);
      conf.shops.push({ id, name: c.name, url: c.url, area: c.area || undefined, enabled: true, addedBy: 'discover', addedAt: today() });
      added++;
    }
    await writeJSON(shopsFile, conf);
    console.log(`shops.json に ${added}店を追加しました（利用規約の確認が済むまで収集しません）`);
    const names = conf.shops.filter((s) => s.addedBy === 'discover' && s.addedAt === today()).map((s) => s.name);
    if (names.length) await stepSummary(['## お店探し', '', `見つけて足したお店: ${names.join('、')}`, '', '合わないお店は「お店の管理」→「お店を止める」で止められます。', ''].join('\n'));
  }
}

await main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
