#!/usr/bin/env node
/*
  珈琲しるべの収集スクリプト
    node scripts/collect.mjs                 全店を収集して data/beans.json を更新
    node scripts/collect.mjs --shop lightup  1店だけ更新（ほかの店は前回の結果を残す）
    node scripts/collect.mjs --probe URL     お店のURLを読み取れるか確認するだけ（APIキー不要）
    node scripts/collect.mjs --dry-run       保存せずに、新しく読み取る商品の数だけ数える

  読み取りの方法（環境変数 EXTRACTOR）
    rules（既定）  見出しと言葉の辞書で読み取る。API キー不要・費用なし
    hybrid         まずルールで読み、産地や風味がほとんど読めなかった商品だけ Claude に任せる（キーが必要）
    claude         すべて Claude で読み取る（キーが必要）

  集めるもの・集めないもの
    ・残すのは、産地・品種・精製・価格などの事実の項目と、商品ページのURLだけ
    ・商品説明の文章と写真は保存しない（読み取りのあいだメモリに置くだけ）
    ・利用規約の確認が済んでいないお店、自動収集を禁止しているお店は集めない（scripts/terms.mjs）
    ・robots.txt と、ページの noindex 指定に従う（商品ページは2〜3週間ごとに確かめなおす）

  環境変数
    ANTHROPIC_API_KEY      EXTRACTOR が hybrid / claude のときだけ必要
    CLAUDE_MODEL           既定 claude-haiku-5-5
    MAX_NEW_EXTRACTIONS    1回で新しく読み取る・確かめなおす商品数の上限（既定 150。残りは次回に回る）
    INCLUDE_BLENDS=1       ブレンドも載せる（既定はシングルオリジンだけ）
    REQUEST_GAP_MS         同じお店へのアクセス間隔（既定 3000。robots.txt の Crawl-delay が長ければそちらに従う）
    CONTACT_URL            お問い合わせ先（メールアドレスかURL）。収集ボットの名乗りと、サイトのお問い合わせ欄に使う
*/
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  fetchCollectablePage, isShopify, listShopify, pickPrice, htmlToText, mainText, claude, toolInput,
  readJSON, writeJSON, sha, today, daysBetween, isAllowed, isHardStop, termsGate, stepSummary, warn,
} from './lib.mjs';
import { extractByRules, isWeak, pickLinksByRules, specBlock, RULES_VERSION } from './rules.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
const FILES = {
  shops: path.join(DATA, 'shops.json'),
  beans: path.join(DATA, 'beans.json'),
  cache: path.join(DATA, 'cache.json'),
};
const MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-5-5';
const MAX_NEW = Number(process.env.MAX_NEW_EXTRACTIONS || 150);
const INCLUDE_BLENDS = process.env.INCLUDE_BLENDS === '1';
const PROMPT_VERSION = 'v2'; // 抽出の指示を変えたら上げる（キャッシュが作り直される）
const WANT = (process.env.EXTRACTOR || 'rules').trim().toLowerCase();
const EXTRACTOR = ['claude', 'hybrid'].includes(WANT) && process.env.ANTHROPIC_API_KEY ? WANT : 'rules';
const EXTRACTOR_LABEL = { rules: 'ルール（API なし）', hybrid: 'ルール＋読めなかった商品だけ Claude', claude: 'Claude' }[EXTRACTOR];
const EXTRACTOR_VERSION = EXTRACTOR === 'rules' ? `rules:${RULES_VERSION}`
  : EXTRACTOR === 'hybrid' ? `hybrid:${RULES_VERSION}:${PROMPT_VERSION}:${MODEL}` : `claude:${PROMPT_VERSION}:${MODEL}`;
const STALE_DAYS = 7; // 取得できなかったお店の情報を、前回の結果として残す日数
const RECHECK_DAYS = 14; // 商品ページ（noindex の指定と仕様欄）を確かめなおす間隔。商品ごとに最大6日ずらして、アクセスが1日に集まらないようにする
const REMIND_DAYS = 180; // 利用規約をもう一度読むよう知らせるまでの日数

const args = process.argv.slice(2);
const has = (n) => args.includes(n);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const log = (...a) => console.log(...a);

