import fastify from "fastify";
import cors from "@fastify/cors";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import fetch from "node-fetch";

const PORT = 4002;
const API_URL = "https://taixiu.maksh3979madfw.com/api/luckydice/GetSoiCau";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let txHistory = [];
let currentSessionId = null;
let fetchInterval = null;

// ============================================================
// UTILITIES
// ============================================================
function sum(nums) { return nums.reduce((a, b) => a + b, 0); }
function avg(nums) { return nums.length ? sum(nums) / nums.length : 0; }
function entropy(arr) {
    if (!arr.length) return 0;
    const freq = arr.reduce((a, v) => { a[v] = (a[v] || 0) + 1; return a; }, {});
    const n = arr.length;
    return -Object.values(freq).reduce((e, c) => { const p = c / n; return e + (p > 0 ? p * Math.log2(p) : 0); }, 0);
}
function similarity(a, b) {
    if (a.length !== b.length) return 0;
    return a.split('').filter((c, i) => c === b[i]).length / a.length;
}
function majority(obj) {
    return Object.entries(obj).reduce((best, [k, v]) => v > best.val ? { key: k, val: v } : best, { key: null, val: -Infinity });
}
function lastN(arr, n) { return arr.slice(Math.max(0, arr.length - n)); }
function std(nums) {
    const m = avg(nums);
    return Math.sqrt(avg(nums.map(n => Math.pow(n - m, 2))));
}
function extractFeatures(history) {
    const tx = history.map(h => h.tx);
    const totals = history.map(h => h.total);
    const freq = tx.reduce((a, v) => { a[v] = (a[v] || 0) + 1; return a; }, {});
    let runs = [], cur = tx[0], len = 1;
    for (let i = 1; i < tx.length; i++) {
        if (tx[i] === cur) len++;
        else { runs.push({ val: cur, len }); cur = tx[i]; len = 1; }
    }
    if (tx.length) runs.push({ val: cur, len });
    return {
        tx, totals, freq, runs,
        maxRun: runs.reduce((m, r) => Math.max(m, r.len), 0),
        meanTotal: avg(totals),
        stdTotal: std(totals),
        entropy: entropy(tx)
    };
}
function parseLines(data) {
    if (!data || !Array.isArray(data)) return [];
    return data
        .sort((a, b) => b.SessionId - a.SessionId)
        .map(item => {
            const tx = item.DiceSum >= 11 ? 'T' : 'X';
            return {
                session: item.SessionId,
                dice: [item.FirstDice, item.SecondDice, item.ThirdDice],
                total: item.DiceSum,
                result: tx === 'T' ? 'TAI' : 'XIU',
                tx
            };
        })
        .sort((a, b) => a.session - b.session);
}

// ============================================================
// PATTERN DATABASE (100+ patterns)
// ============================================================
const PATTERN_DATABASE = {
    'bet_2':  [['T','T'], ['X','X']],
    'bet_3':  [['T','T','T'], ['X','X','X']],
    'bet_4':  [['T','T','T','T'], ['X','X','X','X']],
    'bet_5':  [['T','T','T','T','T'], ['X','X','X','X','X']],
    'bet_6':  [['T','T','T','T','T','T'], ['X','X','X','X','X','X']],
    'dao_11': [['T','X'], ['X','T']],
    'dao_111':[['T','X','T'], ['X','T','X']],
    'dao_1111':[['T','X','T','X'], ['X','T','X','T']],
    'dao_11111':[['T','X','T','X','T'], ['X','T','X','T','X']],
    'dao_111111':[['T','X','T','X','T','X'], ['X','T','X','T','X','T']],
    'cau_21': [['T','T','X'], ['X','X','T']],
    'cau_12': [['T','X','X'], ['X','T','T']],
    'cau_31': [['T','T','T','X'], ['X','X','X','T']],
    'cau_13': [['T','X','X','X'], ['X','T','T','T']],
    'cau_41': [['T','T','T','T','X'], ['X','X','X','X','T']],
    'cau_14': [['T','X','X','X','X'], ['X','T','T','T','T']],
    'cau_51': [['T','T','T','T','T','X'], ['X','X','X','X','X','T']],
    'cau_22': [['T','T','X','X'], ['X','X','T','T']],
    'cau_33': [['T','T','T','X','X','X'], ['X','X','X','T','T','T']],
    'cau_44': [['T','T','T','T','X','X','X','X'], ['X','X','X','X','T','T','T','T']],
    'cau_221':[['T','T','X','X','T'], ['X','X','T','T','X']],
    'cau_122':[['T','X','X','T','T'], ['X','T','T','X','X']],
    'cau_212':[['T','T','X','T','T'], ['X','X','T','X','X']],
    'cau_121':[['T','X','T','X','T'], ['X','T','X','T','X']],
    'cau_312':[['T','T','T','X','T','T'], ['X','X','X','T','X','X']],
    'cau_213':[['T','T','X','T','T','T'], ['X','X','T','X','X','X']],
    'cau_321':[['T','T','T','X','X','T'], ['X','X','X','T','T','X']],
    'cau_123':[['T','X','X','T','T','T'], ['X','T','T','X','X','X']],
    'cau_1121':[['T','X','T','T','X'], ['X','T','X','X','T']],
    'cau_1211':[['T','X','X','T','X'], ['X','T','T','X','T']],
    'cau_2111':[['T','T','X','T','X'], ['X','X','T','X','T']],
    'cau_1112':[['T','X','T','X','X'], ['X','T','X','T','T']],
    'cau_2211':[['T','T','X','X','T','X'], ['X','X','T','T','X','T']],
    'cau_1122':[['T','X','T','X','X','T'], ['X','T','X','T','T','X']],
    'cau_2121':[['T','T','X','T','T','X'], ['X','X','T','X','X','T']],
    'cau_1212':[['T','X','X','T','X','X'], ['X','T','T','X','T','T']],
    'cau_3211':[['T','T','T','X','X','T','X'], ['X','X','X','T','T','X','T']],
    'cau_1132':[['T','X','T','T','T','X','X'], ['X','T','X','X','X','T','T']],
    'cau_2231':[['T','T','X','X','T','T','T','X'], ['X','X','T','T','X','X','X','T']],
    'wave_sym': [['T','T','X','X','T','T'], ['X','X','T','T','X','X']],
    'wave_tri': [['T','X','T','T','X','T'], ['X','T','X','X','T','X']],
    'bridge_1': [['T','T','X','T','T'], ['X','X','T','X','X']],
    'bridge_2': [['T','X','T','X','X','T'], ['X','T','X','T','T','X']],
    'spiral_1': [['T','X','X','T','X'], ['X','T','T','X','T']],
    'spiral_2': [['T','T','X','T','X','X'], ['X','X','T','X','T','T']],
    'spiral_3': [['T','X','T','T','X','T','X'], ['X','T','X','X','T','X','T']],
    'sym_1':    [['T','X','X','T'], ['X','T','T','X']],
    'sym_2':    [['T','T','X','X','T','T'], ['X','X','T','T','X','X']],
    'sym_3':    [['T','T','T','X','T','T','T'], ['X','X','X','T','X','X','X']],
    'asym_1':   [['T','X','T','T'], ['X','T','X','X']],
    'asym_2':   [['T','T','X','X','X'], ['X','X','T','T','T']],
    'alt_start_T': [['T','X','T','X','T'], ['X','T','X','T','X']],
    'alt_start_X': [['X','T','X','T','X'], ['T','X','T','X','T']],
    'cau_comp1':[['T','T','X','T','X','T'], ['X','X','T','X','T','X']],
    'cau_comp2':[['T','X','T','X','T','X','T'], ['X','T','X','T','X','T','X']],
    'cau_comp3':[['T','T','T','X','T','X'], ['X','X','X','T','X','T']],
    'cau_comp4':[['T','X','X','X','T','X'], ['X','T','T','T','X','T']],
    'cau_mix1': [['T','T','X','T','X','X'], ['X','X','T','X','T','T']],
    'cau_mix2': [['T','X','T','T','T','X'], ['X','T','X','X','X','T']],
    'cau_mix3': [['T','T','X','X','T','X','T'], ['X','X','T','T','X','T','X']],
    'cau_mix4': [['T','X','T','X','T','T','X'], ['X','T','X','T','X','X','T']],
    'fib_pat1': [['T','X','T','T','X'], ['X','T','X','X','T']],
    'fib_pat2': [['T','X','T','T','X','T','T','T'], ['X','T','X','X','T','X','X','X']],
    'geo_pat1': [['T','T','X'], ['X','X','T']],
    'geo_pat2': [['T','T','T','X','X'], ['X','X','X','T','T']],
    'geo_pat3': [['T','T','T','T','X','X','X'], ['X','X','X','X','T','T','T']],
    'long_1':   [['T','X','T','X','T','X','T','X'], ['X','T','X','T','X','T','X','T']],
    'long_2':   [['T','T','X','X','T','T','X','X'], ['X','X','T','T','X','X','T','T']],
    'long_3':   [['T','T','T','X','X','X','T','T','T'], ['X','X','X','T','T','T','X','X','X']],
    'long_4':   [['T','X','X','T','T','X','X','T'], ['X','T','T','X','X','T','T','X']],
    'long_5':   [['T','T','X','T','T','X','T','T'], ['X','X','T','X','X','T','X','X']],
    'deep_1':   [['T','X','T','T','X','X','T'], ['X','T','X','X','T','T','X']],
    'deep_2':   [['T','T','X','T','X','X','T','X'], ['X','X','T','X','T','T','X','T']],
    'deep_3':   [['T','X','X','T','X','T','T','X'], ['X','T','T','X','T','X','X','T']],
    'deep_4':   [['T','T','T','X','T','X','X','T'], ['X','X','X','T','X','T','T','X']],
    'deep_5':   [['T','X','T','X','X','T','T','X'], ['X','T','X','T','T','X','X','T']],
    'ultra_1':  [['T','T','X','X','X','T','T','X'], ['X','X','T','T','T','X','X','T']],
    'ultra_2':  [['T','X','T','T','X','T','X','X'], ['X','T','X','X','T','X','T','T']],
    'ultra_3':  [['T','T','X','T','X','T','X','X'], ['X','X','T','X','T','X','T','T']],
    'ultra_4':  [['T','X','X','T','T','T','X','X'], ['X','T','T','X','X','X','T','T']],
    'ultra_5':  [['T','X','T','X','T','T','X','T'], ['X','T','X','T','X','X','T','X']],
};

