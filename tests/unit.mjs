// robots.txt・noindex・ログイン・アクセス間隔・利用規約の判定を、部品ごとに確かめる
import assert from 'node:assert/strict';
import { parseRobots, isAllowed, robotsMetaBlocks, termsGate, politeFetch, toolInput, htmlToText, mainText, slug, storeCurrency } from '../scripts/lib.mjs';
import { readFileSync } from 'node:fs';
import { extractByRules, judgeTermsByRules, pickLinksByRules, specBlock, FLAVOR_GROUPS } from '../scripts/rules.mjs';
import { cleanName } from '../scripts/collect.mjs';

// robots.txt は自分あての指定を優先し、なければ「*」を使う
let r = parseRobots('User-agent: CoffeeShirubeBot\nDisallow: /private\n\nUser-agent: *\nDisallow: /');
assert.deepEqual(r.rules.map((x) => x.path), ['/private'], '自分あての指定だけを使う');
r = parseRobots('User-agent: OtherBot\nUser-agent: *\nDisallow: /x\n\nUser-agent: OtherBot\nDisallow: /y');
assert.deepEqual(r.rules.map((x) => x.path), ['/x'], '複数の User-agent をまとめた指定も読む');
r = parseRobots('User-agent: *\nCrawl-delay: 2\nDisallow: /cart');
assert.equal(r.delay, 2, 'Crawl-delay を読む');

assert.equal(await isAllowed('https://specific.test/products.json'), false, '自分あてに Disallow: / なら取得しない');
assert.equal(await isAllowed('https://down.test/'), false, 'robots.txt がサーバーエラーなら取得しない');
assert.equal(await isAllowed('https://nobots.test/anything'), true, 'robots.txt が無ければ制限なし');
assert.equal(await isAllowed('https://shop-a.test/cart'), false);
assert.equal(await isAllowed('https://shop-a.test/products.json'), true);

// ページ単位の収集拒否（meta robots / X-Robots-Tag）
const H = (o) => new Headers(o);
assert.equal(robotsMetaBlocks('<meta name="robots" content="noindex">'), true);
assert.equal(robotsMetaBlocks('<meta content="none" name="ROBOTS">'), true);
assert.equal(robotsMetaBlocks('<meta name="robots" content="nofollow">'), false);
assert.equal(robotsMetaBlocks('<meta name="coffeeshirubebot" content="noindex">'), true);
assert.equal(robotsMetaBlocks('<meta name="googlebot" content="noindex">'), false);
assert.equal(robotsMetaBlocks('', H({ 'x-robots-tag': 'noindex' })), true);
assert.equal(robotsMetaBlocks('', H({ 'x-robots-tag': 'googlebot: noindex' })), false);
assert.equal(robotsMetaBlocks('', H({ 'x-robots-tag': 'CoffeeShirubeBot: none' })), true);

// ログインやパスワードのページへ転送されたら取得しない
await assert.rejects(politeFetch('https://pw.test/'), (e) => e.login === true);

// Crawl-delay に従って間をあける（REQUEST_GAP_MS=0 で実行）
const t0 = Date.now();
await politeFetch('https://delay.test/a');
await politeFetch('https://delay.test/b');
assert.ok(Date.now() - t0 >= 950, 'Crawl-delay: 1 なら1秒あける');
await assert.rejects(politeFetch('https://slow.test/a'), (e) => e.robots === true && /Crawl-delay/.test(e.message), '守りきれない長い Crawl-delay のお店は取得しない');

// お店のページに書かれている通貨（Shopify.currency）
assert.equal(storeCurrency('<script>Shopify.currency = {"active":"USD","rate":"0.0066"};</script>'), 'USD');
assert.equal(storeCurrency('<script>Shopify.currency={"active":"JPY","rate":"1.0"};</script>'), 'JPY');
assert.equal(storeCurrency('<p>トップ</p>'), null, '書かれていなければ判断しない');

// 利用規約の判定
assert.equal(termsGate({}, false).ok, false, '未確認は集めない');
assert.equal(termsGate({ terms: { status: 'review' } }, false).ok, false, '要確認は集めない');
assert.equal(termsGate({ terms: { status: 'ng' } }, false).ok, false, '禁止は集めない');
assert.equal(termsGate({ terms: { status: 'ok', commercial: 'ng' } }, false).ok, true, '収益化していなければ集める');
assert.equal(termsGate({ terms: { status: 'ok', commercial: 'ng' } }, true).ok, false, '収益化中は商業利用の禁止も対象外');
assert.equal(termsGate({ terms: { status: 'permission' } }, true).ok, true, '許諾があれば集める');

