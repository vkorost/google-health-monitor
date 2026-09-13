// The dashboard: one self-contained page served by the Worker. No CDN scripts,
// no build step. The markup, styles and client script live in ui.html, which
// Wrangler bundles as a text module (its default rules treat *.html as Text).
// Kept as a separate file so the page stays editable (and previewable) as
// plain HTML instead of one escaped JavaScript string.

import PAGE from "./ui.html";

export { PAGE };
