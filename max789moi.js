import fastify from "fastify";
import cors from "@fastify/cors";
import fetch from "node-fetch";

const PORT = 4002;

// ============================================================
// APIs
// ============================================================
const APIS = {
  tx:  "https://taixiu.maksh3979madfw.com/api/luckydice/GetSoiCau",
  md5: "https://taixiumd5.maksh3979madfw.com/api/md5luckydice/GetSoiCau",
};

// ============================================================
// UTILS
// ============================================================
const sum  = a => a.reduce((s,v)=>s+v,0);
const avg  = a => a.length ? sum(a)/a.length : 0;
const std  = a => { const m=avg(a); return Math.sqrt(avg(a.map(v=>Math.pow(v-m,2)))); };
const entropy = a => {
  if (!a.length) return 0;
  const f = a.reduce((o,v)=>{o[v]=(o[v]||0)+1;return o},{});
  const n = a.length;
  return -Object.values(f).reduce((e,c)=>{const p=c/n;return e+(p>0?p*Math.log2(p):0);},0);
};
const similarity = (a,b) => a.length!==b.length ? 0 : a.split('').filter((c,i)=>c===b[i]).length/a.length;
const lastN = (a,n) => a.slice(Math.max(0,a.length-n));

function getStreak(tx) {
  if (!tx.length) return { val:null, len:0 };
  let len=1, val=tx.at(-1);
  for (let i=tx.length-2;i>=0;i--) { if(tx[i]===val)len++; else break; }
  return { val, len };
}
function extractFeatures(h) {
  const tx=h.map(r=>r.tx), totals=h.map(r=>r.total);
  const freq=tx.reduce((a,v)=>{a[v]=(a[v]||0)+1;return a},{});
  let runs=[],cur=tx[0],len=1;
  for(let i=1;i<tx.length;i++){if(tx[i]===cur)len++;else{runs.push({val:cur,len});cur=tx[i];len=1;}}
  if(tx.length)runs.push({val:cur,len});
  return { tx,totals,freq,runs, maxRun:runs.reduce((m,r)=>Math.max(m,r.len),0), meanTotal:avg(totals), stdTotal:std(totals), entropy:entropy(tx) };
}

// ============================================================
// ENV (MÔI TRƯỜNG CẦU) CLASSIFIER — VIP
// ============================================================
// Phân loại bàn chơi đang ở trạng thái nào
// Trả về: { type, confidence, params }
function classifyEnvironment(tx) {
  if (tx.length < 10) return { type: 'unknown', conf: 0.5, desc: 'chưa đủ dữ liệu' };

  const last30 = tx.slice(-30);
  const last20 = tx.slice(-20);
  const last10 = tx.slice(-10);

  // 1. Streak (cầu bệt)
  const { val:sv, len:sl } = getStreak(tx);
  if (sl >= 4) return { type:'streak', conf:Math.min(0.95,0.7+sl*0.04), val:sv, len:sl, desc:`cầu bệt ${sl}x${sv}` };

  // 2. Alternating (cầu 1-1)
  let altLen=1;
  for(let i=tx.length-2;i>=0&&tx[i]!==tx[i+1];i--)altLen++;
  if (altLen >= 4) return { type:'alternate', conf:Math.min(0.95,0.68+altLen*0.03), len:altLen, desc:`cầu 1-1 dài ${altLen}` };

  // 3. Double pattern (cầu kép 2-2)
  if (last10.length>=8) {
    const pairs=[0,2,4,6].map(i=>last10[i]+last10[i+1]);
    if (pairs.every(p=>p==='TT'||p==='XX') && new Set(pairs.map(p=>p[0])).size>1)
      return { type:'double', conf:0.82, desc:'cầu kép 2-2' };
  }

  // 4. Triple pattern (cầu 3-3)
  if (last30.length>=12) {
    const a=last30.slice(-12,- 6), b=last30.slice(-6);
    const aSet=new Set(a).size, bSet=new Set(b).size;
    if (aSet===1 && bSet===1 && a[0]!==b[0]) return { type:'triple', conf:0.80, desc:'cầu 3-3' };
  }

  // 5. Noisy / chaotic
  const ent20 = entropy(last20);
  if (ent20 > 0.98) return { type:'chaotic', conf:0.72, desc:'cầu hỗn loạn' };

  // 6. Biased
  const T10 = last10.filter(v=>v==='T').length;
  if (T10>=8) return { type:'biased_T', conf:0.78, desc:'thiên lệch Tài' };
  if (T10<=2) return { type:'biased_X', conf:0.78, desc:'thiên lệch Xỉu' };

  // 7. Balanced
  if (Math.abs(T10-5)<=1 && ent20>0.90)
    return { type:'balanced', conf:0.65, desc:'cầu cân bằng' };

  return { type:'mixed', conf:0.60, desc:'cầu hỗn hợp' };
}

// ============================================================
// CẦU GÃY DETECTOR — VIP CORE
// ============================================================
// Phát hiện cầu gãy và học pattern cầu gãy
class BreakDetector {
  constructor() {
    // Memory: lưu (cauType → history của dự đoán sai/cầu gãy)
    this.memory = {};           // key: pattern → { breakCount, totalCount, breakAfter }
    this.recentBreaks = [];     // lịch sử gãy gần đây
    this.log = [];
  }

  // Mã hóa cầu thành key
  _encodePattern(tx, len=6) {
    return tx.slice(-len).join('');
  }

  // Ghi nhận kết quả thực tế sau khi predict
  // pred: 'T'|'X', actual: 'T'|'X', tx: mảng lịch sử trước khi thêm actual
  learn(tx, pred, actual) {
    const isMiss = pred !== actual;
    const env = classifyEnvironment(tx);

    for (let len=3; len<=7; len++) {
      if (tx.length < len) continue;
      const key = `${env.type}:${this._encodePattern(tx, len)}`;
      if (!this.memory[key]) this.memory[key] = { breakCount:0, totalCount:0, lastBreakIdx:0 };
      const m = this.memory[key];
      m.totalCount++;
      if (isMiss) {
        m.breakCount++;
        m.lastBreakIdx = tx.length;
        this.recentBreaks.push({ key, tx:tx.slice(-8).join(''), pred, actual, env:env.type });
        if (this.recentBreaks.length>100) this.recentBreaks.shift();
      }
    }

    this.log.push({ pred, actual, miss:isMiss, env:env.desc });
    if (this.log.length>200) this.log.shift();
  }

  // Trả về xác suất cần bẻ dựa trên pattern hiện tại
  // Returns: { shouldBreak, breakProb, reason }
  checkBreak(tx) {
    const env = classifyEnvironment(tx);
    let maxBreakProb = 0, reason = '';

    for (let len=7; len>=3; len--) {
      if (tx.length < len) continue;
      const key = `${env.type}:${this._encodePattern(tx, len)}`;
      const m = this.memory[key];
      if (!m || m.totalCount < 2) continue;
      const bp = m.breakCount / m.totalCount;
      if (bp > maxBreakProb) {
        maxBreakProb = bp;
        reason = `pattern len${len} gãy ${m.breakCount}/${m.totalCount} lần [${env.desc}]`;
      }
    }

    // Luôn check env-level break
    const envBreaks = this.recentBreaks.filter(b=>b.env===env.type);
    if (envBreaks.length >= 3) {
      const envBP = envBreaks.length / Math.max(this.log.length,1);
      if (envBP > maxBreakProb) {
        maxBreakProb = envBP;
        reason = `môi trường ${env.type} hay gãy gần đây`;
      }
    }

    return {
      shouldBreak: maxBreakProb >= 0.60,
      breakProb: maxBreakProb,
      env,
      reason
    };
  }