// ============================================================
// BẺ CẦU STATE MANAGER
// ============================================================
class BreakCauManager {
    constructor() {
        this.isBreaking   = false;  // đang ở chế độ bẻ cầu
        this.breakCount   = 0;      // số tay liên tiếp bẻ
        this.lastWasWrong = false;  // tay vừa rồi có sai không
        this.log          = [];
    }

    // Cập nhật sau khi biết kết quả thực tế
    // predicted: 'T' | 'X', actual: 'T' | 'X'
    update(predicted, actual) {
        const correct = predicted === actual;

        if (!correct) {
            // Sai → bật bẻ cầu
            this.isBreaking   = true;
            this.lastWasWrong = true;
            this.breakCount++;
        } else {
            // Đúng → tắt bẻ cầu
            this.isBreaking   = false;
            this.lastWasWrong = false;
            this.breakCount   = 0;
        }

        this.log.push({ predicted, actual, correct, breaking: this.isBreaking });
        if (this.log.length > 50) this.log.shift();
    }

    // Áp dụng bẻ cầu nếu cần
    apply(rawPred) {
        if (!rawPred) return rawPred;
        if (this.isBreaking) {
            return rawPred === 'T' ? 'X' : 'T';
        }
        return rawPred;
    }

    getStatus() {
        return {
            isBreaking:   this.isBreaking,
            breakCount:   this.breakCount,
            lastWasWrong: this.lastWasWrong
        };
    }
}

// ============================================================
// 100 THUẬT TOÁN DỰ ĐOÁN TÀI XỈU
// ============================================================

// --- NHÓM 1: MARKOV (10 thuật toán) ---
function buildMarkov(tx, order) {
    const m = {};
    for (let i = 0; i <= tx.length - order - 1; i++) {
        const key = tx.slice(i, i + order).join('');
        const nxt = tx[i + order];
        m[key] = m[key] || { T: 0, X: 0 };
        m[key][nxt]++;
    }
    return m;
}
function markovPredict(tx, order, minSamples = 4, minConf = 0.6) {
    if (tx.length < order + minSamples) return null;
    const m = buildMarkov(tx, order);
    const key = tx.slice(-order).join('');
    const c = m[key];
    if (!c) return null;
    const total = c.T + c.X;
    if (total < minSamples) return null;
    const conf = Math.max(c.T, c.X) / total;
    if (conf < minConf) return null;
    return c.T > c.X ? 'T' : 'X';
}
const A01 = h => markovPredict(h.map(r=>r.tx), 1, 5, 0.58);
const A02 = h => markovPredict(h.map(r=>r.tx), 2, 5, 0.60);
const A03 = h => markovPredict(h.map(r=>r.tx), 3, 4, 0.62);
const A04 = h => markovPredict(h.map(r=>r.tx), 4, 4, 0.64);
const A05 = h => markovPredict(h.map(r=>r.tx), 5, 3, 0.66);
const A06 = h => markovPredict(h.map(r=>r.tx), 6, 3, 0.68);
const A07 = h => markovPredict(h.map(r=>r.tx), 2, 3, 0.55);  // relaxed
const A08 = h => markovPredict(h.map(r=>r.tx), 3, 3, 0.58);  // relaxed
const A09 = (h) => { // Markov weighted recent
    const tx = h.map(r=>r.tx);
    if (tx.length < 30) return null;
    const recent = tx.slice(-30);
    return markovPredict(recent, 3, 3, 0.60);
};
const A10 = (h) => { // Markov bậc 4 trên 50 phiên gần nhất
    const tx = h.map(r=>r.tx).slice(-50);
    return markovPredict(tx, 4, 3, 0.62);
};

// --- NHÓM 2: N-GRAM / PATTERN MATCHING (10 thuật toán) ---
function ngramPredict(tx, k, minMatches = 3, minDiff = 2) {
    if (tx.length < k + minMatches) return null;
    const last = tx.slice(-k).join('');
    let T = 0, X = 0;
    for (let i = 0; i <= tx.length - k - 1; i++) {
        if (tx.slice(i, i+k).join('') === last) {
            tx[i+k] === 'T' ? T++ : X++;
        }
    }
    if (T + X < minMatches) return null;
    if (Math.abs(T - X) < minDiff) return null;
    return T > X ? 'T' : 'X';
}
const B01 = h => ngramPredict(h.map(r=>r.tx), 3, 3, 2);
const B02 = h => ngramPredict(h.map(r=>r.tx), 4, 3, 2);
const B03 = h => ngramPredict(h.map(r=>r.tx), 5, 2, 1);
const B04 = h => ngramPredict(h.map(r=>r.tx), 6, 2, 1);
const B05 = h => ngramPredict(h.map(r=>r.tx), 7, 2, 1);
const B06 = (h) => { // fuzzy ngram similarity
    const tx = h.map(r=>r.tx);
    if (tx.length < 20) return null;
    const last = tx.slice(-5).join('');
    let T = 0, X = 0;
    for (let i = 0; i <= tx.length - 6; i++) {
        const s = similarity(tx.slice(i,i+5).join(''), last);
        if (s >= 0.8) { tx[i+5]==='T' ? T+=s : X+=s; }
    }
    return T===X ? null : T>X ? 'T' : 'X';
};
const B07 = (h) => {
    const tx = h.map(r=>r.tx);
    if (tx.length < 25) return null;
    const last = tx.slice(-6).join('');
    let T = 0, X = 0;
    for (let i = 0; i <= tx.length - 7; i++) {
        const s = similarity(tx.slice(i,i+6).join(''), last);
        if (s >= 0.75) { tx[i+6]==='T' ? T+=s : X+=s; }
    }
    return T===X ? null : T>X ? 'T' : 'X';
};
const B08 = h => ngramPredict(h.map(r=>r.tx).slice(-60), 4, 2, 1);
const B09 = h => ngramPredict(h.map(r=>r.tx).slice(-40), 3, 2, 1);
const B10 = (h) => {
    const tx = h.map(r=>r.tx);
    if (tx.length < 30) return null;
    const last = tx.slice(-8).join('');
    let T = 0, X = 0;
    for (let i = 0; i <= tx.length - 9; i++) {
        const s = similarity(tx.slice(i,i+8).join(''), last);
        if (s >= 0.7) { tx[i+8]==='T' ? T+=s : X+=s; }
    }
    return T===X ? null : T>X ? 'T' : 'X';
};