// Claude の応答の扱い
const call = (input, stop = 'tool_use') => ({ stop_reason: stop, content: [{ type: 'thinking', thinking: '' }, { type: 'tool_use', name: 'x', input }] });
assert.deepEqual(toolInput(call({ a: ' b\n', c: ['d\n'], e: { f: 'g\n' }, n: 1, t: true, z: null }), 'x'), { a: 'b', c: ['d'], e: { f: 'g' }, n: 1, t: true, z: null }, '前後の空白・改行を落とす');
assert.equal(toolInput(call({ a: 1 }, 'max_tokens'), 'x'), null, '上限で切れた応答は使わない');
assert.equal(toolInput(call({ a: 1 }, 'refusal'), 'x'), null, '断られた応答は使わない');
assert.equal(toolInput(call({ a: 1 }), 'y'), null);

// ルールでの読み取り
const R = (name, html, extra = {}) => extractByRules({ name, text: htmlToText(html), productType: 'Coffee', tags: '', variants: [{ title: '100g', price: 2000, available: true }], ...extra });
let x = R('KIENI - KENYA', '<dl><dt>COUNTRY</dt><dd>Kenya</dd><dt>VARIETY</dt><dd>SL28, SL34, Ruiru 11, Batian</dd><dt>PROCESS</dt><dd>Washed</dd><dt>ALTITUDE</dt><dd>1700-1800m</dd><dt>NOTES</dt><dd>Blackberry, Blood Orange, Cassis</dd></dl>');
assert.deepEqual([x.country, x.varieties, x.process_groups, x.altitude, x.notes], ['ケニア', ['SL28', 'SL34', 'ルイル11', 'バティアン'], ['ウォッシュト'], '1,700–1,800m', ['ブラックベリー', 'ブラッドオレンジ', 'カシス']], '英語の見出し（dt/dd）');
x = R('【浅煎り】コロンビア エル・パライソ農園', '<table><tr><th>品種</th><td>カスティージョ</td></tr><tr><th>精製</th><td>ダブルアナエロビック</td></tr></table><p>ライチや白桃、アプリコットを思わせる華やかな味わい。</p>');
assert.deepEqual([x.country, x.maker, x.varieties, x.process_groups, x.process_note, x.roast, x.notes], ['コロンビア', 'エル・パライソ', ['カスティージョ'], ['アナエロビック'], 'ダブルアナエロビック', '浅煎り', ['ライチ', '白桃', 'アプリコット']], '表の見出しと、文中の風味');
x = R('Colombia Geisha', '<p>Variety: Geisha. Process: Double anaerobic</p>');
assert.deepEqual([x.varieties, x.process_note], [['ゲイシャ'], 'ダブルアナエロビック']);
assert.equal(R('グアテマラ ハウスブレンド', '').single_origin, false, 'ブレンド');
assert.equal(R('ドリップバッグ 10個', '').is_coffee_beans, false, 'ドリップバッグ');
assert.equal(R('テイスティング 3種', '').is_coffee_beans, false, '飲み比べ');
assert.equal(R('ケニア SL28種', '').is_coffee_beans, true, '品種名の「28種」は飲み比べではない');
assert.equal(R('スタイルのある一杯', '<p>おいしい豆</p>').country, null, '「スタイル」をタイと読まない');
assert.equal(R('インドネシア マンデリン', '<p>スマトラ式</p>').country, 'インドネシア', '「インドネシア」をインドと読まない');
x = extractByRules({ name: 'グァテマラ エル・インヘルト | B店', text: htmlToText('<p>¥1,800 / 200g</p><p>SOLD OUT</p>'), variants: null });
assert.deepEqual([x.country, x.product_name, x.price_yen, x.grams, x.sold_out], ['グアテマラ', 'グァテマラ エル・インヘルト', 1800, 200, true], 'Shopify 以外のページ');

// 実際のお店の書き方に合わせた読み取り（中身は作りもの。書き方だけをまねている）
// 1) 説明は文章だけで、仕様欄は商品ページにだけあるお店
const page = `<header><a href="/">TOP</a></header><main><h1>MONTE VERDE - COSTA RICA</h1><p>¥1,800 税込</p>
<div><p>生産地: Tarrazu</p><p>農園: Monte Verde</p><p>生産者: Juan Perez,Maria Sánchez</p><p>標高: 1,700-1,800m</p><p>精製: Honey</p><p>品種: Catuai</p><p>焙煎 SAMPLE COFFEE</p><p>東京都三鷹市1-2-3</p></div>
<h2>よく一緒に買われている商品</h2></main><footer><table><tr><th>エリア</th><td>送料</td></tr><tr><th>地域</th><td>本州</td></tr></table></footer>`;
const spec = specBlock(mainText(page));
assert.deepEqual(Object.keys(spec.fields), ['origin', 'farm', 'producer', 'altitude', 'process', 'variety', 'roast'], '商品ページから仕様欄だけを取り出す');
assert.equal(specBlock(htmlToText('<table><tr><th>エリア</th><td>送料</td></tr><tr><th>地域</th><td>本州</td></tr><tr><th>県</th><td>東京</td></tr></table>')), null, '送料の表は仕様欄として読まない');
x = extractByRules({ name: 'MONTE VERDE - COSTA RICA', productType: 'コーヒー豆', tags: 'SWEET, コーヒー豆',
  text: htmlToText('<p><span>青りんごの果実感をフローラルな印象が包み、クッキーの甘さがゆっくり広がる。</span></p>'),
  variants: [{ title: '豆のまま / 150g', price: 1800, available: true }], pageSpec: spec });