/* ---------- 抽出の指示 ---------- */
const PROCESS = ['ウォッシュト', 'ナチュラル', 'ハニー', 'アナエロビック', '特殊発酵', 'スマトラ式'];
const ROASTS = ['浅煎り', '中浅煎り', '中煎り', '中深煎り', '深煎り'];
const orNull = (type, description) => ({ type: [type, 'null'], description });

const RECORD_TOOL = {
  name: 'record_bean',
  description: 'コーヒー豆の商品ページから読み取れた事実の項目を記録する。',
  input_schema: {
    type: 'object',
    properties: {
      is_coffee_beans: { type: 'boolean', description: '焙煎済みのコーヒー豆を1銘柄ずつ売る商品なら true。ドリップバッグ、飲み比べセット、定期便、ギフト、生豆、器具、グッズは false。' },
      single_origin: { type: 'boolean', description: '単一の産地（農園・精製所・生産者・地域）のコーヒーなら true。ブレンドは false。' },
      product_name: orNull('string', '商品名（ページの表記のまま）'),
      country: orNull('string', '生産国。日本語の一般的な表記（例: エチオピア、コロンビア、グアテマラ、中国）'),
      region: orNull('string', '生産地域（州・県・地区など）。カタカナ表記'),
      maker: orNull('string', '農園名・精製所名・生産者名のうち最も具体的なもの。「農園」「Finca」などの語は付けない'),
      maker_kind: { type: ['string', 'null'], enum: ['農園', '精製所', '生産者', null] },
      producer: orNull('string', '生産者の名前（maker と別に書かれている場合）'),
      station: orNull('string', '精製所・ウォッシングステーションの名前（maker と別の場合）'),
      varieties: { type: 'array', items: { type: 'string' }, description: '品種。カタカナ表記（例: ゲイシャ、カトゥアイ、ピンクブルボン）。SL28、74158 などの記号や番号はそのまま' },
      process_groups: { type: 'array', items: { type: 'string', enum: PROCESS } },
      process_note: orNull('string', '精製方法の名前（例: ダブルアナエロビック、カーボニックマセレーション）。区分と同じなら null。説明文ではなく名前だけ'),
      altitude: orNull('string', '標高（例: 1,700–1,800m）'),
      roast: { type: ['string', 'null'], enum: [...ROASTS, null] },
      notes: { type: 'array', items: { type: 'string' }, maxItems: 6, description: '風味を表す単語だけ（例: ライチ、ジャスミン、ミルクチョコレート）。1つ16字以内。文章や比喩表現は入れない' },
      price_yen: orNull('integer', '豆の一番小さい容量の税込価格（円）'),
      grams: orNull('integer', 'price_yen の容量（g）'),
      sold_out: { type: 'boolean', description: '売り切れ・在庫なしと明記されていれば true' },
    },
    required: ['is_coffee_beans', 'single_origin', 'product_name', 'country', 'region', 'maker', 'maker_kind', 'producer', 'station',
      'varieties', 'process_groups', 'process_note', 'altitude', 'roast', 'notes', 'price_yen', 'grams', 'sold_out'],
  },
};

const SYSTEM = `あなたはスペシャルティコーヒー豆の商品ページから、事実の項目だけを抜き出す担当です。
- ページに書かれていることだけを記録します。推測では埋めず、書かれていない項目は null か空の配列にします。
- 説明文を要約したり言い換えたりはしません。文章をそのまま写すこともしません。項目に当てはまる名前・数値・単語だけを入れます。
- 地域・農園・品種は日本語のカタカナ表記にそろえます。読みが確かでない固有名は英字のままにします。
- 精製区分: Washed/Fully Washed/水洗式→ウォッシュト、Natural/Dry/乾燥式→ナチュラル、Honey/Pulped Natural→ハニー、Anaerobic/嫌気性発酵→アナエロビック、酵母・乳酸菌・インフューズド・樽・カーボニックマセレーションなど→特殊発酵、Wet-hulled/スマトラ式→スマトラ式。複数当てはまれば複数入れます。
- 焙煎度は、ページに記載がある場合だけ当てはめます。ライト・シナモン→浅煎り、ミディアム→中浅煎り、ハイ→中煎り、シティ・フルシティ→中深煎り、フレンチ・イタリアン→深煎り。
- 店全体の説明やナビゲーションの文言ではなく、その商品についての記載だけを見ます。`;

