const Strategy = {
    name: "估值趋势杠杆策略 (Py复刻版)",
    description: "估值定仓位 + 趋势增强 + 动态回撤保护",

    /**
     * 核心回测函数
     * @param {Array} klines - K线数据 [{date, close, high, low}, ...]
     * @param {Object} config - 配置参数 {capital, grids, lotSize, minCap, maxCap, totalShares}
     */
    run: function(klines, config) {
        // 1. 核心参数 (对应 Python 中的用户可调参数)
        const LOW_MV = config.minCap * 100000000;  
        const HIGH_MV = config.maxCap * 100000000; 
        const MAX_LEVERAGE = 2.0;   // 低估时最大杠杆
        const MIN_LEVERAGE = 0.01;  // 高估时最小杠杆
        const CURVE_PARAM = 2.5;    // 曲线参数
        const MDD_MAX = 0.15;       // 最大回撤
        const PROTECT_REDUCE = 0.6; // 保护期减仓比例
        const RECOVER_DAYS = 10;    // 恢复观察期
        const LOW_MV_NO_PROTECT = 0.05; // 极度低估不保护

        const feeRate = 0.00025;
        let cash = config.capital;
        let shares = 0;
        let trades = [];
        let history = [];
        let totalShares = config.totalShares;

        // 状态变量
        let prev_L = 0; 
        let peak_nav = config.capital;
        let in_protect = false;

        // 预计算 MA (用于趋势判断)
        const closes = klines.map(k => k.close);
        const ma5 = this.calculateMA(closes, 5);
        const ma10 = this.calculateMA(closes, 10);
        const ma20 = this.calculateMA(closes, 20);

        // --- 辅助函数 ---
        // 1. 估值驱动杠杆 (Exp曲线)
        function getValuationLeverage(mv) {
            if (mv <= LOW_MV) return MAX_LEVERAGE;
            if (mv >= HIGH_MV) return MIN_LEVERAGE;
            const r = (mv - LOW_MV) / (HIGH_MV - LOW_MV);
            return MIN_LEVERAGE + (MAX_LEVERAGE - MIN_LEVERAGE) * Math.exp(-CURVE_PARAM * r);
        }

        // 2. 估值得分
        const mid_mv = (LOW_MV + HIGH_MV) / 2.0;
        function getValScore(mv) {
            if (mv <= LOW_MV) return 1.0;
            if (mv >= HIGH_MV) return -1.0;
            if (mv <= mid_mv) return (mid_mv - mv) / (mid_mv - LOW_MV);
            return - (mv - mid_mv) / (HIGH_MV - mid_mv);
        }

        // 3. 趋势判断 (MA5 > MA10 > MA20)
        function isUptrend(i) {
            if (i < 20) return false;
            return (ma5[i] > ma10[i]) && (ma10[i] > ma20[i]);
        }

        // --- 初始化 (Day 0) ---
        let startPrice = klines[0].close;
        let init_L = getValuationLeverage(startPrice * totalShares);
        // 初始建仓
        let initVal = config.capital * init_L;
        let buyVol = Math.floor(initVal / startPrice / 100) * 100;
        if (buyVol > 0) {
            cash -= buyVol * startPrice * (1 + feeRate);
            shares += buyVol;
            trades.push({ date: klines[0].date, type: '建仓', price: startPrice });
        }
        prev_L = init_L;

        // --- 主循环 ---
        for (let i = 1; i < klines.length; i++) {
            const day = klines[i];
            const curPrice = day.close;
            const curMv = curPrice * totalShares;
            
            // 当日涨跌幅
            const r = curPrice / klines[i-1].close - 1;

            // 基础目标杠杆 (基于估值)
            const target_L = getValuationLeverage(curMv);
            let new_L = target_L;

            // 计算回撤
            let curNetAsset = cash + shares * curPrice;
            if (curNetAsset > peak_nav) peak_nav = curNetAsset;
            let drawdown = (peak_nav - curNetAsset) / peak_nav;
            let nearLow = curMv <= LOW_MV * (1.0 + LOW_MV_NO_PROTECT);

            // --- A. 回撤保护 ---
            if (drawdown > MDD_MAX && !in_protect) {
                if (!nearLow) {
                    in_protect = true;
                    new_L = prev_L * (1 - PROTECT_REDUCE);
                    peak_nav = curNetAsset; // 重置以重新计算
                }
            }

            // --- B. 保护期恢复 ---
            if (in_protect) {
                let startCheck = Math.max(0, i - RECOVER_DAYS);
                let recentMVs = klines.slice(startCheck, i).map(k => k.close * totalShares);
                let avgScore = recentMVs.reduce((a,b)=>a+getValScore(b),0) / recentMVs.length;
                
                let trendUp = (ma5[i] > ma10[i]) && (ma10[i] > ma20[i]);
                let undervalued = getValScore(curMv) <= avgScore;

                if (trendUp && undervalued) {
                    in_protect = false;
                    new_L = target_L;
                } else {
                    // 下跌趋势继续减仓
                    let downTrend = (ma5[i] < ma10[i]) && (ma10[i] < ma20[i]);
                    if (downTrend) {
                        let slope = (ma10[i] - ma20[i]) / ma20[i];
                        let reduce = Math.min(1.0, Math.abs(slope) * 10);
                        new_L = Math.max(MIN_LEVERAGE, prev_L * (1 - reduce * 0.3));
                    } else {
                        new_L = prev_L;
                    }
                }
            }

            // --- C. 下跌趋势减仓 ---
            if (!in_protect) {
                let downTrend = (ma5[i] < ma10[i]) && (ma10[i] < ma20[i]);
                if (downTrend) {
                    let slope = (ma10[i] - ma20[i]) / ma20[i];
                    let reduce = Math.min(1.0, Math.abs(slope) * 10);
                    new_L = Math.max(MIN_LEVERAGE, prev_L * (1 - reduce * 0.3));
                }
            }

            // --- ★★★ D. 上涨趋势逻辑 ★★★ ---
            let upTrend = isUptrend(i);
            if (!in_protect && upTrend) {
                if (r < -0.02) {
                    // 急跌加仓
                    new_L = prev_L * 1.05;
                } else {
                    // 正常上涨，暂停估值减仓 (只能升不能降)
                    new_L = Math.max(prev_L, target_L);
                }
            }

            // --- 执行交易 ---
            let targetAsset = (cash + shares * curPrice) * new_L; // 目标持仓市值
            let currentHold = shares * curPrice;
            let diff = targetAsset - currentHold;
            let diffVol = Math.floor(Math.abs(diff) / curPrice / 100) * 100;

            if (diffVol > 0) {
                if (diff > 0) { // 买入
                    // 模拟杠杆：允许 cash 变负 (融资)
                    cash -= diffVol * curPrice * (1 + feeRate);
                    shares += diffVol;
                    trades.push({ date: day.date, type: 'BUY', price: curPrice });
                } else { // 卖出
                    cash += diffVol * curPrice * (1 - feeRate);
                    shares -= diffVol;
                    trades.push({ date: day.date, type: 'SELL', price: curPrice });
                }
            }

            prev_L = new_L;
            history.push({ date: day.date, val: cash + shares * curPrice, close: curPrice });
        }

        // 不需要网格线，返回空数组
        return { history, trades, gridLines: [] };
    },

    calculateMA: function(data, n) {
        let ma = [];
        for(let i=0; i<data.length; i++) {
            if(i < n-1) { ma.push(data[i]); continue; }
            let sum = 0;
            for(let j=0; j<n; j++) sum += data[i-j];
            ma.push(sum/n);
        }
        return ma;
    }
};