// テスト用：ネットワークと Claude API を偽物に差し替える（node --import で読み込む）
import { appendFileSync } from 'node:fs';

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
const html = (t, status = 200, headers = {}) => new Response(t, { status, headers: { 'content-type': 'text/html', ...headers } });
const redirected = (res, url) => { Object.defineProperty(res, 'url', { value: url }); return res; };

const LONG_TERMS = '（ここまで前文）'.repeat(40);

const SHOP_A = [
  { title: 'Ethiopia Gesha Village Natural', handle: 'eth-gesha', product_type: 'Coffee', tags: ['浅煎り'],
    body_html: '<p>生産国: エチオピア<br>地域: ベンチ・マジ<br>農園: ゲシャ・ビレッジ農園<br>品種: Gesha / 精製: Natural / 標高: 1,900-2,100m</p><p>フレーバー：ジャスミン、ピーチ</p>',
    variants: [
      { option1: '豆のまま', option2: '100g', price: '3000', available: true },
      { option1: '粉に挽く', option2: '100g', price: '3000', available: true },
      { option1: '豆のまま', option2: '200g', price: '5600', available: true },
    ] },
  { title: 'Kenya Sold Out AA', handle: 'kenya-so', product_type: 'Coffee', body_html: '', variants: [{ option1: '150g', price: '2000', available: false }] },
  { title: 'ロゴ入りドリッパー', handle: 'dripper', product_type: 'Goods', body_html: '', variants: [{ price: '3000', available: true }] },
  { title: 'テイスティング 3種', handle: 'tasting', product_type: 'Coffee', body_html: '飲み比べセット', variants: [{ option1: '3 x 50g', price: '2500', available: true }] },
  { title: 'House Blend', handle: 'blend', product_type: 'Coffee', body_html: 'ブレンド', variants: [{ option1: '200g', price: '1800', available: true }] },
  { title: '【NEW】Colombia El Paraíso Geisha Thermal', handle: 'col-gesha', product_type: 'Coffee', body_html: 'Variety: Geisha. Process: Double anaerobic', variants: [{ option1: '1,000g', price: '30000', available: true }, { option1: '50g', price: '2800', available: true }] },
  { title: 'Kenya Hidden Lot', handle: 'hidden-lot', product_type: 'Coffee', body_html: 'SL28', variants: [{ option1: '100g', price: '2500', available: true }] },
  { title: 'Long Notes Lot', handle: 'long-notes', product_type: 'Coffee',
    body_html: '<p>生産国：ルワンダ</p><p>精製：収穫したチェリーを72時間タンクで発酵させてからアフリカンベッドで乾燥</p><p>フレーバー：ジャスミン、完熟した赤いりんごのようなジューシーな果実感が広がる、カシス。</p>',
    variants: [{ option1: '100g', price: '2000', available: true }] },
  { title: 'Mystery Lot', handle: 'mystery', product_type: 'Coffee', body_html: '<p>今月のおすすめです。</p>', variants: [{ option1: '100g', price: '1900', available: true }] },
  // 説明は文章だけで、仕様欄（生産地・農園・品種など）は商品ページにだけあるお店の書き方
  { title: 'MONTE VERDE - COSTA RICA', handle: 'page-spec', product_type: 'コーヒー豆', tags: ['SWEET', 'コーヒー豆'],
    body_html: '<p><span>青りんごの果実感をフローラルな印象が包み、クッキーの甘さがゆっくり広がる。</span></p><p><strong>全国送料300円</strong></p>',
    variants: [{ option1: '豆のまま', option2: '150g', price: '1800', available: true }, { option1: '粉に挽く', option2: '150g', price: '1800', available: true }] },
  { title: 'Original Glass', handle: 'glass', product_type: '', body_html: '<p>コーヒーがおいしく飲めるグラスです。</p>', variants: [{ price: '2000', available: true }] },
];
const PAGE_SPEC = `<title>MONTE VERDE</title><header><a href="/">TOP</a></header><main><h1>MONTE VERDE - COSTA RICA</h1><p>¥1,800 税込</p>
<div><p>生産地: Tarrazu</p><p>農園: Monte Verde</p><p>生産者: Juan Perez,Maria Sánchez</p><p>標高: 1,700-1,800m</p><p>精製: Honey</p><p>品種: Catuai</p><p>焙煎 SAMPLE COFFEE</p></div>
<h2>よく一緒に買われている商品</h2></main><footer><table><tr><th>エリア</th><td>送料</td></tr></table></footer>`;

