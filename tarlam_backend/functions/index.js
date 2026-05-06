/**
 * TARLAM — Firebase Cloud Functions
 * Tüm oyun aksiyonları sunucuda işlenir.
 * Client yalnızca sonucu alır ve ekranda gösterir.
 */

const functions = require("firebase-functions");
const admin     = require("firebase-admin");
admin.initializeApp();

const db = admin.firestore();

// ═══════════════════════════════════════════════════════════
// SABİT DEĞERLER — Remote Config yerine buraya yazılmış
// Firebase Console → Remote Config üzerinden yönetmek için
// getConfig() fonksiyonunu yorumdan çıkarın.
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
    cow:     { buy: 80,  food: "carrot", produceItem: "milk", sellPrice: 120, slaughterMeat: 3, gestationDays: 5 },
    sheep:   { buy: 60,  food: "wheat",  produceItem: "wool", sellPrice: 90,  slaughterMeat: 2, gestationDays: 4 },
    chicken: { buy: 30,  food: "corn",   produceItem: "egg",  sellPrice: 50,  slaughterMeat: 1, gestationDays: 3 },
  },

  orchard: {
    apple:  { seedCost: 30, producePrice: 20, xp: 8  },
    orange: { seedCost: 40, producePrice: 24, xp: 10 },
    grape:  { seedCost: 50, producePrice: 28, xp: 12 },
  },

  energy: {
    hoe:     5,
    water:   3,
    harvest: 4,
    plant:   4,
    feed:    2,
    collect: 2,
    orchardHarvest: 3,
    orchardWater:   2,
  },

  xp: {
    hoe:    2,
    water:  1,
    sleep:  0,
    pickup: 30,
  },

  neighborRewards: { min: 40, max: 90 },
  questRewardXpMultiplier: 1,
  pickupCargoValue: 28,
  sleepEnergyRestore: 40,
  rateLimitPerMinute: 120,
};

// ═══════════════════════════════════════════════════════════
// YARDIMCI FONKSİYONLAR
// ═══════════════════════════════════════════════════════════

/** CORS header'ları ayarla */
function cors(res) {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
}

/** OPTIONS preflight isteğini yanıtla */
function handlePreflight(req, res) {
  cors(res);
  if (req.method === "OPTIONS") { res.status(204).send(""); return true; }
  return false;
}

/** Firebase JWT token doğrula — uid döndür */
async function verifyToken(req, res) {
  cors(res);
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) {
    res.status(401).json({ error: "Yetkisiz: token yok" });
    return null;
  }
  try {
    const decoded = await admin.auth().verifyIdToken(auth.slice(7));
    return decoded.uid;
  } catch (e) {
    res.status(401).json({ error: "Yetkisiz: geçersiz token" });
    return null;
  }
}

/** Basit rate limiter — Firestore tabanlı, dakika başına N istek */
async function rateLimit(uid) {
  const ref  = db.doc(`ratelimit/${uid}`);
  const now  = Date.now();
  const snap = await ref.get();
  const d    = snap.exists ? snap.data() : { count: 0, window: now };

  if (now - d.window > 60000) {
    await ref.set({ count: 1, window: now });
    return true;
  }
  if (d.count >= GAME_CONFIG.rateLimitPerMinute) return false;
  await ref.update({ count: admin.firestore.FieldValue.increment(1) });
  return true;
}

/** Oyun verisini getir */
async function getGameData(uid) {
  const snap = await db.doc(`users/${uid}/gameData/save`).get();
  return snap.exists ? snap.data() : null;
}

/** Oyun verisini kaydet (partial update) */
async function updateGameData(uid, delta) {
  await db.doc(`users/${uid}/gameData/save`).update({
    ...delta,
    lastAction: admin.firestore.FieldValue.serverTimestamp(),
  });
}

/** XP hesapla ve seviye atla */
function calcXP(currentXP, currentLevel, currentMaxXP, gainedXP) {
  let xp    = currentXP + gainedXP;
  let level = currentLevel;
  let maxXp = currentMaxXP;
  let maxEnergy = 100 + (level - 1) * 10;

  while (xp >= maxXp) {
    xp    -= maxXp;
    level++;
    maxXp  = Math.floor(maxXp * 1.4);
    maxEnergy = 100 + (level - 1) * 10;
  }
  return { xp, level, maxXp, maxEnergy };
}

