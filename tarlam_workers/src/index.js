/**
 * TARLAM — Cloudflare Workers Backend
 * Firebase Functions'tan taşındı. Firebase Admin SDK yok,
 * her şey Web Crypto API + Firestore REST API ile yapılıyor.
 *
 * Gerekli secret:  SERVICE_ACCOUNT_KEY  (wrangler secret put SERVICE_ACCOUNT_KEY)
 */

// Firebase Auth project ID (token aud/iss doğrulama için)
const FIREBASE_PROJECT_ID = 'tarlam-oyun';
// GCP project ID (Firestore REST API için — service account ile aynı proje)
const GCP_PROJECT_ID      = 'tarlam-oyun-505320-p1';
const FS_BASE      = `https://firestore.googleapis.com/v1/projects/${GCP_PROJECT_ID}/databases/(default)/documents`;
const FIREBASE_ISS = `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`;

// ═══════════════════════════════════════════════════════════
// OYUN KONFİGÜRASYONU
// ═══════════════════════════════════════════════════════════
const GAME_CONFIG = {
  startingGold:   300,
  startingEnergy: 100,
  maxLevel:       100,

  crops: {
    wheat:  { seedCost: 5,  growTime: 30, price: 8,  xp: 5  },
    corn:   { seedCost: 10, growTime: 50, price: 15, xp: 10 },
    tomato: { seedCost: 15, growTime: 70, price: 25, xp: 15 },
    carrot: { seedCost: 12, growTime: 60, price: 20, xp: 12 },
  },

  market: {
    wheat: 8, corn: 15, tomato: 25, carrot: 20,
    meat: 45, wool: 30, egg: 12, milk: 18,
    apple: 20, orange: 24, grape: 28,
  },

  animals: {
    cow:     { buy: 80,  food: 'carrot', produceItem: 'milk', sellPrice: 120, slaughterMeat: 3, gestationDays: 5 },
    sheep:   { buy: 60,  food: 'wheat',  produceItem: 'wool', sellPrice: 90,  slaughterMeat: 2, gestationDays: 4 },
    chicken: { buy: 30,  food: 'corn',   produceItem: 'egg',  sellPrice: 50,  slaughterMeat: 1, gestationDays: 3 },
  },

  orchard: {
    apple:  { seedCost: 30, producePrice: 20, xp: 8  },
    orange: { seedCost: 40, producePrice: 24, xp: 10 },
    grape:  { seedCost: 50, producePrice: 28, xp: 12 },
  },

  energy: {
    hoe:            5,
    water:          3,
    harvest:        4,
    plant:          4,
    feed:           2,
    collect:        2,
    orchardHarvest: 3,
    orchardWater:   2,
  },

  xp: {
    hoe:    2,
    water:  1,
    sleep:  0,
    pickup: 30,
  },

  neighborRewards:          { min: 40, max: 90 },
  questRewardXpMultiplier:  1,
  pickupCargoValue:         28,
  sleepEnergyRestore:       40,
  rateLimitPerMinute:       120,
};

// ═══════════════════════════════════════════════════════════
// BASE64URL YARDIMCILARI
// ═══════════════════════════════════════════════════════════

function b64url(str) {
  return btoa(str).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function b64urlBytes(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function b64urlDecode(s) {
  const p = s.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(p.padEnd(p.length + (4 - p.length % 4) % 4, '=')), c => c.charCodeAt(0));
}

// ═══════════════════════════════════════════════════════════
// FİRESTORE DEĞER DÖNÜŞTÜRÜCÜLER
// ═══════════════════════════════════════════════════════════

function toFsValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean')        return { booleanValue: v };
  if (typeof v === 'number')
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string')  return { stringValue: v };
  if (v instanceof Date)      return { timestampValue: v.toISOString() };
  if (Array.isArray(v))       return { arrayValue: { values: v.map(toFsValue) } };
  if (typeof v === 'object')  return { mapValue: { fields: toFsFields(v) } };
  return { stringValue: String(v) };
}

function toFsFields(obj) {
  const fields = {};
  for (const [k, val] of Object.entries(obj)) fields[k] = toFsValue(val);
  return fields;
}

function fromFsValue(v) {
  if (!v)                    return null;
  if ('nullValue'      in v) return null;
  if ('booleanValue'   in v) return v.booleanValue;
  if ('integerValue'   in v) return parseInt(v.integerValue, 10);
  if ('doubleValue'    in v) return v.doubleValue;
  if ('stringValue'    in v) return v.stringValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue'     in v) return (v.arrayValue.values || []).map(fromFsValue);
  if ('mapValue'       in v) return fromFsFields(v.mapValue.fields || {});
  return null;
}