  getStats() {
    const total = Object.values(this.memory).reduce((s,m)=>s+m.totalCount,0);
    const breaks = Object.values(this.memory).reduce((s,m)=>s+m.breakCount,0);
    return { learnedPatterns: Object.keys(this.memory).length, totalSamples: total, totalBreaks: breaks, breakRate: total?breaks/total:0 };
  }
}

// ============================================================
// ENVIRONMENT LEARNER — học hành vi từng loại môi trường
// ============================================================
class EnvLearner {
  constructor() {
    // env type → { predT:0, predX:0, correctT:0, correctX:0 }
    this.envStats = {};
  }

  learn(env, pred, actual) {
    if (!this.envStats[env]) this.envStats[env] = { predT:0,predX:0,corrT:0,corrX:0,total:0 };
    const s = this.envStats[env];
    s.total++;
    pred==='T' ? s.predT++ : s.predX++;
    if (pred===actual) pred==='T' ? s.corrT++ : s.corrX++;
  }

  // Điều chỉnh prediction dựa trên hiệu quả trong môi trường này
  adjust(env, rawPred, rawConf) {
    const s = this.envStats[env];
    if (!s || s.total < 5) return { pred: rawPred, conf: rawConf };
    const accT = s.predT>0 ? s.corrT/s.predT : 0.5;
    const accX = s.predX>0 ? s.corrX/s.predX : 0.5;
    // Nếu trong môi trường này T hay sai → chuyển sang X
    if (rawPred==='T' && accT < 0.42) return { pred:'X', conf: Math.max(rawConf,0.60), adjusted:true };
    if (rawPred==='X' && accX < 0.42) return { pred:'T', conf: Math.max(rawConf,0.60), adjusted:true };
    return { pred:rawPred, conf:rawConf };
  }

  getStats() { return this.envStats; }
}

// ============================================================
// PATTERN DATABASE
// ============================================================
const PATTERN_DB = {
  'bet_2':[[`T`,`T`],[`X`,`X`]],'bet_3':[[`T`,`T`,`T`],[`X`,`X`,`X`]],
  'bet_4':[[`T`,`T`,`T`,`T`],[`X`,`X`,`X`,`X`]],'bet_5':[[`T`,`T`,`T`,`T`,`T`],[`X`,`X`,`X`,`X`,`X`]],
  'dao_11':[[`T`,`X`],[`X`,`T`]],'dao_111':[[`T`,`X`,`T`],[`X`,`T`,`X`]],
  'dao_1111':[[`T`,`X`,`T`,`X`],[`X`,`T`,`X`,`T`]],'dao_11111':[[`T`,`X`,`T`,`X`,`T`],[`X`,`T`,`X`,`T`,`X`]],
  'cau_21':[[`T`,`T`,`X`],[`X`,`X`,`T`]],'cau_12':[[`T`,`X`,`X`],[`X`,`T`,`T`]],
  'cau_31':[[`T`,`T`,`T`,`X`],[`X`,`X`,`X`,`T`]],'cau_13':[[`T`,`X`,`X`,`X`],[`X`,`T`,`T`,`T`]],
  'cau_22':[[`T`,`T`,`X`,`X`],[`X`,`X`,`T`,`T`]],'cau_33':[[`T`,`T`,`T`,`X`,`X`,`X`],[`X`,`X`,`X`,`T`,`T`,`T`]],
  'cau_221':[[`T`,`T`,`X`,`X`,`T`],[`X`,`X`,`T`,`T`,`X`]],'cau_212':[[`T`,`T`,`X`,`T`,`T`],[`X`,`X`,`T`,`X`,`X`]],
  'cau_312':[[`T`,`T`,`T`,`X`,`T`,`T`],[`X`,`X`,`X`,`T`,`X`,`X`]],
  'bridge_1':[[`T`,`T`,`X`,`T`,`T`],[`X`,`X`,`T`,`X`,`X`]],
  'sym_1':[[`T`,`X`,`X`,`T`],[`X`,`T`,`T`,`X`]],'sym_2':[[`T`,`T`,`X`,`X`,`T`,`T`],[`X`,`X`,`T`,`T`,`X`,`X`]],
  'long_2':[[`T`,`T`,`X`,`X`,`T`,`T`,`X`,`X`],[`X`,`X`,`T`,`T`,`X`,`X`,`T`,`T`]],
};

// ============================================================
// 100+ ALGORITHMS
// ============================================================
function markovPredict(tx,order,minS=4,minC=0.60) {
  if(tx.length<order+minS)return null;
  const m={};
  for(let i=0;i<=tx.length-order-1;i++){const k=tx.slice(i,i+order).join('');const n=tx[i+order];m[k]=m[k]||{T:0,X:0};m[k][n]++;}
  const k=tx.slice(-order).join('');const c=m[k];
  if(!c)return null;const t=c.T+c.X;if(t<minS)return null;
  const cf=Math.max(c.T,c.X)/t;if(cf<minC)return null;
  return c.T>c.X?'T':'X';
}
function ngramPredict(tx,k,minM=3,minD=2) {
  if(tx.length<k+minM)return null;
  const last=tx.slice(-k).join('');let T=0,X=0;
  for(let i=0;i<=tx.length-k-1;i++){if(tx.slice(i,i+k).join('')===last){tx[i+k]==='T'?T++:X++;}}
  if(T+X<minM||Math.abs(T-X)<minD)return null;
  return T>X?'T':'X';
}

const A01=h=>markovPredict(h.map(r=>r.tx),1,5,0.58);
const A02=h=>markovPredict(h.map(r=>r.tx),2,5,0.60);
const A03=h=>markovPredict(h.map(r=>r.tx),3,4,0.62);
const A04=h=>markovPredict(h.map(r=>r.tx),4,4,0.64);
const A05=h=>markovPredict(h.map(r=>r.tx),5,3,0.66);
const A06=h=>markovPredict(h.map(r=>r.tx),6,3,0.68);
const A07=h=>markovPredict(h.map(r=>r.tx),2,3,0.55);
const A08=h=>markovPredict(h.map(r=>r.tx),3,3,0.58);
const A09=h=>markovPredict(h.map(r=>r.tx).slice(-30),3,3,0.60);
const A10=h=>markovPredict(h.map(r=>r.tx).slice(-50),4,3,0.62);

const B01=h=>ngramPredict(h.map(r=>r.tx),3,3,2);
const B02=h=>ngramPredict(h.map(r=>r.tx),4,3,2);
const B03=h=>ngramPredict(h.map(r=>r.tx),5,2,1);
const B04=h=>ngramPredict(h.map(r=>r.tx),6,2,1);
const B05=h=>ngramPredict(h.map(r=>r.tx),7,2,1);
const B06=h=>{
  const tx=h.map(r=>r.tx);if(tx.length<20)return null;
  const last=tx.slice(-5).join('');let T=0,X=0;
  for(let i=0;i<=tx.length-6;i++){const s=similarity(tx.slice(i,i+5).join(''),last);if(s>=0.8){tx[i+5]==='T'?T+=s:X+=s;}}
  return T===X?null:T>X?'T':'X';
};
const B07=h=>{
  const tx=h.map(r=>r.tx);if(tx.length<25)return null;
  const last=tx.slice(-6).join('');let T=0,X=0;
  for(let i=0;i<=tx.length-7;i++){const s=similarity(tx.slice(i,i+6).join(''),last);if(s>=0.75){tx[i+6]==='T'?T+=s:X+=s;}}
  return T===X?null:T>X?'T':'X';
};
const B08=h=>ngramPredict(h.map(r=>r.tx).slice(-60),4,2,1);
const B09=h=>ngramPredict(h.map(r=>r.tx).slice(-40),3,2,1);
const B10=h=>{
  const tx=h.map(r=>r.tx);if(tx.length<30)return null;
  const last=tx.slice(-8).join('');let T=0,X=0;
  for(let i=0;i<=tx.length-9;i++){const s=similarity(tx.slice(i,i+8).join(''),last);if(s>=0.70){tx[i+8]==='T'?T+=s:X+=s;}}
  return T===X?null:T>X?'T':'X';
};

