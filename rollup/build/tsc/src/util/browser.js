const now = performance && performance.now ?
    performance.now.bind(performance) :
    Date.now.bind(Date);
let linkEl;
let reducedMotionQuery;
/**
 * @private
 */
const exported = {
    /**
     * Provides a function that outputs milliseconds: either performance.now()
     * or a fallback to Date.now()
     */
    now,
    frame(fn) {
        const frame = requestAnimationFrame(fn);
        return { cancel: () => cancelAnimationFrame(frame) };
    },
    getImageData(img, padding = 0) {
        const canvas = window.document.createElement('canvas');
        const context = canvas.getContext('2d');
        if (!context) {
            throw new Error('failed to create canvas 2d context');
        }
        canvas.width = img.width;
        canvas.height = img.height;
        context.drawImage(img, 0, 0, img.width, img.height);
        return context.getImageData(-padding, -padding, img.width + 2 * padding, img.height + 2 * padding);
    },
    resolveURL(path) {
        if (!linkEl)
            linkEl = document.createElement('a');
        linkEl.href = path;
        return linkEl.href;
    },
    hardwareConcurrency: typeof navigator !== 'undefined' && navigator.hardwareConcurrency || 4,
    get prefersReducedMotion() {
        if (!matchMedia)
            return false;
        //Lazily initialize media query
        if (reducedMotionQuery == null) {
            reducedMotionQuery = matchMedia('(prefers-reduced-motion: reduce)');
        }
        return reducedMotionQuery.matches;
    },
};
export default exported;
//# sourceMappingURL=browser.js.map