// --- NHÓM 3: STREAK / CẦU BỆT (10 thuật toán) ---
function getStreak(tx) {
    if (!tx.length) return { val: null, len: 0 };
    let len = 1, val = tx.at(-1);
    for (let i = tx.length-2; i >= 0; i--) {
        if (tx[i] === val) len++; else break;
    }
    return { val, len };
}
const C01 = (h) => { // bệt 2: tiếp tục
    const { val, len } = getStreak(h.map(r=>r.tx));
    return len === 2 ? val : null;
};
const C02 = (h) => { // bệt 3-4: tiếp tục
    const { val, len } = getStreak(h.map(r=>r.tx));
    return len >= 3 && len <= 4 ? val : null;
};
const C03 = (h) => { // bệt 5-6: tiếp tục
    const { val, len } = getStreak(h.map(r=>r.tx));
    return len >= 5 && len <= 6 ? val : null;
};
const C04 = (h) => { // bệt >= 7: bẻ
    const { val, len } = getStreak(h.map(r=>r.tx));
    return len >= 7 ? (val==='T'?'X':'T') : null;
};
const C05 = (h) => { // alternating >= 6: tiếp tục đảo
    const tx = h.map(r=>r.tx);
    let cnt = 1;
    for (let i = tx.length-2; i >= 0 && tx[i] !== tx[i+1]; i--) cnt++;
    return cnt >= 6 ? (tx.at(-1)==='T'?'X':'T') : null;
};
const C06 = (h) => { // alternating >= 4
    const tx = h.map(r=>r.tx);
    let cnt = 1;
    for (let i = tx.length-2; i >= 0 && tx[i] !== tx[i+1]; i--) cnt++;
    return cnt >= 4 && cnt < 6 ? (tx.at(-1)==='T'?'X':'T') : null;
};
const C07 = (h) => { // alternating >= 8: bẻ bắt đầu bệt
    const tx = h.map(r=>r.tx);
    let cnt = 1;
    for (let i = tx.length-2; i >= 0 && tx[i] !== tx[i+1]; i--) cnt++;
    return cnt >= 8 ? tx.at(-1) : null;
};
const C08 = (h) => { // double pattern 22
    const tx = h.map(r=>r.tx);
    if (tx.length < 8) return null;
    const last8 = tx.slice(-8);
    const pairs = [0,2,4,6].map(i => last8[i]+last8[i+1]);
    if (pairs.every(p => p==='TT'||p==='XX') && pairs[0]!==pairs[1] && pairs[1]!==pairs[2] && pairs[2]!==pairs[3]) {
        return pairs[3][0];
    }
    return null;
};
const C09 = (h) => { // triple pattern 33
    const tx = h.map(r=>r.tx);
    if (tx.length < 6) return null;
    const [a,b,c,d,e,f] = tx.slice(-6);
    if (a===b&&b===c && d===e&&e===f && c!==d) return c;
    return null;
};
const C10 = (h) => { // pattern database matching
    const tx = h.map(r=>r.tx);
    for (const [, variants] of Object.entries(PATTERN_DATABASE)) {
        for (const variant of variants) {
            const vlen = variant.length;
            if (tx.length < vlen) continue;
            const tail = tx.slice(-vlen);
            if (tail.every((v,i) => v === variant[i])) {
                return tail.at(-1) === 'T' ? 'X' : 'T';
            }
        }
    }
    return null;
};

// --- NHÓM 4: THỐNG KÊ & TẦN SUẤT (10 thuật toán) ---
const D01 = (h) => { // frequency rebalance global
    if (h.length < 20) return null;
    const tx = h.map(r=>r.tx);
    const T = tx.filter(c=>c==='T').length;
    const total = tx.length;
    const r = T / total;
    if (r > 0.62) return 'X';
    if (r < 0.38) return 'T';
    return null;
};
const D02 = (h) => { // window 20 frequency
    if (h.length < 20) return null;
    const tx = h.map(r=>r.tx).slice(-20);
    const T = tx.filter(c=>c==='T').length;
    if (T >= 14) return 'X';
    if (T <= 6) return 'T';
    return null;
};
const D03 = (h) => { // window 10 frequency
    if (h.length < 10) return null;
    const tx = h.map(r=>r.tx).slice(-10);
    const T = tx.filter(c=>c==='T').length;
    if (T >= 8) return 'X';
    if (T <= 2) return 'T';
    return null;
};
const D04 = (h) => { // regression to mean short vs long
    if (h.length < 50) return null;
    const tx = h.map(r=>r.tx);
    const sT = tx.slice(-10).filter(c=>c==='T').length / 10;
    const lT = tx.filter(c=>c==='T').length / tx.length;
    const diff = sT - lT;
    if (diff > 0.2) return 'X';
    if (diff < -0.2) return 'T';
    return null;
};
const D05 = (h) => { // hot cold window
    if (h.length < 30) return null;
    const tx = h.map(r=>r.tx);
    const r20 = tx.slice(-20).filter(c=>c==='T').length / 20;
    const r50 = tx.slice(-50).filter(c=>c==='T').length / Math.min(50, tx.length);
    const diff = r20 - r50;
    if (diff > 0.18) return 'X';
    if (diff < -0.18) return 'T';
    return null;
};
const D06 = (h) => { // momentum weighted
    if (h.length < 10) return null;
    const tx = h.map(r=>r.tx).slice(-10);
    let score = 0;
    tx.forEach((v,i) => { score += (v==='T'?1:-1) * (i+1); });
    const norm = score / 55;
    if (norm > 0.2) return 'T';
    if (norm < -0.2) return 'X';
    return null;
};
const D07 = (h) => { // entropy-based
    if (h.length < 20) return null;
    const tx = h.map(r=>r.tx).slice(-20);
    const ent = entropy(tx);
    if (ent < 0.7) {
        const T = tx.filter(c=>c==='T').length;
        return T > 10 ? 'T' : 'X';
    }
    return null;
};
const D08 = (h) => { // moving average crossover
    if (h.length < 20) return null;
    const tx = h.map(r=>r.tx);
    const bins = tx.map(v=>v==='T'?1:0);
    const ma5  = avg(bins.slice(-5));
    const ma15 = avg(bins.slice(-15));
    const diff = ma5 - ma15;
    if (diff > 0.12) return 'T';
    if (diff < -0.12) return 'X';
    return null;
};
const D09 = (h) => { // dice sum avg analysis
    if (h.length < 10) return null;
    const sums = h.slice(-15).map(r=>r.total);
    const a = avg(sums);
    if (a < 9.5) return 'T';
    if (a > 11.5) return 'X';
    return null;
};
const D10 = (h) => { // dice variance
    if (h.length < 10) return null;
    const sums = h.slice(-10).map(r=>r.total);
    const a = avg(sums);
    const v = avg(sums.map(s=>Math.pow(s-a,2)));
    if (v < 2.0) return a < 10.5 ? 'X' : 'T';
    return null;
};

// --- NHÓM 5: AI LOGIC ENGINES (20 AI) ---

// AI-01: Adaptive Markov bậc động
const AI01 = (h) => {
    const tx = h.map(r=>r.tx);
    for (let ord = 5; ord >= 1; ord--) {
        const p = markovPredict(tx, ord, 3, 0.60);
        if (p) return p;
    }
    return null;
};

