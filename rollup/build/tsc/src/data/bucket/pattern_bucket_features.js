export function hasPattern(type, layers, options) {
    const patterns = options.patternDependencies;
    let hasPattern = false;
    for (const layer of layers) {
        const patternProperty = layer.paint.get(`${type}-pattern`);
        if (!patternProperty.isConstant()) {
            hasPattern = true;
        }
        const constantPattern = patternProperty.constantOr(null);
        if (constantPattern) {
            hasPattern = true;
            patterns[constantPattern.to] = true;
            patterns[constantPattern.from] = true;
        }
    }
    return hasPattern;
}
export function addPatternDependencies(type, layers, patternFeature, zoom, options) {
    const patterns = options.patternDependencies;
    for (const layer of layers) {
        const patternProperty = layer.paint.get(`${type}-pattern`);
        const patternPropertyValue = patternProperty.value;
        if (patternPropertyValue.kind !== 'constant') {
            let min = patternPropertyValue.evaluate({ zoom: zoom - 1 }, patternFeature, {}, options.availableImages);
            let mid = patternPropertyValue.evaluate({ zoom }, patternFeature, {}, options.availableImages);
            let max = patternPropertyValue.evaluate({ zoom: zoom + 1 }, patternFeature, {}, options.availableImages);
            min = min && min.name ? min.name : min;
            mid = mid && mid.name ? mid.name : mid;
            max = max && max.name ? max.name : max;
            // add to patternDependencies
            patterns[min] = true;
            patterns[mid] = true;
            patterns[max] = true;
            // save for layout
            patternFeature.patterns[layer.id] = { min, mid, max };
        }
    }
    return patternFeature;
}
//# sourceMappingURL=pattern_bucket_features.js.map