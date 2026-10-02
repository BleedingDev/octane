---
'octane': patch
---

Fix hydration of a hookless component that renders several roots when the server rendered another `@if`/`@switch` arm in its place, without a range for it. The component adopted the server nodes after checking only its first root, so a server arm that ran out first threw `Node can't be inserted in a #comment parent`, and one that ended where a trailing hole began was adopted with no report. Hydration now compares every root and rebuilds the component, with one structural `onRecoverableError`, when they differ. When they match, it adopts the nodes and continues after the last root, so the next component keeps its own server nodes instead of rebuilding over them, and server content the arm leaves after them is discarded and reported, as after a single root adopted in place. The development diagnostic names the call site and the first root that differs.