assert.deepEqual([x.country, x.region, x.maker, x.maker_kind, x.varieties, x.process_groups, x.altitude, x.roast, x.notes],
  ['コスタリカ', 'タラス', 'Monte Verde', '農園', ['カトゥアイ'], ['ハニー'], '1,700–1,800m', null, ['青りんご', 'フローラル', 'クッキー']], '焙煎したお店の名前を焙煎度と読まない');
// 2) 英語の見出しを <br> で並べるお店
x = R('【NEW】Panama Boquete Sample Estate (Lot#12)', '<hr><p><span>Variety:Geisha</span><br><span>Altitude:1450m</span><br><span>Processing:Natural</span><br><span>Tasting notes:Violet, White Grape, Plum, Smooth, Round</span></p><hr><p>ご注文後に焙煎してお届けします。</p>',
  { productType: '', tags: 'Competition', variants: [{ title: '50g', price: 12200, available: true }] });
assert.deepEqual([x.is_coffee_beans, x.country, x.region, x.varieties, x.process_groups, x.altitude, x.notes],
  [true, 'パナマ', 'ボケテ', ['ゲイシャ'], ['ナチュラル'], '1,450m', ['バイオレット', 'ホワイトグレープ', 'プラム']], '英語の風味はカタカナに、口当たりの言葉（Smooth など）は載せない');
x = R('Colombia Nariño Sample', '<p>Processing:Nitrogen Anaerobic Natural<br>Tasting notes:Mayer Lemon, Honey, Chamomile Tea, Long After</p>', { productType: '' });
assert.deepEqual([x.region, x.process_groups, x.notes], ['ナリーニョ', ['ナチュラル', 'アナエロビック'], ['メイヤーレモン', 'はちみつ', 'カモミールティー']]);
// 3) 日本語の見出しに「English（カタカナ）」を並べるお店
x = R('ホンジュラス / サンプル・モレノ [カトゥアイ]', '<p>やさしい甘さが続きます。</p><p><strong>----------</strong></p><p><strong>生産地: El Cedral, Santa Barbara（エル セドラル、サンタバルバラ）</strong><br><strong>農園: La Sample（ラ サンプル農園）</strong><br><strong>生産者: Sample Moreno（サンプル・モレノ）</strong><br><strong>品種 : Catuai（カトゥアイ）</strong><br><strong>精製方法：Washed（ウォッシュト）</strong><br><strong>標高：1,670m</strong><br><strong>テイスティングコメント：アーモンド、和梨、紅茶、スイート、長く続く余韻</strong></p>',
  { productType: 'コーヒー豆', variants: [{ title: '100g / 豆のまま/whole beans', price: 1500, available: true }] });
assert.deepEqual([x.country, x.region, x.maker, x.producer, x.varieties, x.process_groups, x.process_note, x.altitude, x.notes],
  ['ホンジュラス', 'エル セドラル、サンタバルバラ', 'ラ サンプル農園', 'サンプル・モレノ', ['カトゥアイ'], ['ウォッシュト'], null, '1,670m', ['アーモンド', '和梨', '紅茶']], '併記はカタカナのほうを使い、余韻などの言葉は載せない');