function fromFsFields(fields) {
  const obj = {};
  for (const [k, v] of Object.entries(fields)) obj[k] = fromFsValue(v);
  return obj;
}

// ═══════════════════════════════════════════════════════════
// GOOGLE SERVICE ACCOUNT YETKİLENDİRME
// ═══════════════════════════════════════════════════════════

let _adminTok    = null;
let _adminExp    = 0;

async function getAdminToken(env) {
  if (!env.SERVICE_ACCOUNT_KEY) throw new Error('SERVICE_ACCOUNT_KEY secret eksik');
  const sa = JSON.parse(env.SERVICE_ACCOUNT_KEY);
  console.log('[DEBUG] SA email:', sa.client_email, '| project:', sa.project_id);
  if (_adminTok && Date.now() < _adminExp - 60_000) return _adminTok;

  const now = Math.floor(Date.now() / 1000);
  const hdr = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const cla = b64url(JSON.stringify({
    iss:   sa.client_email,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud:   'https://oauth2.googleapis.com/token',
    iat:   now,
    exp:   now + 3600,
  }));

  // PKCS8 private key → CryptoKey
  const pemBody  = sa.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const keyBytes = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8', keyBytes,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  );

  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', cryptoKey,
    new TextEncoder().encode(`${hdr}.${cla}`)
  );
  const jwt = `${hdr}.${cla}.${b64urlBytes(new Uint8Array(sig))}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  if (!res.ok) throw new Error(`Google token alınamadı: ${res.status}`);

  const { access_token, expires_in } = await res.json();
  _adminTok = access_token;
  _adminExp = Date.now() + (expires_in || 3600) * 1000;
  return _adminTok;
}

// ═══════════════════════════════════════════════════════════
// FİREBASE JWT DOĞRULAMA (Web Crypto API)
// ═══════════════════════════════════════════════════════════

let _fbKeys    = null;
let _fbKeysExp = 0;

async function getFirebasePublicKeys() {
  if (_fbKeys && Date.now() < _fbKeysExp) return _fbKeys;
  const res    = await fetch('https://www.googleapis.com/robot/v1/metadata/jwk/securetoken@system.gserviceaccount.com');
  const maxAge = parseInt(res.headers.get('cache-control')?.match(/max-age=(\d+)/)?.[1] || '3600', 10);
  _fbKeys    = (await res.json()).keys;
  _fbKeysExp = Date.now() + maxAge * 1000;
  return _fbKeys;
}

async function verifyFirebaseToken(authHeader) {
  if (!authHeader?.startsWith('Bearer ')) throw new Error('Token yok');
  const token = authHeader.slice(7);
  const parts  = token.split('.');
  if (parts.length !== 3) throw new Error('Geçersiz JWT formatı');

  const header  = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[0])));
  const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1])));

  if (payload.aud !== FIREBASE_PROJECT_ID) throw new Error('Yanlış audience');
  if (payload.iss !== FIREBASE_ISS) throw new Error('Yanlış issuer');
  if (payload.exp < Date.now() / 1000) throw new Error('Token süresi dolmuş');

  const keys = await getFirebasePublicKeys();
  const jwk  = keys.find(k => k.kid === header.kid);
  if (!jwk) throw new Error('Anahtar bulunamadı');

  const cryptoKey = await crypto.subtle.importKey(
    'jwk', jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['verify']
  );
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5', cryptoKey,
    b64urlDecode(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
  );
  if (!valid) throw new Error('İmza geçersiz');

  return payload.user_id || payload.sub;
}

// ═══════════════════════════════════════════════════════════
// FİRESTORE CRUD (REST API)
// ═══════════════════════════════════════════════════════════

async function fsGet(path, tok) {
  const res = await fetch(`${FS_BASE}/${path}`, {
    headers: { Authorization: `Bearer ${tok}` }
  });
  if (res.status === 404) return null;
  if (!res.ok) { const body = await res.text(); throw new Error(`fsGet hata ${res.status}: ${body}`); }
  const doc = await res.json();
  return doc.fields ? fromFsFields(doc.fields) : null;
}

async function fsSet(path, data, tok) {
  const res = await fetch(`${FS_BASE}/${path}`, {
    method:  'PATCH',
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ fields: toFsFields(data) }),
  });
  if (!res.ok) throw new Error(`fsSet hata ${res.status}: ${await res.text()}`);
}

async function fsUpdate(path, delta, tok) {
  const withTs = { ...delta, lastAction: new Date().toISOString() };
  const mask   = Object.keys(withTs)
    .map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`)
    .join('&');
  const res = await fetch(`${FS_BASE}/${path}?${mask}`, {
    method:  'PATCH',
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ fields: toFsFields(withTs) }),
  });
  if (!res.ok) throw new Error(`fsUpdate hata ${res.status}: ${await res.text()}`);
}

