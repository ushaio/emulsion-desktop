# liquid-glass-react port

`LiquidGlass.tsx`, `shader-utils.ts` and `maps.ts` are a port of
[liquid-glass-react](https://github.com/rdev/liquid-glass-react) by rdev, MIT
licensed. The upstream checkout used for the port lives at
`emulsion-desktop/.ui/liquid-glass-react` (its own git clone, taken from
`master`).

The upstream algorithm and its numeric constants are kept: the SVG refraction
filter (edge mask, three-channel displacement, screen blend for chromatic
aberration), the backdrop warp layer, the mouse-reactive rim gradient, and the
elastic transform. `LiquidGlass.tsx`'s header comment lists the adaptations
that turn the demo pill into a whole-application material — layout modes,
normal-flow anchoring, absolutely positioned decoration layers, tokenised
content colour, the accessibility gate, a bounded shader texture, and
ResizeObserver-based sizing.

`maps.ts` and `shader-utils.ts` are copied verbatim apart from their header
comments; `shader-utils.ts` itself is upstream's copy of
[shuding/liquid-glass](https://github.com/shuding/liquid-glass).

Upstream's own LICENSE is preserved at
`.ui/liquid-glass-react/LICENSE` (MIT). Nothing from `glasscn-components`, the
previous material, remains in the repository.
