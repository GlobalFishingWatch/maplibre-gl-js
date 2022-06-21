let supportsOffscreenCanvas;
export default function offscreenCanvasSupported() {
    if (supportsOffscreenCanvas == null) {
        supportsOffscreenCanvas = typeof OffscreenCanvas !== 'undefined' &&
            new OffscreenCanvas(1, 1).getContext('2d') &&
            typeof createImageBitmap === 'function';
    }
    return supportsOffscreenCanvas;
}
//# sourceMappingURL=offscreen_canvas_supported.js.map