const C01=h=>{const{val,len}=getStreak(h.map(r=>r.tx));return len===2?val:null;};
const C02=h=>{const{val,len}=getStreak(h.map(r=>r.tx));return len>=3&&len<=4?val:null;};
const C03=h=>{const{val,len}=getStreak(h.map(r=>r.tx));return len>=5&&len<=6?val:null;};
const C04=h=>{const{val,len}=getStreak(h.map(r=>r.tx));return len>=7?(val==='T'?'X':'T'):null;};
const C05=h=>{
  const tx=h.map(r=>r.tx);let cnt=1;
  for(let i=tx.length-2;i>=0&&tx[i]!==tx[i+1];i--)cnt++;
  return cnt>=6?(tx.at(-1)==='T'?'X':'T'):null;
};
const C06=h=>{
  const tx=h.map(r=>r.tx);let cnt=1;
  for(let i=tx.length-2;i>=0&&tx[i]!==tx[i+1];i--)cnt++;
  return cnt>=4&&cnt<6?(tx.at(-1)==='T'?'X':'T'):null;
};
const C07=h=>{
  const tx=h.map(r=>r.tx);let cnt=1;
  for(let i=tx.length-2;i>=0&&tx[i]!==tx[i+1];i--)cnt++;
  return cnt>=8?tx.at(-1):null;
};
const C08=h=>{
  const tx=h.map(r=>r.tx);if(tx.length<8)return null;
  const last8=tx.slice(-8);const pairs=[0,2,4,6].map(i=>last8[i]+last8[i+1]);
  if(pairs.every(p=>p==='TT'||p==='XX')&&pairs[0]!==pairs[1]&&pairs[1]!==pairs[2]&&pairs[2]!==pairs[3])return pairs[3][0];
  return null;
};
const C09=h=>{
  const tx=h.map(r=>r.tx);if(tx.length<6)return null;
  const[a,b,c,d,e,f]=tx.slice(-6);
  return a===b&&b===c&&d===e&&e===f&&c!==d?c:null;
};
const C10=h=>{
  const tx=h.map(r=>r.tx);
  for(const[,variants]of Object.entries(PATTERN_DB)){for(const v of variants){const vl=v.length;if(tx.length<vl)continue;if(tx.slice(-vl).every((c,i)=>c===v[i]))return tx.at(-1)==='T'?'X':'T';}}
  return null;
};

const D01=h=>{if(h.length<20)return null;const tx=h.map(r=>r.tx);const T=tx.filter(c=>c==='T').length/tx.length;return T>0.62?'X':T<0.38?'T':null;};
const D02=h=>{if(h.length<20)return null;const tx=h.map(r=>r.tx).slice(-20);const T=tx.filter(c=>c==='T').length;return T>=14?'X':T<=6?'T':null;};
const D03=h=>{if(h.length<10)return null;const tx=h.map(r=>r.tx).slice(-10);const T=tx.filter(c=>c==='T').length;return T>=8?'X':T<=2?'T':null;};
const D04=h=>{if(h.length<50)return null;const tx=h.map(r=>r.tx);const sT=tx.slice(-10).filter(c=>c==='T').length/10;const lT=tx.filter(c=>c==='T').length/tx.length;const d=sT-lT;return d>0.2?'X':d<-0.2?'T':null;};
const D05=h=>{if(h.length<30)return null;const tx=h.map(r=>r.tx);const r20=tx.slice(-20).filter(c=>c==='T').length/20;const r50=tx.slice(-50).filter(c=>c==='T').length/Math.min(50,tx.length);const d=r20-r50;return d>0.18?'X':d<-0.18?'T':null;};
const D06=h=>{if(h.length<10)return null;const tx=h.map(r=>r.tx).slice(-10);let s=0;tx.forEach((v,i)=>{s+=(v==='T'?1:-1)*(i+1);});const n=s/55;return n>0.2?'T':n<-0.2?'X':null;};
const D07=h=>{if(h.length<20)return null;const tx=h.map(r=>r.tx).slice(-20);const ent=entropy(tx);if(ent<0.7){const T=tx.filter(c=>c==='T').length;return T>10?'T':'X';}return null;};
const D08=h=>{if(h.length<20)return null;const tx=h.map(r=>r.tx);const bins=tx.map(v=>v==='T'?1:0);const ma5=avg(bins.slice(-5));const ma15=avg(bins.slice(-15));const d=ma5-ma15;return d>0.12?'T':d<-0.12?'X':null;};
const D09=h=>{if(h.length<10)return null;const a=avg(h.slice(-15).map(r=>r.total));return a<9.5?'T':a>11.5?'X':null;};
const D10=h=>{if(h.length<10)return null;const sums=h.slice(-10).map(r=>r.total);const a=avg(sums);const v=avg(sums.map(s=>Math.pow(s-a,2)));return v<2.0?(a<10.5?'X':'T'):null;};