async function fsAdd(collPath, data, tok) {
  const res = await fetch(`${FS_BASE}/${collPath}`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ fields: toFsFields(data) }),
  });
  if (!res.ok) throw new Error(`fsAdd hata ${res.status}`);
}

// ═══════════════════════════════════════════════════════════
// RATE LIMIT
// ═══════════════════════════════════════════════════════════

async function rateLimit(uid, tok) {
  const path = `ratelimit/${uid}`;
  const now  = Date.now();
  const d    = (await fsGet(path, tok)) || { count: 0, window: 0 };

  if (now - (d.window || 0) > 60_000) {
    await fsSet(path, { count: 1, window: now }, tok);
    return true;
  }
  if ((d.count || 0) >= GAME_CONFIG.rateLimitPerMinute) return false;
  await fsSet(path, { count: (d.count || 0) + 1, window: d.window }, tok);
  return true;
}

// ═══════════════════════════════════════════════════════════
// RESPONSE YARDIMCILARI
// ═══════════════════════════════════════════════════════════

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const ok  = (d, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });
const err = (msg, s = 400) => ok({ error: msg }, s);

// ═══════════════════════════════════════════════════════════
// OYUN YARDIMCI FONKSİYONLARI
// ═══════════════════════════════════════════════════════════

function calcXP(currentXP, currentLevel, currentMaxXP, gainedXP) {
  let xp = currentXP + gainedXP, level = currentLevel, maxXp = currentMaxXP;
  let maxEnergy = 100 + (level - 1) * 10;
  while (xp >= maxXp) {
    xp -= maxXp; level++;
    maxXp     = Math.floor(maxXp * 1.4);
    maxEnergy = 100 + (level - 1) * 10;
  }
  return { xp, level, maxXp, maxEnergy };
}

function spendEnergy(data, cost) {
  if ((data.energy || 0) < cost) return { ok: false, reason: '⚡ Enerji yetersiz!' };
  return { ok: true, newEnergy: data.energy - cost };
}

// ═══════════════════════════════════════════════════════════
// AKSİYON SARMALAYICI
// ═══════════════════════════════════════════════════════════

async function act(req, env, fn, noGameData = false) {
  try {
    const uid = await verifyFirebaseToken(req.headers.get('Authorization'));
    const tok = await getAdminToken(env);
    if (!(await rateLimit(uid, tok))) return err('Çok fazla istek. Bir dakika bekle.', 429);
    if (noGameData) return await fn(uid, null, null, tok);
    const data = await fsGet(`users/${uid}/gameData/save`, tok);
    if (!data) return err('Oyun verisi bulunamadı', 404);
    const body = await req.json().catch(() => ({}));
    return await fn(uid, data, body, tok);
  } catch (e) {
    if (/Token|token|imza|Yanlış|audience|issuer/.test(e.message))
      return err(`Yetkisiz: ${e.message}`, 401);
    console.error('[TARLAM]', e.stack || e.message);
    return err('Sunucu hatası', 500);
  }
}

// ═══════════════════════════════════════════════════════════
// ENDPOINTler
// ═══════════════════════════════════════════════════════════