const PICK_TOOL = {
  name: 'pick_product_links',
  description: 'リンク一覧から、コーヒー豆（1銘柄ずつ）の商品ページへのリンクを選ぶ。',
  input_schema: {
    type: 'object',
    properties: { urls: { type: 'array', items: { type: 'string' } } },
    required: ['urls'],
  },
};

/* ---------- キャッシュ ----------
   商品ごとに、読み取った事実の項目だけを残す（説明文は残さない）。
     sig   読み取りに使った内容（商品名・種類・タグ・説明・容量の選択肢）の指紋。価格や在庫は含めないので、値段が変わっても読みなおさない
     spec  商品ページの仕様欄の指紋
     data  読み取った項目（収集を断っているページなら { blocked: true }）
     page  商品ページを最後に確かめた日
     used  最後に使った日（45日使わなければ消す） */
const CACHE_V = 2;
let cache = { _v: CACHE_V };
const touch = (c, day) => { if (!c.used || daysBetween(c.used, day) >= 7) c.used = day; }; // 毎日書きかえると差分が増えるので、週に1度だけ
const pageDue = (key, c, day) => !c.page || daysBetween(c.page, day) >= RECHECK_DAYS + (parseInt(sha(key).slice(0, 2), 16) % 7);
const sigOf = (item) => sha([EXTRACTOR_VERSION, item.name, item.productType || '', item.tags || '',
  (item.variants || []).map((v) => v.title).join('|'), item.text || ''].join('\n'));
function pruneCache(days = 45) {
  const limit = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  for (const [k, c] of Object.entries(cache)) if (k !== '_v' && (!c.used || c.used < limit)) delete cache[k];
}