/** Enerji kontrolü ve düşme */
function spendEnergy(data, cost) {
  if ((data.energy || 0) < cost) {
    return { ok: false, reason: "⚡ Enerji yetersiz!" };
  }
  return { ok: true, newEnergy: data.energy - cost };
}

/** Temel request işleyici sarmalayıcı */
async function handleAction(req, res, handler) {
  if (handlePreflight(req, res)) return;
  if (req.method !== "POST") { res.status(405).json({ error: "Yalnızca POST" }); return; }

  const uid = await verifyToken(req, res);
  if (!uid) return;

  if (!(await rateLimit(uid))) {
    res.status(429).json({ error: "Çok fazla istek. Bir dakika bekle." });
    return;
  }

  const data = await getGameData(uid);
  if (!data) { res.status(404).json({ error: "Oyun verisi bulunamadı" }); return; }

  await handler(uid, data, req.body, res);
}

// ═══════════════════════════════════════════════════════════
// AKSİYONLAR
// ═══════════════════════════════════════════════════════════

/** YENİ OYUNCU — kayıt sonrası çağrılır */
exports.createPlayer = functions.https.onRequest(async (req, res) => {
  if (handlePreflight(req, res)) return;
  const uid = await verifyToken(req, res);
  if (!uid) return;

  const existing = await db.doc(`users/${uid}/gameData/save`).get();
  if (existing.exists) {
    res.json({ success: true, alreadyExists: true });
    return;
  }

  const cfg = GAME_CONFIG;
  const initialTiles = [];
  for (let r = 0; r < 5; r++)
    for (let c = 0; c < 6; c++)
      initialTiles.push({ c, r, state: "grass", crop: null, growProgress: 0, watered: false });

  await db.doc(`users/${uid}/gameData/save`).set({
    gold:        cfg.startingGold,
    energy:      cfg.startingEnergy,
    maxEnergy:   cfg.startingEnergy,
    level:       1,
    xp:          0,
    maxXp:       100,
    dayCount:    1,
    gameTime:    360,
    weather:     "sunny",
    weatherTimer: 300,
    totalGoldEarned: 0,
    inventory: { wheat:0, corn:0, tomato:0, carrot:0, meat:0, wool:0, egg:0, milk:0, apple:0, orange:0, grape:0 },
    tiles: initialTiles,
    animals: [],
    animalId: 1,
    orchardSlots: [
      { side:"left",  idx:0, type:"apple",  stage:0, growTimer:0, fruitsReady:0, watered:false },
      { side:"left",  idx:1, type:"orange", stage:0, growTimer:0, fruitsReady:0, watered:false },
      { side:"right", idx:0, type:"grape",  stage:0, growTimer:0, fruitsReady:0, watered:false },
      { side:"right", idx:1, type:"apple",  stage:0, growTimer:0, fruitsReady:0, watered:false },
    ],
    activeQuests: [],
    completedQuests: [],
    questProgress: { harvest:0, buy_animal:0, feed_animal:0, pickup:0, earn_gold:0, water:0, slaughter:0, give_neighbor:0, breed:0 },
    neighborRequests: [],
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    lastAction: admin.firestore.FieldValue.serverTimestamp(),
  });

  // Kayıt logu
  await db.collection(`users/${uid}/logs`).add({
    type: "created", timestamp: admin.firestore.FieldValue.serverTimestamp(),
  });

  res.json({ success: true, startingGold: cfg.startingGold });
});

// ── TARLAM TARLA AKSİYONLARI ──