// AI-02: Neural-like voting với 5 layer
const AI02 = (h) => {
    if (h.length < 30) return null;
    const tx = h.map(r=>r.tx);
    const layers = [
        markovPredict(tx, 2, 3, 0.55),
        markovPredict(tx, 3, 3, 0.58),
        ngramPredict(tx, 4, 2, 1),
        (() => { const {val,len} = getStreak(tx); return len>=3 ? val : null; })(),
        (() => { const T=tx.slice(-10).filter(c=>c==='T').length; return T>=7?'X':T<=3?'T':null; })()
    ].filter(Boolean);
    if (!layers.length) return null;
    const T = layers.filter(v=>v==='T').length;
    const X = layers.filter(v=>v==='X').length;
    return T > X ? 'T' : X > T ? 'X' : null;
};

// AI-03: Long pattern similarity engine
const AI03 = (h) => {
    const tx = h.map(r=>r.tx);
    if (tx.length < 40) return null;
    const target = tx.slice(-10).join('');
    let T=0, X=0;
    for (let i=0; i<=tx.length-11; i++) {
        const s = similarity(tx.slice(i,i+10).join(''), target);
        if (s>=0.75) { tx[i+10]==='T' ? T+=s : X+=s; }
    }
    return T===X ? null : T>X ? 'T' : 'X';
};

// AI-04: Cycle detector (chu kỳ 3,5,7,9,11)
const AI04 = (h) => {
    const tx = h.map(r=>r.tx);
    if (tx.length < 20) return null;
    for (const cyc of [3,5,7,9,11]) {
        if (tx.length < cyc*2) continue;
        const recent = tx.slice(-cyc);
        const prev   = tx.slice(-cyc*2, -cyc);
        const match  = recent.filter((v,i)=>v===prev[i]).length;
        if (match >= cyc-1) {
            const idx = tx.length % cyc;
            const ref = tx.slice(-cyc*2, -cyc);
            if (ref[idx]) return ref[idx];
        }
    }
    return null;
};

// AI-05: Bayesian posterior
const AI05 = (h) => {
    if (h.length < 15) return null;
    const tx = h.map(r=>r.tx);
    let pT = 0.5, lr = 0.03;
    for (const v of tx) { pT = v==='T' ? Math.min(0.95,pT+lr) : Math.max(0.05,pT-lr); }
    if (pT > 0.62) return 'X';
    if (pT < 0.38) return 'T';
    return null;
};

// AI-06: Run-length analysis
const AI06 = (h) => {
    const { runs } = extractFeatures(h);
    if (runs.length < 5) return null;
    const last5 = runs.slice(-5);
    const avgLen = avg(last5.map(r=>r.len));
    const lastRun = last5.at(-1);
    if (lastRun.len < avgLen * 0.6) return lastRun.val;
    if (lastRun.len > avgLen * 1.5) return lastRun.val==='T'?'X':'T';
    return null;
};

// AI-07: Transformer-like sequence matcher
const AI07 = (h) => {
    const tx = h.map(r=>r.tx);
    if (tx.length < 100) return null;
    const target = tx.slice(-12).join('');
    let T=0, X=0, W=0;
    for (let i=0; i<=tx.length-13; i++) {
        const s = similarity(tx.slice(i,i+12).join(''), target);
        if (s>0.7) {
            const w = s/(tx.length-i);
            tx[i+12]==='T' ? T+=w : X+=w;
            W+=w;
        }
    }
    return W<0.5 ? null : T>X ? 'T' : 'X';
};

// AI-08: Ensemble meta-learner
const AI08 = (h) => {
    if (h.length < 50) return null;
    const preds = [A01,A02,A03,B01,B02,C01,C02,D01,D02,D06]
        .map(fn=>fn(h)).filter(Boolean);
    if (!preds.length) return null;
    const T = preds.filter(v=>v==='T').length;
    const X = preds.filter(v=>v==='X').length;
    const ratio = Math.max(T,X)/(T+X);
    return ratio >= 0.65 ? (T>X?'T':'X') : null;
};

// AI-09: Pattern database deep scan
const AI09 = (h) => {
    const tx = h.map(r=>r.tx);
    let bestScore = 0, bestPred = null;
    for (const [, variants] of Object.entries(PATTERN_DATABASE)) {
        for (const variant of variants) {
            const vlen = variant.length;
            if (tx.length < vlen + 5) continue;
            let T=0, X=0;
            for (let i=0; i<=tx.length-vlen-1; i++) {
                if (tx.slice(i,i+vlen).every((v,j)=>v===variant[j])) {
                    tx[i+vlen]==='T' ? T++ : X++;
                }
            }
            const total = T+X;
            if (total < 2) continue;
            const score = Math.abs(T-X)/total * total;
            if (score > bestScore) { bestScore=score; bestPred=T>X?'T':'X'; }
        }
    }
    return bestScore >= 2 ? bestPred : null;
};

// AI-10: Dice total regression
const AI10 = (h) => {
    if (h.length < 20) return null;
    const sums = h.slice(-20).map(r=>r.total);
    const a = avg(sums);
    const s = std(sums);
    const last = h.at(-1).total;
    if (last > a + s*1.2) return 'X';
    if (last < a - s*1.2) return 'T';
    return null;
};

// AI-11: Multi-window consensus
const AI11 = (h) => {
    if (h.length < 20) return null;
    const windows = [10,20,30,50].map(w => {
        const tx = h.map(r=>r.tx).slice(-w);
        const T = tx.filter(c=>c==='T').length/tx.length;
        return T > 0.6 ? 'X' : T < 0.4 ? 'T' : null;
    }).filter(Boolean);
    if (!windows.length) return null;
    const T = windows.filter(v=>v==='T').length;
    const X = windows.filter(v=>v==='X').length;
    return T > X ? 'T' : X > T ? 'X' : null;
};

// AI-12: Streak reversal pressure
const AI12 = (h) => {
    const tx = h.map(r=>r.tx);
    const { val, len } = getStreak(tx);
    if (len >= 8) return val==='T'?'X':'T';
    if (len >= 5) {
        const runs = extractFeatures(h).runs;
        const avgRunLen = avg(runs.map(r=>r.len));
        if (len > avgRunLen * 1.8) return val==='T'?'X':'T';
    }
    return null;
};

// AI-13: Alternating pressure
const AI13 = (h) => {
    const tx = h.map(r=>r.tx);
    let alt = 1;
    for (let i=tx.length-2; i>=0 && tx[i]!==tx[i+1]; i--) alt++;
    if (alt >= 10) return tx.at(-1);  // quá dài → bắt đầu bệt
    if (alt >= 6) return tx.at(-1)==='T'?'X':'T';  // tiếp tục đảo
    return null;
};

// AI-14: Global entropy judge
const AI14 = (h) => {
    if (h.length < 25) return null;
    const tx = h.map(r=>r.tx).slice(-25);
    const ent = entropy(tx);
    const T = tx.filter(c=>c==='T').length;
    if (ent < 0.75) return T > 12 ? 'T' : 'X';
    if (ent > 0.99) return tx.at(-1)==='T'?'X':'T';
    return null;
};

// AI-15: Statistical chi-square bias detector
const AI15 = (h) => {
    if (h.length < 30) return null;
    const tx = h.map(r=>r.tx);
    const T = tx.filter(c=>c==='T').length;
    const X = tx.length - T;
    const expected = tx.length / 2;
    const chi2 = Math.pow(T-expected,2)/expected + Math.pow(X-expected,2)/expected;
    if (chi2 > 3.84) return T > X ? 'X' : 'T';  // p < 0.05, bù ngược
    return null;
};

// AI-16: Adaptive learning memory
class AdaptiveLearner {
    constructor() { this.memory = {}; this.maxMem = 1000; }
    learn(tx, pred, actual) {
        const key = tx.slice(-5).join('');
        this.memory[key] = this.memory[key] || { T:0, X:0 };
        this.memory[key][actual]++;
    }
    predict(tx) {
        for (let len=5; len>=2; len--) {
            const key = tx.slice(-len).join('');
            const m = this.memory[key];
            if (m && (m.T+m.X) >= 3) {
                return m.T > m.X ? 'T' : m.X > m.T ? 'X' : null;
            }
        }
        return null;
    }
}
const adaptiveLearner = new AdaptiveLearner();
const AI16 = (h) => adaptiveLearner.predict(h.map(r=>r.tx));