// AI engines
const AI01=h=>{const tx=h.map(r=>r.tx);for(let o=5;o>=1;o--){const p=markovPredict(tx,o,3,0.60);if(p)return p;}return null;};
const AI02=h=>{if(h.length<30)return null;const tx=h.map(r=>r.tx);const layers=[markovPredict(tx,2,3,0.55),markovPredict(tx,3,3,0.58),ngramPredict(tx,4,2,1),(()=>{const{val,len}=getStreak(tx);return len>=3?val:null;})(),(()=>{const T=tx.slice(-10).filter(c=>c==='T').length;return T>=7?'X':T<=3?'T':null;})()].filter(Boolean);if(!layers.length)return null;const T=layers.filter(v=>v==='T').length;const X=layers.filter(v=>v==='X').length;return T>X?'T':X>T?'X':null;};
const AI03=h=>{const tx=h.map(r=>r.tx);if(tx.length<40)return null;const target=tx.slice(-10).join('');let T=0,X=0;for(let i=0;i<=tx.length-11;i++){const s=similarity(tx.slice(i,i+10).join(''),target);if(s>=0.75){tx[i+10]==='T'?T+=s:X+=s;}}return T===X?null:T>X?'T':'X';};
const AI04=h=>{const tx=h.map(r=>r.tx);if(tx.length<20)return null;for(const cyc of[3,5,7,9,11]){if(tx.length<cyc*2)continue;const r=tx.slice(-cyc),p=tx.slice(-cyc*2,-cyc);const m=r.filter((v,i)=>v===p[i]).length;if(m>=cyc-1){const idx=tx.length%cyc;if(p[idx])return p[idx];}}return null;};
const AI05=h=>{if(h.length<15)return null;const tx=h.map(r=>r.tx);let pT=0.5;for(const v of tx){pT=v==='T'?Math.min(0.95,pT+0.03):Math.max(0.05,pT-0.03);}return pT>0.62?'X':pT<0.38?'T':null;};
const AI06=h=>{const{runs}=extractFeatures(h);if(runs.length<5)return null;const last5=runs.slice(-5);const avgL=avg(last5.map(r=>r.len));const lr=last5.at(-1);if(lr.len<avgL*0.6)return lr.val;if(lr.len>avgL*1.5)return lr.val==='T'?'X':'T';return null;};
const AI08=h=>{if(h.length<50)return null;const preds=[A01,A02,A03,B01,B02,C01,C02,D01,D02,D06].map(fn=>fn(h)).filter(Boolean);if(!preds.length)return null;const T=preds.filter(v=>v==='T').length,X=preds.filter(v=>v==='X').length;return Math.max(T,X)/(T+X)>=0.65?(T>X?'T':'X'):null;};
const AI09=h=>{const tx=h.map(r=>r.tx);let best=0,pred=null;for(const[,vs]of Object.entries(PATTERN_DB)){for(const v of vs){const vl=v.length;if(tx.length<vl+5)continue;let T=0,X=0;for(let i=0;i<=tx.length-vl-1;i++){if(tx.slice(i,i+vl).every((c,j)=>c===v[j])){tx[i+vl]==='T'?T++:X++;}}const t=T+X;if(t<2)continue;const sc=Math.abs(T-X)/t*t;if(sc>best){best=sc;pred=T>X?'T':'X';}}}return best>=2?pred:null;};
const AI10=h=>{if(h.length<20)return null;const sums=h.slice(-20).map(r=>r.total);const a=avg(sums),s=std(sums),last=h.at(-1).total;return last>a+s*1.2?'X':last<a-s*1.2?'T':null;};
const AI11=h=>{if(h.length<20)return null;const ws=[10,20,30,50].map(w=>{const tx=h.map(r=>r.tx).slice(-w);const T=tx.filter(c=>c==='T').length/tx.length;return T>0.6?'X':T<0.4?'T':null;}).filter(Boolean);if(!ws.length)return null;const T=ws.filter(v=>v==='T').length,X=ws.filter(v=>v==='X').length;return T>X?'T':X>T?'X':null;};
const AI12=h=>{const tx=h.map(r=>r.tx);const{val,len}=getStreak(tx);if(len>=8)return val==='T'?'X':'T';if(len>=5){const runs=extractFeatures(h).runs;const avg_r=avg(runs.map(r=>r.len));if(len>avg_r*1.8)return val==='T'?'X':'T';}return null;};
const AI13=h=>{const tx=h.map(r=>r.tx);let alt=1;for(let i=tx.length-2;i>=0&&tx[i]!==tx[i+1];i--)alt++;if(alt>=10)return tx.at(-1);if(alt>=6)return tx.at(-1)==='T'?'X':'T';return null;};
const AI14=h=>{if(h.length<25)return null;const tx=h.map(r=>r.tx).slice(-25);const ent=entropy(tx);const T=tx.filter(c=>c==='T').length;if(ent<0.75)return T>12?'T':'X';if(ent>0.99)return tx.at(-1)==='T'?'X':'T';return null;};
const AI15=h=>{if(h.length<30)return null;const tx=h.map(r=>r.tx);const T=tx.filter(c=>c==='T').length,X=tx.length-T,exp=tx.length/2;const chi2=Math.pow(T-exp,2)/exp+Math.pow(X-exp,2)/exp;return chi2>3.84?(T>X?'X':'T'):null;};
const AI17=h=>{const tx=h.map(r=>r.tx);if(tx.length<12)return null;for(let ps=2;ps<=4;ps++){const last=tx.slice(-ps*4);if(last.length<ps*4)continue;const groups=[];for(let i=0;i<4;i++)groups.push(last.slice(i*ps,(i+1)*ps));if(groups.every(g=>new Set(g).size===1)){const vals=groups.map(g=>g[0]);if(vals[0]!==vals[1]&&vals[1]!==vals[2]&&vals[2]!==vals[3])return vals[3];}}return null;};
const AI18=h=>{if(h.length<30)return null;const tx=h.map(r=>r.tx);for(const w of[5,8,10]){if(tx.length<w)continue;const wave=tx.slice(-w);const T=wave.filter(c=>c==='T').length;if(T>=w*0.8)return 'X';if(T<=w*0.2)return 'T';}return null;};
const AI19=h=>{if(h.length<15)return null;const tx=h.map(r=>r.tx);const bins=tx.map(v=>v==='T'?1:-1);const ma3=avg(bins.slice(-3));const ma7=avg(bins.slice(-7));const ma15=avg(bins.slice(-15));if(ma3>0.3&&ma7>0&&ma15<0)return 'T';if(ma3<-0.3&&ma7<0&&ma15>0)return 'X';if(ma3>0.5)return 'T';if(ma3<-0.5)return 'X';return null;};
const AI20=h=>{if(h.length<50)return null;const all=[AI01,AI02,AI03,AI04,AI05,AI06,AI08,AI09,AI11,AI12,AI14,AI15,AI17,AI18,AI19,A01,A02,A03,B01,B02,C01,C02,C05,C08,C09,D01,D02,D04,D06,D08].map(fn=>fn(h)).filter(Boolean);if(all.length<5)return null;const T=all.filter(v=>v==='T').length,X=all.filter(v=>v==='X').length;return Math.max(T,X)/all.length>=0.62?(T>X?'T':'X'):null;};

