# ADR 0002: Preserve bpmn-js attribution in exported SVG

- Status: accepted
- Date: 2026-08-22
- Bead: `mcp-bpmn-33g.6`

## Decision

MCP-BPMN will continue to use the pinned `bpmn-js@17.11.1` navigated viewer
under its distributed license. This is a maintainer release decision; the
project does not claim a separate commercial license for watermark-free use.

The headless renderer must preserve bpmn-js's own `.bjs-powered-by` logo in
every served SVG. The logo is placed last in the SVG, over an opaque background
inside the lower-right corner of the viewBox, and linked only to
`https://bpmn.io`. Consumers must not crop, cover, or remove the attribution.

The renderer verifies that bpmn-js created the expected attribution source and
clones that logo rather than maintaining a separate approximation. If the
upstream source disappears or changes identity, export fails closed until this
decision and implementation are reviewed.

## Security boundary

Diagram-derived SVG is sanitized before attribution is added. It may not
contain anchors, `href`/`xlink:href`, event handlers, external URL styles,
scripts, images, or foreign objects. The only external link in the final SVG is
the renderer-owned `https://bpmn.io` attribution; it is non-embedded, requires
a user click, opens in a separate context, and carries `noopener noreferrer`.
The renderer page continues to block every network request.

## Distribution and verification

`THIRD_PARTY_NOTICES.md` reproduces the installed bpmn-js license and is part of
the npm tarball. CI's package smoke test installs that tarball, checks the exact
dependency version and watermark clause in both the published notice and the
installed dependency license, renders a real fixture through the installed
renderer, and permits no other SVG link. The focused integration test also
checks attribution while retaining the existing SVG injection and external
resource assertions.

Any bpmn-js upgrade, renderer replacement, or request for watermark-free output
requires a new release decision and corresponding notice and test updates.

## Rejected alternatives

- **Watermark-free headless export:** rejected without a recorded alternative
  license because `saveSVG()` omits the viewer's DOM overlay.
- **A separately drawn text credit:** rejected because it could drift from the
  dependency-provided attribution source.
- **Allowing arbitrary SVG links:** rejected because BPMN labels and imported
  XML are untrusted input; only the renderer-owned fixed link is necessary.