// AI-17: Double pattern detector 2-2 extended
const AI17 = (h) => {
    const tx = h.map(r=>r.tx);
    if (tx.length < 12) return null;
    for (let pairSize=2; pairSize<=4; pairSize++) {
        const last = tx.slice(-pairSize*4);
        if (last.length < pairSize*4) continue;
        const groups = [];
        for (let i=0; i<4; i++) groups.push(last.slice(i*pairSize,(i+1)*pairSize));
        if (groups.every(g=>new Set(g).size===1)) {
            const vals = groups.map(g=>g[0]);
            if (vals[0]!==vals[1] && vals[1]!==vals[2] && vals[2]!==vals[3]) {
                return vals[3];
            }
        }
    }
    return null;
};

// AI-18: Wave theory
const AI18 = (h) => {
    if (h.length < 30) return null;
    const tx = h.map(r=>r.tx);
    // Phát hiện "sóng" T nhiều → bù X
    for (const w of [5,8,10]) {
        if (tx.length < w) continue;
        const wave = tx.slice(-w);
        const T = wave.filter(c=>c==='T').length;
        if (T >= w*0.8) return 'X';
        if (T <= w*0.2) return 'T';
    }
    return null;
};

// AI-19: Trend momentum reversal
const AI19 = (h) => {
    if (h.length < 15) return null;
    const tx = h.map(r=>r.tx);
    const bins = tx.map(v=>v==='T'?1:-1);
    const ma3  = avg(bins.slice(-3));
    const ma7  = avg(bins.slice(-7));
    const ma15 = avg(bins.slice(-15));
    // Double crossover
    if (ma3 > 0.3 && ma7 > 0 && ma15 < 0) return 'T';
    if (ma3 < -0.3 && ma7 < 0 && ma15 > 0) return 'X';
    if (ma3 > 0.5) return 'T';
    if (ma3 < -0.5) return 'X';
    return null;
};

// AI-20: Supreme consensus — meta of metas
const AI20 = (h) => {
    if (h.length < 50) return null;
    const aiPreds = [AI01,AI02,AI03,AI04,AI05,AI06,AI08,AI09,AI11,AI12,AI14,AI15,AI17,AI18,AI19]
        .map(fn=>fn(h)).filter(Boolean);
    const algPreds = [A01,A02,A03,B01,B02,C01,C02,C05,C08,C09,D01,D02,D04,D06,D08]
        .map(fn=>fn(h)).filter(Boolean);
    const all = [...aiPreds, ...algPreds];
    if (all.length < 5) return null;
    const T = all.filter(v=>v==='T').length;
    const X = all.filter(v=>v==='X').length;
    const ratio = Math.max(T,X)/all.length;
    return ratio >= 0.62 ? (T>X?'T':'X') : null;
};

// --- NHÓM 6: THUẬT TOÁN BỔ SUNG (50 thuật toán còn lại) ---

// E01-E10: Extended Markov với window giới hạn
const E01 = h => markovPredict(h.map(r=>r.tx).slice(-30), 2, 3, 0.60);
const E02 = h => markovPredict(h.map(r=>r.tx).slice(-40), 3, 3, 0.62);
const E03 = h => markovPredict(h.map(r=>r.tx).slice(-25), 2, 3, 0.58);
const E04 = h => markovPredict(h.map(r=>r.tx).slice(-35), 3, 3, 0.60);
const E05 = h => markovPredict(h.map(r=>r.tx).slice(-20), 2, 3, 0.62);
const E06 = h => markovPredict(h.map(r=>r.tx).slice(-45), 4, 2, 0.64);
const E07 = h => markovPredict(h.map(r=>r.tx).slice(-50), 5, 2, 0.65);
const E08 = h => ngramPredict(h.map(r=>r.tx).slice(-30), 3, 2, 1);
const E09 = h => ngramPredict(h.map(r=>r.tx).slice(-50), 5, 2, 1);
const E10 = h => ngramPredict(h.map(r=>r.tx).slice(-80), 6, 2, 1);

// E11-E20: Advanced streak logic
const E11 = (h) => { // cầu 1-2: TXX → T
    const tx = h.map(r=>r.tx);
    if (tx.length < 3) return null;
    const [a,b,c] = tx.slice(-3);
    if (a!==b && b===c) return a;
    return null;
};
const E12 = (h) => { // cầu 2-1: TTX → T
    const tx = h.map(r=>r.tx);
    if (tx.length < 3) return null;
    const [a,b,c] = tx.slice(-3);
    if (a===b && b!==c) return a;
    return null;
};
const E13 = (h) => { // cầu 3-1: TTTX → T
    const tx = h.map(r=>r.tx);
    if (tx.length < 4) return null;
    const [a,b,c,d] = tx.slice(-4);
    if (a===b&&b===c&&c!==d) return a;
    return null;
};
const E14 = (h) => { // cầu 1-3: TXXX → X
    const tx = h.map(r=>r.tx);
    if (tx.length < 4) return null;
    const [a,b,c,d] = tx.slice(-4);
    if (a!==b&&b===c&&c===d) return b;
    return null;
};
const E15 = (h) => { // cầu 4-1: TTTTX → T
    const tx = h.map(r=>r.tx);
    if (tx.length < 5) return null;
    const last5 = tx.slice(-5);
    if (last5.slice(0,4).every(v=>v===last5[0]) && last5[4]!==last5[0]) return last5[0];
    return null;
};
const E16 = (h) => { // cầu vòng lặp 4: kiểm tra chu kỳ 4
    const tx = h.map(r=>r.tx);
    if (tx.length < 12) return null;
    const p4 = tx.slice(-4).join('');
    const p4_2 = tx.slice(-8,-4).join('');
    const p4_3 = tx.slice(-12,-8).join('');
    if (p4===p4_2 && p4_2===p4_3) return tx.at(-1)==='T'?'X':'T';
    return null;
};
const E17 = (h) => { // Big wave 15: T>=12 → X
    const tx = h.map(r=>r.tx).slice(-15);
    if (tx.length < 15) return null;
    const T = tx.filter(v=>v==='T').length;
    if (T >= 12) return 'X';
    if (T <= 3) return 'T';
    return null;
};
const E18 = (h) => { // balanced zone flip
    const tx = h.map(r=>r.tx).slice(-20);
    if (tx.length < 20) return null;
    const T = tx.filter(v=>v==='T').length;
    if (Math.abs(T-10)<=1) return tx.at(-1)==='T'?'X':'T';
    return null;
};
const E19 = (h) => { // last result inverse with freq check
    if (h.length < 10) return null;
    const tx = h.map(r=>r.tx);
    const last = tx.at(-1);
    const T10 = tx.slice(-10).filter(v=>v==='T').length;
    if (last==='T' && T10>=7) return 'X';
    if (last==='X' && T10<=3) return 'T';
    return null;
};
const E20 = (h) => { // Fibonacci index check
    const fibs = new Set([1,2,3,5,8,13,21,34,55,89,144,233]);
    if (fibs.has(h.length % 233)) {
        const tx = h.map(r=>r.tx);
        return tx.at(-1)==='T'?'X':'T';
    }
    return null;
};