// Extended
const E01=h=>markovPredict(h.map(r=>r.tx).slice(-30),2,3,0.60);
const E02=h=>markovPredict(h.map(r=>r.tx).slice(-40),3,3,0.62);
const E03=h=>markovPredict(h.map(r=>r.tx).slice(-25),2,3,0.58);
const E04=h=>markovPredict(h.map(r=>r.tx).slice(-35),3,3,0.60);
const E05=h=>markovPredict(h.map(r=>r.tx).slice(-20),2,3,0.62);
const E06=h=>markovPredict(h.map(r=>r.tx).slice(-45),4,2,0.64);
const E07=h=>markovPredict(h.map(r=>r.tx).slice(-50),5,2,0.65);
const E08=h=>ngramPredict(h.map(r=>r.tx).slice(-30),3,2,1);
const E09=h=>ngramPredict(h.map(r=>r.tx).slice(-50),5,2,1);
const E10=h=>ngramPredict(h.map(r=>r.tx).slice(-80),6,2,1);
const E11=h=>{const tx=h.map(r=>r.tx);if(tx.length<3)return null;const[a,b,c]=tx.slice(-3);return a!==b&&b===c?a:null;};
const E12=h=>{const tx=h.map(r=>r.tx);if(tx.length<3)return null;const[a,b,c]=tx.slice(-3);return a===b&&b!==c?a:null;};
const E13=h=>{const tx=h.map(r=>r.tx);if(tx.length<4)return null;const[a,b,c,d]=tx.slice(-4);return a===b&&b===c&&c!==d?a:null;};
const E14=h=>{const tx=h.map(r=>r.tx);if(tx.length<4)return null;const[a,b,c,d]=tx.slice(-4);return a!==b&&b===c&&c===d?b:null;};
const E15=h=>{const tx=h.map(r=>r.tx);if(tx.length<5)return null;const l=tx.slice(-5);return l.slice(0,4).every(v=>v===l[0])&&l[4]!==l[0]?l[0]:null;};
const E16=h=>{const tx=h.map(r=>r.tx);if(tx.length<12)return null;const p4=tx.slice(-4).join('');return p4===tx.slice(-8,-4).join('')&&p4===tx.slice(-12,-8).join('')?(tx.at(-1)==='T'?'X':'T'):null;};
const E17=h=>{const tx=h.map(r=>r.tx).slice(-15);if(tx.length<15)return null;const T=tx.filter(v=>v==='T').length;return T>=12?'X':T<=3?'T':null;};
const E18=h=>{const tx=h.map(r=>r.tx).slice(-20);if(tx.length<20)return null;const T=tx.filter(v=>v==='T').length;return Math.abs(T-10)<=1?(tx.at(-1)==='T'?'X':'T'):null;};
const E19=h=>{if(h.length<10)return null;const tx=h.map(r=>r.tx);const last=tx.at(-1);const T10=tx.slice(-10).filter(v=>v==='T').length;if(last==='T'&&T10>=7)return 'X';if(last==='X'&&T10<=3)return 'T';return null;};
const E20=h=>{const fibs=new Set([1,2,3,5,8,13,21,34,55,89]);if(fibs.has(h.length%89)){const tx=h.map(r=>r.tx);return tx.at(-1)==='T'?'X':'T';}return null;};
const E21=h=>{if(h.length<5)return null;const last=h.at(-1).total;return last>=15?'X':last<=6?'T':null;};
const E22=h=>{if(h.length<10)return null;const a=avg(h.slice(-5).map(r=>r.total));return a>=13?'X':a<=8?'T':null;};
const E23=h=>{if(h.length<10)return null;const sums=h.slice(-10).map(r=>r.total);const trend=sums.slice(-3).reduce((s,v,i,a)=>i>0?s+(v-a[i-1]):s,0)/2;return trend>1.5?'T':trend<-1.5?'X':null;};
const E24=h=>{if(h.length<20)return null;const sums=h.slice(-20).map(r=>r.total);const a=avg(sums),s2=std(sums),last=h.at(-1).total;return last>a+s2*1.5?'X':last<a-s2*1.5?'T':null;};
const E25=h=>{if(h.length<15)return null;const ex=h.slice(-15).filter(r=>r.total>=16||r.total<=5).length;return ex>=5?(h.at(-1).total>=11?'X':'T'):null;};
const E26=h=>{if(h.length<10)return null;const sums=h.slice(-10).map(r=>r.total);const inc=sums.every((v,i)=>i===0||v>=sums[i-1]);const dec=sums.every((v,i)=>i===0||v<=sums[i-1]);return inc?'T':dec?'X':null;};
const E27=h=>h.length>=5&&h.at(-1).dice.includes(6)&&h.at(-2)?.dice.includes(6)?'T':null;
const E28=h=>h.length>=5&&h.at(-1).dice.includes(1)&&h.at(-2)?.dice.includes(1)?'X':null;
const E29=h=>{if(h.length<10)return null;const pairs=h.slice(-10).map(r=>r.total).filter(t=>t%2===0).length;return pairs>=8?'T':pairs<=2?'X':null;};
const E30=h=>{if(h.length<10)return null;const sums=h.slice(-10).map(r=>r.total);const diffs=sums.slice(1).map((v,i)=>v-sums[i]);const alt=diffs.every((v,i)=>i===0||(v>0)!==(diffs[i-1]>0));return alt?(h.at(-1).tx==='T'?'X':'T'):null;};
const E31=h=>{const p=AI01(h),q=B01(h);return p&&q&&p===q?p:null;};
const E32=h=>{const p=AI02(h),q=C05(h);return p&&q&&p===q?p:null;};
const E33=h=>{const p=A03(h),q=D04(h);return p&&q&&p===q?p:null;};
const E34=h=>{const p=AI05(h),q=D01(h);return p&&q&&p===q?p:null;};
const E35=h=>{const p=AI06(h),q=C02(h);return p&&q&&p===q?p:null;};
const E36=h=>{const preds=[A01,B01,C01].map(fn=>fn(h)).filter(Boolean);if(preds.length<2)return null;const T=preds.filter(v=>v==='T').length;return T===preds.length?'X':T===0?'T':null;};
const E37=h=>{const s=getStreak(h.map(r=>r.tx));const m=A03(h);return s.len>=3&&m&&m===s.val?m:null;};
const E38=h=>{const p=C10(h),b=AI05(h);return p&&b&&p===b?p:null;};
const E39=h=>{const n=B02(h),f=D02(h);return n&&f&&n===f?n:null;};
const E40=h=>{const m=D08(h),mo=D06(h);return m&&mo&&m===mo?m:null;};
const E41=h=>{const tx=h.map(r=>r.tx);if(tx.length<20)return null;const l5=tx.slice(-5).join('');const p={'TTTXX':'T','XXXTT':'X','TTXXT':'X','XXTTX':'T','TXTXT':'X','XTXTX':'T'};return p[l5]||null;};
const E42=h=>{const tx=h.map(r=>r.tx);if(tx.length<20)return null;const l6=tx.slice(-6).join('');const p={'TTTXXX':'T','XXXTTT':'X','TTXXTT':'X','XXTXXX':'T','TXTXTX':'T','XTXTXT':'X'};return p[l6]||null;};
const E43=h=>{const tx=h.map(r=>r.tx);if(tx.length<8)return null;const l7=tx.slice(-7).join('');const p={'TTTXXXX':'T','XXXTTTT':'X','TXTXTXT':'X','XTXTXTX':'T'};return p[l7]||null;};
const E44=h=>{if(h.length<15)return null;const zone=h.map(r=>r.tx).slice(-15);const T=zone.filter(v=>v==='T').length;return T>=12?'X':T<=3?'T':null;};
const E45=h=>{if(h.length<20)return null;const tx=h.map(r=>r.tx);const[a,b,c,d,e,f,g,k]=tx.slice(-8);return a===b&&c===d&&e===f&&g===k&&a!==c&&c!==e&&e!==g?g:null;};
const E46=h=>{if(h.length<10)return null;const runs=extractFeatures(h).runs;const lens=runs.slice(-6).map(r=>r.len);if(lens.length<4)return null;const inc=lens.every((v,i)=>i===0||v>=lens[i-1]);if(inc)return runs.at(-1).val;const dec=lens.every((v,i)=>i===0||v<=lens[i-1]);return dec?(runs.at(-1).val==='T'?'X':'T'):null;};
const E47=h=>{if(h.length<25)return null;const tx=h.map(r=>r.tx);const l20=tx.slice(-20);const ch=l20.filter((v,i)=>i>0&&v!==l20[i-1]).length;return ch>=17?(tx.at(-1)==='T'?'X':'T'):ch<=3?tx.at(-1):null;};
const E48=h=>{if(h.length<20)return null;const f=extractFeatures(h.slice(-20));if(f.maxRun>=6)return f.runs.at(-1).val==='T'?'X':'T';if(f.entropy<0.6){const T=f.tx.filter(v=>v==='T').length;return T>10?'T':'X';}return null;};
const E49=h=>{if(h.length<10)return null;const l10=h.slice(-10);const cp=l10.filter((r,i)=>i>0&&r.tx===l10[i-1].tx).length;return cp>=7?l10.at(-1).tx:cp<=2?(l10.at(-1).tx==='T'?'X':'T'):null;};
const E50=h=>{if(h.length<30)return null;const preds=[E41,E42,E43,E44,E45,E46,E47,E48,E49].map(fn=>fn(h)).filter(Boolean);if(preds.length<3)return null;const T=preds.filter(v=>v==='T').length,X=preds.filter(v=>v==='X').length;return T>X?'T':X>T?'X':null;};

