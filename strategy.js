/**
 * 策略文件名: strategy.js
 * 策略名称: 估值趋势杠杆策略 (Python复刻版)
 * 逻辑: 市值定锚 + 趋势增强 + 动态回撤保护
 */

const Strategy = {
    name: "估值趋势杠杆策略",
    description: "基于市值区间的动态杠杆，叠加趋势判断与回撤控制",

    /**
     * 核心回测入口
     * @param {Array} klines - K线数组 [{date, close, high, low}, ...]
     * @param {Object} config - 配置参数 { capital, minCap, maxCap, totalShares, lotSize }
     */
    run: function(klines, config) {
        // ==========================================
        // 1. 策略参数 (对应 Python 脚本中的常量)
        // ==========================================
        const LOW_MV = config.minCap * 100000000;   // 最低市值 (元)
        const HIGH_MV = config.maxCap * 100000000;  // 最高市值 (元)
        const MAX_LEVERAGE = 2.0;    // 低估时最大杠杆 (允许融资)
        const MIN_LEVERAGE = 0.01;   // 高估时最小仓位
        const CURVE_PARAM = 2.5;     // 估值曲线参数 (exp)
        const MDD_MAX = 0.15;        // 最大回撤阈值 (15%)
        const PROTECT_REDUCE = 0.6;  // 触发保护后减仓比例 (60%)
        const RECOVER_DAYS = 10;     // 恢复观察期
        const LOW_MV_NO_PROTECT = 0.05; // 接近底部5%时不触发保护(死扛)
        
        const feeRate = 0.00025;     // 手续费
        const lotSize = config.lotSize || 100; // 交易单位

        // ==========================================
        // 2. 数据准备
        // ==========================================
        let cash = config.capital;
        let shares = 0;
        let trades = [];
        let history = [];
        let totalShares = config.totalShares;

        // 预计算均线 (MA5, MA10, MA20)
        const closes = klines.map(k => k.close);
        const ma5 = this.calculateMA(closes, 5);
        const ma10 = this.calculateMA(closes, 10);
        const ma20 = this.calculateMA(closes, 20);

        // 状态变量
        let prev_L = 0;       // 上一日实际杠杆
        let peak_nav = config.capital; // 历史最高净值
        let in_protect = false; // 是否处于保护模式

        // ==========================================
        // 3. 辅助计算函数
        // ==========================================
        
        // 根据市值计算目标杠杆 (Exponential Curve)
        function getValuationLeverage(mv) {
            if (mv <= LOW_MV) return MAX_LEVERAGE;
            if (mv >= HIGH_MV) return MIN_LEVERAGE;
            const r = (mv - LOW_MV) / (HIGH_MV - LOW_MV);
            // Python: min + (max-min) * exp(-param * r)
            return MIN_LEVERAGE + (MAX_LEVERAGE - MIN_LEVERAGE) * Math.exp(-CURVE_PARAM * r);
        }

        // 计算估值得分 (1.0=低估, -1.0=高估)
        const mid_mv = (LOW_MV + HIGH_MV) / 2.0;
        function getValScore(mv) {
            if (mv <= LOW_MV) return 1.0;
            if (mv >= HIGH_MV) return -1.0;
            if (mv <= mid_mv) return (mid_mv - mv) / (mid_mv - LOW_MV);
            return - (mv - mid_mv) / (HIGH_MV - mid_mv);
        }

        // 判断上涨趋势 (MA5 > MA10 > MA20)
        function isUptrend(i) {
            if (i < 20) return false;
            return (ma5[i] > ma10[i]) && (ma10[i] > ma20[i]);
        }

        // ==========================================
        // 4. 初始建仓 (Day 0)
        // ==========================================
        let startPrice = klines[0].close;
        let startMv = startPrice * totalShares;
        let init_L = getValuationLeverage(startMv);
        
        // 计算初始目标市值 = 本金 * 初始杠杆
        // 注意: 如果 init_L > 1.0，cash 会变为负数，模拟融资
        let initTargetVal = config.capital * init_L;
        let buyVol = Math.floor(initTargetVal / startPrice / lotSize) * lotSize;
        
        if (buyVol > 0) {
            let cost = buyVol * startPrice;
            cash -= cost * (1 + feeRate);
            shares += buyVol;
            trades.push({ date: klines[0].date, type: '建仓', price: startPrice });
        }
        prev_L = init_L;

        // ==========================================
        // 5. 每日回测循环 (Day 1 -> End)
        // ==========================================
        for (let i = 1; i < klines.length; i++) {
            const day = klines[i];
            const curPrice = day.close;
            const curMv = curPrice * totalShares;
            const prevPrice = klines[i-1].close;
            
            // 1. 计算基础涨跌幅 & 基础目标杠杆
            const r = curPrice / prevPrice - 1;
            const target_L = getValuationLeverage(curMv);
            let new_L = target_L; // 默认目标杠杆

            // 2. 更新净值与回撤
            let curNetAsset = cash + shares * curPrice;
            if (curNetAsset > peak_nav) peak_nav = curNetAsset;
            // 防止分母为0
            let drawdown = peak_nav > 0 ? (peak_nav - curNetAsset) / peak_nav : 0;
            
            // 判断是否接近最低市值 (接近底部时不触发保护)
            let nearLowMv = curMv <= LOW_MV * (1.0 + LOW_MV_NO_PROTECT);

            // ------------------------------------------
            // 逻辑 A: 回撤触发保护
            // ------------------------------------------
            if (drawdown > MDD_MAX && !in_protect) {
                if (!nearLowMv) {
                    in_protect = true;
                    new_L = prev_L * (1 - PROTECT_REDUCE); // 强制减仓
                    peak_nav = curNetAsset; // 重置高点，重新计算后续回撤
                }
            }

            // ------------------------------------------
            // 逻辑 B: 保护期内的恢复与调整
            // ------------------------------------------
            if (in_protect) {
                // 计算过去一段时间的平均估值得分
                let startCheck = Math.max(0, i - RECOVER_DAYS);
                let sumScore = 0;
                let count = 0;
                for(let k = startCheck; k < i; k++) {
                    sumScore += getValScore(klines[k].close * totalShares);
                    count++;
                }
                let avgScore = count > 0 ? sumScore / count : 0;
                let curScore = getValScore(curMv);

                let trendUp = isUptrend(i);
                // 只有当 趋势向上 且 估值优于近期均值 时，才解除保护
                if (trendUp && curScore <= avgScore) {
                    in_protect = false;
                    new_L = target_L; // 恢复到估值驱动的杠杆
                } else {
                    // 保护期内如果还在跌，继续减仓
                    let downTrend = (ma5[i] < ma10[i]) && (ma10[i] < ma20[i]);
                    if (downTrend) {
                        let slope = (ma10[i] - ma20[i]) / ma20[i]; // 计算斜率
                        let reduce = Math.min(1.0, Math.abs(slope) * 10);
                        new_L = Math.max(MIN_LEVERAGE, prev_L * (1 - reduce * 0.3));
                    } else {
                        new_L = prev_L; // 维持现状
                    }
                }
            }

            // ------------------------------------------
            // 逻辑 C: 非保护期的下跌趋势减仓
            // ------------------------------------------
            if (!in_protect) {
                let downTrend = (ma5[i] < ma10[i]) && (ma10[i] < ma20[i]);
                if (downTrend) {
                    let slope = (ma10[i] - ma20[i]) / ma20[i];
                    let reduce = Math.min(1.0, Math.abs(slope) * 10);
                    // 下跌趋势中，杠杆只能比上一日低，不能高
                    let reduced_L = prev_L * (1 - reduce * 0.3);
                    new_L = Math.max(MIN_LEVERAGE, reduced_L);
                }
            }

            // ------------------------------------------
            // 逻辑 D: 上涨趋势 (根据你的要求修改)
            // ------------------------------------------
            let upTrend = isUptrend(i);
            if (!in_protect && upTrend) {
                // 若单日跌幅 > 2% -> 视为急跌机会，加杠杆 +5%
                if (r < -0.02) {
                    new_L = prev_L * 1.05;
                } else {
                    // 正常上涨日 -> 暂停估值调整带来的减仓
                    // 即：取 (上一日杠杆) 和 (估值目标杠杆) 的最大值
                    // 这样随着股价上涨、市值变大、本来target_L会变小，但我们强制不减仓
                    new_L = Math.max(prev_L, target_L);
                }
            }

            // ==========================================
            // 6. 交易执行 (调仓)
            // ==========================================
            // 限制杠杆范围 (防止无限加杠杆)
            new_L = Math.min(new_L, MAX_LEVERAGE);
            new_L = Math.max(new_L, MIN_LEVERAGE);

            // 目标持仓市值
            let totalAsset = cash + shares * curPrice;
            let targetMv = totalAsset * new_L;
            let currentMv = shares * curPrice;
            let diff = targetMv - currentMv;

            // 计算需变动的股数
            let diffVol = Math.floor(Math.abs(diff) / curPrice / lotSize) * lotSize;

            // 只有当变动量 > 0 时才操作
            if (diffVol > 0) {
                if (diff > 0) {
                    // 买入 (加仓/融资)
                    let cost = diffVol * curPrice;
                    cash -= cost * (1 + feeRate);
                    shares += diffVol;
                    trades.push({ date: day.date, type: 'BUY', price: curPrice });
                } else {
                    // 卖出 (减仓/还款)
                    // 确保有持仓可卖
                    let sellVol = Math.min(shares, diffVol);
                    if (sellVol >= lotSize) {
                        let revenue = sellVol * curPrice;
                        cash += revenue * (1 - feeRate);
                        shares -= sellVol;
                        trades.push({ date: day.date, type: 'SELL', price: curPrice });
                    }
                }
            }

            // 更新历史记录
            prev_L = new_L;
            history.push({
                date: day.date,
                val: cash + shares * curPrice,
                close: curPrice
            });
        }

        // 返回结果 (gridLines为空，因为不再是网格策略)
        return { history: history, trades: trades, gridLines: [] };
    },

    /**
     * 通用移动平均线计算
     */
    calculateMA: function(data, n) {
        let ma = [];
        for (let i = 0; i < data.length; i++) {
            if (i < n - 1) {
                ma.push(data[i]); // 数据不足时用当日价格代替，防止NaN
                continue;
            }
            let sum = 0;
            for (let j = 0; j < n; j++) {
                sum += data[i - j];
            }
            ma.push(sum / n);
        }
        return ma;
    }
};
