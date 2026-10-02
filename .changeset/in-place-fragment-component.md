---
'octane': patch
---

Hydrate the component after one whose fragment adopted server nodes in place. When the server rendered a different `@if`/`@switch` arm, a hookless component that found that arm's elements where its own server range belonged, and whose body returns a fragment of several roots, adopted them, but hydration continued from the fragment's first root. The next component compared its template against that node, discarded it, and rebuilt, which left the fragment holding a detached node and left the server's content for the next component on the page. Hydration now continues after the fragment's last root.