// VIP: Environment-aware algorithms
const V01 = h => {
  if (h.length < 10) return null;
  const env = classifyEnvironment(h.map(r=>r.tx));
  const tx = h.map(r=>r.tx);
  if (env.type === 'streak') return env.len <= 5 ? env.val : (env.val==='T'?'X':'T');
  if (env.type === 'alternate') return tx.at(-1)==='T'?'X':'T';
  if (env.type === 'double') return C08(h);
  if (env.type === 'biased_T') return 'X';
  if (env.type === 'biased_X') return 'T';
  if (env.type === 'chaotic') return AI15(h);
  return null;
};
const V02 = h => {
  if (h.length < 15) return null;
  const env = classifyEnvironment(h.map(r=>r.tx));
  if (env.type === 'triple') return C09(h);
  if (env.type === 'balanced') return D04(h);
  if (env.type === 'mixed') return AI01(h);
  return null;
};
const V03 = h => {
  if (h.length < 20) return null;
  const tx = h.map(r=>r.tx);
  const env = classifyEnvironment(tx);
  // Nếu môi trường vừa chuyển (10 phiên trước vs 5 phiên gần nhất khác type)
  const prevEnv = classifyEnvironment(tx.slice(0,-5));
  if (prevEnv.type !== env.type) {
    // Môi trường đổi → dùng markov thích nghi
    return markovPredict(tx.slice(-20), 3, 2, 0.58);
  }
  return null;
};

const ALL_ALGORITHMS = [
  {id:'A01',fn:A01,w:1.0},{id:'A02',fn:A02,w:1.1},{id:'A03',fn:A03,w:1.2},{id:'A04',fn:A04,w:1.2},{id:'A05',fn:A05,w:1.1},{id:'A06',fn:A06,w:1.0},{id:'A07',fn:A07,w:0.9},{id:'A08',fn:A08,w:1.0},{id:'A09',fn:A09,w:1.1},{id:'A10',fn:A10,w:1.1},
  {id:'B01',fn:B01,w:1.1},{id:'B02',fn:B02,w:1.2},{id:'B03',fn:B03,w:1.0},{id:'B04',fn:B04,w:1.0},{id:'B05',fn:B05,w:0.9},{id:'B06',fn:B06,w:1.1},{id:'B07',fn:B07,w:1.0},{id:'B08',fn:B08,w:1.0},{id:'B09',fn:B09,w:1.0},{id:'B10',fn:B10,w:0.9},
  {id:'C01',fn:C01,w:1.0},{id:'C02',fn:C02,w:1.1},{id:'C03',fn:C03,w:1.1},{id:'C04',fn:C04,w:1.2},{id:'C05',fn:C05,w:1.2},{id:'C06',fn:C06,w:1.0},{id:'C07',fn:C07,w:0.9},{id:'C08',fn:C08,w:1.1},{id:'C09',fn:C09,w:1.1},{id:'C10',fn:C10,w:1.3},
  {id:'D01',fn:D01,w:1.0},{id:'D02',fn:D02,w:1.1},{id:'D03',fn:D03,w:1.0},{id:'D04',fn:D04,w:1.1},{id:'D05',fn:D05,w:1.0},{id:'D06',fn:D06,w:1.1},{id:'D07',fn:D07,w:0.9},{id:'D08',fn:D08,w:1.0},{id:'D09',fn:D09,w:0.8},{id:'D10',fn:D10,w:0.7},
  {id:'AI01',fn:AI01,w:1.5},{id:'AI02',fn:AI02,w:1.4},{id:'AI03',fn:AI03,w:1.3},{id:'AI04',fn:AI04,w:1.2},{id:'AI05',fn:AI05,w:1.3},{id:'AI06',fn:AI06,w:1.1},{id:'AI08',fn:AI08,w:1.5},{id:'AI09',fn:AI09,w:1.4},{id:'AI10',fn:AI10,w:1.0},{id:'AI11',fn:AI11,w:1.3},{id:'AI12',fn:AI12,w:1.2},{id:'AI13',fn:AI13,w:1.2},{id:'AI14',fn:AI14,w:1.1},{id:'AI15',fn:AI15,w:1.0},{id:'AI17',fn:AI17,w:1.2},{id:'AI18',fn:AI18,w:1.1},{id:'AI19',fn:AI19,w:1.2},{id:'AI20',fn:AI20,w:1.8},
  {id:'E01',fn:E01,w:0.9},{id:'E02',fn:E02,w:0.9},{id:'E03',fn:E03,w:0.9},{id:'E04',fn:E04,w:0.9},{id:'E05',fn:E05,w:0.9},{id:'E06',fn:E06,w:1.0},{id:'E07',fn:E07,w:1.0},{id:'E08',fn:E08,w:0.9},{id:'E09',fn:E09,w:0.9},{id:'E10',fn:E10,w:0.9},{id:'E11',fn:E11,w:1.0},{id:'E12',fn:E12,w:1.0},{id:'E13',fn:E13,w:1.0},{id:'E14',fn:E14,w:1.0},{id:'E15',fn:E15,w:1.0},{id:'E16',fn:E16,w:1.1},{id:'E17',fn:E17,w:1.0},{id:'E18',fn:E18,w:0.8},{id:'E19',fn:E19,w:0.9},{id:'E20',fn:E20,w:0.7},{id:'E21',fn:E21,w:0.8},{id:'E22',fn:E22,w:0.8},{id:'E23',fn:E23,w:0.8},{id:'E24',fn:E24,w:0.9},{id:'E25',fn:E25,w:0.7},{id:'E26',fn:E26,w:0.8},{id:'E27',fn:E27,w:0.6},{id:'E28',fn:E28,w:0.6},{id:'E29',fn:E29,w:0.7},{id:'E30',fn:E30,w:0.8},{id:'E31',fn:E31,w:1.2},{id:'E32',fn:E32,w:1.1},{id:'E33',fn:E33,w:1.1},{id:'E34',fn:E34,w:1.1},{id:'E35',fn:E35,w:1.1},{id:'E36',fn:E36,w:1.0},{id:'E37',fn:E37,w:1.2},{id:'E38',fn:E38,w:1.1},{id:'E39',fn:E39,w:1.1},{id:'E40',fn:E40,w:1.0},{id:'E41',fn:E41,w:1.0},{id:'E42',fn:E42,w:1.0},{id:'E43',fn:E43,w:1.0},{id:'E44',fn:E44,w:1.0},{id:'E45',fn:E45,w:1.0},{id:'E46',fn:E46,w:1.0},{id:'E47',fn:E47,w:1.0},{id:'E48',fn:E48,w:1.0},{id:'E49',fn:E49,w:1.0},{id:'E50',fn:E50,w:1.2},
  // VIP env-aware
  {id:'V01',fn:V01,w:2.0},{id:'V02',fn:V02,w:1.8},{id:'V03',fn:V03,w:1.5},
];

// ============================================================
// ADAPTIVE LEARNER
// ============================================================
class AdaptiveLearner {
  constructor() { this.memory={}; }
  learn(tx,pred,actual) {
    for (let len=3; len<=7; len++) {
      if(tx.length<len)continue;
      const key=tx.slice(-len).join('');
      this.memory[key]=this.memory[key]||{T:0,X:0};
      this.memory[key][actual]++;
    }
  }
  predict(tx) {
    for (let len=7; len>=2; len--) {
      if(tx.length<len)continue;
      const key=tx.slice(-len).join('');const m=this.memory[key];
      if(m&&(m.T+m.X)>=3)return m.T>m.X?'T':m.X>m.T?'X':null;
    }
    return null;
  }
}