/** ÇAPALA (grass → tilled) */
exports.tillTile = functions.https.onRequest((req, res) =>
  handleAction(req, res, async (uid, data, body) => {
    const { c, r } = body;
    const tile = (data.tiles || []).find(t => t.c === c && t.r === r);
    if (!tile) return res.status(400).json({ error: "Kare bulunamadı" });
    if (tile.state !== "grass") return res.status(400).json({ error: "Zaten hazır" });

    const eng = spendEnergy(data, GAME_CONFIG.energy.hoe);
    if (!eng.ok) return res.status(400).json({ error: eng.reason });

    const newTiles = data.tiles.map(t =>
      t.c === c && t.r === r ? { ...t, state: "tilled" } : t
    );
    const lvl = calcXP(data.xp, data.level, data.maxXp, GAME_CONFIG.xp.hoe);

    await updateGameData(uid, {
      tiles: newTiles,
      energy: eng.newEnergy,
      ...lvl,
    });
    res.json({ success: true, newEnergy: eng.newEnergy, ...lvl });
  })
);

/** SULA */
exports.waterTile = functions.https.onRequest((req, res) =>
  handleAction(req, res, async (uid, data, body) => {
    const { c, r } = body;
    const tile = (data.tiles || []).find(t => t.c === c && t.r === r);
    if (!tile) return res.status(400).json({ error: "Kare bulunamadı" });
    if (tile.state !== "tilled" && tile.state !== "planted")
      return res.status(400).json({ error: "Sulanacak kare yok" });
    if (tile.watered) return res.status(400).json({ error: "Zaten sulandı" });

    const eng = spendEnergy(data, GAME_CONFIG.energy.water);
    if (!eng.ok) return res.status(400).json({ error: eng.reason });

    const rainBonus = data.weather === "rainy" || data.weather === "stormy";
    const newTiles = data.tiles.map(t =>
      t.c === c && t.r === r
        ? { ...t, watered: true, waterTimer: rainBonus ? 200 : 120 }
        : t
    );

    await updateGameData(uid, { tiles: newTiles, energy: eng.newEnergy });
    res.json({ success: true, newEnergy: eng.newEnergy, rainBonus });
  })
);

/** EK (tilled → planted) */
exports.plantCrop = functions.https.onRequest((req, res) =>
  handleAction(req, res, async (uid, data, body) => {
    const { c, r, cropType } = body;
    const cropDef = GAME_CONFIG.crops[cropType];
    if (!cropDef) return res.status(400).json({ error: "Geçersiz ürün türü" });

    const tile = (data.tiles || []).find(t => t.c === c && t.r === r);
    if (!tile) return res.status(400).json({ error: "Kare bulunamadı" });
    if (tile.state !== "tilled") return res.status(400).json({ error: "Toprak hazır değil" });

    if ((data.gold || 0) < cropDef.seedCost)
      return res.status(400).json({ error: `Yeterli altın yok (gereken: ${cropDef.seedCost}₺)` });

    const eng = spendEnergy(data, GAME_CONFIG.energy.plant);
    if (!eng.ok) return res.status(400).json({ error: eng.reason });

    const newTiles = data.tiles.map(t =>
      t.c === c && t.r === r
        ? { ...t, state: "planted", crop: cropType, growProgress: 0, watered: false }
        : t
    );

    await updateGameData(uid, {
      tiles: newTiles,
      gold: (data.gold || 0) - cropDef.seedCost,
      energy: eng.newEnergy,
    });
    res.json({ success: true, newGold: data.gold - cropDef.seedCost, newEnergy: eng.newEnergy, seedCost: cropDef.seedCost });
  })
);

