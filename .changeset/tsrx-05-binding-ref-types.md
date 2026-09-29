---
'@octanejs/three': patch
'@octanejs/recharts': patch
---

Type-check under the TSRX 0.5 editor output, which reports a spread's `ref`
composed with an element's own. `Canvas` passes its wrapper a spread that never
carries `ref`, and Recharts' adapted event handlers declare that they never
carry one.
