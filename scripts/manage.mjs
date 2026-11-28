#!/usr/bin/env node
/*
  お店の管理（data/shops.json を書きかえる）
  GitHub の Actions →「お店の管理」のフォームから動かします。手元でも使えます。

    node scripts/manage.mjs add URL [--name 店名] [--list-urls "一覧ページのURL"] [--note メモ]
    node scripts/manage.mjs stop ID [--note メモ]         掲載を止める（次の収集で、そのお店の豆がサイトから消える）
    node scripts/manage.mjs resume ID                     掲載を再開する
    node scripts/manage.mjs ok ID [--commercial ok|ng] [--note メモ]    利用規約を目で確かめた（掲載してよい）
    node scripts/manage.mjs ng ID [--note メモ]           利用規約で自動収集が禁止されていた
    node scripts/manage.mjs permission ID [--note メモ]   お店から掲載の許諾をもらった

  ID のかわりに、お店のURLや店名でも指定できます。
  フォームからは、環境変数 ACTION・TARGET・NAME・COMMERCIAL・NOTE・LIST_URLS で受け取ります。
*/
import path from 'node:path';
import { appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { readJSON, writeJSON, today, slug, markTerms, stepSummary, isShopify, listShopify, isAllowed, fetchCollectablePage, htmlToText } from './lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
const SHOPS_FILE = path.join(DATA, 'shops.json');
const log = (...a) => console.log(...a);

const ACTIONS = {
  'お店を足す': 'add', 'お店を止める': 'stop', 'お店を再開する': 'resume',
  '規約を確認した（掲載してよい）': 'ok', '規約で禁止されていた': 'ng', '掲載の許諾をもらった': 'permission',
};
const COMMERCIAL = { '禁止されていない': 'ok', '禁止されている': 'ng', ok: 'ok', ng: 'ng' };

const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const clean = (v) => String(v ?? '').trim();
const input = {
  action: clean(process.env.ACTION || argv[0]),
  target: clean(process.env.TARGET || argv[1]),
  name: clean(process.env.NAME || opt('--name')),
  commercial: COMMERCIAL[clean(process.env.COMMERCIAL || opt('--commercial'))],
  note: clean(process.env.NOTE || opt('--note')),
  listUrls: clean(process.env.LIST_URLS || opt('--list-urls')).split(/[\s,、]+/).filter(Boolean),
};
const action = ACTIONS[input.action] || input.action;

const originOf = (u) => { try { return new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`).origin.replace('://www.', '://'); } catch { return null; } };

function findShop(conf, target) {
  const t = target.toLowerCase();
  const o = /[./]/.test(target) ? originOf(target) : null;
  const hits = conf.shops.filter((s) => s.id === target || (o && originOf(s.url) === o) || String(s.name).toLowerCase() === t);
  if (hits.length !== 1) throw new Error(hits.length ? `「${target}」に当てはまるお店が複数あります。id で指定してください` : `「${target}」というお店は登録されていません（id・URL・店名のどれかで指定します）`);
  return hits[0];
}

async function addShop(conf) {
  const o = originOf(input.target);
  if (!o || !/\./.test(o)) throw new Error('足すお店は、オンラインストアのURL（例: https://example-coffee.jp/）で指定してください');
  const dup = conf.shops.find((s) => originOf(s.url) === o);
  if (dup) throw new Error(dup.enabled === false ? `${dup.name} はすでに登録されています（休止中）。「お店を再開する」を使ってください` : `${dup.name} はすでに登録されています`);
  const url = new URL(/^https?:\/\//i.test(input.target) ? input.target : `https://${input.target}`).origin + '/';
  const lines = [];

  // トップページを開けるか（収集を断っていないか）を確かめ、店名の候補を取る
  let top;
  try {
    top = await fetchCollectablePage(url);
  } catch (e) {
    throw new Error(`お店のサイトを開けませんでした（${e.message}）。URLを確かめてください`);
  }
  if (!top) throw new Error('このお店はトップページで検索エンジン向けの収集を断っている（noindex）ため、足せません');
  // 店名は、サイトの名前（og:site_name。Shopify では店名）を先に使い、無ければ題名の最初の区切りまで
  // （題名は「コーヒー通販 | 店名」のように店名が後ろに来ることや、&ndash; と改行で区切られることがある）
  const plain = (s) => htmlToText(s).replace(/&[nm]dash;/g, '–').replace(/\s+/g, ' ').trim();
  const ogTag = /<meta\b[^>]*\bproperty=(["'])og:site_name\1[^>]*>/i.exec(top.html)?.[0] || '';
  const siteName = plain(/\bcontent=(["'])([\s\S]*?)\1/i.exec(ogTag)?.[2] || '').slice(0, 60);
  const title = plain((top.html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').split(/\s*[|｜–—-]\s+|\s+[|｜–—-]\s*/)[0].trim();
  const shop = { id: '', name: input.name || siteName || title || new URL(url).hostname, url, enabled: true, addedBy: 'manage', addedAt: today() };
  if (input.note) shop.note = input.note;

  if (input.listUrls.length) {
    shop.listUrls = input.listUrls;
    lines.push(`豆の一覧ページ: ${input.listUrls.join('、')}`);
  } else if (await isShopify(new URL(url).origin).catch((e) => { throw new Error(`お店のサイトが混んでいるか、開けませんでした（${e.message}）。しばらくしてから、もう一度実行してください`); })) {
    const items = await listShopify({ id: 'new', url });
    const inStock = items.filter((i) => i.variants.some((v) => v.available)).length;
    lines.push(`Shopify のお店です。グッズを除いた商品 ${items.length}件（在庫あり ${inStock}件）`);
  } else if (!(await isAllowed(`${new URL(url).origin}/products.json`))) {
    throw new Error('このお店は robots.txt で商品一覧の取得を許可していないため、足せません');
  } else {
    throw new Error('Shopify のお店ではないようです。「豆の一覧ページのURL」も入れて、もう一度実行してください');
  }

  const ids = new Set(conf.shops.map((s) => s.id));
  let id = slug(new URL(url).hostname);
  while (ids.has(id)) id += '-2';
  shop.id = id;
  conf.shops.push(shop);
  return { shop, done: `${shop.name}（id: ${id}）を足しました`, lines: [...lines, 'このあと利用規約を自動で判定します。「対象外」と出たら、規約を読んで「規約を確認した（掲載してよい）」を実行してください'] };
}

async function main() {
  if (!action || !input.target) throw new Error('やることと、対象のお店を指定してください');
  const conf = await readJSON(SHOPS_FILE);
  let result;
  if (action === 'add') {
    result = await addShop(conf);
  } else {
    const shop = findShop(conf, input.target);
    if (action === 'stop') {
      shop.enabled = false;
      shop.stoppedAt = today();
      if (input.note) shop.note = input.note;
      result = { shop, done: `${shop.name} の掲載を止めました`, lines: ['このあとの収集で、このお店の豆がサイトから消えます', 'お店探しでも、もう一度足されることはありません'] };
    } else if (action === 'resume') {
      shop.enabled = true;
      delete shop.stoppedAt;
      result = { shop, done: `${shop.name} の掲載を再開しました`, lines: [] };
    } else if (['ok', 'ng', 'permission'].includes(action)) {
      const t = markTerms(shop, action, { commercial: input.commercial, note: input.note });
      const label = { ok: '利用規約を確認した（掲載してよい）', ng: '利用規約で禁止されていた（集めません）', permission: '掲載の許諾をもらった' }[action];
      result = { shop, done: `${shop.name}: ${label} と記録しました`, lines: [`自動収集 ${t.status} / 情報の商業利用 ${t.commercial}${t.note ? ` / メモ: ${t.note}` : ''}`] };
    } else {
      throw new Error(`やること「${input.action}」がわかりません`);
    }
  }
  await writeJSON(SHOPS_FILE, conf);
  log(result.done);
  result.lines.forEach((l) => log(`  ${l}`));
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `shop=${result.shop.id}\n`, 'utf8');
  await stepSummary(['## お店の管理', '', `**${result.done}**`, '', ...result.lines.map((l) => `- ${l}`), ''].join('\n'));
}

await main().catch(async (e) => {
  console.error(e.message);
  await stepSummary(['## お店の管理', '', `できませんでした: ${e.message}`, ''].join('\n'));
  process.exitCode = 1;
});
