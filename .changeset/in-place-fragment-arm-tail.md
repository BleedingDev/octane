---
'octane': patch
---

Continue hydration after every root of a fragment that a component adopts in place. When the server rendered another `@if` or `@switch` arm, a component whose own server range was missing adopts the server's nodes in place. If the component rendered a fragment or text, hydration stayed on its first root. The server content after the fragment then stayed on screen with no report, and the next component adopted that root again and discarded it. Hydration now steps past all of the fragment's roots. Production finds where they end from the compiled template's root count, without parsing the template. So the arm's stale tail is removed and reported once, and the next component claims its own server range. When the server's arm ends before the fragment's roots do, hydration stops at the arm's end and discards nothing.
