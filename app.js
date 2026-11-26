/**
 * Factorio 2.1.21+ Thruster Speed & Pump Control Calculator
 *
 * Physics constants verified against:
 * - core/prototypes/utility-constants.lua (space_platform_acceleration_expression, v2.1.21+)
 * - space-age/prototypes/entity/entities.lua (Thruster min_performance / max_performance)
 */

(() => {
  "use strict";

  // =========================================================================
  // 1. CONSTANTS (Factorio 2.1.21+ Space Age)
  // =========================================================================
  const UPS = 60;
  const MIN_FILL = 0.10;          // 10% fluid reserve
  const MAX_FILL = 0.80;          // 80% fluid reserve
  const MIN_USAGE_TICK = 0.1;     // 6 u/s normal thruster
  const MAX_USAGE_TICK = 2.0;     // 120 u/s normal thruster
  const MIN_FLOW_S = MIN_USAGE_TICK * UPS; // 6 u/s
  const MAX_FLOW_S = MAX_USAGE_TICK * UPS; // 120 u/s
  const MAX_EFF = 1.00;           // 100% at <= 10% fill
  const MIN_EFF = 0.51;           // 51% at >= 80% fill
  const THRUST_SCALE = 100000;    // kN per (fluid_usage_per_tick * effectivity) -> 102,000 kN (102 MN) at 2.0 * 0.51
  const THRUSTER_FLUIDBOX = 1000; // units per fluidbox per thruster
  const GRAVITY_BAND_KMS = 10;    // ±10 km/s first/second half of route

  // Curve palette (Fluid Consumption in Factoriopedia blue, Cruise Speed in red)
  const COLOR_EFF = "#22c55e";
  const COLOR_FLUID = "#4ea1ff";
  const COLOR_SPEED = "#ef4444";
  const COLOR_SPEED_TEXT = "#f87171";
  const COLOR_PUMP_CAP = "#f59e0b";

  // =========================================================================
  // 2. APPLICATION STATE
  // =========================================================================
  const state = {
    thrusters: 7,
    thrusterQuality: 1.0,
    pumps: 1,
    pumpCapacity: 1200,
    weightTons: 400,
    targetMode: "efficiency", // efficiency | speed | fill | flowPerThruster | totalFlow | manual
    targetValue: 75.5,        // corresponds to 45.0% fill, 63 u/s per thruster, 441 u/s total
    manualOn: 18,
    manualPeriod: 49,
    maxPeriod: 60,
    useDeltaSigma: false,
    dsScale: 1,
    architecture: "two",      // two | one
    simMetric: "fill",        // fill | eff | flow
    simPlaying: false,
    simSpeed: 5,
    simMoving: true,
    simTick: 0,
    simAccE: 0,
    simTimerId: null
  };

  // =========================================================================
  // 3. PHYSICS & THERMODYNAMICS (Factorio 2.1.21+)
  // =========================================================================

  /** Convert normalized curve parameter t in [0, 1] (10%..80% fill) to thruster metrics */
  function metricsFromT(t, thrusters, quality, weightTons) {
    const tc = clamp(t, 0, 1);
    const fill = MIN_FILL + tc * (MAX_FILL - MIN_FILL);
    const eff = MAX_EFF - tc * (MAX_EFF - MIN_EFF);
    const flowPerThruster = (MIN_FLOW_S + tc * (MAX_FLOW_S - MIN_FLOW_S)) * quality;
    const totalFlow = flowPerThruster * thrusters;
    const usagePerTick = flowPerThruster / UPS;
    const thrustKN = thrusters * THRUST_SCALE * usagePerTick * eff; // total thrust in kN (Lua formula unit)
    const speedKms = equilibriumSpeedKms(thrustKN, weightTons);
    return { t: tc, fill, eff, flowPerThruster, totalFlow, thrustKN, speedKms };
  }

  /**
   * Factorio 2.1.21+ space_platform_acceleration_expression:
   * (thrust / (1 + weight / 10000000) - ((90 * speed^2) * ((weight / 200) ^ 0.80) + 10000) * sign(speed)) / weight / 60
   * Setting acceleration = 0 and multiplying speed (km/tick) by 60 gives cruise speed in km/s.
   */
  function equilibriumSpeedKms(thrustKN, weightTons) {
    const weightKg = Math.max(weightTons, 1) * 1000;
    const effectiveThrust = thrustKN / (1 + weightKg / 10000000);
    const netForce = effectiveThrust - 10000;
    if (netForce <= 0) return 0;
    const dragCoeff = 90 * Math.pow(weightKg / 200, 0.80);
    const speedPerTick = Math.sqrt(netForce / dragCoeff);
    return speedPerTick * UPS;
  }

  /** Invert equilibrium speed (km/s) to required thrust (kN) */
  function requiredThrustFromSpeed(speedKms, weightTons) {
    if (speedKms <= 0) return 0;
    const weightKg = Math.max(weightTons, 1) * 1000;
    const speedPerTick = speedKms / UPS;
    const dragForce = 90 * speedPerTick * speedPerTick * Math.pow(weightKg / 200, 0.80) + 10000;
    return dragForce * (1 + weightKg / 10000000);
  }

  /** Convert total flow (u/s) to metrics (handles below 10% fill gracefully) */
  function metricsFromTotalFlow(totalFlow, thrusters, quality, weightTons) {
    const flowPerThruster = totalFlow / Math.max(thrusters, 1);
    const minFlowQ = MIN_FLOW_S * quality;
    const maxFlowQ = MAX_FLOW_S * quality;

    if (flowPerThruster <= 0) {
      return { t: 0, fill: 0, eff: 1.0, flowPerThruster: 0, totalFlow: 0, thrustKN: 0, speedKms: 0 };
    }
    if (flowPerThruster <= minFlowQ) {
      const frac = flowPerThruster / minFlowQ;
      const usagePerTick = flowPerThruster / UPS;
      const thrustKN = thrusters * THRUST_SCALE * usagePerTick * MAX_EFF;
      return {
        t: 0,
        fill: MIN_FILL * frac,
        eff: MAX_EFF,
        flowPerThruster,
        totalFlow,
        thrustKN,
        speedKms: equilibriumSpeedKms(thrustKN, weightTons)
      };
    }
    const t = clamp((flowPerThruster - minFlowQ) / (maxFlowQ - minFlowQ), 0, 1);
    return metricsFromT(t, thrusters, quality, weightTons);
  }

  /**
   * Solve for curve parameter t in [0, 1] given desired thrustKN.
   * For a single normal thruster:
   * usage(t) * eff(t) = (0.1 + 1.9t)(1 - 0.49t) = 0.1 + 1.851t - 0.931t^2
   * Total thrust = thrusters * quality * 100000 * (0.1 + 1.851t - 0.931t^2)
   */
  function solveTFromThrust(targetThrustKN, thrusters, quality) {
    const scale = thrusters * quality * THRUST_SCALE;
    const minThrust = scale * (MIN_USAGE_TICK * MAX_EFF);
    const maxThrust = scale * (MAX_USAGE_TICK * MIN_EFF);
    if (targetThrustKN <= minThrust) {
      return { t: 0, belowMin: true, aboveMax: false, ratioBelowMin: Math.max(0, targetThrustKN / minThrust) };
    }
    if (targetThrustKN >= maxThrust) {
      return { t: 1, belowMin: false, aboveMax: true, ratioBelowMin: 1 };
    }
    const y = targetThrustKN / scale;
    // 0.931 t^2 - 1.851 t + (y - 0.1) = 0 -> choose smaller root in [0, 1]
    const a = 0.931;
    const b = -1.851;
    const c = y - 0.1;
    const disc = Math.max(0, b * b - 4 * a * c);
    const t = clamp((-b - Math.sqrt(disc)) / (2 * a), 0, 1);
    return { t, belowMin: false, aboveMax: false, ratioBelowMin: 1 };
  }

  // =========================================================================
  // 4. MODULATION (PWM Rational Search & Delta-Sigma Phase Accumulator)
  // =========================================================================

  /** Generate Pareto-optimal PWM fractions on / period for targetDuty in [0, 1] */
  function findPwmCandidates(targetDuty, maxPeriod) {
    const maxP = clamp(Math.round(maxPeriod), 2, 600);
    const duty = clamp(targetDuty, 0, 1);
    const seen = new Set();
    const candidates = [];
    let bestErr = Infinity;

    for (let p = 2; p <= maxP; p++) {
      const on = Math.round(duty * p);
      const actual = on / p;
      const err = Math.abs(actual - duty);
      const key = actual.toFixed(10);

      // Keep only strictly improving approximations (Pareto frontier by period)
      if (!seen.has(key) && err < bestErr - 1e-12) {
        seen.add(key);
        bestErr = err;
        candidates.push({ on, period: p, off: p - on, duty: actual, err });
      }
    }

    if (candidates.length === 0) {
      const on = Math.round(duty * 2);
      candidates.push({ on, period: 2, off: 2 - on, duty: on / 2, err: Math.abs(on / 2 - duty) });
    }
    return candidates;
  }

  /** Compute Delta-Sigma (Bresenham) integer parameters A, B, threshold (B - A) */
  function computeDeltaSigma(desiredTotalFlow, totalPumpCap, scale) {
    const s = scale === 10 ? 10 : 1;
    const B = Math.max(1, Math.round(totalPumpCap * s));
    const A = clamp(Math.round(desiredTotalFlow * s), 0, B);
    const threshold = B - A;
    const actualDuty = A / B;
    return { A, B, threshold, scale: s, duty: actualDuty };
  }

  /** Generate a 60-tick pulse train for PWM or Delta-Sigma */
  function generatePulseTrain(length, mode, pwm, ds) {
    const pulses = [];
    if (mode === "pwm") {
      for (let i = 0; i < length; i++) {
        pulses.push((i % pwm.period) < pwm.on ? 1 : 0);
      }
    } else {
      let E = 0;
      for (let i = 0; i < length; i++) {
        if (E >= ds.threshold && ds.A > 0) {
          pulses.push(1);
          E -= ds.threshold;
        } else {
          pulses.push(0);
          E += ds.A;
        }
      }
    }
    return pulses;
  }

  // =========================================================================
  // 5. TRANSIENT FLUIDBOX STABILITY SIMULATION (PWM vs Delta-Sigma)
  // =========================================================================

  /**
   * Simulates a thruster bank's fluidbox over warm-up + 180 observation ticks
   * under both Standard PWM and Delta-Sigma pulses so users can visually compare ripple.
   */
  function simulateStability(pwm, ds, thrusters, quality, totalPumpCap) {
    const capTotal = thrusters * THRUSTER_FLUIDBOX;
    const pumpPerTick = totalPumpCap / UPS;
    const warmup = 240;
    const obsTicks = 180;

    function runMode(mode) {
      const targetFlow = (mode === "pwm" ? pwm.duty : ds.duty) * totalPumpCap;
      const initM = metricsFromTotalFlow(targetFlow, thrusters, quality, state.weightTons);
      let fluid = clamp(initM.fill, 0.05, 0.95) * capTotal;
      let E = 0;

      const fillSeries = [];
      const effSeries = [];
      const flowSeries = [];

      for (let tick = 0; tick < warmup + obsTicks; tick++) {
        let on = false;
        if (mode === "pwm") {
          on = (tick % pwm.period) < pwm.on;
        } else {
          if (E >= ds.threshold && ds.A > 0) {
            on = true;
            E -= ds.threshold;
          } else {
            on = false;
            E += ds.A;
          }
        }

        if (on) {
          fluid = Math.min(capTotal, fluid + pumpPerTick);
        }

        const fillFrac = fluid / capTotal;
        const t = clamp((fillFrac - MIN_FILL) / (MAX_FILL - MIN_FILL), 0, 1);
        const eff = MAX_EFF - t * (MAX_EFF - MIN_EFF);
        let burnPerTick = thrusters * quality * (MIN_USAGE_TICK + t * (MAX_USAGE_TICK - MIN_USAGE_TICK));
        if (fluid < burnPerTick) {
          burnPerTick = fluid;
        }
        fluid = Math.max(0, fluid - burnPerTick);

        if (tick >= warmup) {
          fillSeries.push(fillFrac * 100);
          effSeries.push(eff * 100);
          flowSeries.push(burnPerTick * UPS);
        }
      }
      return { fill: fillSeries, eff: effSeries, flow: flowSeries };
    }

    return {
      pwm: runMode("pwm"),
      ds: runMode("ds")
    };
  }

  // =========================================================================
  // 6. FULL CALCULATION PIPELINE
  // =========================================================================

  function computeModel() {
    const thrusters = Math.max(1, Math.round(state.thrusters));
    const quality = Number(state.thrusterQuality);
    const pumps = Math.max(1, Math.round(state.pumps));
    const pumpCapEach = Number(state.pumpCapacity);
    const totalPumpCap = pumps * pumpCapEach;
    const weightTons = Math.max(40, Number(state.weightTons));

    const maxThrusterFlow = thrusters * MAX_FLOW_S * quality;
    const minThrusterFlow = thrusters * MIN_FLOW_S * quality;
    const maxAchievableFlow = Math.min(maxThrusterFlow, totalPumpCap);
    const maxSystemMetrics = metricsFromTotalFlow(maxAchievableFlow, thrusters, quality, weightTons);
    const maxUnthrottledMetrics = metricsFromT(1, thrusters, quality, weightTons);

    let desiredFlow = 0;
    let warning = null;

    if (state.targetMode === "efficiency") {
      const effFrac = clamp(state.targetValue / 100, MIN_EFF, MAX_EFF);
      const t = clamp((MAX_EFF - effFrac) / (MAX_EFF - MIN_EFF), 0, 1);
      const m = metricsFromT(t, thrusters, quality, weightTons);
      desiredFlow = m.totalFlow;
    } else if (state.targetMode === "fill") {
      const fillFrac = clamp(state.targetValue / 100, MIN_FILL, MAX_FILL);
      const t = clamp((fillFrac - MIN_FILL) / (MAX_FILL - MIN_FILL), 0, 1);
      const m = metricsFromT(t, thrusters, quality, weightTons);
      desiredFlow = m.totalFlow;
    } else if (state.targetMode === "flowPerThruster") {
      desiredFlow = Math.max(0, state.targetValue) * thrusters;
    } else if (state.targetMode === "totalFlow") {
      desiredFlow = Math.max(0, state.targetValue);
    } else if (state.targetMode === "speed") {
      const reqThrust = requiredThrustFromSpeed(state.targetValue, weightTons);
      const solved = solveTFromThrust(reqThrust, thrusters, quality);
      if (solved.aboveMax) {
        desiredFlow = maxThrusterFlow;
        warning = {
          text: `Target speed (${state.targetValue.toFixed(1)} km/s) exceeds max speed for ${thrusters} thrusters at ${weightTons}t (${maxUnthrottledMetrics.speedKms.toFixed(1)} km/s).`,
          fixLabel: `Set to ${maxSystemMetrics.speedKms.toFixed(1)} km/s`,
          fixAction: () => {
            state.targetValue = Number(maxSystemMetrics.speedKms.toFixed(1));
          }
        };
      } else if (solved.belowMin) {
        desiredFlow = minThrusterFlow * solved.ratioBelowMin;
      } else {
        desiredFlow = metricsFromT(solved.t, thrusters, quality, weightTons).totalFlow;
      }
    } else if (state.targetMode === "manual") {
      const period = clamp(Math.round(state.manualPeriod), 2, 600);
      const on = clamp(Math.round(state.manualOn), 0, period);
      desiredFlow = (on / period) * totalPumpCap;
    }

    if (desiredFlow > totalPumpCap + 1e-6) {
      const cappedSpeed = maxSystemMetrics.speedKms;
      warning = {
        text: `Requested flow (${desiredFlow.toFixed(1)} u/s) exceeds pump capacity (${totalPumpCap} u/s). Add pumps, upgrade pump quality, or lower target.`,
        fixLabel: `Clamp to Pump Cap (${totalPumpCap} u/s)`,
        fixAction: () => {
          if (state.targetMode === "efficiency") {
            state.targetValue = Number((maxSystemMetrics.eff * 100).toFixed(1));
          } else if (state.targetMode === "fill") {
            state.targetValue = Number((maxSystemMetrics.fill * 100).toFixed(1));
          } else if (state.targetMode === "flowPerThruster") {
            state.targetValue = Number((totalPumpCap / thrusters).toFixed(1));
          } else if (state.targetMode === "totalFlow") {
            state.targetValue = totalPumpCap;
          } else if (state.targetMode === "speed") {
            state.targetValue = Number(cappedSpeed.toFixed(1));
          }
        }
      };
      desiredFlow = totalPumpCap;
    } else if (desiredFlow > maxThrusterFlow + 1e-6) {
      warning = {
        text: `Flow (${desiredFlow.toFixed(1)} u/s) exceeds max burn of ${thrusters} thrusters (${maxThrusterFlow.toFixed(1)} u/s). Thrusters will cap at 80% fill (51% efficiency).`,
        fixLabel: `Clamp to Max Burn (${maxThrusterFlow.toFixed(0)} u/s)`,
        fixAction: () => {
          if (state.targetMode === "flowPerThruster") {
            state.targetValue = Number((MAX_FLOW_S * quality).toFixed(1));
          } else if (state.targetMode === "totalFlow") {
            state.targetValue = Number(maxThrusterFlow.toFixed(1));
          } else if (state.targetMode === "manual") {
            const p = clamp(Math.round(state.manualPeriod), 2, 600);
            state.manualOn = Math.round((maxThrusterFlow / totalPumpCap) * p);
          }
        }
      };
    }

    const clampedFlow = clamp(desiredFlow, 0, totalPumpCap);
    const targetDuty = clampedFlow / totalPumpCap;

    const candidates = findPwmCandidates(targetDuty, state.maxPeriod);
    let pwm;
    if (state.targetMode === "manual") {
      const period = clamp(Math.round(state.manualPeriod), 2, 600);
      const on = clamp(Math.round(state.manualOn), 0, period);
      pwm = { on, period, off: period - on, duty: on / period, err: 0 };
    } else {
      pwm = candidates[candidates.length - 1];
    }

    const ds = computeDeltaSigma(clampedFlow, totalPumpCap, state.dsScale);

    const activeDuty = state.useDeltaSigma ? ds.duty : pwm.duty;
    const achievedFlow = activeDuty * totalPumpCap;
    const effectiveBurnFlow = Math.min(achievedFlow, maxThrusterFlow);
    const achievedMetrics = metricsFromTotalFlow(effectiveBurnFlow, thrusters, quality, weightTons);
    const desiredMetrics = metricsFromTotalFlow(Math.min(clampedFlow, maxThrusterFlow), thrusters, quality, weightTons);

    const flowErrorPct = clampedFlow > 0
      ? ((achievedFlow - clampedFlow) / clampedFlow) * 100
      : 0;

    return {
      thrusters,
      quality,
      pumps,
      totalPumpCap,
      weightTons,
      maxThrusterFlow,
      maxAchievableFlow,
      maxSystemMetrics,
      desiredFlow: clampedFlow,
      desiredMetrics,
      pwm,
      ds,
      candidates,
      activeDuty,
      achievedFlow,
      achievedMetrics,
      flowErrorPct,
      warning
    };
  }

  // =========================================================================
  // 7. CIRCUIT SPECIFICATION RENDERER
  // =========================================================================

  function renderCircuitSpec(model) {
    const isDs = state.useDeltaSigma;
    const isTwo = state.architecture === "two";
    const { pwm, ds } = model;

    let html = "";
    let copyLines = [];

    if (!isDs && isTwo) {
      html = `
        <div class="comb-block">
          <div class="comb-title">
            <span>Decider 1 — Tick Counter</span>
            <span class="wire-tag wire-red">Red self-loop + Red out → Decider 2</span>
          </div>
          <ul class="comb-rows">
            <li><strong>Condition:</strong> <code>L</code> (R) <code>&lt;</code> <code>${pwm.period - 1}</code></li>
            <li><strong>Outputs:</strong> <code>L</code> (Input count R), <code>L = 1</code></li>
            <li><strong>Else outputs:</strong> <em>None</em> (resets <code>L</code> to <code>0</code>)</li>
          </ul>
        </div>
        <div class="comb-block">
          <div class="comb-title">
            <span>Decider 2 — PWM Threshold &amp; Planet Motion Gate</span>
            <span class="wire-tag wire-green">Green in ← Hub</span>
          </div>
          <ul class="comb-rows">
            <li><strong>Conditions (AND):</strong> <code>L</code> (R) <code>&lt;</code> <code>${pwm.on}</code> <strong>AND</strong> <code>[Each Planet]</code> (G) <code>&lt;</code> <code>3</code></li>
            <li><strong>Outputs:</strong> <code>[Thruster Fuel] = 1</code> &nbsp;|&nbsp; <strong>Else:</strong> <code>[Thruster Fuel] = -1</code></li>
            <li><strong>Pumps (Fuel &amp; Oxidizer):</strong> Enable if <code>[Thruster Fuel] &gt; 0</code></li>
          </ul>
        </div>`;

      copyLines = [
        `Factorio 2.1.21+ 2-Decider Motion-Gated PWM (${pwm.on}/${pwm.period} ticks)`,
        `Space Platform Hub: Check "Read moving from" (1) and "Read moving to" (2) -> Green wire to Decider 2`,
        `Decider 1 (Red self-loop -> Red to Decider 2): If L(R) < ${pwm.period - 1} -> Output L(Input count R) + L=1 | Else: empty`,
        `Decider 2 (Red out -> Pumps): If L(R) < ${pwm.on} AND [All Planets](G) < 3 -> Output Fuel=1 | Else: Fuel=-1`,
        `Pumps (Fuel & Oxidizer): Enable if [Thruster Fuel] > 0`
      ];
    } else if (!isDs && !isTwo) {
      html = `
        <div class="comb-block">
          <div class="comb-title">
            <span>Decider 1 — Single-Combinator Clock</span>
            <span class="wire-tag wire-red">Red self-loop + Red out → Pumps</span>
          </div>
          <ul class="comb-rows">
            <li><strong>Condition:</strong> <code>L</code> (R) <code>&lt;</code> <code>${pwm.period - 1}</code></li>
            <li><strong>Outputs:</strong> <code>L</code> (Input count R), <code>L = 1</code></li>
            <li><strong>Pumps (Fuel &amp; Oxidizer):</strong> Enable if <code>L &lt; ${pwm.on}</code></li>
          </ul>
        </div>`;

      copyLines = [
        `Factorio 2.1.21+ 1-Decider Simple PWM (${pwm.on}/${pwm.period} ticks)`,
        `Decider 1 (Red self-loop -> Pumps): If L(R) < ${pwm.period - 1} -> Output L(Input count R) + L=1`,
        `Pumps (Fuel & Oxidizer): Enable if L < ${pwm.on}`
      ];
    } else if (isDs && isTwo) {
      html = `
        <div class="comb-block">
          <div class="comb-title">
            <span>Decider 1 — Delta-Sigma Phase Accumulator</span>
            <span class="wire-tag wire-red">Red self-loop + Red out → Decider 2</span>
          </div>
          <ul class="comb-rows">
            <li><strong>Condition:</strong> <code>E</code> (R) <code>&ge;</code> <code>${ds.threshold}</code></li>
            <li><strong>Outputs:</strong> <code>E</code> (Input count R), <code>E = -${ds.threshold}</code>, <code>P = 1</code></li>
            <li><strong>Else outputs:</strong> <code>E</code> (Input count R), <code>E = ${ds.A}</code></li>
          </ul>
        </div>
        <div class="comb-block">
          <div class="comb-title">
            <span>Decider 2 — Planet Motion Gate</span>
            <span class="wire-tag wire-green">Green in ← Hub</span>
          </div>
          <ul class="comb-rows">
            <li><strong>Conditions (AND):</strong> <code>P</code> (R) <code>&gt;</code> <code>0</code> <strong>AND</strong> <code>[Each Planet]</code> (G) <code>&lt;</code> <code>3</code></li>
            <li><strong>Outputs:</strong> <code>[Thruster Fuel] = 1</code> &nbsp;|&nbsp; <strong>Else:</strong> <code>[Thruster Fuel] = -1</code></li>
            <li><strong>Pumps (Fuel &amp; Oxidizer):</strong> Enable if <code>[Thruster Fuel] &gt; 0</code></li>
          </ul>
        </div>`;

      copyLines = [
        `Factorio 2.1.21+ 2-Decider Motion-Gated Delta-Sigma (A=${ds.A}, B=${ds.B}, B-A=${ds.threshold})`,
        `Space Platform Hub: Check "Read moving from" (1) and "Read moving to" (2) -> Green wire to Decider 2`,
        `Decider 1 (Red self-loop -> Red to Decider 2): If E(R) >= ${ds.threshold} -> Output E(Input count R), E=-${ds.threshold}, P=1 | Else: E(Input count R), E=${ds.A}`,
        `Decider 2 (Red out -> Pumps): If P(R) > 0 AND [All Planets](G) < 3 -> Output Fuel=1 | Else: Fuel=-1`,
        `Pumps (Fuel & Oxidizer): Enable if [Thruster Fuel] > 0`
      ];
    } else {
      html = `
        <div class="comb-block">
          <div class="comb-title">
            <span>Decider 1 — Delta-Sigma Phase Accumulator</span>
            <span class="wire-tag wire-red">Red self-loop + Red out → Pumps</span>
          </div>
          <ul class="comb-rows">
            <li><strong>Condition:</strong> <code>E</code> (R) <code>&ge;</code> <code>${ds.threshold}</code></li>
            <li><strong>Outputs:</strong> <code>E</code> (Input count R), <code>E = -${ds.threshold}</code>, <code>P = 1</code></li>
            <li><strong>Else outputs:</strong> <code>E</code> (Input count R), <code>E = ${ds.A}</code></li>
            <li><strong>Pumps (Fuel &amp; Oxidizer):</strong> Enable if <code>P &gt; 0</code></li>
          </ul>
        </div>`;

      copyLines = [
        `Factorio 2.1.21+ 1-Decider Delta-Sigma (A=${ds.A}, B=${ds.B}, B-A=${ds.threshold})`,
        `Decider 1 (Red self-loop -> Pumps): If E(R) >= ${ds.threshold} -> Output E(Input count R), E=-${ds.threshold}, P=1 | Else: E(Input count R), E=${ds.A}`,
        `Pumps (Fuel & Oxidizer): Enable if P > 0`
      ];
    }

    const noteEl = document.getElementById("circuitNoteBox");
    if (isTwo) {
      noteEl.className = "callout callout-good";
      noteEl.innerHTML =
        `<strong>Why 2-Decider Gated is recommended:</strong> Enable <em>Read moving from</em> (1) and <em>Read moving to</em> (2) on the Space Platform Hub. Any planet signal <code>= 3</code> means parked at rest; all planets <code>&lt; 3</code> means in motion. Decider 1 runs continuously without windup while Decider 2 blocks pumping in orbit so thrusters stay at your target efficiency from tick 1 of departure.`;
    } else {
      noteEl.className = "callout callout-warn";
      noteEl.innerHTML =
        `<strong>Idle overfill warning:</strong> A single ungated decider keeps pumping while parked in orbit, filling thruster reserves to 100%. Upon departure, thrusters burn rich (51% efficiency) until reserves drain back down—often wasting fuel across ~70% of inner-planet trips.`;
    }

    document.getElementById("circuitSpecContainer").innerHTML = html;
    return copyLines.join("\n");
  }

  // =========================================================================
  // 8. SVG RENDERERS (Operating Curve & Stability Comparison)
  // =========================================================================

  const CURVE_PAD = { left: 48, right: 52, top: 20, bottom: 38 };
  const CURVE_W = 640;
  const CURVE_H = 310;

  function renderOperatingCurve(model) {
    const svg = document.getElementById("operatingCurveSvg");
    const pw = CURVE_W - CURVE_PAD.left - CURVE_PAD.right;
    const ph = CURVE_H - CURVE_PAD.top - CURVE_PAD.bottom;

    const maxFlowPerThruster = MAX_FLOW_S * model.quality;
    const maxSpeedCurve = Math.max(10, metricsFromT(1, model.thrusters, model.quality, model.weightTons).speedKms);
    const speedAxisMax = Math.ceil(maxSpeedCurve / 50) * 50;

    const xOfFill = (fillPct) => CURVE_PAD.left + ((fillPct - 10) / 70) * pw;
    const yOfPct = (pct) => CURVE_PAD.top + (1 - pct / 100) * ph;
    const yOfSpeed = (spd) => CURVE_PAD.top + (1 - spd / speedAxisMax) * ph;

    // Sample curve points across 10%..80% fill
    const effPts = [];
    const flowPts = [];
    const spdPts = [];
    const steps = 70;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const m = metricsFromT(t, model.thrusters, model.quality, model.weightTons);
      const x = xOfFill(m.fill * 100);
      effPts.push(`${x.toFixed(1)},${yOfPct(m.eff * 100).toFixed(1)}`);
      flowPts.push(`${x.toFixed(1)},${yOfPct((m.flowPerThruster / maxFlowPerThruster) * 100).toFixed(1)}`);
      spdPts.push(`${x.toFixed(1)},${yOfSpeed(m.speedKms).toFixed(1)}`);
    }

    // Current operating marker
    const curFillPct = clamp(model.achievedMetrics.fill * 100, 10, 80);
    const curX = xOfFill(curFillPct);
    const curEffY = yOfPct(model.achievedMetrics.eff * 100);
    const curFlowY = yOfPct((model.achievedMetrics.flowPerThruster / maxFlowPerThruster) * 100);
    const curSpdY = yOfSpeed(model.achievedMetrics.speedKms);

    // Optional Pump Cap vertical line (amber dashed so it stays distinct from red Speed curve)
    let pumpCapSvg = "";
    if (model.totalPumpCap < model.maxThrusterFlow - 0.1) {
      const capFillPct = clamp(model.maxSystemMetrics.fill * 100, 10, 80);
      const capX = xOfFill(capFillPct);
      pumpCapSvg = `
        <line x1="${capX.toFixed(1)}" y1="${CURVE_PAD.top}" x2="${capX.toFixed(1)}" y2="${CURVE_PAD.top + ph}"
              stroke="${COLOR_PUMP_CAP}" stroke-width="1.6" stroke-dasharray="5 4" />
        <text x="${Math.min(capX + 5, CURVE_W - CURVE_PAD.right - 68)}" y="${CURVE_PAD.top + 14}"
              fill="#fcd34d" font-size="11" font-family="monospace">Pump Cap</text>`;
    }

    // Grid lines
    let gridSvg = "";
    for (let p = 0; p <= 100; p += 20) {
      const y = yOfPct(p);
      gridSvg += `<line x1="${CURVE_PAD.left}" y1="${y}" x2="${CURVE_PAD.left + pw}" y2="${y}" stroke="#2b323d" stroke-width="1" />`;
      gridSvg += `<text x="${CURVE_PAD.left - 8}" y="${y + 4}" text-anchor="end" fill="#8b97a8" font-size="11" font-family="monospace">${p}%</text>`;
      const spdTick = Math.round((p / 100) * speedAxisMax);
      gridSvg += `<text x="${CURVE_PAD.left + pw + 8}" y="${y + 4}" text-anchor="start" fill="${COLOR_SPEED_TEXT}" font-size="11" font-family="monospace">${spdTick}</text>`;
    }
    for (let f = 10; f <= 80; f += 10) {
      const x = xOfFill(f);
      gridSvg += `<line x1="${x}" y1="${CURVE_PAD.top}" x2="${x}" y2="${CURVE_PAD.top + ph}" stroke="#232831" stroke-width="1" />`;
      gridSvg += `<text x="${x}" y="${CURVE_H - 15}" text-anchor="middle" fill="#8b97a8" font-size="11" font-family="monospace">${f}%</text>`;
    }

    svg.innerHTML = `
      ${gridSvg}
      <text x="${CURVE_PAD.left + pw / 2}" y="${CURVE_H - 2}" text-anchor="middle" fill="#98a4b5" font-size="11">Fluid Reserve Fill (%)</text>
      <text x="${CURVE_W - 6}" y="${CURVE_PAD.top - 6}" text-anchor="end" fill="${COLOR_SPEED_TEXT}" font-size="11">Speed (km/s)</text>
      <text x="${CURVE_PAD.left}" y="${CURVE_PAD.top - 6}" text-anchor="start" fill="#98a4b5" font-size="11">Eff % / Fluid %</text>

      ${pumpCapSvg}

      <polyline fill="none" stroke="${COLOR_EFF}" stroke-width="2.4" points="${effPts.join(" ")}" />
      <polyline fill="none" stroke="${COLOR_FLUID}" stroke-width="2.5" points="${flowPts.join(" ")}" />
      <polyline fill="none" stroke="${COLOR_SPEED}" stroke-width="2.5" points="${spdPts.join(" ")}" />

      <line x1="${curX.toFixed(1)}" y1="${CURVE_PAD.top}" x2="${curX.toFixed(1)}" y2="${CURVE_PAD.top + ph}"
            stroke="#e6ebf2" stroke-width="1.3" stroke-dasharray="3 3" opacity="0.8" />

      <circle cx="${curX.toFixed(1)}" cy="${curEffY.toFixed(1)}" r="5" fill="${COLOR_EFF}" stroke="#111316" stroke-width="1.8" />
      <circle cx="${curX.toFixed(1)}" cy="${curFlowY.toFixed(1)}" r="5" fill="${COLOR_FLUID}" stroke="#111316" stroke-width="1.8" />
      <circle cx="${curX.toFixed(1)}" cy="${curSpdY.toFixed(1)}" r="5" fill="${COLOR_SPEED}" stroke="#111316" stroke-width="1.8" />
    `;
  }

  function renderStabilityComparison(model) {
    const sim = simulateStability(model.pwm, model.ds, model.thrusters, model.quality, model.totalPumpCap);
    const metric = state.simMetric;
    const pwmArr = sim.pwm[metric];
    const dsArr = sim.ds[metric];
    const targetVal = metric === "fill"
      ? model.desiredMetrics.fill * 100
      : metric === "eff"
      ? model.desiredMetrics.eff * 100
      : model.desiredFlow;
    const unit = metric === "flow" ? " u/s" : "%";

    const pwmMin = Math.min(...pwmArr);
    const pwmMax = Math.max(...pwmArr);
    const dsMin = Math.min(...dsArr);
    const dsMax = Math.max(...dsArr);
    const pwmSwing = pwmMax - pwmMin;
    const dsSwing = dsMax - dsMin;
    const ratio = dsSwing > 1e-6 ? pwmSwing / dsSwing : 1;

    document.getElementById("statPwmSwing").textContent = `${pwmSwing.toFixed(2)}${unit}`;
    document.getElementById("statDsSwing").textContent = `${dsSwing.toFixed(2)}${unit}`;
    document.getElementById("statRippleGain").textContent = pwmSwing > 1e-5
      ? `${ratio.toFixed(1)}× tighter`
      : "Flat (0 swing)";

    const W = 760, H = 250;
    const pad = { left: 56, right: 20, top: 22, bottom: 32 };
    const pw = W - pad.left - pad.right;
    const ph = H - pad.top - pad.bottom;

    const allVals = [...pwmArr, ...dsArr, targetVal];
    let vMin = Math.min(...allVals);
    let vMax = Math.max(...allVals);
    const span = Math.max(vMax - vMin, metric === "flow" ? 4 : 0.6);
    vMin -= span * 0.2;
    vMax += span * 0.2;

    const xOf = (i) => pad.left + (i / (pwmArr.length - 1)) * pw;
    const yOf = (v) => pad.top + (1 - (v - vMin) / (vMax - vMin)) * ph;

    const pwmPts = pwmArr.map((v, i) => `${xOf(i).toFixed(1)},${yOf(v).toFixed(1)}`).join(" ");
    const dsPts = dsArr.map((v, i) => `${xOf(i).toFixed(1)},${yOf(v).toFixed(1)}`).join(" ");
    const targetY = yOf(targetVal);

    let grid = "";
    for (let k = 0; k <= 4; k++) {
      const val = vMin + (k / 4) * (vMax - vMin);
      const y = yOf(val);
      grid += `<line x1="${pad.left}" y1="${y}" x2="${pad.left + pw}" y2="${y}" stroke="#2b323d" stroke-width="1" />`;
      grid += `<text x="${pad.left - 8}" y="${y + 4}" text-anchor="end" fill="#8b97a8" font-size="11" font-family="monospace">${val.toFixed(1)}</text>`;
    }
    for (let t = 0; t <= 180; t += 30) {
      const x = pad.left + (t / 180) * pw;
      grid += `<text x="${x}" y="${H - 10}" text-anchor="middle" fill="#8b97a8" font-size="11" font-family="monospace">${t}t</text>`;
    }

    document.getElementById("stabilitySvg").innerHTML = `
      ${grid}
      <line x1="${pad.left}" y1="${targetY.toFixed(1)}" x2="${pad.left + pw}" y2="${targetY.toFixed(1)}"
            stroke="#98a4b5" stroke-width="1.2" stroke-dasharray="5 4" />
      <polyline fill="none" stroke="#f59e0b" stroke-width="2.2" opacity="0.9" points="${pwmPts}" />
      <polyline fill="none" stroke="#38bdf8" stroke-width="2.5" points="${dsPts}" />

      <g font-size="11" font-family="sans-serif">
        <line x1="${pad.left + 8}" y1="12" x2="${pad.left + 26}" y2="12" stroke="#f59e0b" stroke-width="2.5" />
        <text x="${pad.left + 32}" y="16" fill="#e6ebf2">Standard PWM (${model.pwm.on}/${model.pwm.period})</text>
        <line x1="${pad.left + 195}" y1="12" x2="${pad.left + 213}" y2="12" stroke="#38bdf8" stroke-width="2.5" />
        <text x="${pad.left + 219}" y="16" fill="#e6ebf2">Delta-Sigma (A=${model.ds.A}, B=${model.ds.B})</text>
        <line x1="${pad.left + 420}" y1="12" x2="${pad.left + 438}" y2="12" stroke="#98a4b5" stroke-width="1.5" stroke-dasharray="4 3" />
        <text x="${pad.left + 444}" y="16" fill="#98a4b5">Target (${targetVal.toFixed(1)}${unit})</text>
      </g>
    `;

    const pwmPulses = generatePulseTrain(60, "pwm", model.pwm, model.ds);
    const dsPulses = generatePulseTrain(60, "ds", model.pwm, model.ds);
    renderPulseStrip("stripPwm", pwmPulses, "on-pwm", state.simTick % 60);
    renderPulseStrip("stripDs", dsPulses, "on-ds", state.simTick % 60);
  }

  function renderPulseStrip(containerId, pulses, onClass, cursorIdx) {
    const el = document.getElementById(containerId);
    el.innerHTML = pulses.map((p, idx) => {
      const cls = `pulse-cell ${p ? onClass : ""} ${idx === cursorIdx ? "active-cursor" : ""}`;
      return `<span class="${cls}" title="Tick ${idx}: ${p ? "ON" : "OFF"}"></span>`;
    }).join("");
  }

  // =========================================================================
  // 9. UI SYNC & EVENT HANDLING
  // =========================================================================

  let lastCopyText = "";
  let currentModel = null;

  function updateTargetControlBounds(model) {
    const mode = state.targetMode;
    const stdGroup = document.getElementById("standardTargetGroup");
    const manGroup = document.getElementById("manualTicksGroup");
    const rangeEl = document.getElementById("rangeTargetValue");
    const numEl = document.getElementById("inputTargetValue");
    const labelEl = document.getElementById("labelTargetValue");
    const hintEl = document.getElementById("targetRangeHint");

    if (mode === "manual") {
      stdGroup.classList.add("hidden");
      manGroup.classList.remove("hidden");
      document.getElementById("inputManualOn").value = state.manualOn;
      document.getElementById("inputManualPeriod").value = state.manualPeriod;
      return;
    }

    stdGroup.classList.remove("hidden");
    manGroup.classList.add("hidden");

    const maxFlowThr = MAX_FLOW_S * model.quality;
    const minFlowThr = MIN_FLOW_S * model.quality;
    const maxSpeed = metricsFromT(1, model.thrusters, model.quality, model.weightTons).speedKms;

    let min = 0, max = 100, step = 0.1, label = "", hint = "";
    if (mode === "efficiency") {
      min = 51; max = 100; step = 0.1;
      label = "Target Efficiency (%)";
      hint = "51.0% – 100.0%";
    } else if (mode === "fill") {
      min = 10; max = 80; step = 0.5;
      label = "Target Fluid Fill (%)";
      hint = "10.0% – 80.0%";
    } else if (mode === "speed") {
      min = 0; max = Number(maxSpeed.toFixed(1)); step = 1;
      label = "Target Cruise Speed (km/s)";
      hint = `0 – ${maxSpeed.toFixed(1)} km/s`;
    } else if (mode === "flowPerThruster") {
      min = Number(minFlowThr.toFixed(1)); max = Number(maxFlowThr.toFixed(1)); step = 0.5;
      label = "Fluid Consumption / Thruster (u/s)";
      hint = `${minFlowThr.toFixed(1)} – ${maxFlowThr.toFixed(1)} u/s`;
    } else if (mode === "totalFlow") {
      min = 0; max = Number(model.maxThrusterFlow.toFixed(0)); step = 1;
      label = "Total Fluid Consumption (u/s)";
      hint = `0 – ${model.maxThrusterFlow.toFixed(0)} u/s`;
    }

    labelEl.textContent = label;
    hintEl.textContent = hint;
    rangeEl.min = min;
    rangeEl.max = max;
    rangeEl.step = step;
    numEl.min = min;
    numEl.max = max;
    numEl.step = step;
    rangeEl.value = clamp(state.targetValue, min, max);
    if (document.activeElement !== numEl) {
      numEl.value = Number(state.targetValue).toFixed(step >= 1 ? 0 : 1);
    }
  }

  function renderCandidatesTable(model) {
    const tbody = document.getElementById("candidatesTbody");
    const rows = model.candidates.slice().reverse().map((c) => {
      const flow = c.duty * model.totalPumpCap;
      const m = metricsFromTotalFlow(Math.min(flow, model.maxThrusterFlow), model.thrusters, model.quality, model.weightTons);
      const errPct = model.desiredFlow > 0 ? ((flow - model.desiredFlow) / model.desiredFlow) * 100 : 0;
      const isSelected = !state.useDeltaSigma && c.on === model.pwm.on && c.period === model.pwm.period;
      return `
        <tr class="${isSelected ? "selected-row" : ""}" data-on="${c.on}" data-period="${c.period}">
          <td><strong>${c.on} / ${c.period}</strong></td>
          <td>${c.off}</td>
          <td>${(c.duty * 100).toFixed(2)}%</td>
          <td>${flow.toFixed(1)} u/s</td>
          <td>${m.speedKms.toFixed(1)} km/s</td>
          <td>${errPct >= 0 ? "+" : ""}${errPct.toFixed(2)}%</td>
        </tr>`;
    });
    tbody.innerHTML = rows.join("");
  }

  function updateLiveSimReadout(model) {
    const { pwm, ds } = model;
    const isDs = state.useDeltaSigma;
    const isTwo = state.architecture === "two";
    let rawSignalOn = false;
    let sigLabel = "";
    let sigVal = "";

    if (!isDs) {
      const L = state.simTick % pwm.period;
      rawSignalOn = L < pwm.on;
      sigLabel = "Counter Signal L";
      sigVal = `${L} / ${pwm.period - 1}`;
    } else {
      rawSignalOn = state.simAccE >= ds.threshold && ds.A > 0;
      sigLabel = "Accumulator E";
      sigVal = `${state.simAccE} (≥${ds.threshold})`;
    }

    const gatedBlocked = isTwo && !state.simMoving;
    const pumpActive = rawSignalOn && !gatedBlocked;

    document.getElementById("liveSignalName").textContent = sigLabel;
    document.getElementById("liveSignalVal").textContent = sigVal;
    document.getElementById("liveTickReadout").textContent =
      `Tick ${state.simTick} · ${sigLabel} = ${sigVal} · ${gatedBlocked ? "BLOCKED (Docked = 3)" : pumpActive ? "Pump ON" : "Pump OFF"}`;

    const setPipe = (cardId, stateId) => {
      const card = document.getElementById(cardId);
      const st = document.getElementById(stateId);
      card.classList.remove("pumping", "blocked");
      if (gatedBlocked) {
        card.classList.add("blocked");
        st.textContent = "DOCKED (= 3)";
      } else if (pumpActive) {
        card.classList.add("pumping");
        st.textContent = "PUMPING (+20u)";
      } else {
        st.textContent = "OFF";
      }
    };
    setPipe("pipeFuel", "pipeFuelState");
    setPipe("pipeOxidizer", "pipeOxState");

    const idx = state.simTick % 60;
    ["stripPwm", "stripDs"].forEach((id) => {
      const children = document.getElementById(id).children;
      for (let i = 0; i < children.length; i++) {
        children[i].classList.toggle("active-cursor", i === idx);
      }
    });
  }

  function renderAll() {
    const model = computeModel();
    currentModel = model;

    document.getElementById("pwmOptionsGroup").classList.toggle("hidden", state.useDeltaSigma || state.targetMode === "manual");
    document.getElementById("deltaSigmaOptionsGroup").classList.toggle("hidden", !state.useDeltaSigma);
    document.getElementById("toggleDeltaSigma").checked = state.useDeltaSigma;

    const pill = document.getElementById("heroMethodPill");
    if (state.useDeltaSigma) {
      document.getElementById("heroModeEyebrow").textContent = "Delta-Sigma Phase Accumulator";
      document.getElementById("heroHeadline").textContent = `+${model.ds.A} / −${model.ds.threshold}`;
      document.getElementById("heroSubline").textContent =
        `Capacity B = ${model.ds.B} · Fire pulse when E ≥ ${model.ds.threshold} · ${(model.ds.duty * 100).toFixed(2)}% duty`;
      pill.textContent = "Delta-Sigma";
      pill.classList.add("pill-cyan");
    } else {
      document.getElementById("heroModeEyebrow").textContent = "Optimal PWM Clock";
      document.getElementById("heroHeadline").textContent = `${model.pwm.on} / ${model.pwm.period} ticks`;
      document.getElementById("heroSubline").textContent =
        `${model.pwm.on} ticks ON, ${model.pwm.off} ticks OFF · ${(model.pwm.duty * 100).toFixed(2)}% duty cycle`;
      pill.textContent = "PWM";
      pill.classList.remove("pill-cyan");
    }

    const m = model.achievedMetrics;
    const lowSpd = Math.max(0, m.speedKms - GRAVITY_BAND_KMS);
    const highSpd = m.speedKms > 0 ? m.speedKms + GRAVITY_BAND_KMS : 0;

    document.getElementById("kpiSpeed").innerHTML = `${m.speedKms.toFixed(1)} <small>km/s</small>`;
    document.getElementById("kpiSpeedBand").textContent = `${lowSpd.toFixed(0)} – ${highSpd.toFixed(0)} km/s (±10g)`;
    document.getElementById("kpiEff").innerHTML = `${(m.eff * 100).toFixed(1)}<small>%</small>`;
    document.getElementById("kpiFill").textContent = `${(m.fill * 100).toFixed(1)}% fluid fill`;
    document.getElementById("kpiFlow").innerHTML = `${model.achievedFlow.toFixed(1)} <small>u/s</small>`;
    document.getElementById("kpiPerThruster").textContent = `${m.flowPerThruster.toFixed(1)} u/s per thruster`;
    document.getElementById("kpiThrust").innerHTML = `${(m.thrustKN / 1000).toFixed(1)} <small>MN</small>`;
    document.getElementById("kpiError").textContent =
      `Error: ${model.flowErrorPct >= 0 ? "+" : ""}${model.flowErrorPct.toFixed(2)}%`;

    const warnEl = document.getElementById("warningBanner");
    if (model.warning) {
      warnEl.classList.remove("hidden");
      document.getElementById("warningText").textContent = model.warning.text;
      document.getElementById("btnFixWarning").textContent = model.warning.fixLabel;
    } else {
      warnEl.classList.add("hidden");
    }

    document.getElementById("readoutFill").textContent = `${(m.fill * 100).toFixed(1)}%`;
    document.getElementById("readoutEff").textContent = `${(m.eff * 100).toFixed(1)}%`;
    document.getElementById("readoutFlow").textContent = `${m.flowPerThruster.toFixed(1)} u/s`;
    document.getElementById("readoutSpeed").textContent = `${m.speedKms.toFixed(1)} km/s`;
    document.getElementById("readoutPumpCap").textContent = `${model.totalPumpCap} u/s`;

    updateTargetControlBounds(model);
    lastCopyText = renderCircuitSpec(model);
    renderOperatingCurve(model);
    renderCandidatesTable(model);

    if (document.getElementById("drawerStability").open) {
      renderStabilityComparison(model);
    }
    updateLiveSimReadout(model);
  }

  // =========================================================================
  // 10. INTERACTIVE CURVE CLICK / DRAG HANDLER
  // =========================================================================

  function applyCurvePointer(evt) {
    if (!currentModel) return;
    const svg = document.getElementById("operatingCurveSvg");
    const rect = svg.getBoundingClientRect();
    const scaleX = CURVE_W / rect.width;
    const x = (evt.clientX - rect.left) * scaleX;
    const pw = CURVE_W - CURVE_PAD.left - CURVE_PAD.right;
    const t = clamp((x - CURVE_PAD.left) / pw, 0, 1);
    const m = metricsFromT(t, currentModel.thrusters, currentModel.quality, currentModel.weightTons);

    if (state.targetMode === "manual") {
      state.targetMode = "fill";
      document.getElementById("selectTargetMode").value = "fill";
    }

    if (state.targetMode === "efficiency") {
      state.targetValue = Number((m.eff * 100).toFixed(1));
    } else if (state.targetMode === "fill") {
      state.targetValue = Number((m.fill * 100).toFixed(1));
    } else if (state.targetMode === "speed") {
      state.targetValue = Number(m.speedKms.toFixed(1));
    } else if (state.targetMode === "flowPerThruster") {
      state.targetValue = Number(m.flowPerThruster.toFixed(1));
    } else if (state.targetMode === "totalFlow") {
      state.targetValue = Number(m.totalFlow.toFixed(1));
    }
    renderAll();
  }

  // =========================================================================
  // 11. LIVE TICK STEPPER
  // =========================================================================

  function stepSimulator() {
    if (!currentModel) return;
    if (state.useDeltaSigma) {
      const { A, threshold } = currentModel.ds;
      if (state.simAccE >= threshold && A > 0) {
        state.simAccE -= threshold;
      } else {
        state.simAccE += A;
      }
    }
    state.simTick += 1;
    updateLiveSimReadout(currentModel);
  }

  function setSimPlaying(play) {
    state.simPlaying = play;
    const btn = document.getElementById("btnSimPlay");
    btn.textContent = play ? "Pause" : "Play";
    if (state.simTimerId) {
      clearInterval(state.simTimerId);
      state.simTimerId = null;
    }
    if (play) {
      const intervalMs = Math.max(16, Math.round(1000 / state.simSpeed));
      state.simTimerId = setInterval(stepSimulator, intervalMs);
    }
  }

  // =========================================================================
  // 12. BIND DOM EVENTS
  // =========================================================================

  function bindEvents() {
    const numBind = (id, key, parseFn = Number) => {
      document.getElementById(id).addEventListener("input", (e) => {
        const val = parseFn(e.target.value);
        if (!Number.isNaN(val)) {
          state[key] = val;
          renderAll();
        }
      });
    };

    numBind("inputThrusters", "thrusters", (v) => Math.max(1, parseInt(v, 10) || 1));
    numBind("selectThrusterQuality", "thrusterQuality", parseFloat);
    numBind("inputPumps", "pumps", (v) => Math.max(1, parseInt(v, 10) || 1));
    numBind("selectPumpQuality", "pumpCapacity", parseFloat);
    numBind("inputWeight", "weightTons", (v) => Math.max(40, parseFloat(v) || 40));
    numBind("inputMaxPeriod", "maxPeriod", (v) => clamp(parseInt(v, 10) || 60, 2, 600));
    numBind("inputManualOn", "manualOn", (v) => Math.max(0, parseInt(v, 10) || 0));
    numBind("inputManualPeriod", "manualPeriod", (v) => Math.max(2, parseInt(v, 10) || 2));
    numBind("selectDsScale", "dsScale", (v) => parseInt(v, 10) || 1);

    document.getElementById("selectTargetMode").addEventListener("change", (e) => {
      const newMode = e.target.value;
      const m = currentModel ? currentModel.achievedMetrics : null;
      state.targetMode = newMode;
      if (m) {
        if (newMode === "efficiency") state.targetValue = Number((m.eff * 100).toFixed(1));
        else if (newMode === "fill") state.targetValue = Number((m.fill * 100).toFixed(1));
        else if (newMode === "speed") state.targetValue = Number(m.speedKms.toFixed(1));
        else if (newMode === "flowPerThruster") state.targetValue = Number(m.flowPerThruster.toFixed(1));
        else if (newMode === "totalFlow") state.targetValue = Number(m.totalFlow.toFixed(1));
        else if (newMode === "manual") {
          state.manualOn = currentModel.pwm.on;
          state.manualPeriod = currentModel.pwm.period;
        }
      }
      renderAll();
    });

    document.getElementById("rangeTargetValue").addEventListener("input", (e) => {
      state.targetValue = parseFloat(e.target.value);
      document.getElementById("inputTargetValue").value = state.targetValue;
      renderAll();
    });
    document.getElementById("inputTargetValue").addEventListener("input", (e) => {
      const val = parseFloat(e.target.value);
      if (!Number.isNaN(val)) {
        state.targetValue = val;
        renderAll();
      }
    });

    document.getElementById("toggleDeltaSigma").addEventListener("change", (e) => {
      state.useDeltaSigma = e.target.checked;
      state.simTick = 0;
      state.simAccE = 0;
      renderAll();
    });

    document.querySelectorAll("[data-arch]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.architecture = btn.dataset.arch;
        document.querySelectorAll("[data-arch]").forEach((b) => {
          const active = b.dataset.arch === state.architecture;
          b.classList.toggle("active", active);
          b.setAttribute("aria-selected", String(active));
        });
        renderAll();
      });
    });

    document.querySelectorAll("[data-weight]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.weightTons = Number(btn.dataset.weight);
        document.getElementById("inputWeight").value = state.weightTons;
        renderAll();
      });
    });
    document.querySelectorAll("[data-maxp]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.maxPeriod = Number(btn.dataset.maxp);
        document.getElementById("inputMaxPeriod").value = state.maxPeriod;
        renderAll();
      });
    });

    document.getElementById("btnFixWarning").addEventListener("click", () => {
      if (currentModel && currentModel.warning && currentModel.warning.fixAction) {
        currentModel.warning.fixAction();
        renderAll();
      }
    });

    document.getElementById("btnCopyCircuit").addEventListener("click", async () => {
      const btn = document.getElementById("btnCopyCircuit");
      try {
        await navigator.clipboard.writeText(lastCopyText);
        btn.textContent = "Copied!";
        setTimeout(() => { btn.textContent = "Copy Settings"; }, 1400);
      } catch {
        btn.textContent = "Copy Failed";
        setTimeout(() => { btn.textContent = "Copy Settings"; }, 1400);
      }
    });

    const curveSvg = document.getElementById("operatingCurveSvg");
    let dragging = false;
    curveSvg.addEventListener("pointerdown", (e) => {
      dragging = true;
      curveSvg.setPointerCapture(e.pointerId);
      applyCurvePointer(e);
    });
    curveSvg.addEventListener("pointermove", (e) => {
      if (dragging) applyCurvePointer(e);
    });
    curveSvg.addEventListener("pointerup", () => { dragging = false; });
    curveSvg.addEventListener("pointercancel", () => { dragging = false; });

    document.getElementById("drawerStability").addEventListener("toggle", (e) => {
      if (e.target.open && currentModel) {
        renderStabilityComparison(currentModel);
        updateLiveSimReadout(currentModel);
      } else if (!e.target.open) {
        setSimPlaying(false);
      }
    });

    document.querySelectorAll("[data-sim-metric]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.simMetric = btn.dataset.simMetric;
        document.querySelectorAll("[data-sim-metric]").forEach((b) => {
          b.classList.toggle("active", b.dataset.simMetric === state.simMetric);
        });
        if (currentModel) renderStabilityComparison(currentModel);
      });
    });

    document.getElementById("btnSimPlay").addEventListener("click", () => {
      setSimPlaying(!state.simPlaying);
    });
    document.getElementById("btnSimStep").addEventListener("click", () => {
      setSimPlaying(false);
      stepSimulator();
    });
    document.getElementById("btnSimReset").addEventListener("click", () => {
      setSimPlaying(false);
      state.simTick = 0;
      state.simAccE = 0;
      if (currentModel) updateLiveSimReadout(currentModel);
    });
    document.getElementById("selectSimSpeed").addEventListener("change", (e) => {
      state.simSpeed = parseInt(e.target.value, 10) || 5;
      if (state.simPlaying) setSimPlaying(true);
    });
    document.querySelectorAll("[data-moving]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.simMoving = btn.dataset.moving === "true";
        document.querySelectorAll("[data-moving]").forEach((b) => {
          b.classList.toggle("active", (b.dataset.moving === "true") === state.simMoving);
        });
        if (currentModel) updateLiveSimReadout(currentModel);
      });
    });

    document.getElementById("candidatesTbody").addEventListener("click", (e) => {
      const tr = e.target.closest("tr[data-on]");
      if (!tr) return;
      state.useDeltaSigma = false;
      state.targetMode = "manual";
      state.manualOn = parseInt(tr.dataset.on, 10);
      state.manualPeriod = parseInt(tr.dataset.period, 10);
      document.getElementById("selectTargetMode").value = "manual";
      renderAll();
    });
  }

  function clamp(val, min, max) {
    return Math.min(max, Math.max(min, val));
  }

  bindEvents();
  renderAll();
})();