/* ---------- 一覧の取得 ---------- */
async function listGeneric(shop) {
  const base = new URL(shop.url);
  const links = new Map();
  for (const lu of shop.listUrls) {
    const listUrl = new URL(lu, base).href;
    const page = await fetchCollectablePage(listUrl);
    if (!page) throw new Error(`一覧ページで収集を断っている（noindex）ため取得しません: ${listUrl}`);
    for (const m of page.html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
      let href;
      try { href = new URL(m[1], listUrl).href; } catch { continue; }
      if (new URL(href).origin !== base.origin) continue;
      const text = htmlToText(m[2]).replace(/[\n\t]/g, ' ').slice(0, 120);
      if (!links.has(href) || (text && !links.get(href))) links.set(href, text);
    }
  }
  const list = [...links].map(([u, t]) => `${u}\t${t}`).join('\n').slice(0, 30000);
  const h = `pick:${sha(`${PROMPT_VERSION}:${MODEL}:${list}`)}`;
  let picked = EXTRACTOR === 'rules' ? pickLinksByRules(links, shop, shop.listUrls.map((lu) => new URL(lu, base).href)) : cache[h]?.data;
  if (picked) { if (cache[h]) touch(cache[h], today()); } else {
    if (has('--dry-run')) { log(`  （dry-run）${shop.id}: リンク一覧の読み取りが必要`); return []; }
    const resp = await claude({
      model: MODEL, max_tokens: 4096,
      tools: [PICK_TOOL], tool_choice: { type: 'tool', name: PICK_TOOL.name },
      messages: [{ role: 'user', content: `お店「${shop.name}」の商品一覧ページにあるリンクです（URL<TAB>リンク文字）。コーヒー豆を1銘柄ずつ売っている商品ページのURLだけを選んでください。カテゴリー・カート・ブログ・セット・ドリップバッグ・器具は含めません。\n\n${list}` }],
    });
    const got = toolInput(resp, PICK_TOOL.name);
    if (!got) throw new Error('商品ページのリンクを選び出せませんでした'); // 失敗はキャッシュしない
    picked = (got.urls || []).filter((u) => links.has(u));
    cache[h] = { data: picked, used: today() };
  }
  const items = [];
  for (const url of picked.slice(0, 80)) {
    try {
      const page = await fetchCollectablePage(url);
      if (!page) { log(`  - 収集を断っているページのため飛ばします: ${url}`); continue; }
      const title = htmlToText((page.html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
      const u = new URL(url);
      items.push({ key: `${shop.id}:${u.pathname}${u.search}`, url, name: title, text: mainText(page.html).slice(0, 8000), variants: null });
    } catch (e) {
      if (isHardStop(e)) throw e; // お店が混んでいる・止めてほしいサインなので、その回は打ち切る
      log(`  ! ${url}: ${e.message}`);
    }
  }
  return items;
}

async function listProducts(shop) {
  const origin = new URL(shop.url).origin;
  if (!shop.listUrls?.length && (await isShopify(origin))) return { platform: 'shopify', items: await listShopify(shop) };
  if (shop.listUrls?.length) return { platform: 'html', items: await listGeneric(shop) };
  const blocked = !(await isAllowed(`${origin}/products.json`));
  throw new Error(blocked
    ? 'robots.txt で一覧の取得が許可されていません'
    : 'Shopify のお店ではないようです。shops.json の listUrls に豆の一覧ページのURLを書いてください');
}

/* ---------- 1商品の読み取り ---------- */
// Claude に渡す文章（hybrid / claude のときだけ使う）
function buildInput(shop, item) {
  const lines = [`お店: ${shop.name}`, `商品名: ${item.name}`];
  if (item.productType) lines.push(`商品の種類: ${item.productType}`);
  if (item.tags) lines.push(`タグ: ${item.tags}`);
  if (item.variants) lines.push(`バリエーション: ${item.variants.map((v) => `${v.title} ¥${v.price}${v.available ? '' : '（在庫なし）'}`).join(' | ')}`);
  if (item.pageSpec) lines.push('商品ページの仕様欄:', ...item.pageSpec.lines);
  lines.push('説明:', item.text || '（なし）');
  return lines.join('\n');
}

// ルールで読み、hybrid なら読めなかった商品だけ Claude に任せる
async function extractItem(shop, item) {
  if (EXTRACTOR === 'claude') return sanitize(await extract(buildInput(shop, item)));
  const r = extractByRules(item);
  if (EXTRACTOR === 'hybrid' && isWeak(r)) {
    try { return sanitize(await extract(buildInput(shop, item))); } catch (e) { log(`  ! ${item.name}: Claude で読めなかったので、ルールの結果を使います（${e.message}）`); }
  }
  return sanitize(r);
}

async function extract(input) {
  const resp = await claude({
    model: MODEL, max_tokens: 1200, system: SYSTEM,
    tools: [RECORD_TOOL], tool_choice: { type: 'tool', name: RECORD_TOOL.name },
    messages: [{ role: 'user', content: input }],
  });
  const r = toolInput(resp, RECORD_TOOL.name);
  if (!r) throw new Error('抽出結果を受け取れませんでした');
  return r;
}

/* ---------- 表記ゆれをそろえる ---------- */
const SYNONYMS = {
  'ゲシャ': 'ゲイシャ', 'gesha': 'ゲイシャ', 'geisha': 'ゲイシャ', 'sl28': 'SL28', 'sl34': 'SL34', 'ruiru11': 'ルイル11',
  'グァテマラ': 'グアテマラ', 'ホンデュラス': 'ホンジュラス', 'エルサルバトール': 'エルサルバドル',
};
const key = (s) => String(s).normalize('NFKC').toLowerCase().replace(/[\s・･\-‐–—_.()（）]/g, '').replace(/種$/, '');
function tidy(s, { stripSuffix } = {}) {
  if (s == null) return null;
  let t = String(s).normalize('NFKC').trim();
  if (stripSuffix) t = t.replace(stripSuffix, '').trim();
  return SYNONYMS[key(t)] || SYNONYMS[t] || t || null;
}
function unifySpelling(beans) {
  for (const field of ['country', 'region', 'maker', 'varieties']) {
    const tally = new Map();
    const each = (fn) => beans.forEach((b) => {
      if (Array.isArray(b[field])) b[field] = b[field].map((v) => fn(v));
      else if (b[field]) b[field] = fn(b[field]);
    });
    each((v) => { const k = key(v); const m = tally.get(k) || new Map(); m.set(v, (m.get(v) || 0) + 1); tally.set(k, m); return v; });
    const best = new Map([...tally].map(([k, m]) => [k, [...m].sort((a, b) => b[1] - a[1])[0][0]]));
    each((v) => best.get(key(v)) || v);
    beans.forEach((b) => { if (Array.isArray(b[field])) b[field] = [...new Set(b[field])]; });
  }
}

// 商品名の頭に付く【NEW】【再入荷】【浅煎り】のような飾りを外す（お店の付けた名前そのものは変えない）
const DECOR = /^(new|新入荷|新着|新商品|新豆|再入荷|再販|限定|数量限定|期間限定|季節限定|おすすめ|オススメ|人気|sale|セール|予約|送料無料|受注焙煎|極?[浅中深]{1,2}煎り)$/i;
export function cleanName(name) {
  let s = String(name || '').trim();
  for (;;) {
    const m = /^[【\[［]([^】\]］]{1,12})[】\]］]\s*/.exec(s);
    if (!m || !DECOR.test(m[1].trim()) || m[0].length >= s.length) break;
    s = s.slice(m[0].length);
  }
  return s.trim();
}

// 長い文字列は説明文の写しになりうるので、項目ごとの上限を超えたら載せない
const LIMITS = { name: 80, country: 20, region: 30, maker: 40, producer: 60, station: 40, processNote: 24, altitude: 24, note: 16 };
const clip = (s, n) => (s && [...s].length <= n ? s : null);

// 読み取った結果を、短い事実の項目だけにする（キャッシュに残す前に通す。長い文や想定外の値はここで落とす）
function sanitize(x) {
  const str = (v, n) => (typeof v === 'string' ? clip(v.trim(), n) : null);
  const list = (v, n) => (Array.isArray(v) ? v.map((s) => str(s, n)).filter(Boolean) : []);
  const num = (v) => (Number.isFinite(v) && v > 0 ? Math.round(v) : null);
  return {
    is_coffee_beans: x.is_coffee_beans === true, single_origin: x.single_origin === true, sold_out: x.sold_out === true,
    product_name: str(x.product_name, LIMITS.name),
    country: str(x.country, LIMITS.country), region: str(x.region, LIMITS.region),
    maker: str(x.maker, LIMITS.maker), maker_kind: str(x.maker_kind, 6),
    producer: str(x.producer, LIMITS.producer), station: str(x.station, LIMITS.station),
    varieties: list(x.varieties, 30), process_groups: list(x.process_groups, 12),
    process_note: str(x.process_note, LIMITS.processNote), altitude: str(x.altitude, LIMITS.altitude), roast: str(x.roast, 8),
    notes: list(x.notes, LIMITS.note).filter((v) => !/[。．.!！?？]/.test(v)).slice(0, 6),
    price_yen: num(x.price_yen), grams: num(x.grams),
  };
}

function toBean(shop, item, x, price) {
  const bean = {
    id: item.key,
    shop: shop.id,
    name: clip(cleanName(item.variants ? item.name : (x.product_name || item.name)), LIMITS.name) || clip(cleanName(item.name), LIMITS.name),
    url: item.url,
    country: clip(tidy(x.country), LIMITS.country),
    region: clip(tidy(x.region), LIMITS.region),
    maker: clip(tidy(x.maker, { stripSuffix: /(農園|ファーム)$/ }), LIMITS.maker),
    makerKind: x.maker ? x.maker_kind : null,
    producer: clip(tidy(x.producer), LIMITS.producer),
    station: clip(tidy(x.station), LIMITS.station),
    varieties: (x.varieties || []).map((v) => clip(tidy(v, { stripSuffix: /種$/ }), 30)).filter(Boolean),
    processGroups: (x.process_groups || []).filter((p) => PROCESS.includes(p)),
    processNote: clip(tidy(x.process_note), LIMITS.processNote),
    altitude: clip(tidy(x.altitude), LIMITS.altitude),
    roast: ROASTS.includes(x.roast) ? x.roast : null,
    notes: (x.notes || []).map((v) => clip(tidy(v), LIMITS.note)).filter((v) => v && !/[。．.!！?？]/.test(v)).slice(0, 6),
    price: price?.price ?? null,
    grams: price?.grams ?? null,
    from: price?.from || undefined,
    ad: shop.ad || undefined,
  };
  if (!bean.maker) bean.makerKind = null;
  for (const [k, v] of Object.entries(bean)) {
    if (v == null || v === false || (Array.isArray(v) && !v.length)) delete bean[k];
  }
  return bean;
}

/* ---------- 確認モード ---------- */
async function probe(url) {
  const origin = new URL(url).origin;
  log(`確認: ${origin}`);
  if (!(await isAllowed(`${origin}/products.json`))) log('  robots.txt で products.json の取得が許可されていません');
  if (await isShopify(origin)) {
    try {
      const items = await listShopify({ id: 'probe', url });
      const inStock = items.filter((i) => i.variants.some((v) => v.available));
      log(`  Shopify のお店です。グッズを除いた商品 ${items.length}件（在庫あり ${inStock.length}件）`);
      inStock.slice(0, 20).forEach((i) => log(`   - ${i.name}`));
      log('  → 「お店の管理」のフォーム（手元では node scripts/manage.mjs add URL）で足すと、利用規約の確認のあと収集対象になります');
    } catch (e) {
      log(`  ! ${e.message}`);
    }
  } else {
    log('  Shopify ではないようです。足すときに「豆の一覧ページのURL」も指定すると読み取れます');
  }
}

/* ---------- 結果のまとめ（ログと、GitHub Actions の実行結果のページに出す） ---------- */
const mdCell = (v) => String(v).replace(/\|/g, '｜').replace(/\r?\n/g, ' ');
function reminders(conf, day) {
  const out = [];
  for (const s of conf.shops || []) {
    if (s.enabled === false) continue;
    const t = s.terms || {};
    if (!['ok', 'permission'].includes(t.status)) continue;
    if (t.changed) out.push(`${s.name}: 利用規約のページの内容が変わったようです（${t.changed}）。読みなおして「規約を確認した」を記録してください${t.url ? ` → ${t.url}` : ''}`);
    else if (t.checkedBy !== '目視確認') out.push(`${s.name}: 利用規約を自分の目で確かめた記録がまだありません。読んで「規約を確認した」を記録してください${t.url ? ` → ${t.url}` : ''}`);
    else if (t.checkedAt && daysBetween(t.checkedAt, day) >= REMIND_DAYS) out.push(`${s.name}: 利用規約を確かめてから半年以上たちました。もう一度読んで「規約を確認した」を記録してください${t.url ? ` → ${t.url}` : ''}`);
  }
  return out;
}

async function report({ conf, beans, errors, skipped, counts, day }) {
  const errBy = new Map(errors.map((e) => [e.shop, e.message]));
  const skipBy = new Map(skipped.map((e) => [e.shop, e.reason]));
  const rows = [];
  log('\nお店ごとの結果（掲載 / 風味・品種・精製が読めた件数）');
  for (const s of conf.shops || []) {
    if (s.enabled === false) continue;
    const mine = beans.filter((b) => b.shop === s.id);
    const n = (f) => mine.filter(f).length;
    const read = [n((b) => b.notes?.length), n((b) => b.varieties?.length), n((b) => b.processGroups?.length)];
    const state = skipBy.has(s.id) ? `対象外: ${skipBy.get(s.id)}`
      : errBy.has(s.id) ? `取得できませんでした（${mine.length ? '前回までの情報を載せています' : '載せられる情報がありません'}）: ${errBy.get(s.id)}` : '更新しました';
    log(`  ${s.name}: ${skipBy.has(s.id) ? '–' : `${mine.length}件 / ${read.join('・')}`} … ${state}`);
    rows.push(`| ${mdCell(s.name)} | ${skipBy.has(s.id) ? '–' : `${mine.length}件`} | ${skipBy.has(s.id) ? '–' : read.join(' / ')} | ${mdCell(state)} |`);
    if (errBy.has(s.id)) warn(`${s.name}: 取得できませんでした（${errBy.get(s.id)}）`);
  }
  const notes = reminders(conf, day);
  if (notes.length) { log('\n確認のお願い'); notes.forEach((x) => log(`  - ${x}`)); }
  await stepSummary([
    `## 豆データの収集（${day}）`,
    '',
    `掲載 **${beans.length}件** ／ 読み取りの方法: ${EXTRACTOR_LABEL} ／ 新しく読み取った商品 ${counts.fresh}件、ページを確かめなおした商品 ${counts.rechecked}件、次回に回した商品 ${counts.waiting}件`,
    '',
    '| お店 | 掲載 | 風味 / 品種 / 精製が読めた件数 | 状態 |',
    '|---|---|---|---|',
    ...rows,
    ...(notes.length ? ['', '### 確認のお願い', ...notes.map((x) => `- ${mdCell(x)}`)] : []),
    '',
    '読めた件数が少ないお店は、商品ページの書き方に読み取りのルールが合っていないかもしれません（scripts/rules.mjs の見出しと辞書に言葉を足すと読めるようになります）。',
  ].join('\n'));
}

/* ---------- 本体 ---------- */
async function main() {
  if (opt('--probe')) return probe(opt('--probe'));

  const conf = await readJSON(FILES.shops);
  const commercial = conf.commercial === true;
  const shops = (conf.shops || []).filter((s) => s.enabled !== false);
  const only = opt('--shop') || process.env.ONLY_SHOP || null;
  const dry = has('--dry-run');
  const saved = await readJSON(FILES.cache, {});
  cache = saved._v === CACHE_V ? saved : { _v: CACHE_V }; // 古い形式のキャッシュは作りなおす
  const prev = await readJSON(FILES.beans, { beans: [] });
  const prevById = new Map((prev.beans || []).map((b) => [b.id, b]));
  const day = today();
  log(`読み取りの方法: ${EXTRACTOR_LABEL}`);
  if (WANT !== EXTRACTOR) log(`  （EXTRACTOR=${WANT} には ANTHROPIC_API_KEY が必要なので、ルールで読み取ります）`);
  const fresh0 = (b) => b.checkedAt && daysBetween(b.checkedAt, day) <= STALE_DAYS;

  const counts = { fresh: 0, rechecked: 0, waiting: 0 };
  const beans = [];
  const errors = [];
  const skipped = [];
  const listed = new Set();

  for (const shop of shops) {
    const gate = termsGate(shop, commercial);
    if (!gate.ok) {
      log(`■ ${shop.name}: 対象外 — ${gate.reason}`);
      skipped.push({ shop: shop.id, reason: gate.reason });
      continue; // 前回の結果も残さない
    }
    listed.add(shop.id);
    if (only && shop.id !== only) {
      beans.push(...(prev.beans || []).filter((b) => b.shop === shop.id && fresh0(b)));
      continue;
    }
    log(`■ ${shop.name}`);
    const mine = []; // この回に確かめられた豆
    const seen = new Set(); // この回に扱った商品（載せないと決めたものも含む）
    try {
      const { platform, items } = await listProducts(shop);
      for (const item of items) {
        seen.add(item.key);
        if (item.variants && !item.variants.some((v) => v.available)) continue; // 売り切れ
        const old = prevById.get(item.key);
        const sig = sigOf(item);
        const c = cache[item.key];
        const same = !!c && c.sig === sig;
        const busy = dry || counts.fresh + counts.rechecked >= MAX_NEW;
        let x;
        if (same && (platform !== 'shopify' || !pageDue(item.key, c, day) || busy)) {
          x = c.data; // 前に読んだ内容がそのまま使える（ページの確かめなおしが重なったら次回に回す）
        } else if (busy) {
          counts.waiting++;
          if (old) { // 読みなおしは次回。価格と在庫だけ新しくして載せておく
            const p = item.variants ? pickPrice(item.variants) : null;
            const again = { ...old, checkedAt: day };
            if (p) Object.assign(again, { price: p.price, grams: p.grams ?? undefined, from: p.from || undefined });
            mine.push(again);
          }
          continue;
        } else {
          let spec = null;
          let specSig = '';
          if (platform === 'shopify') {
            // 商品ページを開いて、収集を断っていない（noindex でない）ことを確かめ、ページにだけある仕様欄も読む
            let page;
            try {
              page = await fetchCollectablePage(item.url);
            } catch (e) {
              if (isHardStop(e)) { seen.delete(item.key); throw e; }
              log(`  ! ${item.name}: ${e.message}`);
              if (!same) continue;
              x = c.data; // 一時的に開けなかっただけなら、前に読んだ内容を使う
            }
            if (page === null) {
              cache[item.key] = { sig, data: { blocked: true }, page: day, used: day };
              log(`  - 収集を断っているページのため載せません: ${item.url}`);
              continue;
            }
            if (page) {
              spec = specBlock(mainText(page.html));
              specSig = spec ? sha(JSON.stringify(spec.fields)) : '';
            }
          }
          if (x === undefined && same && c.spec === specSig && !c.data.blocked) {
            x = c.data; // ページも変わっていなければ、読みなおさない
            c.page = day;
            counts.rechecked++;
          } else if (x === undefined) {
            try {
              x = await extractItem(shop, { ...item, pageSpec: spec });
            } catch (e) {
              log(`  ! ${item.name}: ${e.message}`);
              continue;
            }
            cache[item.key] = { sig, spec: specSig, data: x, page: day, used: day };
            counts.fresh++;
          }
        }
        touch(cache[item.key], day);
        if (x.blocked) continue;
        if (!x.is_coffee_beans || (!x.single_origin && !INCLUDE_BLENDS) || x.sold_out) continue;
        const price = item.variants ? pickPrice(item.variants) : (x.price_yen ? { price: x.price_yen, grams: x.grams || null, from: false } : null);
        const bean = toBean(shop, item, x, price);
        bean.firstSeen = old?.firstSeen || day; // 初めて載った日（新着の表示に使う）
        bean.checkedAt = day; // この情報を確かめた日
        mine.push(bean);
      }
      log(`  ${platform}: 商品 ${items.length}件 → 掲載 ${mine.length}件`);
      beans.push(...mine);
    } catch (e) {
      // 途中で止まったら、この回に確かめられた分に、前回までの情報（7日以内）を足す
      // 価格の通貨が円でなかったときは、前回までの価格も正しいとは言えないので残さない
      const carry = e.currency ? [] : (prev.beans || []).filter((b) => b.shop === shop.id && fresh0(b) && !seen.has(b.id));
      log(`  ! 取得できませんでした: ${e.message}（この回に確かめた ${mine.length}件に、${STALE_DAYS}日以内に確かめた ${carry.length}件を足して載せます）`);
      errors.push({ shop: shop.id, message: e.message });
      beans.push(...mine, ...carry);
    }
  }

  unifySpelling(beans);
  log(`\n新しく読み取った商品: ${counts.fresh}件 / ページを確かめなおした商品: ${counts.rechecked}件 / 次回に回した商品: ${counts.waiting}件 / 掲載: ${beans.length}件 / 対象外のお店: ${skipped.length}店`);
  if (dry) { log('（dry-run のため保存していません）'); return; }

  const shopMap = {};
  for (const s of conf.shops || []) {
    if (s.enabled === false || !listed.has(s.id)) continue;
    shopMap[s.id] = Object.fromEntries(Object.entries({ name: s.name, url: s.url, area: s.area, style: s.style, shipping: s.shipping, ad: s.ad }).filter(([, v]) => v));
  }
  pruneCache();
  await writeJSON(FILES.cache, cache);
  // お問い合わせ先（サイトの「お問い合わせ・掲載の停止」に出す。GitHub の変数 CONTACT_URL、既定はリポジトリの Issues）
  const contact = (process.env.CONTACT_URL || '').trim() || undefined;
  await writeJSON(FILES.beans, { generatedAt: new Date().toISOString(), contact, shops: shopMap, beans, errors, skipped });
  const rel = path.relative(ROOT, FILES.beans);
  log(`保存しました: ${rel.startsWith('..') ? FILES.beans : rel}`);
  await report({ conf, beans, errors, skipped, counts, day });
}

// ほかのスクリプトやテストから読みこまれたときは動かさない
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
}
