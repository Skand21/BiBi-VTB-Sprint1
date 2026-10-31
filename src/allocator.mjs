// Monetary amounts are integer kopecks; prices have up to four RUB decimals.
export const ENGINE_VERSION = '1.0.0';
export const MAX_ASSETS = 12;
const MAX_MONEY = 100_000_000_000; // 1 billion RUB per monetary input.

export class InputError extends Error {
  constructor(message, field = '') { super(message); this.name = 'InputError'; this.field = field; }
}

export function decimal(value, places = 2, label = 'Число') {
  const text = String(value ?? '').trim().replace(/[\s\u00a0\u202f]/g, '').replace(',', '.');
  if (!(places ? new RegExp(`^\\d+(?:\\.\\d{1,${places}})?$`) : /^\d+$/).test(text))
    throw new InputError(`${label}: введите неотрицательное число, до ${places} знаков после запятой`);
  const [whole, fraction = ''] = text.split('.');
  const n = Number(whole) * 10 ** places + Number(fraction.padEnd(places, '0'));
  if (!Number.isSafeInteger(n)) throw new InputError(`${label}: слишком большое значение`);
  return n;
}

const money = (value, label) => {
  const n = decimal(value, 2, label);
  if (n > MAX_MONEY) throw new InputError(`${label}: максимум 1 млрд ₽`);
  return n;
};
const integer = (value, label, min, max) => {
  const n = decimal(value, 0, label);
  if (n < min || n > max) throw new InputError(`${label}: допустимо от ${min} до ${max}`);
  return n;
};

export function validatePlan(plan) {
  if (!plan || typeof plan !== 'object') throw new InputError('Не удалось прочитать план');
  const name = String(plan.name ?? '').trim();
  if (!name || name.length > 80) throw new InputError('Название плана: от 1 до 80 символов', 'name');
  if (!Array.isArray(plan.assets) || plan.assets.length < 2 || plan.assets.length > MAX_ASSETS)
    throw new InputError(`Добавьте от 2 до ${MAX_ASSETS} активов`);
  const ids = new Set();
  const assets = plan.assets.map((a, i) => {
    const prefix = `Актив ${i + 1}`;
    const ticker = String(a.ticker ?? '').trim().toUpperCase();
    if (!/^[A-ZА-ЯЁ0-9._-]{1,16}$/u.test(ticker)) throw new InputError(`${prefix}: укажите короткий тикер без пробелов`);
    if (ids.has(ticker)) throw new InputError(`Тикер ${ticker} повторяется`);
    ids.add(ticker);
    const title = String(a.title ?? ticker).trim();
    if (title.length > 80) throw new InputError(`${prefix}: название длиннее 80 символов`);
    const price = decimal(a.price, 4, `${ticker}, цена`);
    if (price < 1 || price > 10_000_000_000) throw new InputError(`${ticker}: цена от 0,0001 до 1 млн ₽`);
    const lot = integer(a.lot, `${ticker}, размер лота`, 1, 1_000_000);
    const quantity = integer(a.quantity, `${ticker}, количество`, 0, 100_000_000);
    if (valueFor(price, lot) < 1) throw new InputError(`${ticker}: стоимость лота должна быть не меньше копейки`);
    const weight = decimal(a.weight, 2, `${ticker}, доля`);
    if (weight > 10_000) throw new InputError(`${ticker}: доля не больше 100%`);
    const value = valueFor(price, quantity);
    if (value > MAX_MONEY * 100) throw new InputError(`${ticker}: стоимость позиции слишком велика`);
    return { ticker, title, price, lot, quantity, weight, value,
      quoteAt: typeof a.quoteAt === 'string' ? a.quoteAt.slice(0, 60) : '',
      priceSource: typeof a.priceSource === 'string' ? a.priceSource.slice(0, 80) : 'Введено вручную' };
  });
  if (assets.reduce((s, a) => s + a.weight, 0) !== 10_000)
    throw new InputError('Целевые доли должны в сумме составлять 100%', 'weights');
  const feeRate = decimal(plan.feePercent ?? '0.05', 4, 'Комиссия');
  if (feeRate > 1_000_000) throw new InputError('Комиссия: максимум 100%');
  const minimumFee = money(plan.minimumFee ?? '0', 'Минимум за заявку');
  return { name, assets, feeRate, minimumFee, cash: money(plan.cash ?? '0', 'Деньги в портфеле') };
}

