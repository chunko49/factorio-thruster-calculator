# Factorio 2.1.21+ Thruster Speed & Pump Control Calculator

A lightweight, zero-dependency web calculator for **Factorio: Space Age (v2.1.21+)** that computes thruster cruise speed under the post-2.1.21 weight-based drag formula and generates exact in-game **PWM** and **Delta-Sigma (Bresenham)** decider combinator settings.

## Features

- **Post-2.1.21 Weight-Drag Physics**: Uses Wube's exact `space_platform_acceleration_expression` (`weight` in kg, `thrust` in kN, `±10 km/s` orbital gravity band) with support for all thruster and pump qualities (Normal through Legendary).
- **Interactive Operating Curve**: Click or drag directly across the 10%–80% fluid reserve curve to target Efficiency %, Cruise Speed (km/s), Fill %, Fluid Consumption/Thruster, or Total Fluid Consumption.
- **PWM & Advanced Delta-Sigma (Bresenham) Modes**:
  - **Standard PWM (default)**: Finds Pareto-optimal short-period rational clocks (`ON / Period`) to keep fluid ripple low.
  - **Delta-Sigma Phase Accumulator (advanced toggle)**: Fits in a single Factorio 2.1 decider combinator (`Else outputs`) to spread single-tick pulses evenly with minimal thruster reserve oscillation.
- **2-Decider Motion-Gated & 1-Decider Simple Wiring**: Includes Space Platform Hub planet gating (`Read moving from (1)` + `Read moving to (2)` → `< 3` when moving, `= 3` when parked) to prevent idle reserve overfill.
- **Collapsible Stability Simulator**: Compares 180-tick thruster fluidbox ripple between Standard PWM and Delta-Sigma alongside a live step-by-step tick visualizer.

## Reference Formulas & Official Sources

### 1. Space Platform Acceleration & Equilibrium Speed (v2.1.21+)

From [`core/prototypes/utility-constants.lua`](https://github.com/wube/factorio-data/blob/master/core/prototypes/utility-constants.lua) ([Version 2.1.21 Changelog](https://forums.factorio.com/viewtopic.php?t=136430)):

```lua
space_platform_acceleration_expression = "(thrust / (1 + weight / 10000000) - ((90 * speed * speed) * ((weight / 200) ^ 0.80) + 10000) * sign(speed)) / weight / 60"
```

Setting acceleration to `0` gives the equilibrium cruise speed (in `km/s`, where `speed` is in `km/tick` and `weight` is in `kg`):

$$v_{\text{eq}}\;(\text{km/s}) = 60 \sqrt{\frac{\frac{\text{thrust}}{1 + \text{weight}/10^7} - 10000}{90\,(\text{weight}/200)^{0.80}}}$$

### 2. Thruster Performance Curve

From [`space-age/prototypes/entity/entities.lua`](https://github.com/wube/factorio-data/blob/master/space-age/prototypes/entity/entities.lua) and the [Factorio Wiki: Thruster](https://wiki.factorio.com/Thruster):

- `min_performance`: `10%` fill → `0.1 u/tick` (`6 u/s`), `100%` efficiency (`10 MN` thrust at Normal quality)
- `max_performance`: `80%` fill → `2.0 u/tick` (`120 u/s`), `51%` efficiency (`102 MN` thrust at Normal quality)
- Quality scaling (`1.0×`, `1.3×`, `1.6×`, `1.9×`, `2.5×`) scales fluid consumption and thrust proportionally.

### 3. Additional Wiki References

- [Space Platform Hub Circuit Signals](https://wiki.factorio.com/Space_platform)
- [Pump Throughput & Quality](https://wiki.factorio.com/Pump)
- [Decider Combinator (2.1 Else Outputs)](https://wiki.factorio.com/Decider_combinator)

## Running Locally or Hosting on GitHub Pages

No build step or dependencies are required:
1. Open `index.html` directly in any modern browser to run locally.
2. To host on **GitHub Pages**, upload `index.html`, `styles.css`, `app.js`, and `README.md` to the root of a public repository and enable **Settings → Pages → Deploy from branch (`main` / `/root`)**.