/** HASAT */
exports.harvestCrop = functions.https.onRequest((req, res) =>
  handleAction(req, res, async (uid, data, body) => {
    const { c, r } = body;
    const tile = (data.tiles || []).find(t => t.c === c && t.r === r);
    if (!tile) return res.status(400).json({ error: "Kare bulunamadı" });
    if (tile.state !== "ready") return res.status(400).json({ error: "Hasat zamanı değil" });

    const cropDef = GAME_CONFIG.crops[tile.crop];
    if (!cropDef) return res.status(400).json({ error: "Geçersiz ürün" });

    const eng = spendEnergy(data, GAME_CONFIG.energy.harvest);
    if (!eng.ok) return res.status(400).json({ error: eng.reason });

    const cropType = tile.crop;
    const newTiles = data.tiles.map(t =>
      t.c === c && t.r === r
        ? { ...t, state: "tilled", crop: null, growProgress: 0, watered: false }
        : t
    );
    const newInv = { ...(data.inventory || {}) };
    newInv[cropType] = (newInv[cropType] || 0) + 1;

    const qp = { ...(data.questProgress || {}), harvest: (data.questProgress?.harvest || 0) + 1 };
    const lvl = calcXP(data.xp, data.level, data.maxXp, cropDef.xp);

    await updateGameData(uid, {
      tiles: newTiles,
      inventory: newInv,
      energy: eng.newEnergy,
      questProgress: qp,
      ...lvl,
    });
    res.json({ success: true, cropType, newEnergy: eng.newEnergy, inventory: newInv, ...lvl });
  })
);

// ── PAZAR ──

/** TEK ÜRÜN SAT */
exports.sellItem = functions.https.onRequest((req, res) =>
  handleAction(req, res, async (uid, data, body) => {
    const { itemKey } = body;
    const price = GAME_CONFIG.market[itemKey];
    if (!price) return res.status(400).json({ error: "Geçersiz ürün" });

    const qty = (data.inventory || {})[itemKey] || 0;
    if (qty <= 0) return res.status(400).json({ error: "Satacak ürün yok" });

    const earned = qty * price;
    const newGold = (data.gold || 0) + earned;
    const newTotalGold = (data.totalGoldEarned || 0) + earned;
    const newInv = { ...(data.inventory || {}), [itemKey]: 0 };
    const lvl = calcXP(data.xp, data.level, data.maxXp, 5);

    await updateGameData(uid, {
      gold: newGold, totalGoldEarned: newTotalGold,
      inventory: newInv, ...lvl,
    });
    res.json({ success: true, earned, newGold, qty, ...lvl });
  })
);

/** TÜM ÜRÜNLERİ SAT */
exports.sellAllItems = functions.https.onRequest((req, res) =>
  handleAction(req, res, async (uid, data) => {
    const inv = data.inventory || {};
    let total = 0;
    const newInv = { ...inv };

    Object.entries(GAME_CONFIG.market).forEach(([k, price]) => {
      const qty = inv[k] || 0;
      total += qty * price;
      newInv[k] = 0;
    });

    if (total === 0) return res.status(400).json({ error: "Satacak ürün yok" });

    const newGold = (data.gold || 0) + total;
    const newTotalGold = (data.totalGoldEarned || 0) + total;
    const lvl = calcXP(data.xp, data.level, data.maxXp, 15);

    await updateGameData(uid, {
      gold: newGold, totalGoldEarned: newTotalGold,
      inventory: newInv, ...lvl,
    });
    res.json({ success: true, total, newGold, inventory: newInv, ...lvl });
  })
);

// ── HAYVANLAR ──

/** HAYVAN SATIN AL */
exports.buyAnimal = functions.https.onRequest((req, res) =>
  handleAction(req, res, async (uid, data, body) => {
    const { animalType } = body;
    const def = GAME_CONFIG.animals[animalType];
    if (!def) return res.status(400).json({ error: "Geçersiz hayvan türü" });
    if ((data.gold || 0) < def.buy)
      return res.status(400).json({ error: `Yeterli altın yok (gereken: ${def.buy}₺)` });

    const newId = (data.animalId || 1) + 1;
    const newAnimal = {
      id: newId, type: animalType,
      name: `${animalType === "cow" ? "İnek" : animalType === "sheep" ? "Koyun" : "Tavuk"} #${newId}`,
      hunger: 100, happy: 100, age: 0,
      pregnant: false, pregnancyDays: 0,
      readyProduce: false, produceTimer: 0,
    };

    const qp = { ...(data.questProgress || {}), buy_animal: (data.questProgress?.buy_animal || 0) + 1 };
    const lvl = calcXP(data.xp, data.level, data.maxXp, 15);

    await updateGameData(uid, {
      gold: (data.gold || 0) - def.buy,
      animals: [...(data.animals || []), newAnimal],
      animalId: newId,
      questProgress: qp,
      ...lvl,
    });
    res.json({ success: true, newGold: data.gold - def.buy, animal: newAnimal, ...lvl });
  })
);