// ============================================================
// MASTER ENSEMBLE — PER TABLE
// ============================================================
class MasterEnsemble {
  constructor(tableId) {
    this.tableId     = tableId;
    this.weights     = {};
    this.ema         = 0.08;
    this.minW        = 0.001;
    this.learner     = new AdaptiveLearner();
    this.breakDet    = new BreakDetector();
    this.envLearner  = new EnvLearner();
    this.lastRaw     = null;
    this.consecutiveMiss = 0;  // số tay sai liên tiếp
    this.forceBreak  = false;  // đang ép bẻ cầu
    for (const a of ALL_ALGORITHMS) this.weights[a.id] = a.w;
    this._normalize();
  }

  _normalize() {
    const s=Object.values(this.weights).reduce((a,b)=>a+b,0)||1;
    for(const id in this.weights)this.weights[id]/=s;
  }

  fitInitial(history) {
    if (history.length < 15) return;
    const win = lastN(history, 300);
    const scores = {};
    for (const a of ALL_ALGORITHMS) scores[a.id]=0;
    for (let i=15;i<win.length;i++) {
      const prefix=win.slice(0,i),actual=win[i].tx;
      for (const a of ALL_ALGORITHMS) {
        const p=a.fn(prefix);if(p&&p===actual)scores[a.id]++;
      }
    }
    let total=0;
    for (const a of ALL_ALGORITHMS) {
      this.weights[a.id]=Math.max(this.minW,a.w+(scores[a.id]||0)/Math.max(win.length-15,1)*0.5);
      total+=this.weights[a.id];
    }
    for(const id in this.weights)this.weights[id]/=total;
  }

  updateWithOutcome(history, actual) {
    const tx = history.map(r=>r.tx);
    const env = classifyEnvironment(tx);

    // Update algo weights
    for (const a of ALL_ALGORITHMS) {
      const p=a.fn(history);if(!p)continue;
      const correct=p===actual;
      const reward=correct?1.06:0.94;
      this.weights[a.id]=Math.max(this.minW,this.ema*this.weights[a.id]*reward+(1-this.ema)*this.weights[a.id]);
    }

    // Update sub-learners
    this.learner.learn(tx, this.lastRaw, actual);
    this.breakDet.learn(tx, this.lastRaw, actual);
    this.envLearner.learn(env.type, this.lastRaw, actual);

    // Track consecutive misses
    if (this.lastRaw && this.lastRaw !== actual) {
      this.consecutiveMiss++;
      if (this.consecutiveMiss >= 2) this.forceBreak = true;
    } else {
      this.consecutiveMiss = 0;
      this.forceBreak = false;
    }

    this._normalize();
  }

  predict(history) {
    const tx = history.map(r=>r.tx);
    const env = classifyEnvironment(tx);

    if (history.length < 20) {
      const p=markovPredict(tx,Math.min(2,tx.length-1),2,0.55)||(getStreak(tx).len>=2?getStreak(tx).val:null)||'T';
      this.lastRaw=p;
      return { prediction:p==='T'?'tài':'xỉu', confidence:0.55, rawPrediction:p, phase:'bootstrap', env:env.desc, wasFlipped:false, breakInfo:null };
    }

    // Ensemble vote
    const votes={T:0,X:0};let totalW=0;
    for(const a of ALL_ALGORITHMS){const p=a.fn(history);if(!p)continue;const w=this.weights[a.id]||a.w;votes[p]+=w;totalW+=w;}

    // Adaptive learner vote (extra weight)
    const lp = this.learner.predict(tx);
    if(lp){votes[lp]+=0.15;totalW+=0.15;}

    let raw, confidence;
    if (!totalW) {
      const T15=tx.slice(-15).filter(v=>v==='T').length;raw=T15>=8?'X':'T';confidence=0.55;
    } else {
      raw=votes.T>=votes.X?'T':'X';
      confidence=Math.min(0.96,Math.max(0.52,Math.max(votes.T,votes.X)/totalW));
    }

    this.lastRaw = raw;

    // Check break detector
    const breakInfo = this.breakDet.checkBreak(tx);
    // Env adjustment
    const envAdj = this.envLearner.adjust(env.type, raw, confidence);

    // Final decision: apply breaks
    let final = raw;
    let wasFlipped = false;
    let flipReason = '';

    if (this.forceBreak && this.consecutiveMiss >= 2) {
      final = raw==='T'?'X':'T';
      wasFlipped = true;
      flipReason = `bẻ cầu tự động (sai ${this.consecutiveMiss} tay liên tiếp)`;
    } else if (breakInfo.shouldBreak && breakInfo.breakProb >= 0.65) {
      final = raw==='T'?'X':'T';
      wasFlipped = true;
      flipReason = `break detector: ${breakInfo.reason}`;
    } else if (envAdj.adjusted) {
      final = envAdj.pred;
      wasFlipped = true;
      flipReason = `env learner điều chỉnh (môi trường ${env.type})`;
    }

    return {
      prediction:    final==='T'?'tài':'xỉu',
      confidence:    parseFloat(confidence.toFixed(4)),
      rawPrediction: final,
      rawBeforeFlip: raw,
      wasFlipped,
      flipReason,
      votesT:        parseFloat((votes.T||0).toFixed(4)),
      votesX:        parseFloat((votes.X||0).toFixed(4)),
      activeModels:  Object.values(votes).filter(v=>v>0).length,
      totalAlgos:    ALL_ALGORITHMS.length,
      phase:         'full',
      env:           env.desc,
      envType:       env.type,
      envConf:       env.conf,
      breakInfo:     { prob: breakInfo.breakProb.toFixed(3), reason: breakInfo.reason||'none' },
      consecutiveMiss: this.consecutiveMiss,
      breakDetStats: this.breakDet.getStats(),
    };
  }
}

// ============================================================
// PER-TABLE MANAGER
// ============================================================
class TableManager {
  constructor(tableId, apiUrl) {
    this.tableId       = tableId;
    this.apiUrl        = apiUrl;
    this.history       = [];
    this.ensemble      = new MasterEnsemble(tableId);
    this.lastPred      = null;
    this.currentSession = null;
    this.fetchInterval = null;
  }

  parseLines(data) {
    if (!Array.isArray(data)) return [];
    return data.sort((a,b)=>b.SessionId-a.SessionId).map(item=>{
      const ismd5 = this.tableId === 'md5';
      const total = ismd5 ? item.DiceSum : item.DiceSum;
      const tx = total >= 11 ? 'T' : 'X';
      return { session:item.SessionId, dice:[item.FirstDice,item.SecondDice,item.ThirdDice], total, result:tx==='T'?'TAI':'XIU', tx };
    }).sort((a,b)=>a.session-b.session);
  }

  loadInitial(lines) {
    this.history = lines;
    this.ensemble.fitInitial(this.history);
    this.lastPred = this.ensemble.predict(this.history);
    this.currentSession = lines.at(-1)?.session || null;
    console.log(`[${this.tableId}] 📦 Loaded ${lines.length} phiên → Next: ${this.lastPred.prediction}`);
  }

  pushRecord(rec) {
    const prefix = [...this.history];
    this.history.push(rec);
    if (this.history.length > 300) this.history.shift();
    if (prefix.length >= 5) this.ensemble.updateWithOutcome(prefix, rec.tx);
    this.lastPred = this.ensemble.predict(this.history);
    this.currentSession = rec.session;
    console.log(`[${this.tableId}] 📥 #${rec.session}→${rec.tx} | Next: ${this.lastPred.prediction}${this.lastPred.wasFlipped?' [BẺ CẦU]':''} | Env: ${this.lastPred.env}`);
  }