// E21-E30: Dice total advanced
const E21 = (h) => {
    if (h.length < 5) return null;
    const last = h.at(-1).total;
    return last >= 15 ? 'X' : last <= 6 ? 'T' : null;
};
const E22 = (h) => {
    if (h.length < 10) return null;
    const sums = h.slice(-5).map(r=>r.total);
    const a = avg(sums);
    return a >= 13 ? 'X' : a <= 8 ? 'T' : null;
};
const E23 = (h) => {
    if (h.length < 10) return null;
    const sums = h.slice(-10).map(r=>r.total);
    const trend = sums.slice(-3).reduce((s,v,i,a)=>i>0?s+(v-a[i-1]):s,0)/2;
    if (trend > 1.5) return 'T';
    if (trend < -1.5) return 'X';
    return null;
};
const E24 = (h) => {
    if (h.length < 20) return null;
    const sums = h.slice(-20).map(r=>r.total);
    const s = std(sums);
    const a = avg(sums);
    const last = h.at(-1).total;
    if (last > a+s*1.5) return 'X';
    if (last < a-s*1.5) return 'T';
    return null;
};
const E25 = (h) => {
    if (h.length < 15) return null;
    const extremes = h.slice(-15).filter(r=>r.total>=16||r.total<=5).length;
    return extremes >= 5 ? (h.at(-1).total>=11?'X':'T') : null;
};
const E26 = (h) => {
    if (h.length < 10) return null;
    const sums = h.slice(-10).map(r=>r.total);
    const increasing = sums.every((v,i)=>i===0||v>=sums[i-1]);
    const decreasing = sums.every((v,i)=>i===0||v<=sums[i-1]);
    if (increasing) return 'T';
    if (decreasing) return 'X';
    return null;
};
const E27 = h => h.length>=5 && h.at(-1).dice.includes(6) && h.at(-2)?.dice.includes(6) ? 'T' : null;
const E28 = h => h.length>=5 && h.at(-1).dice.includes(1) && h.at(-2)?.dice.includes(1) ? 'X' : null;
const E29 = (h) => {
    if (h.length < 10) return null;
    const totals = h.slice(-10).map(r=>r.total);
    const pairs = totals.filter(t=>t%2===0).length;
    return pairs >= 8 ? 'T' : pairs <= 2 ? 'X' : null;
};
const E30 = (h) => {
    if (h.length < 10) return null;
    const sums = h.slice(-10).map(r=>r.total);
    const diffs = sums.slice(1).map((v,i)=>v-sums[i]);
    const altDiff = diffs.every((v,i)=>i===0||(v>0)!==(diffs[i-1]>0));
    return altDiff ? (h.at(-1).tx==='T'?'X':'T') : null;
};

// E31-E50: Combo and advanced pattern algorithms
const E31 = h => { const p=AI01(h); const q=B01(h); return p&&q&&p===q?p:null; };
const E32 = h => { const p=AI02(h); const q=C05(h); return p&&q&&p===q?p:null; };
const E33 = h => { const p=A03(h); const q=D04(h); return p&&q&&p===q?p:null; };
const E34 = h => { const p=AI05(h); const q=D01(h); return p&&q&&p===q?p:null; };
const E35 = h => { const p=AI06(h); const q=C02(h); return p&&q&&p===q?p:null; };
const E36 = (h) => { // reverse of last 3 algo consensus
    const preds = [A01,B01,C01].map(fn=>fn(h)).filter(Boolean);
    if (preds.length<2) return null;
    const T=preds.filter(v=>v==='T').length;
    return T===preds.length?'X':T===0?'T':null;
};
const E37 = (h) => { // streak + markov confirm
    const s = getStreak(h.map(r=>r.tx));
    const m = A03(h);
    if (s.len>=3 && m && m===s.val) return m;
    return null;
};
const E38 = (h) => { // pattern + bayesian
    const p = C10(h);
    const b = AI05(h);
    return p&&b&&p===b?p:null;
};
const E39 = (h) => { // ngram + frequency
    const n = B02(h);
    const f = D02(h);
    return n&&f&&n===f?n:null;
};
const E40 = (h) => { // MA + momentum
    const m = D08(h);
    const mo = D06(h);
    return m&&mo&&m===mo?m:null;
};
const E41 = (h) => {
    const tx = h.map(r=>r.tx);
    if (tx.length<20) return null;
    const last5 = tx.slice(-5).join('');
    const patterns5 = {'TTTXX':'T','XXXTT':'X','TTXXT':'X','XXTTX':'T','TXTXT':'X','XTXTX':'T'};
    return patterns5[last5]||null;
};
const E42 = (h) => {
    const tx = h.map(r=>r.tx);
    if (tx.length<20) return null;
    const last6 = tx.slice(-6).join('');
    const patterns6 = {'TTTXXX':'T','XXXTTT':'X','TTXXTT':'X','XXTXXX':'T','TXTXTX':'T','XTXTXT':'X'};
    return patterns6[last6]||null;
};
const E43 = (h) => {
    const tx = h.map(r=>r.tx);
    if (tx.length<8) return null;
    const l7 = tx.slice(-7).join('');
    const p7 = {'TTTXXXX':'T','XXXTTTT':'X','TXTXTXT':'X','XTXTXTX':'T'};
    return p7[l7]||null;
};
const E44 = (h) => {
    if (h.length<15) return null;
    const tx = h.map(r=>r.tx);
    const zone = tx.slice(-15);
    const T=zone.filter(v=>v==='T').length;
    // Khu vực chênh lệch 10+
    if (T>=12) return 'X';
    if (T<=3) return 'T';
    return null;
};
const E45 = (h) => {
    if (h.length<20) return null;
    const tx = h.map(r=>r.tx);
    // Phát hiện đang trong cầu kép
    const last8 = tx.slice(-8);
    const [a,b,c,d,e,f,g,k] = last8;
    if (a===b&&c===d&&e===f&&g===k&&a!==c&&c!==e&&e!==g) return g;
    return null;
};
const E46 = (h) => {
    if (h.length<10) return null;
    const runs = extractFeatures(h).runs;
    const lens = runs.slice(-6).map(r=>r.len);
    if (lens.length<4) return null;
    const increasing = lens.every((v,i)=>i===0||v>=lens[i-1]);
    if (increasing) return runs.at(-1).val;
    const decreasing = lens.every((v,i)=>i===0||v<=lens[i-1]);
    if (decreasing) return runs.at(-1).val==='T'?'X':'T';
    return null;
};
const E47 = (h) => {
    if (h.length<25) return null;
    const tx = h.map(r=>r.tx);
    const last20 = tx.slice(-20);
    const changes = last20.filter((v,i)=>i>0&&v!==last20[i-1]).length;
    if (changes>=17) return tx.at(-1)==='T'?'X':'T';
    if (changes<=3) return tx.at(-1);
    return null;
};
const E48 = (h) => {
    if (h.length<20) return null;
    const features = extractFeatures(h.slice(-20));
    if (features.maxRun>=6) return features.runs.at(-1).val==='T'?'X':'T';
    if (features.entropy<0.6) {
        const T=features.tx.filter(v=>v==='T').length;
        return T>10?'T':'X';
    }
    return null;
};
const E49 = (h) => {
    if (h.length<10) return null;
    const last10 = h.slice(-10);
    const consecutivePairs = last10.filter((r,i)=>i>0&&r.tx===last10[i-1].tx).length;
    if (consecutivePairs>=7) return last10.at(-1).tx;
    if (consecutivePairs<=2) return last10.at(-1).tx==='T'?'X':'T';
    return null;
};
const E50 = (h) => {
    if (h.length<30) return null;
    const preds = [E41,E42,E43,E44,E45,E46,E47,E48,E49].map(fn=>fn(h)).filter(Boolean);
    if (preds.length<3) return null;
    const T=preds.filter(v=>v==='T').length;
    const X=preds.filter(v=>v==='X').length;
    return T>X?'T':X>T?'X':null;
};