/** HAYVAN BESLE */
exports.feedAnimal = functions.https.onRequest((req, res) =>
  handleAction(req, res, async (uid, data, body) => {
    const { animalId } = body;
    const animals = data.animals || [];
    const aIdx = animals.findIndex(a => a.id === animalId);
    if (aIdx < 0) return res.status(400).json({ error: "Hayvan bulunamadı" });

    const animal = animals[aIdx];
    const def = GAME_CONFIG.animals[animal.type];
    const inv = data.inventory || {};

    if ((inv[def.food] || 0) < 1)
      return res.status(400).json({ error: `Yem yok (gereken: ${def.food})` });

    const newAnimals = animals.map((a, i) =>
      i === aIdx
        ? { ...a, hunger: Math.min(100, a.hunger + 40), happy: Math.min(100, a.happy + 25) }
        : a
    );
    const newInv = { ...inv, [def.food]: (inv[def.food] || 0) - 1 };
    const qp = { ...(data.questProgress || {}), feed_animal: (data.questProgress?.feed_animal || 0) + 1 };

    await updateGameData(uid, { animals: newAnimals, inventory: newInv, questProgress: qp });
    res.json({ success: true, animalId, newHunger: Math.min(100, animal.hunger + 40), inventory: newInv });
  })
);

/** ÜRÜN TOPLA (süt / yün / yumurta) */
exports.collectProduce = functions.https.onRequest((req, res) =>
  handleAction(req, res, async (uid, data, body) => {
    const { animalId } = body;
    const animals = data.animals || [];
    const aIdx = animals.findIndex(a => a.id === animalId);
    if (aIdx < 0) return res.status(400).json({ error: "Hayvan bulunamadı" });

    const animal = animals[aIdx];
    if (!animal.readyProduce) return res.status(400).json({ error: "Ürün hazır değil" });

    const def = GAME_CONFIG.animals[animal.type];
    const newAnimals = animals.map((a, i) =>
      i === aIdx ? { ...a, readyProduce: false, produceTimer: 0 } : a
    );
    const inv = data.inventory || {};
    const newInv = { ...inv, [def.produceItem]: (inv[def.produceItem] || 0) + 1 };
    const lvl = calcXP(data.xp, data.level, data.maxXp, 8);

    await updateGameData(uid, { animals: newAnimals, inventory: newInv, ...lvl });
    res.json({ success: true, produceItem: def.produceItem, inventory: newInv, ...lvl });
  })
);

/** ÇİFTLEŞTİR */
exports.breedAnimal = functions.https.onRequest((req, res) =>
  handleAction(req, res, async (uid, data, body) => {
    const { animalId } = body;
    const animals = data.animals || [];
    const animal = animals.find(a => a.id === animalId);
    if (!animal) return res.status(400).json({ error: "Hayvan bulunamadı" });
    if (animal.pregnant) return res.status(400).json({ error: "Zaten gebe" });
    if (animals.filter(a => a.type === animal.type).length < 2)
      return res.status(400).json({ error: "Aynı türden 2. hayvan gerekli" });

    const newAnimals = animals.map(a =>
      a.id === animalId ? { ...a, pregnant: true, pregnancyDays: 0 } : a
    );
    await updateGameData(uid, { animals: newAnimals });
    res.json({ success: true, gestationDays: GAME_CONFIG.animals[animal.type].gestationDays });
  })
);

/** KES (mezbaha) */
exports.slaughterAnimal = functions.https.onRequest((req, res) =>
  handleAction(req, res, async (uid, data, body) => {
    const { animalId } = body;
    const animals = data.animals || [];
    const animal = animals.find(a => a.id === animalId);
    if (!animal) return res.status(400).json({ error: "Hayvan bulunamadı" });

    const def = GAME_CONFIG.animals[animal.type];
    const newAnimals = animals.filter(a => a.id !== animalId);
    const inv = data.inventory || {};
    const newInv = { ...inv, meat: (inv.meat || 0) + def.slaughterMeat };
    const qp = { ...(data.questProgress || {}), slaughter: (data.questProgress?.slaughter || 0) + def.slaughterMeat };
    const lvl = calcXP(data.xp, data.level, data.maxXp, 10);

    await updateGameData(uid, { animals: newAnimals, inventory: newInv, questProgress: qp, ...lvl });
    res.json({ success: true, meatGained: def.slaughterMeat, inventory: newInv, ...lvl });
  })
);