export function valueFor(priceTicks, quantity) {
  return Number((BigInt(priceTicks) * BigInt(quantity) + 50n) / 100n);
}
function feeFor(notional, rate, minimum) {
  if (!notional) return 0;
  const fee = Number((BigInt(notional) * BigInt(rate) + 500_000n) / 1_000_000n);
  return Math.max(fee, minimum);
}

export function deviation(values, assets) {
  const total = values.reduce((s, v) => s + v, 0);
  if (!total) return null;
  return values.reduce((s, v, i) => s + Math.abs(v / total * 100 - assets[i].weight / 100), 0) / 2;
}

// Bounded deterministic discrete optimization. No global-optimum claim.
// Minimize squared monetary distance to target wealth; cash has a zero target.
export function allocate(plan, contribution = '0', options = {}) {
  const p = validatePlan(plan);
  const deposit = money(contribution, 'Новый взнос');
  const budget = p.cash + deposit;
  if (budget > MAX_MONEY) throw new InputError('Доступно к распределению не больше 1 млрд ₽');
  if (!budget) throw new InputError('Добавьте новый взнос или деньги в портфеле');
  const assets = p.assets;
  const original = assets.map(a => a.value);
  const originalTotal = original.reduce((s, v) => s + v, 0);
  const wealth = originalTotal + budget;
  const scale = Math.max(wealth, 1);
  const order = (i, lots) => {
    if (!Number.isSafeInteger(lots) || lots < 0 || lots * assets[i].lot + assets[i].quantity > 100_000_000) return null;
    const amount = valueFor(assets[i].price, lots * assets[i].lot);
    if (lots && !amount) return null; // below one kopeck is not a valid order
    const fee = feeFor(amount, p.feeRate, p.minimumFee);
    return { amount, fee, cost: amount + fee };
  };
  const evaluate = lots => {
    const orders = lots.map((n, i) => order(i, n));
    if (orders.some(o => !o)) return null;
    const spent = orders.reduce((s, o) => s + o.cost, 0);
    if (spent > budget) return null;
    const fees = orders.reduce((s, o) => s + o.fee, 0);
    const values = orders.map((o, i) => original[i] + o.amount);
    const cash = budget - spent;
    const total = wealth - fees;
    const loss = values.reduce((s, v, i) => s + ((v - total * assets[i].weight / 10_000) / scale) ** 2, (cash / scale) ** 2);
    return { orders, spent, fees, values, cash, loss };
  };
  const maxAffordable = (i, limit, cap = 100_000_000 / assets[i].lot) => {
    let low = 0, high = Math.min(Math.floor(cap), 100_000_000);
    while (low < high) {
      const mid = Math.ceil((low + high) / 2), o = order(i, mid);
      if (o && o.cost <= limit) low = mid; else high = mid - 1;
    }
    return low;
  };
  let lots = assets.map(() => 0);
  // Bulk seed using continuous water filling; handles millions of cheap lots.
  let low = originalTotal, high = wealth;
  for (let k = 0; k < 60; k++) {
    const level = (low + high) / 2;
    const needed = assets.reduce((s, a) => s + Math.max(0, level * a.weight / 10_000 - a.value), 0);
    if (needed > budget / (1 + p.feeRate / 1_000_000)) high = level; else low = level;
  }
  let remaining = budget;
  for (let i = 0; i < assets.length; i++) {
    if (!assets[i].weight) continue;
    const desired = Math.max(0, low * assets[i].weight / 10_000 - original[i]);
    const cap = Math.floor(desired * 100 / Math.max(1, assets[i].price * assets[i].lot));
    lots[i] = maxAffordable(i, remaining, cap);
    remaining -= order(i, lots[i]).cost;
  }
  let current = evaluate(lots);
  const zero = evaluate(assets.map(() => 0));
  if (zero.loss < current.loss) { lots.fill(0); current = zero; }

  // Exact enumeration for small feasible spaces, independent of greedy seed.
  const caps = assets.map((a, i) => a.weight ? maxAffordable(i, budget) : 0);
  const searchSize = caps.reduce((s, c) => s * (c + 1), 1);
  let method = 'bounded-search', iterations = 0;
  if (searchSize <= (options.exactLimit ?? 120_000)) {
    method = 'enumeration';
    const candidate = [...lots];
    const search = (i, spent) => {
      if (i === assets.length) {
        const e = evaluate(candidate); iterations++;
        if (e && (e.loss < current.loss - 1e-15 || (Math.abs(e.loss - current.loss) <= 1e-15 && e.cash < current.cash))) {
          current = e; lots = [...candidate];
        }
        return;
      }
      for (let n = 0; n <= caps[i]; n++) {
        const o = order(i, n);
        if (!o || spent + o.cost > budget) break;
        candidate[i] = n; search(i + 1, spent + o.cost);
      }
    };
    search(0, 0);
  } else {
    // Coordinate add/remove and one-lot swaps escape simple greedy dead ends.
    for (let step = 0; step < 300; step++) {
      let best = current, bestLots = lots;
      const consider = candidate => {
        const e = evaluate(candidate); iterations++;
        if (e && e.loss < best.loss - 1e-15) { best = e; bestLots = candidate; }
      };
      for (let i = 0; i < assets.length; i++) {
        if (assets[i].weight) { const c = [...lots]; c[i]++; consider(c); }
        if (lots[i]) {
          const c = [...lots]; c[i]--; consider(c);
          for (let j = 0; j < assets.length; j++) if (i !== j && assets[j].weight) {
            const swap = [...c]; swap[j]++; consider(swap);
          }
        }
      }
      if (bestLots === lots) break;
      lots = bestLots; current = best;
    }
  }
  const beforeDeviation = deviation(original, assets);
  const afterDeviation = deviation(current.values, assets);
  const rows = assets.map((a, i) => {
    const o = current.orders[i];
    return { ...a, lots: lots[i], buyQuantity: lots[i] * a.lot, amount: o.amount, fee: o.fee,
      afterQuantity: a.quantity + lots[i] * a.lot,
      beforeValue: original[i], afterValue: current.values[i],
      beforeWeight: originalTotal ? original[i] / originalTotal * 100 : 0,
      afterWeight: current.values.reduce((s, v) => s + v, 0) ? current.values[i] / current.values.reduce((s, v) => s + v, 0) * 100 : 0,
      targetWeight: a.weight / 100 };
  });
  const baselineLots = assets.map((a, i) => maxAffordable(i, Math.floor(budget * a.weight / 10_000)));
  const baseline = evaluate(baselineLots) ?? zero;
  return { version: ENGINE_VERSION, name: p.name, contribution: deposit, startingCash: p.cash, budget,
    beforeTotal: originalTotal, purchaseTotal: current.orders.reduce((s, o) => s + o.amount, 0),
    fees: current.fees, cash: current.cash, afterTotal: current.values.reduce((s, v) => s + v, 0),
    beforeDeviation, afterDeviation, rows,
    baseline: { purchaseTotal: baseline.orders.reduce((s, o) => s + o.amount, 0), fees: baseline.fees, cash: baseline.cash,
      deviation: deviation(baseline.values, assets), quantities: baselineLots.map((n, i) => n * assets[i].lot) },
    diagnostics: { method, iterations, loss: current.loss, searchSize } };
}