const ANSWERS = {
  'Ethiopia Gesha Village Natural': { country: 'エチオピア\n', region: 'ベンチ・マジ', maker: 'ゲシャ・ビレッジ農園\n', maker_kind: '農園\n', varieties: ['ゲシャ'], process_groups: ['ナチュラル\n'], altitude: '1,900–2,100m', roast: '浅煎り\n', notes: ['ジャスミン\n', 'ピーチ'] },
  'Colombia El Paraíso Geisha Thermal': { country: 'コロンビア', region: 'カウカ', maker: 'エル・パライソ', maker_kind: '農園', varieties: ['Geisha'], process_groups: ['アナエロビック'], process_note: 'ダブルアナエロビック' },
  'Mystery Lot': { country: 'ペルー', notes: ['キャラメル'] },
  'Long Notes Lot': { country: 'ルワンダ', notes: ['ジャスミン', '完熟した赤いりんごのようなジューシーな果実感が広がる', 'カシス。'], process_note: '収穫したチェリーを72時間タンクで発酵させてからアフリカンベッドで乾燥' },
  'B店 グアテマラ': { product_name: 'グァテマラ エル・インヘルト パカマラ', country: 'グァテマラ', maker: 'エル・インヘルト', maker_kind: '農園', varieties: ['パカマラ種'], process_groups: ['ウォッシュト'], price_yen: 1800, grams: 200 },
  'B店 売り切れ': { product_name: 'ブラジル 売り切れ', country: 'ブラジル', sold_out: true },
};

function recordAnswer(content) {
  const name = (content.match(/商品名: (.*)/) || [])[1] || '';
  const base = { is_coffee_beans: true, single_origin: true, product_name: null, country: null, region: null, maker: null, maker_kind: null, producer: null, station: null, varieties: [], process_groups: [], process_note: null, altitude: null, roast: null, notes: [], price_yen: null, grams: null, sold_out: false };
  if (/飲み比べ|Glass/.test(content)) return { ...base, is_coffee_beans: false };
  if (/ブレンド/.test(content)) return { ...base, single_origin: false };
  for (const [k, v] of Object.entries(ANSWERS)) if (name.includes(k) || content.includes(k)) return { ...base, ...v };
  return base;
}

function termsAnswer(content) {
  return {
    is_terms: /利用規約/.test(content),
    automated_access: /スクレイピング[^。]*禁止/.test(content) ? 'prohibited\n' : 'not_mentioned',
    commercial_use: /商業的に利用[^。]*禁止/.test(content) ? 'prohibited' : 'not_mentioned',
    reproduction: 'not_mentioned',
    clauses: [{ ref: '第3条', summary: '禁止事項の定め' }],
  };
}