/** HAYVAN SAT */
exports.sellAnimal = functions.https.onRequest((req, res) =>
  handleAction(req, res, async (uid, data, body) => {
    const { animalId } = body;
    const animals = data.animals || [];
    const animal = animals.find(a => a.id === animalId);
    if (!animal) return res.status(400).json({ error: "Hayvan bulunamadı" });

    const def = GAME_CONFIG.animals[animal.type];
    const newGold = (data.gold || 0) + def.sellPrice;
    const newTotalGold = (data.totalGoldEarned || 0) + def.sellPrice;
    const newAnimals = animals.filter(a => a.id !== animalId);
    const lvl = calcXP(data.xp, data.level, data.maxXp, 5);

    await updateGameData(uid, {
      animals: newAnimals,
      gold: newGold, totalGoldEarned: newTotalGold,
      ...lvl,
    });
    res.json({ success: true, newGold, earned: def.sellPrice, ...lvl });
  })
);

// ── BAHÇE ──

/** AĞAÇ DİK */
exports.plantOrchardTree = functions.https.onRequest((req, res) =>
  handleAction(req, res, async (uid, data, body) => {
    const { side, idx, treeType } = body;
    const def = GAME_CONFIG.orchard[treeType];
    if (!def) return res.status(400).json({ error: "Geçersiz ağaç türü" });
    if ((data.gold || 0) < def.seedCost)
      return res.status(400).json({ error: `Yeterli altın yok (gereken: ${def.seedCost}₺)` });

    const slots = data.orchardSlots || [];
    const slotIdx = slots.findIndex(s => s.side === side && s.idx === idx);
    if (slotIdx < 0) return res.status(400).json({ error: "Yuva bulunamadı" });

    const newSlots = slots.map((s, i) =>
      i === slotIdx ? { ...s, type: treeType, stage: 1, growTimer: 0, fruitsReady: 0 } : s
    );
    const lvl = calcXP(data.xp, data.level, data.maxXp, 5);

    await updateGameData(uid, {
      orchardSlots: newSlots,
      gold: (data.gold || 0) - def.seedCost,
      ...lvl,
    });
    res.json({ success: true, newGold: data.gold - def.seedCost, ...lvl });
  })
);

/** BAHÇE HASAT */
exports.harvestOrchard = functions.https.onRequest((req, res) =>
  handleAction(req, res, async (uid, data, body) => {
    const { side, idx } = body;
    const slots = data.orchardSlots || [];
    const slotIdx = slots.findIndex(s => s.side === side && s.idx === idx);
    if (slotIdx < 0) return res.status(400).json({ error: "Yuva bulunamadı" });

    const slot = slots[slotIdx];
    if (slot.stage !== 3 || slot.fruitsReady <= 0)
      return res.status(400).json({ error: "Meyve hazır değil" });

    const eng = spendEnergy(data, GAME_CONFIG.energy.orchardHarvest);
    if (!eng.ok) return res.status(400).json({ error: eng.reason });

    const def = GAME_CONFIG.orchard[slot.type];
    const count = slot.fruitsReady;
    const newSlots = slots.map((s, i) =>
      i === slotIdx ? { ...s, fruitsReady: 0, growTimer: 0 } : s
    );
    const inv = data.inventory || {};
    const newInv = { ...inv, [slot.type]: (inv[slot.type] || 0) + count };
    const lvl = calcXP(data.xp, data.level, data.maxXp, count * (def?.xp || 8));

    await updateGameData(uid, {
      orchardSlots: newSlots,
      inventory: newInv,
      energy: eng.newEnergy,
      ...lvl,
    });
    res.json({ success: true, treeType: slot.type, count, newEnergy: eng.newEnergy, inventory: newInv, ...lvl });
  })
);