const routes = {

  // ── YENİ OYUNCU ──────────────────────────────────────────
  createPlayer(req, env) {
    return act(req, env, async (uid, _d, _b, tok) => {
      const existing = await fsGet(`users/${uid}/gameData/save`, tok);
      if (existing) return ok({ success: true, alreadyExists: true });

      const tiles = [];
      for (let r = 0; r < 5; r++)
        for (let c = 0; c < 6; c++)
          tiles.push({ c, r, state: 'grass', crop: null, growProgress: 0, watered: false });

      await fsSet(`users/${uid}/gameData/save`, {
        gold:        GAME_CONFIG.startingGold,
        energy:      GAME_CONFIG.startingEnergy,
        maxEnergy:   GAME_CONFIG.startingEnergy,
        level: 1, xp: 0, maxXp: 100,
        dayCount: 1, gameTime: 360, weather: 'sunny', weatherTimer: 300,
        totalGoldEarned: 0,
        inventory: { wheat:0, corn:0, tomato:0, carrot:0, meat:0, wool:0, egg:0, milk:0, apple:0, orange:0, grape:0 },
        tiles,
        animals: [], animalId: 1,
        orchardSlots: [
          { side:'left',  idx:0, type:'apple',  stage:0, growTimer:0, fruitsReady:0, watered:false },
          { side:'left',  idx:1, type:'orange', stage:0, growTimer:0, fruitsReady:0, watered:false },
          { side:'right', idx:0, type:'grape',  stage:0, growTimer:0, fruitsReady:0, watered:false },
          { side:'right', idx:1, type:'apple',  stage:0, growTimer:0, fruitsReady:0, watered:false },
        ],
        activeQuests: [], completedQuests: [],
        questProgress: { harvest:0, buy_animal:0, feed_animal:0, pickup:0, earn_gold:0, water:0, slaughter:0, give_neighbor:0, breed:0 },
        neighborRequests: [],
        createdAt:  new Date().toISOString(),
        lastAction: new Date().toISOString(),
      }, tok);

      await fsAdd(`users/${uid}/logs`, { type: 'created', timestamp: new Date().toISOString() }, tok);
      return ok({ success: true, startingGold: GAME_CONFIG.startingGold });
    }, true);
  },

  // ── TARLA AKSİYONLARI ─────────────────────────────────────

  tillTile: (req, env) => act(req, env, async (uid, data, { c, r }, tok) => {
    const tile = (data.tiles || []).find(t => t.c === c && t.r === r);
    if (!tile) return err('Kare bulunamadı');
    if (tile.state !== 'grass') return err('Zaten hazır');
    const eng = spendEnergy(data, GAME_CONFIG.energy.hoe);
    if (!eng.ok) return err(eng.reason);
    const newTiles = data.tiles.map(t => t.c === c && t.r === r ? { ...t, state: 'tilled' } : t);
    const lvl = calcXP(data.xp, data.level, data.maxXp, GAME_CONFIG.xp.hoe);
    await fsUpdate(`users/${uid}/gameData/save`, { tiles: newTiles, energy: eng.newEnergy, ...lvl }, tok);
    return ok({ success: true, newEnergy: eng.newEnergy, ...lvl });
  }),

  waterTile: (req, env) => act(req, env, async (uid, data, { c, r }, tok) => {
    const tile = (data.tiles || []).find(t => t.c === c && t.r === r);
    if (!tile) return err('Kare bulunamadı');
    if (tile.state !== 'tilled' && tile.state !== 'planted') return err('Sulanacak kare yok');
    if (tile.watered) return err('Zaten sulandı');
    const eng = spendEnergy(data, GAME_CONFIG.energy.water);
    if (!eng.ok) return err(eng.reason);
    const rainBonus = data.weather === 'rainy' || data.weather === 'stormy';
    const newTiles  = data.tiles.map(t =>
      t.c === c && t.r === r ? { ...t, watered: true, waterTimer: rainBonus ? 200 : 120 } : t
    );
    await fsUpdate(`users/${uid}/gameData/save`, { tiles: newTiles, energy: eng.newEnergy }, tok);
    return ok({ success: true, newEnergy: eng.newEnergy, rainBonus });
  }),

  plantCrop: (req, env) => act(req, env, async (uid, data, { c, r, cropType }, tok) => {
    const cropDef = GAME_CONFIG.crops[cropType];
    if (!cropDef) return err('Geçersiz ürün türü');
    const tile = (data.tiles || []).find(t => t.c === c && t.r === r);
    if (!tile) return err('Kare bulunamadı');
    if (tile.state !== 'tilled') return err('Toprak hazır değil');
    if ((data.gold || 0) < cropDef.seedCost) return err(`Yeterli altın yok (gereken: ${cropDef.seedCost}₺)`);
    const eng = spendEnergy(data, GAME_CONFIG.energy.plant);
    if (!eng.ok) return err(eng.reason);
    const newTiles = data.tiles.map(t =>
      t.c === c && t.r === r ? { ...t, state: 'planted', crop: cropType, growProgress: 0, watered: false } : t
    );
    const newGold = (data.gold || 0) - cropDef.seedCost;
    await fsUpdate(`users/${uid}/gameData/save`, { tiles: newTiles, gold: newGold, energy: eng.newEnergy }, tok);
    return ok({ success: true, newGold, newEnergy: eng.newEnergy, seedCost: cropDef.seedCost });
  }),

  harvestCrop: (req, env) => act(req, env, async (uid, data, { c, r }, tok) => {
    const tile = (data.tiles || []).find(t => t.c === c && t.r === r);
    if (!tile) return err('Kare bulunamadı');
    if (tile.state !== 'ready') return err('Hasat zamanı değil');
    const cropDef = GAME_CONFIG.crops[tile.crop];
    if (!cropDef) return err('Geçersiz ürün');
    const eng = spendEnergy(data, GAME_CONFIG.energy.harvest);
    if (!eng.ok) return err(eng.reason);
    const cropType = tile.crop;
    const newTiles = data.tiles.map(t =>
      t.c === c && t.r === r ? { ...t, state: 'tilled', crop: null, growProgress: 0, watered: false } : t
    );
    const inv    = data.inventory || {};
    const newInv = { ...inv, [cropType]: (inv[cropType] || 0) + 1 };
    const qp     = { ...(data.questProgress || {}), harvest: ((data.questProgress || {}).harvest || 0) + 1 };
    const lvl    = calcXP(data.xp, data.level, data.maxXp, cropDef.xp);
    await fsUpdate(`users/${uid}/gameData/save`, { tiles: newTiles, inventory: newInv, energy: eng.newEnergy, questProgress: qp, ...lvl }, tok);
    return ok({ success: true, cropType, newEnergy: eng.newEnergy, inventory: newInv, ...lvl });
  }),

  // ── PAZAR ─────────────────────────────────────────────────

  sellItem: (req, env) => act(req, env, async (uid, data, { itemKey }, tok) => {
    const price = GAME_CONFIG.market[itemKey];
    if (!price) return err('Geçersiz ürün');
    const inv = data.inventory || {};
    const qty = inv[itemKey] || 0;
    if (qty <= 0) return err('Satacak ürün yok');
    const earned       = qty * price;
    const newGold      = (data.gold || 0) + earned;
    const newTotalGold = (data.totalGoldEarned || 0) + earned;
    const newInv       = { ...inv, [itemKey]: 0 };
    const lvl          = calcXP(data.xp, data.level, data.maxXp, 5);
    await fsUpdate(`users/${uid}/gameData/save`, { gold: newGold, totalGoldEarned: newTotalGold, inventory: newInv, ...lvl }, tok);
    return ok({ success: true, earned, newGold, qty, ...lvl });
  }),

  sellAllItems: (req, env) => act(req, env, async (uid, data, _b, tok) => {
    const inv    = data.inventory || {};
    let   total  = 0;
    const newInv = { ...inv };
    Object.entries(GAME_CONFIG.market).forEach(([k, price]) => {
      total   += (inv[k] || 0) * price;
      newInv[k] = 0;
    });
    if (total === 0) return err('Satacak ürün yok');
    const newGold      = (data.gold || 0) + total;
    const newTotalGold = (data.totalGoldEarned || 0) + total;
    const lvl          = calcXP(data.xp, data.level, data.maxXp, 15);
    await fsUpdate(`users/${uid}/gameData/save`, { gold: newGold, totalGoldEarned: newTotalGold, inventory: newInv, ...lvl }, tok);
    return ok({ success: true, total, newGold, inventory: newInv, ...lvl });
  }),

  // ── HAYVANLAR ─────────────────────────────────────────────

  buyAnimal: (req, env) => act(req, env, async (uid, data, { animalType }, tok) => {
    const def = GAME_CONFIG.animals[animalType];
    if (!def) return err('Geçersiz hayvan türü');
    if ((data.gold || 0) < def.buy) return err(`Yeterli altın yok (gereken: ${def.buy}₺)`);
    const newId     = (data.animalId || 1) + 1;
    const newAnimal = {
      id: newId, type: animalType,
      name: animalType === 'cow' ? `İnek #${newId}` : animalType === 'sheep' ? `Koyun #${newId}` : `Tavuk #${newId}`,
      hunger: 100, happy: 100, age: 0,
      pregnant: false, pregnancyDays: 0, readyProduce: false, produceTimer: 0,
    };
    const qp  = { ...(data.questProgress || {}), buy_animal: ((data.questProgress || {}).buy_animal || 0) + 1 };
    const lvl = calcXP(data.xp, data.level, data.maxXp, 15);
    await fsUpdate(`users/${uid}/gameData/save`, {
      gold: (data.gold || 0) - def.buy,
      animals: [...(data.animals || []), newAnimal],
      animalId: newId, questProgress: qp, ...lvl,
    }, tok);
    return ok({ success: true, newGold: data.gold - def.buy, animal: newAnimal, ...lvl });
  }),

  feedAnimal: (req, env) => act(req, env, async (uid, data, { animalId }, tok) => {
    const animals = data.animals || [];
    const aIdx    = animals.findIndex(a => a.id === animalId);
    if (aIdx < 0) return err('Hayvan bulunamadı');
    const animal  = animals[aIdx];
    const def     = GAME_CONFIG.animals[animal.type];
    const inv     = data.inventory || {};
    if ((inv[def.food] || 0) < 1) return err(`Yem yok (gereken: ${def.food})`);
    const newAnimals = animals.map((a, i) =>
      i === aIdx ? { ...a, hunger: Math.min(100, a.hunger + 40), happy: Math.min(100, a.happy + 25) } : a
    );
    const newInv = { ...inv, [def.food]: (inv[def.food] || 0) - 1 };
    const qp     = { ...(data.questProgress || {}), feed_animal: ((data.questProgress || {}).feed_animal || 0) + 1 };
    await fsUpdate(`users/${uid}/gameData/save`, { animals: newAnimals, inventory: newInv, questProgress: qp }, tok);
    return ok({ success: true, animalId, newHunger: Math.min(100, animal.hunger + 40), inventory: newInv });
  }),

  collectProduce: (req, env) => act(req, env, async (uid, data, { animalId }, tok) => {
    const animals = data.animals || [];
    const aIdx    = animals.findIndex(a => a.id === animalId);
    if (aIdx < 0) return err('Hayvan bulunamadı');
    const animal  = animals[aIdx];
    if (!animal.readyProduce) return err('Ürün hazır değil');
    const def        = GAME_CONFIG.animals[animal.type];
    const newAnimals = animals.map((a, i) => i === aIdx ? { ...a, readyProduce: false, produceTimer: 0 } : a);
    const inv        = data.inventory || {};
    const newInv     = { ...inv, [def.produceItem]: (inv[def.produceItem] || 0) + 1 };
    const lvl        = calcXP(data.xp, data.level, data.maxXp, 8);
    await fsUpdate(`users/${uid}/gameData/save`, { animals: newAnimals, inventory: newInv, ...lvl }, tok);
    return ok({ success: true, produceItem: def.produceItem, inventory: newInv, ...lvl });
  }),

  breedAnimal: (req, env) => act(req, env, async (uid, data, { animalId }, tok) => {
    const animals = data.animals || [];
    const animal  = animals.find(a => a.id === animalId);
    if (!animal) return err('Hayvan bulunamadı');
    if (animal.pregnant) return err('Zaten gebe');
    if (animals.filter(a => a.type === animal.type).length < 2) return err('Aynı türden 2. hayvan gerekli');
    const newAnimals = animals.map(a => a.id === animalId ? { ...a, pregnant: true, pregnancyDays: 0 } : a);
    await fsUpdate(`users/${uid}/gameData/save`, { animals: newAnimals }, tok);
    return ok({ success: true, gestationDays: GAME_CONFIG.animals[animal.type].gestationDays });
  }),

  slaughterAnimal: (req, env) => act(req, env, async (uid, data, { animalId }, tok) => {
    const animals = data.animals || [];
    const animal  = animals.find(a => a.id === animalId);
    if (!animal) return err('Hayvan bulunamadı');
    const def        = GAME_CONFIG.animals[animal.type];
    const newAnimals = animals.filter(a => a.id !== animalId);
    const inv        = data.inventory || {};
    const newInv     = { ...inv, meat: (inv.meat || 0) + def.slaughterMeat };
    const qp         = { ...(data.questProgress || {}), slaughter: ((data.questProgress || {}).slaughter || 0) + def.slaughterMeat };
    const lvl        = calcXP(data.xp, data.level, data.maxXp, 10);
    await fsUpdate(`users/${uid}/gameData/save`, { animals: newAnimals, inventory: newInv, questProgress: qp, ...lvl }, tok);
    return ok({ success: true, meatGained: def.slaughterMeat, inventory: newInv, ...lvl });
  }),

  sellAnimal: (req, env) => act(req, env, async (uid, data, { animalId }, tok) => {
    const animals = data.animals || [];
    const animal  = animals.find(a => a.id === animalId);
    if (!animal) return err('Hayvan bulunamadı');
    const def          = GAME_CONFIG.animals[animal.type];
    const newGold      = (data.gold || 0) + def.sellPrice;
    const newTotalGold = (data.totalGoldEarned || 0) + def.sellPrice;
    const newAnimals   = animals.filter(a => a.id !== animalId);
    const lvl          = calcXP(data.xp, data.level, data.maxXp, 5);
    await fsUpdate(`users/${uid}/gameData/save`, { animals: newAnimals, gold: newGold, totalGoldEarned: newTotalGold, ...lvl }, tok);
    return ok({ success: true, newGold, earned: def.sellPrice, ...lvl });
  }),

  // ── BAHÇE ─────────────────────────────────────────────────

  plantOrchardTree: (req, env) => act(req, env, async (uid, data, { side, idx, treeType }, tok) => {
    const def = GAME_CONFIG.orchard[treeType];
    if (!def) return err('Geçersiz ağaç türü');
    if ((data.gold || 0) < def.seedCost) return err(`Yeterli altın yok (gereken: ${def.seedCost}₺)`);
    const slots   = data.orchardSlots || [];
    const slotIdx = slots.findIndex(s => s.side === side && s.idx === idx);
    if (slotIdx < 0) return err('Yuva bulunamadı');
    const newSlots = slots.map((s, i) =>
      i === slotIdx ? { ...s, type: treeType, stage: 1, growTimer: 0, fruitsReady: 0 } : s
    );
    const lvl = calcXP(data.xp, data.level, data.maxXp, 5);
    await fsUpdate(`users/${uid}/gameData/save`, { orchardSlots: newSlots, gold: (data.gold || 0) - def.seedCost, ...lvl }, tok);
    return ok({ success: true, newGold: data.gold - def.seedCost, ...lvl });
  }),

  harvestOrchard: (req, env) => act(req, env, async (uid, data, { side, idx }, tok) => {
    const slots   = data.orchardSlots || [];
    const slotIdx = slots.findIndex(s => s.side === side && s.idx === idx);
    if (slotIdx < 0) return err('Yuva bulunamadı');
    const slot = slots[slotIdx];
    if (slot.stage !== 3 || slot.fruitsReady <= 0) return err('Meyve hazır değil');
    const eng = spendEnergy(data, GAME_CONFIG.energy.orchardHarvest);
    if (!eng.ok) return err(eng.reason);
    const def      = GAME_CONFIG.orchard[slot.type];
    const count    = slot.fruitsReady;
    const newSlots = slots.map((s, i) => i === slotIdx ? { ...s, fruitsReady: 0, growTimer: 0 } : s);
    const inv      = data.inventory || {};
    const newInv   = { ...inv, [slot.type]: (inv[slot.type] || 0) + count };
    const lvl      = calcXP(data.xp, data.level, data.maxXp, count * (def?.xp || 8));
    await fsUpdate(`users/${uid}/gameData/save`, { orchardSlots: newSlots, inventory: newInv, energy: eng.newEnergy, ...lvl }, tok);
    return ok({ success: true, treeType: slot.type, count, newEnergy: eng.newEnergy, inventory: newInv, ...lvl });
  }),

  waterOrchard: (req, env) => act(req, env, async (uid, data, { side, idx }, tok) => {
    const slots   = data.orchardSlots || [];
    const slotIdx = slots.findIndex(s => s.side === side && s.idx === idx);
    if (slotIdx < 0) return err('Yuva bulunamadı');
    if (slots[slotIdx].stage < 1) return err('Ağaç yok');
    const eng = spendEnergy(data, GAME_CONFIG.energy.orchardWater);
    if (!eng.ok) return err(eng.reason);
    const newSlots = slots.map((s, i) => i === slotIdx ? { ...s, watered: true } : s);
    await fsUpdate(`users/${uid}/gameData/save`, { orchardSlots: newSlots, energy: eng.newEnergy }, tok);
    return ok({ success: true, newEnergy: eng.newEnergy });
  }),

  // ── KOMŞU & GÖREV ─────────────────────────────────────────

  giveNeighbor: (req, env) => act(req, env, async (uid, data, { requestIndex }, tok) => {
    const reqs = data.neighborRequests || [];
    const req2 = reqs[requestIndex];
    if (!req2 || req2.fulfilled) return err('Geçersiz veya zaten tamamlanmış talep');
    const inv = data.inventory || {};
    if ((inv[req2.type] || 0) < req2.qty) return err('Yeterli ürün yok');
    const reward       = req2.reward;
    const newInv       = { ...inv, [req2.type]: (inv[req2.type] || 0) - req2.qty };
    const newGold      = (data.gold || 0) + reward;
    const newTotalGold = (data.totalGoldEarned || 0) + reward;
    const newReqs      = reqs.map((r, i) => i === requestIndex ? { ...r, fulfilled: true } : r);
    const qp           = { ...(data.questProgress || {}), give_neighbor: ((data.questProgress || {}).give_neighbor || 0) + 1 };
    const lvl          = calcXP(data.xp, data.level, data.maxXp, 20);
    await fsUpdate(`users/${uid}/gameData/save`, {
      inventory: newInv, gold: newGold, totalGoldEarned: newTotalGold,
      neighborRequests: newReqs, questProgress: qp, ...lvl,
    }, tok);
    return ok({ success: true, reward, newGold, inventory: newInv, ...lvl });
  }),

  claimQuest: (req, env) => act(req, env, async (uid, data, { questId }, tok) => {
    const activeQuests = data.activeQuests || [];
    const qIdx = activeQuests.findIndex(q => q.id === questId && q.done);
    if (qIdx < 0) return err('Görev bulunamadı veya tamamlanmamış');
    const quest        = activeQuests[qIdx];
    const newGold      = (data.gold || 0) + quest.reward;
    const newTotalGold = (data.totalGoldEarned || 0) + quest.reward;
    const completed    = [...(data.completedQuests || []), questId];
    const newActive    = activeQuests.filter(q => q.id !== questId);
    const lvl          = calcXP(data.xp, data.level, data.maxXp, quest.xpReward || 0);
    await fsUpdate(`users/${uid}/gameData/save`, {
      gold: newGold, totalGoldEarned: newTotalGold,
      activeQuests: newActive, completedQuests: completed, ...lvl,
    }, tok);
    return ok({ success: true, reward: quest.reward, newGold, completedQuests: completed, ...lvl });
  }),

  // ── GÜN SONU & MİNİ OYUNLAR ───────────────────────────────

  sleep: (req, env) => act(req, env, async (uid, data, _b, tok) => {
    if ((data.energy || 0) >= (data.maxEnergy || 100)) return err('Enerji zaten dolu');
    const newEnergy  = data.maxEnergy || 100;
    const newDay     = (data.dayCount || 1) + 1;
    const newGameTime = 6 * 60;
    const newAnimals = (data.animals || []).map(a => ({ ...a, hunger: Math.max(0, (a.hunger || 0) - 15) }));
    await fsUpdate(`users/${uid}/gameData/save`, { energy: newEnergy, dayCount: newDay, gameTime: newGameTime, animals: newAnimals }, tok);
    return ok({ success: true, newEnergy, newDay, newGameTime });
  }),

  completePickup: (req, env) => act(req, env, async (uid, data, { score, won }, tok) => {
    const MAX_SCORE = 700;
    if (typeof score !== 'number' || score < 0 || score > MAX_SCORE) return err('Geçersiz skor');
    const newGold      = (data.gold || 0) + score;
    const newTotalGold = (data.totalGoldEarned || 0) + score;
    const xpGain       = won ? GAME_CONFIG.xp.pickup : 10;
    const qp           = { ...(data.questProgress || {}), pickup: ((data.questProgress || {}).pickup || 0) + 1 };
    const lvl          = calcXP(data.xp, data.level, data.maxXp, xpGain);
    await fsUpdate(`users/${uid}/gameData/save`, { gold: newGold, totalGoldEarned: newTotalGold, questProgress: qp, ...lvl }, tok);
    return ok({ success: true, newGold, ...lvl });
  }),

  completeMiniGame: (req, env) => act(req, env, async (uid, data, { animalId, produceType, count }, tok) => {
    if (!['egg', 'milk', 'wool'].includes(produceType)) return err('Geçersiz ürün türü');
    if (typeof count !== 'number' || count < 0 || count > 20) return err('Geçersiz miktar');
    const animals    = data.animals || [];
    const animal     = animals.find(a => a.id === animalId);
    if (!animal) return err('Hayvan bulunamadı');
    const newAnimals = animals.map(a => a.id === animalId ? { ...a, happy: Math.min(100, (a.happy || 0) + 15) } : a);
    const inv        = data.inventory || {};
    const newInv     = { ...inv, [produceType]: (inv[produceType] || 0) + count };
    const lvl        = calcXP(data.xp, data.level, data.maxXp, count * 5);
    await fsUpdate(`users/${uid}/gameData/save`, { animals: newAnimals, inventory: newInv, ...lvl }, tok);
    return ok({ success: true, inventory: newInv, ...lvl });
  }),

  syncGameState: (req, env) => act(req, env, async (uid, _data, body, tok) => {
    const { tiles, orchardSlots, animals, gameTime, weather, weatherTimer, dayCount } = body;
    const delta = {};
    if (tiles)                            delta.tiles        = tiles;
    if (orchardSlots)                     delta.orchardSlots = orchardSlots;
    if (animals)                          delta.animals      = animals;
    if (typeof gameTime     === 'number') delta.gameTime     = gameTime;
    if (typeof dayCount     === 'number') delta.dayCount     = dayCount;
    if (weather)                          delta.weather      = weather;
    if (typeof weatherTimer === 'number') delta.weatherTimer = weatherTimer;
    if (Object.keys(delta).length === 0) return err('Güncellenecek alan yok');
    await fsUpdate(`users/${uid}/gameData/save`, delta, tok);
    return ok({ success: true });
  }),
};

// ═══════════════════════════════════════════════════════════
// ROUTER — ana giriş noktası
// ═══════════════════════════════════════════════════════════

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS')
      return new Response(null, { status: 204, headers: CORS });

    const url     = new URL(request.url);
    const action  = url.pathname.replace(/^\/+/, '');
    const handler = routes[action];

    if (!handler) return err(`Bilinmeyen endpoint: ${action}`, 404);
    if (request.method !== 'POST') return err('Yalnızca POST', 405);

    return handler(request, env);
  },
};