// ============================================================
// DANH SÁCH 100 THUẬT TOÁN + 20 AI
// ============================================================
const ALL_ALGORITHMS = [
    // Markov (10)
    {id:'A01',fn:A01,w:1.0},{id:'A02',fn:A02,w:1.1},{id:'A03',fn:A03,w:1.2},
    {id:'A04',fn:A04,w:1.2},{id:'A05',fn:A05,w:1.1},{id:'A06',fn:A06,w:1.0},
    {id:'A07',fn:A07,w:0.9},{id:'A08',fn:A08,w:1.0},{id:'A09',fn:A09,w:1.1},
    {id:'A10',fn:A10,w:1.1},
    // N-gram (10)
    {id:'B01',fn:B01,w:1.1},{id:'B02',fn:B02,w:1.2},{id:'B03',fn:B03,w:1.0},
    {id:'B04',fn:B04,w:1.0},{id:'B05',fn:B05,w:0.9},{id:'B06',fn:B06,w:1.1},
    {id:'B07',fn:B07,w:1.0},{id:'B08',fn:B08,w:1.0},{id:'B09',fn:B09,w:1.0},
    {id:'B10',fn:B10,w:0.9},
    // Streak (10)
    {id:'C01',fn:C01,w:1.0},{id:'C02',fn:C02,w:1.1},{id:'C03',fn:C03,w:1.1},
    {id:'C04',fn:C04,w:1.2},{id:'C05',fn:C05,w:1.2},{id:'C06',fn:C06,w:1.0},
    {id:'C07',fn:C07,w:0.9},{id:'C08',fn:C08,w:1.1},{id:'C09',fn:C09,w:1.1},
    {id:'C10',fn:C10,w:1.3},
    // Thống kê (10)
    {id:'D01',fn:D01,w:1.0},{id:'D02',fn:D02,w:1.1},{id:'D03',fn:D03,w:1.0},
    {id:'D04',fn:D04,w:1.1},{id:'D05',fn:D05,w:1.0},{id:'D06',fn:D06,w:1.1},
    {id:'D07',fn:D07,w:0.9},{id:'D08',fn:D08,w:1.0},{id:'D09',fn:D09,w:0.8},
    {id:'D10',fn:D10,w:0.7},
    // AI engines (20)
    {id:'AI01',fn:AI01,w:1.5},{id:'AI02',fn:AI02,w:1.4},{id:'AI03',fn:AI03,w:1.3},
    {id:'AI04',fn:AI04,w:1.2},{id:'AI05',fn:AI05,w:1.3},{id:'AI06',fn:AI06,w:1.1},
    {id:'AI07',fn:AI07,w:1.2},{id:'AI08',fn:AI08,w:1.5},{id:'AI09',fn:AI09,w:1.4},
    {id:'AI10',fn:AI10,w:1.0},{id:'AI11',fn:AI11,w:1.3},{id:'AI12',fn:AI12,w:1.2},
    {id:'AI13',fn:AI13,w:1.2},{id:'AI14',fn:AI14,w:1.1},{id:'AI15',fn:AI15,w:1.0},
    {id:'AI16',fn:AI16,w:1.4},{id:'AI17',fn:AI17,w:1.2},{id:'AI18',fn:AI18,w:1.1},
    {id:'AI19',fn:AI19,w:1.2},{id:'AI20',fn:AI20,w:1.8},
    // Extended (50)
    {id:'E01',fn:E01,w:0.9},{id:'E02',fn:E02,w:0.9},{id:'E03',fn:E03,w:0.9},
    {id:'E04',fn:E04,w:0.9},{id:'E05',fn:E05,w:0.9},{id:'E06',fn:E06,w:1.0},
    {id:'E07',fn:E07,w:1.0},{id:'E08',fn:E08,w:0.9},{id:'E09',fn:E09,w:0.9},
    {id:'E10',fn:E10,w:0.9},{id:'E11',fn:E11,w:1.0},{id:'E12',fn:E12,w:1.0},
    {id:'E13',fn:E13,w:1.0},{id:'E14',fn:E14,w:1.0},{id:'E15',fn:E15,w:1.0},
    {id:'E16',fn:E16,w:1.1},{id:'E17',fn:E17,w:1.0},{id:'E18',fn:E18,w:0.8},
    {id:'E19',fn:E19,w:0.9},{id:'E20',fn:E20,w:0.7},{id:'E21',fn:E21,w:0.8},
    {id:'E22',fn:E22,w:0.8},{id:'E23',fn:E23,w:0.8},{id:'E24',fn:E24,w:0.9},
    {id:'E25',fn:E25,w:0.7},{id:'E26',fn:E26,w:0.8},{id:'E27',fn:E27,w:0.6},
    {id:'E28',fn:E28,w:0.6},{id:'E29',fn:E29,w:0.7},{id:'E30',fn:E30,w:0.8},
    {id:'E31',fn:E31,w:1.2},{id:'E32',fn:E32,w:1.1},{id:'E33',fn:E33,w:1.1},
    {id:'E34',fn:E34,w:1.1},{id:'E35',fn:E35,w:1.1},{id:'E36',fn:E36,w:1.0},
    {id:'E37',fn:E37,w:1.2},{id:'E38',fn:E38,w:1.1},{id:'E39',fn:E39,w:1.1},
    {id:'E40',fn:E40,w:1.0},{id:'E41',fn:E41,w:1.0},{id:'E42',fn:E42,w:1.0},
    {id:'E43',fn:E43,w:1.0},{id:'E44',fn:E44,w:1.0},{id:'E45',fn:E45,w:1.0},
    {id:'E46',fn:E46,w:1.0},{id:'E47',fn:E47,w:1.0},{id:'E48',fn:E48,w:1.0},
    {id:'E49',fn:E49,w:1.0},{id:'E50',fn:E50,w:1.2},
];

// ============================================================
// ENSEMBLE ENGINE + SELF-LEARNING
// ============================================================
class MasterEnsemble {
    constructor() {
        this.weights    = {};
        this.ema        = 0.08;
        this.minW       = 0.001;
        this.breakMgr   = new BreakCauManager();
        this.lastRawPred = null;

        for (const a of ALL_ALGORITHMS) {
            this.weights[a.id] = a.w;
        }
        this._normalizeWeights();
    }

    _normalizeWeights() {
        const s = Object.values(this.weights).reduce((a,b)=>a+b, 0) || 1;
        for (const id in this.weights) this.weights[id] /= s;
    }

    fitInitial(history) {
        const win = lastN(history, 300);
        if (win.length < 15) return;
        const scores = {};
        for (const a of ALL_ALGORITHMS) scores[a.id] = 0;

        for (let i=15; i<win.length; i++) {
            const prefix = win.slice(0, i);
            const actual = win[i].tx;
            for (const a of ALL_ALGORITHMS) {
                const p = a.fn(prefix);
                if (p && p===actual) scores[a.id]++;
            }
        }
        let total = 0;
        for (const a of ALL_ALGORITHMS) {
            const base = a.w;
            const bonus = (scores[a.id] || 0) / Math.max(win.length-15, 1);
            this.weights[a.id] = Math.max(this.minW, base + bonus * 0.5);
            total += this.weights[a.id];
        }
        for (const id in this.weights) this.weights[id] /= total;
        console.log(`✅ Đã fit ${ALL_ALGORITHMS.length} thuật toán trên ${win.length} phiên.`);
    }

    updateWithOutcome(history, actual) {
        for (const a of ALL_ALGORITHMS) {
            const p = a.fn(history);
            if (!p) continue;
            const correct = p === actual;
            const reward  = correct ? 1.06 : 0.94;
            const target  = this.weights[a.id] * reward;
            this.weights[a.id] = Math.max(this.minW, this.ema*target + (1-this.ema)*this.weights[a.id]);
        }
        // Cập nhật adaptive learner
        adaptiveLearner.learn(history.map(r=>r.tx), this.lastRawPred, actual);
        // Cập nhật bẻ cầu
        if (this.lastRawPred) this.breakMgr.update(this.lastRawPred, actual);
        this._normalizeWeights();
    }

