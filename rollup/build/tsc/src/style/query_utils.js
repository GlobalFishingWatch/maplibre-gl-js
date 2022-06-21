import Point from '@mapbox/point-geometry';
export function getMaximumPaintValue(property, layer, bucket) {
    const value = layer.paint.get(property).value;
    if (value.kind === 'constant') {
        return value.value;
    }
    else {
        return bucket.programConfigurations.get(layer.id).getMaxValue(property);
    }
}
export function translateDistance(translate) {
    return Math.sqrt(translate[0] * translate[0] + translate[1] * translate[1]);
}
export function translate(queryGeometry, translate, translateAnchor, bearing, pixelsToTileUnits) {
    if (!translate[0] && !translate[1]) {
        return queryGeometry;
    }
    const pt = Point.convert(translate)._mult(pixelsToTileUnits);
    if (translateAnchor === 'viewport') {
        pt._rotate(-bearing);
    }
    const translated = [];
    for (let i = 0; i < queryGeometry.length; i++) {
        const point = queryGeometry[i];
        translated.push(point.sub(pt));
    }
    return translated;
}
//# sourceMappingURL=query_utils.js.map