/** BAHÇE SULA */
exports.waterOrchard = functions.https.onRequest((req, res) =>
  handleAction(req, res, async (uid, data, body) => {
    const { side, idx } = body;
    const slots = data.orchardSlots || [];
    const slotIdx = slots.findIndex(s => s.side === side && s.idx === idx);
    if (slotIdx < 0) return res.status(400).json({ error: "Yuva bulunamadı" });
    if (slots[slotIdx].stage < 1) return res.status(400).json({ error: "Ağaç yok" });

    const eng = spendEnergy(data, GAME_CONFIG.energy.orchardWater);
    if (!eng.ok) return res.status(400).json({ error: eng.reason });

    const newSlots = slots.map((s, i) =>
      i === slotIdx ? { ...s, watered: true } : s
    );
    await updateGameData(uid, { orchardSlots: newSlots, energy: eng.newEnergy });
    res.json({ success: true, newEnergy: eng.newEnergy });
  })
);

// ── KOMŞU & GÖREV ──

/** KOMŞUYA VER */
exports.giveNeighbor = functions.https.onRequest((req, res) =>
  handleAction(req, res, async (uid, data, body) => {
    const { requestIndex } = body;
    const reqs = data.neighborRequests || [];
    const req2 = reqs[requestIndex];
    if (!req2 || req2.fulfilled)
      return res.status(400).json({ error: "Geçersiz veya zaten tamamlanmış talep" });

    const inv = data.inventory || {};
    if ((inv[req2.type] || 0) < req2.qty)
      return res.status(400).json({ error: "Yeterli ürün yok" });

    const reward = req2.reward; // sunucu doğrular
    const newInv = { ...inv, [req2.type]: (inv[req2.type] || 0) - req2.qty };
    const newGold = (data.gold || 0) + reward;
    const newTotalGold = (data.totalGoldEarned || 0) + reward;
    const newReqs = reqs.map((r, i) => i === requestIndex ? { ...r, fulfilled: true } : r);
    const qp = { ...(data.questProgress || {}), give_neighbor: (data.questProgress?.give_neighbor || 0) + 1 };
    const lvl = calcXP(data.xp, data.level, data.maxXp, 20);

    await updateGameData(uid, {
      inventory: newInv,
      gold: newGold, totalGoldEarned: newTotalGold,
      neighborRequests: newReqs,
      questProgress: qp,
      ...lvl,
    });
    res.json({ success: true, reward, newGold, inventory: newInv, ...lvl });
  })
);

/** GÖREV ÖDÜLÜ AL */
exports.claimQuest = functions.https.onRequest((req, res) =>
  handleAction(req, res, async (uid, data, body) => {
    const { questId } = body;
    const activeQuests = data.activeQuests || [];
    const qIdx = activeQuests.findIndex(q => q.id === questId && q.done);
    if (qIdx < 0) return res.status(400).json({ error: "Görev bulunamadı veya tamamlanmamış" });

    const quest = activeQuests[qIdx];
    const newGold = (data.gold || 0) + quest.reward;
    const newTotalGold = (data.totalGoldEarned || 0) + quest.reward;
    const completed = [...(data.completedQuests || []), questId];
    const newActive = activeQuests.filter(q => q.id !== questId);
    const lvl = calcXP(data.xp, data.level, data.maxXp, quest.xpReward || 0);

    await updateGameData(uid, {
      gold: newGold, totalGoldEarned: newTotalGold,
      activeQuests: newActive,
      completedQuests: completed,
      ...lvl,
    });
    res.json({ success: true, reward: quest.reward, newGold, completedQuests: completed, ...lvl });
  })
);