    predict(history) {
        const MIN_ALGO_SESSIONS = 20;  // không random sau 20 phiên

        // Giai đoạn khởi tạo (< 20 phiên): dùng fallback thông minh
        if (history.length < MIN_ALGO_SESSIONS) {
            const tx = history.map(r=>r.tx);
            let p = null;
            if (tx.length >= 3) {
                p = markovPredict(tx, Math.min(2,tx.length-1), 2, 0.55)
                    || (getStreak(tx).len >= 2 ? getStreak(tx).val : null)
                    || (tx.length >= 5 ? (tx.slice(-5).filter(v=>v==='T').length >= 4 ? 'X' : tx.slice(-5).filter(v=>v==='X').length >= 4 ? 'T' : null) : null)
                    || (tx.at(-1) === 'T' ? 'X' : 'T');
            }
            const raw = p || 'T';
            this.lastRawPred = raw;
            const final = this.breakMgr.apply(raw);
            return {
                prediction:   final === 'T' ? 'tài' : 'xỉu',
                confidence:   0.55,
                rawPrediction: final,
                phase:        'bootstrap',
                breakStatus:  this.breakMgr.getStatus()
            };
        }

        // Phase chính: Ensemble voting
        const votes = { T: 0, X: 0 };
        const fired = [];
        let totalW  = 0;

        for (const a of ALL_ALGORITHMS) {
            const p = a.fn(history);
            if (!p) continue;
            const w = this.weights[a.id] || a.w;
            votes[p] += w;
            totalW   += w;
            fired.push({ id: a.id, pred: p, w: w.toFixed(4) });
        }

        let raw, confidence;
        if (votes.T === 0 && votes.X === 0) {
            // Tuyệt đối không dùng random — fallback deterministic
            const tx = history.map(r=>r.tx);
            const T15 = tx.slice(-15).filter(v=>v==='T').length;
            raw = T15 >= 8 ? 'X' : 'T';
            confidence = 0.55;
        } else {
            raw = votes.T >= votes.X ? 'T' : 'X';
            confidence = Math.min(0.96, Math.max(0.52, (Math.max(votes.T,votes.X)/totalW)));
        }

        // Áp dụng bẻ cầu
        this.lastRawPred = raw;
        const final = this.breakMgr.apply(raw);
        const wasFlipped = final !== raw;

        return {
            prediction:    final === 'T' ? 'tài' : 'xỉu',
            confidence:    parseFloat(confidence.toFixed(4)),
            rawPrediction: final,
            rawBeforeBreak: raw,
            wasFlipped,
            votesT:  parseFloat(votes.T.toFixed(4)),
            votesX:  parseFloat(votes.X.toFixed(4)),
            activeModels: fired.length,
            totalAlgos:   ALL_ALGORITHMS.length,
            phase:        'full',
            breakStatus:  this.breakMgr.getStatus()
        };
    }
}

// ============================================================
// MANAGER
// ============================================================
class PredictionManager {
    constructor() {
        this.history    = [];
        this.ensemble   = new MasterEnsemble();
        this.lastPred   = null;
    }

    loadInitial(lines) {
        this.history = lines;
        this.ensemble.fitInitial(this.history);
        this.lastPred = this.ensemble.predict(this.history);
        console.log(`📦 Loaded ${lines.length} phiên.`);
        console.log(`🔮 Dự đoán tiếp theo: ${this.lastPred.prediction} (${(this.lastPred.confidence*100).toFixed(0)}%) ${this.lastPred.wasFlipped?'[BẺ CẦU]':''}`);
    }

    pushRecord(record) {
        const prefix = [...this.history];
        this.history.push(record);
        if (this.history.length > 300) this.history.shift();

        if (prefix.length >= 5) {
            this.ensemble.updateWithOutcome(prefix, record.tx);
        }
        this.lastPred = this.ensemble.predict(this.history);
        console.log(`📥 Phiên ${record.session} → ${record.tx}. Next: ${this.lastPred.prediction} ${this.lastPred.wasFlipped?'[BẺ CẦU]':''}`);
    }

    getPrediction() {
        if (!this.lastPred) this.lastPred = this.ensemble.predict(this.history);
        return this.lastPred;
    }

    getPattern() {
        if (this.history.length < 10) return { last_15_tx: 'n/a', streak_val: null, streak_len: 0 };
        const tx = this.history.map(r=>r.tx);
        const { val, len } = getStreak(tx);
        return {
            last_15_tx:   tx.slice(-15).join('').toLowerCase(),
            last_30_tx:   tx.slice(-30).join('').toLowerCase(),
            streak_val:   val?.toLowerCase() || null,
            streak_len:   len,
            entropy_20:   entropy(tx.slice(-20)).toFixed(4)
        };
    }
}

const manager = new PredictionManager();

// ============================================================
// FETCH & UPDATE LOOP
// ============================================================
async function fetchAndProcess() {
    try {
        const res  = await fetch(API_URL);
        const data = await res.json();
        const newH = parseLines(data);
        if (!newH.length) return;

        const lastNew = newH.at(-1);

        if (!currentSessionId) {
            manager.loadInitial(newH);
            txHistory       = newH;
            currentSessionId = lastNew.session;
        } else if (lastNew.session > currentSessionId) {
            const newRecs = newH.filter(r => r.session > currentSessionId);
            for (const rec of newRecs) {
                manager.pushRecord(rec);
                txHistory.push(rec);
            }
            if (txHistory.length > 300) txHistory = txHistory.slice(-300);
            currentSessionId = lastNew.session;
        }
    } catch (e) {
        console.error('❌ Fetch error:', e.message);
    }
}

fetchAndProcess();
clearInterval(fetchInterval);
fetchInterval = setInterval(fetchAndProcess, 5000);

// ============================================================
// SERVER
// ============================================================
const app = fastify({ logger: false });
await app.register(cors, { origin: '*' });

app.get('/api/taixiu/max789', async () => {
    const last   = txHistory.at(-1) || null;
    const pred   = manager.getPrediction();
    const pattern = manager.getPattern();

    if (!last || !pred) {
        return { status: 'đang chờ dữ liệu', du_doan: 'chưa có' };
    }

    return {
        id:           '@tranhoang2286',
        phien_truoc:  last.session,
        xuc_xac1:     last.dice[0],
        xuc_xac2:     last.dice[1],
        xuc_xac3:     last.dice[2],
        tong:         last.total,
        ket_qua:      last.result.toLowerCase(),
        pattern:      pattern.last_15_tx,
        pattern_30:   pattern.last_30_tx,
        streak:       `${pattern.streak_len}x${pattern.streak_val||'?'}`,
        entropy:      pattern.entropy_20,
        phien_hien_tai: last.session + 1,
        du_doan:      pred.prediction,
        do_tin_cay:   `${(pred.confidence*100).toFixed(0)}%`,
        be_cau:       pred.wasFlipped,
        be_cau_status: pred.breakStatus,
        active_models: pred.activeModels,
        total_algos:  pred.totalAlgos,
        phase:        pred.phase,
        vote_tai:     pred.votesT?.toFixed(3),
        vote_xiu:     pred.votesX?.toFixed(3),
    };
});

app.get('/api/taixiu/history', async () => {
    if (!txHistory.length) return { message: 'không có dữ liệu' };
    return [...txHistory].reverse().map(r => ({
        session: r.session,
        dice:    r.dice,
        total:   r.total,
        result:  r.result.toLowerCase(),
        tx:      r.tx.toLowerCase()
    }));
});

app.get('/api/taixiu/weights', async () => {
    const sorted = Object.entries(manager.ensemble.weights)
        .sort((a,b)=>b[1]-a[1])
        .slice(0,20)
        .map(([id,w])=>({ id, weight: w.toFixed(5) }));
    return { top20_weights: sorted, total_algorithms: ALL_ALGORITHMS.length };
});

app.get('/api/taixiu/break', async () => {
    return {
        break_status: manager.ensemble.breakMgr.getStatus(),
        log_last_10:  manager.ensemble.breakMgr.log.slice(-10)
    };
});

app.get('/', async () => ({
    status:      'TX Prediction Ultra — 100 Algo + 20 AI',
    endpoints: {
        predict: '/api/taixiu/max789',
        history: '/api/taixiu/history',
        weights: '/api/taixiu/weights',
        break:   '/api/taixiu/break'
    }
}));

const start = async () => {
    try {
        await app.listen({ port: PORT, host: '0.0.0.0' });
        let ip = '0.0.0.0';
        try { ip = (await (await fetch('https://ifconfig.me/ip')).text()).trim(); } catch {}
        console.log('\n' + '='.repeat(65));
        console.log('  TX PREDICTION ULTRA — 100 THUẬT TOÁN + 20 AI LOGIC');
        console.log('  Bẻ Cầu Tự Động | Self-Learning | Zero Random');
        console.log('='.repeat(65));
        console.log(`  📍 Local:   http://localhost:${PORT}/`);
        console.log(`  🌐 Network: http://${ip}:${PORT}/`);
        console.log(`  📊 Predict: http://${ip}:${PORT}/api/taixiu/max789`);
        console.log(`  📜 History: http://${ip}:${PORT}/api/taixiu/history`);
        console.log(`  ⚖️  Weights: http://${ip}:${PORT}/api/taixiu/weights`);
        console.log(`  🔧 Break:   http://${ip}:${PORT}/api/taixiu/break`);
        console.log('='.repeat(65) + '\n');
    } catch (err) {
        console.error('❌ Server error:', err);
        process.exit(1);
    }
};

start();