const shopifyHost = new Set(['shop-a.test', 'www.shop-d.test', 'noindex.test', 'pw.test', 'specific.test', 't-ok.test', 't-watch.test']);

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  if (process.env.MOCK_LOG) appendFileSync(process.env.MOCK_LOG, url + '\n');
  const u = new URL(url);

  if (u.hostname === 'api.anthropic.com') {
    const body = JSON.parse(init.body);
    const names = body.tools.map((t) => t.name);
    if (process.env.MOCK_LOG) appendFileSync(process.env.MOCK_LOG, `api ${names.join(',')} ${body.model}\n`);
    const content = typeof body.messages[0].content === 'string' ? body.messages[0].content : '';
    let toolIn;
    let name;
    if (names.includes('record_bean')) { name = 'record_bean'; toolIn = recordAnswer(content); }
    else if (names.includes('record_terms')) { name = 'record_terms'; toolIn = termsAnswer(content); }
    else if (names.includes('pick_product_links')) { name = 'pick_product_links'; toolIn = { urls: content.split('\n').map((l) => l.split('\t')[0]).filter((x) => /\/items\//.test(x)).concat(['https://hallucinated.test/x']) }; }
    else if (names.includes('submit_shops')) {
      if (!body.tools.some((t) => t.type === 'web_search_20250305')) throw new Error('web search tool missing');
      name = 'submit_shops';
      toolIn = { shops: [
        { name: 'A店（登録済み）', url: 'https://shop-a.test/', area: '東京' },
        { name: 'D珈琲', url: 'https://www.shop-d.test/', area: '福岡' },
        { name: 'E珈琲', url: 'https://shop-e.test', area: '札幌' },
      ] };
    }
    // 強制しないツール呼び出し（お店探し）では、考えた跡のブロックが先に付くことがある
    const thinking = name === 'submit_shops' ? [{ type: 'thinking', thinking: '', signature: 'sig' }] : [];
    return json({ id: 'msg', type: 'message', role: 'assistant', stop_reason: 'tool_use', content: [...thinking, { type: 'tool_use', id: 't1', name, input: toolIn }] });
  }

  if (u.pathname === '/robots.txt') {
    if (u.hostname === 'shop-c.test') return html('User-agent: *\nDisallow: /\n');
    if (u.hostname === 'specific.test') return html('User-agent: CoffeeShirubeBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n');
    if (u.hostname === 'down.test') return html('maintenance', 503);
    if (u.hostname === 'delay.test') return html('User-agent: *\nCrawl-delay: 1\nAllow: /\n');
    if (u.hostname === 'slow.test') return html('User-agent: *\nCrawl-delay: 60\n');
    if (u.hostname === 'nobots.test') return html('not found', 404);
    return html('User-agent: *\nDisallow: /cart\nDisallow: /collections/*sort_by*\n\nUser-agent: OtherBot\nDisallow: /\n');
  }

  // www 付きから www 無しへ転送するお店（転送先へも円の指定を送れているかを確かめる）
  if (u.hostname === 'www.shop-a.test') return new Response(null, { status: 301, headers: { location: 'https://shop-a.test' + u.pathname + u.search } });

  if (shopifyHost.has(u.hostname)) {
    // Shopify の Markets：日本・円の指定（cookie）が無ければドルで返す。MOCK_USD_ALWAYS なら指定があってもドル
    const jp = /localization=JP/.test(String((init.headers || {}).cookie || '')) && !process.env.MOCK_USD_ALWAYS;
    if (u.pathname === '/') {
      if (u.hostname === 'noindex.test') return html('<html><head><meta content="noindex, nofollow" name="robots"></head><body>準備中</body></html>');
      if (u.hostname === 'pw.test') return redirected(html('<form>パスワード</form>'), 'https://pw.test/password');
      if (u.hostname === 't-ok.test' || u.hostname === 't-watch.test') return html('<a href="/policies/terms-of-service">利用規約</a>');
      return html(`<html><head><title>コーヒー通販\n &ndash; D COFFEE ROASTERS 公式オンラインストア</title><meta property="og:site_name" content="D COFFEE ROASTERS"><script>Shopify.currency = {"active":"${jp ? 'JPY' : 'USD'}","rate":"${jp ? '1.0' : '0.0066'}"};</script></head><body>トップ</body></html>`);
    }
    if (u.pathname === '/products.json') {
      if (process.env.MOCK_BUSY_JSON) return html('too many requests', 429); // 商品一覧そのものが混んでいる
      if (u.searchParams.get('limit') === '1') return json({ products: [SHOP_A[0]] });
      let list = process.env.MOCK_PRICE_UP // 値上げ：最初の商品の価格だけが変わる
        ? SHOP_A.map((p, i) => (i ? p : { ...p, variants: p.variants.map((v) => ({ ...v, price: String(Number(v.price) + 300) })) }))
        : SHOP_A;
      if (!jp) list = list.map((p) => ({ ...p, variants: p.variants.map((v) => ({ ...v, price: (Number(v.price) / 150).toFixed(2) })) })); // ドルの価格
      return json({ products: u.searchParams.get('page') === '1' ? list : [] });
    }
    if (u.pathname.startsWith('/products/')) {
      const handle = u.pathname.split('/')[2];
      if (process.env.MOCK_BUSY_PAGE === handle) return html('too many requests', 429);
      if (handle === 'hidden-lot' || process.env.MOCK_NOINDEX === handle) return html('<meta name="robots" content="noindex">非公開ロット', 200);
      if (handle === 'page-spec') return html(PAGE_SPEC);
      return html('<title>商品</title><main>商品ページ</main>');
    }
    if (u.pathname === '/policies/terms-of-service' && u.hostname === 't-ok.test') return html(`<h1>利用規約</h1>${LONG_TERMS}<p>第3条 他のお客さまへの迷惑行為を禁止します。</p>`);
    if (u.pathname === '/policies/terms-of-service' && u.hostname === 't-watch.test') { // 規約があとから変わるお店
      const added = process.env.MOCK_TERMS_NEW ? '<p>第9条 スクレイピングその他の自動的な手段で情報を収集する行為を禁止します。</p>' : '';
      return html(`<nav>ロボット掃除機 特集</nav><main><h1>利用規約</h1>${LONG_TERMS}<p>第3条 他のお客さまへの迷惑行為を禁止します。</p>${added}</main>`);
    }
  }

  if (u.hostname === 'shop-b.test') {
    if (u.pathname === '/products.json') return html('not found', 404);
    if (u.pathname === '/collections/beans') return html('<a href="/items/1">グアテマラ</a><a href="/items/2">ブラジル</a><a href="/about">私たちについて</a><a href="https://other.test/items/9">外部</a>');
    if (u.pathname === '/items/1') {
      if (process.env.MOCK_BUSY_B) return html('too many requests', 429);
      return html('<title>B店 グアテマラ | B店</title><nav>メニュー</nav><main><h1>グァテマラ エル・インヘルト</h1><p>¥1,800 / 200g</p><p>生産国：グァテマラ</p><p>農園：エル・インヘルト農園</p><p>品種：パカマラ種</p><p>精製：ウォッシュト</p></main>');
    }
    if (u.pathname === '/items/2') return html('<title>B店 売り切れ</title><main>B店 売り切れ SOLD OUT</main>');
  }

  if (u.hostname === 't-ng.test') {
    if (u.pathname === '/') return html('<footer><a href="/terms">ご利用規約</a></footer>');
    if (u.pathname === '/terms') return html(`<h1>利用規約</h1>${LONG_TERMS}<p>第3条 ロボットやスクレイピングなど自動的な手段による情報の収集を禁止します。本サービスで得た情報を商業的に利用することを禁止します。</p>`);
  }
  if (u.hostname === 't-none.test' && u.pathname === '/') return html('<p>トップ</p>');
  if (u.hostname === 'plain.test' && u.pathname === '/') return html('<title>Plain Coffee\n &ndash; 自家焙煎</title><p>トップ</p>'); // Shopify ではないお店（og:site_name なし）
  if (u.hostname === 'delay.test' || u.hostname === 'nobots.test') return html('<p>ok</p>');
  if (u.hostname === 'shop-e.test') return html('nope', 404);
  return html('not found', 404);
};