x = R('エチオピア / チェワ サンプル [ハニー]', '<p>生産地: Oromia, Chewa(オロミア、チェワ）<br>生産者: Sample(サンプル)<br>品種 : 74110<br>精製方法: Honey(ハニー)</p>');
assert.deepEqual([x.region, x.maker, x.maker_kind, x.producer, x.varieties, x.process_groups], ['オロミア、チェワ', 'サンプル', '生産者', null, ['74110'], ['ハニー']]);
// 4) 表（1行に2組）
x = R('【浅煎り】ケニア キアンブ AA', '<table><tr><th>品種 / Variety</th><td>SL28, SL34</td><th>精製 / Process</th><td>Washed</td></tr><tr><th>標高</th><td>1,800m</td></tr><tr><th>カップ</th><td>カシス、トマト、黒糖</td></tr></table>');
assert.deepEqual([x.region, x.varieties, x.process_groups, x.altitude, x.roast, x.notes], ['キアンブ', ['SL28', 'SL34'], ['ウォッシュト'], '1,800m', '浅煎り', ['カシス', 'トマト', '黒糖']]);
// 豆だと言える手がかりが無い商品は載せない
assert.equal(R('Original Glass', '<p>コーヒーがおいしく飲めるグラスです。</p>', { productType: '', variants: [{ title: 'Default', price: 2000, available: true }] }).is_coffee_beans, false, '説明に「コーヒー」とあるだけでは豆にしない');
assert.equal(R('グラノーラ', '<p>コーヒーによく合います。</p>', { productType: 'Food', variants: [{ title: '200g', price: 900, available: true }] }).is_coffee_beans, false);
assert.equal(R('季節のコーヒー', '', { productType: '', variants: [{ title: '200g', price: 1500, available: true }] }).is_coffee_beans, true, 'グラム売りでコーヒーの商品名なら豆');
assert.equal(R('Santa Ana', '<p>品種: ブルボン</p>').region, null, '農園名にもよくある地名は、商品名からは地域にしない');
// 商品名の飾り・お店の id
assert.equal(cleanName('【NEW】【浅煎り】Panama Sample (Lot#1)'), 'Panama Sample (Lot#1)');
assert.equal(cleanName('ペルー / ブエナ［ゲイシャ］'), 'ペルー / ブエナ［ゲイシャ］', '飾りでない括弧は残す');
assert.equal(cleanName('【NEW】'), '【NEW】');
assert.deepEqual([slug('www.example-coffee.jp'), slug('shop.sample.com'), slug('sample.base.shop')], ['example-coffee', 'shop-sample', 'sample-base']);
assert.equal(htmlToText('<table><tr><th>品種</th><td>ゲイシャ</td></tr></table><p>a&nbsp;b &yen;100</p>'), '品種\tゲイシャ\na b ¥100', '表のセルはタブで区切る');

// 利用規約（Shopify のひな形にある「スパイダー、クロール、スクレイピング」の禁止も拾う）
let j = judgeTermsByRules('利用規約\n第5条（禁止事項）\nお客様は、以下の行為をしてはなりません。\n(1) 法令に違反する行為\n(2) スパイダー、クロール、スクレイピングを行うこと');
assert.equal(j.automated_access, 'prohibited');
assert.equal(j.clauses[0].ref, '第5条');
j = judgeTermsByRules('利用規約\n第3条 他のお客さまへの迷惑行為を禁止します。');
assert.deepEqual([j.is_terms, j.automated_access, j.commercial_use], [true, 'not_mentioned', 'not_mentioned']);
assert.equal(judgeTermsByRules('利用規約\nロボットによるアクセスについては別に定めます。').automated_access, 'unclear', '禁止かどうか読めなければ要確認');
// 一覧ページから商品ページのリンクを選ぶ
const links = new Map(['https://b.test/items/1', 'https://b.test/items/2', 'https://b.test/about', 'https://b.test/categories/beans', 'https://b.test/?pid=9'].map((u) => [u, '']));
assert.deepEqual(pickLinksByRules(links, {}), ['https://b.test/items/1', 'https://b.test/items/2', 'https://b.test/?pid=9']);

// 収集側の風味の辞書（scripts/rules.mjs）と、サイトの風味タイプ（index.html）が食い違っていないか
const site = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const block = site.match(/\/\* TASTES:START[\s\S]*?\*\/([\s\S]*?)\/\* TASTES:END \*\//);
assert.ok(block, 'index.html に風味タイプの定義がある');
const toKata = (s) => s.replace(/[ぁ-ゖ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0x60));
const { tastesOf } = new Function('toKata', `${block[1]}; return { tastesOf };`)(toKata);
for (const [name, group] of FLAVOR_GROUPS) {
  const got = tastesOf([name]);
  if (group) assert.ok(got.includes(group), `「${name}」はサイトで ${group} に入るはず（実際: ${got.join(',') || 'なし'}）`);
  else assert.deepEqual(got, [], `「${name}」はどの風味タイプにも入らないはず（実際: ${got.join(',')}）`);
}
assert.deepEqual(tastesOf(['グレープフルーツ']), ['citrus'], 'グレープフルーツを果実に数えない');
assert.deepEqual(tastesOf(['ココナッツ']), ['fruity'], 'ココナッツをナッツに数えない');
assert.deepEqual(tastesOf(['バランス']), [], 'バランスをバラと読まない');

console.log('部品のチェックに通りました');