/** UYU — enerji yenile, gün ilerlet */
exports.sleep = functions.https.onRequest((req, res) =>
  handleAction(req, res, async (uid, data) => {
    if ((data.energy || 0) >= (data.maxEnergy || 100))
      return res.status(400).json({ error: "Enerji zaten dolu" });

    const newEnergy = data.maxEnergy || 100;
    const newDay = (data.dayCount || 1) + 1;
    const newGameTime = 6 * 60; // 06:00

    // Hayvanların açlığını azalt (geceleme)
    const newAnimals = (data.animals || []).map(a => ({
      ...a, hunger: Math.max(0, (a.hunger || 0) - 15),
    }));

    await updateGameData(uid, {
      energy: newEnergy,
      dayCount: newDay,
      gameTime: newGameTime,
      animals: newAnimals,
    });
    res.json({ success: true, newEnergy, newDay, newGameTime });
  })
);

/** NAKLİYE TAMAMLANDI — puan kaydet */
exports.completePickup = functions.https.onRequest((req, res) =>
  handleAction(req, res, async (uid, data, body) => {
    const { score, won } = body;

    // Score doğrulama: makul bir üst sınır (6 kargo × 28₺ × 3 pazar + 10×10 ürün = ~604 max)
    const MAX_SCORE = 700;
    if (typeof score !== "number" || score < 0 || score > MAX_SCORE)
      return res.status(400).json({ error: "Geçersiz skor" });

    const newGold = (data.gold || 0) + score;
    const newTotalGold = (data.totalGoldEarned || 0) + score;
    const xpGain = won ? GAME_CONFIG.xp.pickup : 10;
    const qp = { ...(data.questProgress || {}), pickup: (data.questProgress?.pickup || 0) + 1 };
    const lvl = calcXP(data.xp, data.level, data.maxXp, xpGain);

    await updateGameData(uid, {
      gold: newGold, totalGoldEarned: newTotalGold,
      questProgress: qp,
      ...lvl,
    });
    res.json({ success: true, newGold, ...lvl });
  })
);

/** MİNİ OYUN TAMAMLANDI (yumurta/süt/yün) */
exports.completeMiniGame = functions.https.onRequest((req, res) =>
  handleAction(req, res, async (uid, data, body) => {
    const { animalId, produceType, count } = body;

    // Doğrulama
    if (!["egg", "milk", "wool"].includes(produceType))
      return res.status(400).json({ error: "Geçersiz ürün türü" });
    if (typeof count !== "number" || count < 0 || count > 20)
      return res.status(400).json({ error: "Geçersiz miktar" });

    const animals = data.animals || [];
    const animal = animals.find(a => a.id === animalId);
    if (!animal) return res.status(400).json({ error: "Hayvan bulunamadı" });

    const newAnimals = animals.map(a =>
      a.id === animalId ? { ...a, happy: Math.min(100, (a.happy || 0) + 15) } : a
    );
    const inv = data.inventory || {};
    const newInv = { ...inv, [produceType]: (inv[produceType] || 0) + count };
    const lvl = calcXP(data.xp, data.level, data.maxXp, count * 5);

    await updateGameData(uid, { animals: newAnimals, inventory: newInv, ...lvl });
    res.json({ success: true, inventory: newInv, ...lvl });
  })
);

/** OYUN STATE'İ GÜNCELLE (hava, zaman, büyüme — periyodik) */
exports.syncGameState = functions.https.onRequest((req, res) =>
  handleAction(req, res, async (uid, data, body) => {
    const { tiles, orchardSlots, animals, gameTime, weather, weatherTimer, dayCount } = body;

    // Sadece değişebilen "simülasyon" state'ini güncelle
    // Altın, enerji, envanter bu endpoint üzerinden GÜNCELLENEMEZ
    const delta = {};
    if (tiles)        delta.tiles        = tiles;
    if (orchardSlots) delta.orchardSlots = orchardSlots;
    if (animals)      delta.animals      = animals;
    if (typeof gameTime    === "number") delta.gameTime    = gameTime;
    if (typeof dayCount    === "number") delta.dayCount    = dayCount;
    if (weather)           delta.weather      = weather;
    if (typeof weatherTimer === "number") delta.weatherTimer = weatherTimer;

    if (Object.keys(delta).length === 0)
      return res.status(400).json({ error: "Güncellenecek alan yok" });

    await updateGameData(uid, delta);
    res.json({ success: true });
  })
);
