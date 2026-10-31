import test from 'node:test';
import assert from 'node:assert/strict';
import { allocate, validatePlan, decimal, valueFor } from '../src/allocator.mjs';
import { demoPlan, initialState, decodeState, fingerprint, applyDemo, normalizePlan, bookPurchases } from '../src/state.mjs';

test('70/30: whole lots, 0.05% commission, exact cash conservation', () => {
  const r = allocate(demoPlan(), '20000');
  assert.deepEqual(r.rows.map(x => x.lots), [0, 19]);
  assert.equal(r.purchaseTotal, 1_900_000);
  assert.equal(r.fees, 950);
  assert.equal(r.cash, 99_050);
  assert.equal(r.purchaseTotal + r.fees + r.cash, r.budget);
  assert.ok(r.afterDeviation < r.beforeDeviation);
  assert.ok(r.afterDeviation < r.baseline.deviation);
});
test('Existing positions change purchases; saving does not mean execution', () => {
  const p = demoPlan(), before = JSON.stringify(p), a = allocate(p, '20000');
  assert.equal(JSON.stringify(p), before);
  [p.assets[0].quantity, p.assets[1].quantity] = ['30', '70'];
  const b = allocate(p, '20000');
  assert.deepEqual(a.rows.map(x => x.lots), b.rows.map(x => x.lots).reverse());
});
test('Insufficient lot budget, zero-target holding, and minimum per-order commission', () => {
  let p = demoPlan();
  let r = allocate(p, '0.01');
  assert.equal(r.purchaseTotal, 0); assert.equal(r.cash, 1);
  p.assets[0].weight = '0'; p.assets[1].weight = '100'; p.minimumFee = '300';
  r = allocate(p, '1000');
  assert.equal(r.purchaseTotal, 0);
  r = allocate(p, '1300');
  assert.deepEqual(r.rows.map(a => a.lots), [0, 1]); assert.equal(r.fees, 30000);
});
test('Four decimal prices rounded at order level and Russian decimal input', () => {
  assert.equal(decimal('1 234,5678', 4), 12345678);
  assert.equal(valueFor(1234567, 30), 370370);
  const p = demoPlan(); p.assets.forEach(a => { a.price = '123.4567'; a.lot = '10'; a.quantity = '0'; });
  const r = allocate(p, '5000,00');
  assert.equal(r.purchaseTotal + r.fees + r.cash, 500000);
  assert.ok(r.rows.every(a => a.buyQuantity % 10 === 0));
});
test('Validation rejects dangerous/ambiguous inputs before arithmetic', () => {
  const cases = [p=>p.assets[0].price='-1', p=>p.assets[0].quantity='1.5', p=>p.assets[0].weight='49', p=>p.assets[1].ticker='ALFA', p=>p.assets[0].price='1e3', p=>p.cash='Infinity', p=>p.assets[0].lot='0', p=>p.assets[0].price='0.0001'];
  for (const change of cases) { const p=demoPlan(); change(p); assert.throws(()=>validatePlan(p)); }
  assert.throws(()=>allocate(demoPlan(),'0'));
  assert.throws(()=>allocate(demoPlan(),'1000000001'));
});
test('Exact small search equals independent exhaustive optimum with minimum fees', () => {
  for (const budget of [14, 25, 39, 59]) {
    const p=demoPlan(); p.assets[0].price='7'; p.assets[1].price='11'; p.assets[0].quantity='2'; p.assets[1].quantity='1'; p.feePercent='2'; p.minimumFee='0.5';
    const r=allocate(p,String(budget));
    let best=Infinity;
    for(let a=0;a<=budget/7;a++) for(let b=0;b<=budget/11;b++) {
      const aa=a*700,bb=b*1100,fa=a?Math.max(50,Math.round(aa*.02)):0,fb=b?Math.max(50,Math.round(bb*.02)):0;
      const cash=budget*100-aa-bb-fa-fb;if(cash<0)continue;
      const total=2500+budget*100-fa-fb, scale=2500+budget*100;
      const loss=((1400+aa-total*.5)/scale)**2+((1100+bb-total*.5)/scale)**2+(cash/scale)**2;
      best=Math.min(best,loss);
    }
    assert.ok(Math.abs(r.diagnostics.loss-best)<1e-12);
  }
});
test('250 deterministic portfolios maintain financial invariants', () => {
  let seed=1917; const random=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n;};
  for(let k=0;k<250;k++) {
    const p=demoPlan('three'); p.feePercent=['0','0.05','0.3','1'][random(4)];p.minimumFee=String(random(10));p.cash=String(random(1000));
    const first=random(10001),second=random(10001-first);[first,second,10000-first-second].forEach((w,i)=>p.assets[i].weight=(w/100).toFixed(2));
    p.assets.forEach(a=>{a.price=(1+random(50000)/100).toFixed(2);a.lot=String([1,10,100][random(3)]);a.quantity=String(random(500));});
    const r=allocate(p,String(1+random(100000)));
    assert.equal(r.purchaseTotal+r.fees+r.cash,r.budget);assert.ok(r.cash>=0);
    assert.equal(r.afterTotal+r.cash+r.fees,r.beforeTotal+r.budget);
    assert.ok(r.rows.every(a=>Number.isInteger(a.lots)&&a.lots>=0&&a.buyQuantity%a.lot===0));
    assert.ok(Number.isFinite(r.diagnostics.loss));
    const zeroLoss=p.assets.reduce((s,a,i)=>s+((r.rows[i].beforeValue-(r.beforeTotal+r.budget)*Number(a.weight)/100)/(r.beforeTotal+r.budget))**2,(r.budget/(r.beforeTotal+r.budget))**2);
    assert.ok(r.diagnostics.loss<=zeroLoss+1e-12);
  }
});
test('Three-asset exact search matches an independent enumerator with mixed lot sizes',()=>{
  for(const budget of [10,17,31,45]){
    const p=demoPlan('three');p.feePercent='3';p.minimumFee='0.07';
    const prices=[200,300,500],sizes=[1,2,1],held=[3,0,5],weights=[.4,.35,.25];
    p.assets.forEach((a,i)=>Object.assign(a,{price:String(prices[i]/100),lot:String(sizes[i]),quantity:String(held[i])}));
    const r=allocate(p,String(budget)),startValues=prices.map((price,i)=>price*held[i]),wealth=startValues.reduce((s,x)=>s+x,0)+budget*100;
    let best=Infinity;
    for(let a=0;a<=budget*100/prices[0];a++)for(let b=0;b<=budget*100/(prices[1]*sizes[1]);b++)for(let c=0;c<=budget*100/prices[2];c++){
      const amounts=[a,b,c].map((n,i)=>n*prices[i]*sizes[i]);
      const fees=amounts.map(n=>n?Math.max(7,Math.floor(n*.03+.5)):0);
      const cash=budget*100-amounts.reduce((s,x)=>s+x,0)-fees.reduce((s,x)=>s+x,0);if(cash<0)continue;
      const finalWealth=wealth-fees.reduce((s,x)=>s+x,0);
      const loss=amounts.reduce((s,n,i)=>s+((startValues[i]+n-finalWealth*weights[i])/wealth)**2,(cash/wealth)**2);best=Math.min(best,loss);
    }
    assert.ok(Math.abs(r.diagnostics.loss-best)<1e-12);
  }
});
test('Large cheap-lot portfolio completes within a bounded search', () => {
  const p=demoPlan('empty');p.assets.forEach(a=>a.price='0.01');
  const start=performance.now(),r=allocate(p,'1000000');
  assert.ok(performance.now()-start<2000);assert.ok(r.diagnostics.iterations<=300*12*14);
  assert.equal(r.purchaseTotal+r.fees+r.cash,r.budget);
});
test('History export roundtrip, immutable snapshot, two cycles and apply protection', () => {
  const s=initialState(); const p=normalizePlan(s.plan),r=allocate(p,'20000');
  const record={id:'first',date:'2026-10-18',plan:p,contribution:'20000',result:r,mode:'demo',fingerprint:fingerprint(p),applied:false};
  s.history.push(record);applyDemo(s,record);
  assert.equal(s.plan.assets[1].quantity,'49');assert.equal(record.plan.assets[1].quantity,'30');
  assert.throws(()=>applyDemo(s,record));
  const second=allocate(s.plan,'20000');assert.ok(second.rows.some(a=>a.lots));
  const restored=decodeState(JSON.stringify(s));assert.deepEqual(restored.plan,normalizePlan(s.plan));assert.equal(restored.history[0].result.cash,r.cash);
  s.mode='personal';assert.throws(()=>applyDemo(s,{...record,applied:false}));
  assert.throws(()=>decodeState({...s,schema:99}));
  assert.throws(()=>decodeState({...s,plan:{...s.plan,assets:[]}}));
});
test('Stale demonstration cannot mutate a changed portfolio',()=>{
  const s=initialState(),p=normalizePlan(s.plan);
  const record={plan:p,mode:'demo',fingerprint:fingerprint(p),result:allocate(p,'20000'),applied:false};
  s.plan.assets[0].quantity='71';assert.throws(()=>applyDemo(s,record));
});
test('Explicit purchase bookkeeping updates own portfolio once and validates atomically',()=>{
  const s=initialState();s.mode='personal';s.onboarded=true;const p=normalizePlan(s.plan);
  const h={id:'book',plan:p,contribution:'20000',mode:'personal',fingerprint:fingerprint(p),result:allocate(p,'20000')};
  const before=JSON.stringify(s.plan);
  assert.throws(()=>bookPurchases(s,h,['0','-1'],'990.50'));assert.equal(JSON.stringify(s.plan),before);
  assert.throws(()=>bookPurchases(s,h,['0','19'],'-1'));assert.equal(JSON.stringify(s.plan),before);
  bookPurchases(s,h,['0','19'],'990.50');assert.equal(s.plan.assets[1].quantity,'49');assert.equal(s.plan.cash,'990.5');assert.equal(h.plan.assets[1].quantity,'30');
  assert.throws(()=>bookPurchases(s,h,['0','19'],'990.50'));
  s.history=[h];assert.equal(decodeState(JSON.stringify(s)).history[0].booked,true);
});