  async fetchAndProcess() {
    try {
      const res  = await fetch(this.apiUrl);
      const data = await res.json();
      const newH = this.parseLines(data);
      if (!newH.length) return;
      const lastNew = newH.at(-1);

      if (!this.currentSession) {
        this.loadInitial(newH);
      } else if (lastNew.session > this.currentSession) {
        const newRecs = newH.filter(r=>r.session > this.currentSession);
        for (const rec of newRecs) this.pushRecord(rec);
      }
    } catch (e) {
      console.error(`[${this.tableId}] ❌ Fetch error:`, e.message);
    }
  }

  startPolling(ms=5000) {
    this.fetchAndProcess();
    this.fetchInterval = setInterval(()=>this.fetchAndProcess(), ms);
  }

  getPrediction() {
    if (!this.lastPred) this.lastPred = this.ensemble.predict(this.history);
    return this.lastPred;
  }

  getPattern() {
    if (this.history.length < 10) return { last_15_tx:'n/a', streak_val:null, streak_len:0, env:'unknown' };
    const tx = this.history.map(r=>r.tx);
    const { val, len } = getStreak(tx);
    const env = classifyEnvironment(tx);
    return {
      last_15_tx:  tx.slice(-15).join('').toLowerCase(),
      last_30_tx:  tx.slice(-30).join('').toLowerCase(),
      streak_val:  val?.toLowerCase()||null,
      streak_len:  len,
      entropy_20:  entropy(tx.slice(-20)).toFixed(4),
      env_type:    env.type,
      env_desc:    env.desc,
      env_conf:    env.conf.toFixed(2),
    };
  }

  getHistory() { return this.history; }
}

// ============================================================
// INIT TABLES
// ============================================================
const tables = {
  tx:  new TableManager('tx',  APIS.tx),
  md5: new TableManager('md5', APIS.md5),
};

for (const t of Object.values(tables)) t.startPolling(5000);

// ============================================================
// FASTIFY SERVER
// ============================================================
const app = fastify({ logger: false });
await app.register(cors, { origin: '*' });

// Helper to build response
function buildResponse(table) {
  const last   = table.getHistory().at(-1)||null;
  const pred   = table.getPrediction();
  const pattern = table.getPattern();
  if (!last || !pred) return { status:'đang chờ dữ liệu', du_doan:'chưa có' };
  return {
    id:             '@tranhoang2286',
    ban:            table.tableId.toUpperCase(),
    phien_truoc:    last.session,
    xuc_xac1:       last.dice[0], xuc_xac2:last.dice[1], xuc_xac3:last.dice[2],
    tong:           last.total,
    ket_qua:        last.result.toLowerCase(),
    pattern:        pattern.last_15_tx,
    pattern_30:     pattern.last_30_tx,
    streak:         `${pattern.streak_len}x${pattern.streak_val||'?'}`,
    entropy:        pattern.entropy_20,
    moi_truong:     pattern.env_desc,
    moi_truong_type: pattern.env_type,
    moi_truong_conf: pattern.env_conf,
    phien_hien_tai: last.session+1,
    du_doan:        pred.prediction,
    do_tin_cay:     `${(pred.confidence*100).toFixed(0)}%`,
    be_cau:         pred.wasFlipped,
    ly_do_be_cau:   pred.flipReason||null,
    be_cau_lien_tiep: pred.consecutiveMiss,
    break_prob:     pred.breakInfo?.prob,
    active_models:  pred.activeModels,
    total_algos:    pred.totalAlgos,
    phase:          pred.phase,
    vote_tai:       pred.votesT?.toFixed(3),
    vote_xiu:       pred.votesX?.toFixed(3),
  };
}

// ---- TX TABLE ----
app.get('/api/taixiu/max789',    async ()=>buildResponse(tables.tx));
app.get('/api/taixiu/history',   async ()=>[...tables.tx.getHistory()].reverse().map(r=>({session:r.session,dice:r.dice,total:r.total,result:r.result.toLowerCase(),tx:r.tx.toLowerCase()})));
app.get('/api/taixiu/weights',   async ()=>({top20:Object.entries(tables.tx.ensemble.weights).sort((a,b)=>b[1]-a[1]).slice(0,20).map(([id,w])=>({id,weight:w.toFixed(5)})),total:ALL_ALGORITHMS.length}));
app.get('/api/taixiu/break',     async ()=>({stats:tables.tx.ensemble.breakDet.getStats(),log:tables.tx.ensemble.breakDet.log.slice(-10),env:tables.tx.ensemble.envLearner.getStats()}));
app.get('/api/taixiu/env',       async ()=>({env:classifyEnvironment(tables.tx.getHistory().map(r=>r.tx)),envStats:tables.tx.ensemble.envLearner.getStats()}));

// ---- MD5 TABLE ----
app.get('/api/md5/max789',       async ()=>buildResponse(tables.md5));
app.get('/api/md5/history',      async ()=>[...tables.md5.getHistory()].reverse().map(r=>({session:r.session,dice:r.dice,total:r.total,result:r.result.toLowerCase(),tx:r.tx.toLowerCase()})));
app.get('/api/md5/weights',      async ()=>({top20:Object.entries(tables.md5.ensemble.weights).sort((a,b)=>b[1]-a[1]).slice(0,20).map(([id,w])=>({id,weight:w.toFixed(5)})),total:ALL_ALGORITHMS.length}));
app.get('/api/md5/break',        async ()=>({stats:tables.md5.ensemble.breakDet.getStats(),log:tables.md5.ensemble.breakDet.log.slice(-10),env:tables.md5.ensemble.envLearner.getStats()}));
app.get('/api/md5/env',          async ()=>({env:classifyEnvironment(tables.md5.getHistory().map(r=>r.tx)),envStats:tables.md5.ensemble.envLearner.getStats()}));

// ---- ROOT ----
app.get('/', async ()=>({
  status: 'TX Ultra VIP — 2 Bàn | 100+ Thuật Toán | Nhận Diện Môi Trường Cầu | Học Cầu Gãy',
  tables: { taixiu:'TX (Tài Xỉu)', md5:'MD5 (Tài Xỉu MD5)' },
  endpoints: {
    tx:  { predict:'/api/taixiu/max789', history:'/api/taixiu/history', weights:'/api/taixiu/weights', break:'/api/taixiu/break', env:'/api/taixiu/env' },
    md5: { predict:'/api/md5/max789',    history:'/api/md5/history',    weights:'/api/md5/weights',    break:'/api/md5/break',    env:'/api/md5/env' },
  }
}));

// START
try {
  await app.listen({ port:PORT, host:'0.0.0.0' });
  let ip='0.0.0.0';
  try { ip=(await (await fetch('https://ifconfig.me/ip')).text()).trim(); } catch {}
  console.log('\n'+'='.repeat(68));
  console.log('  TX ULTRA VIP — 2 BÀN | 100+ ALGO | MÔI TRƯỜNG CẦU | CẦU GÃY AI');
  console.log('='.repeat(68));
  console.log(`  📍 Local:        http://localhost:${PORT}/`);
  console.log(`  🌐 Network:      http://${ip}:${PORT}/`);
  console.log(`  🎲 TX Predict:   http://${ip}:${PORT}/api/taixiu/max789`);
  console.log(`  🎲 MD5 Predict:  http://${ip}:${PORT}/api/md5/max789`);
  console.log(`  🌊 TX Env:       http://${ip}:${PORT}/api/taixiu/env`);
  console.log(`  🌊 MD5 Env:      http://${ip}:${PORT}/api/md5/env`);
  console.log(`  🔧 TX Break:     http://${ip}:${PORT}/api/taixiu/break`);
  console.log(`  🔧 MD5 Break:    http://${ip}:${PORT}/api/md5/break`);
  console.log('='.repeat(68)+'\n');
} catch(err) { console.error('❌',err); process.exit(1); }
