export function deserialize(input, style) {
    const output = {};
    // Guard against the case where the map's style has been set to null while
    // this bucket has been parsing.
    if (!style)
        return output;
    for (const bucket of input) {
        const layers = bucket.layerIds
            .map((id) => style.getLayer(id))
            .filter(Boolean);
        if (layers.length === 0) {
            continue;
        }
        // look up StyleLayer objects from layer ids (since we don't
        // want to waste time serializing/copying them from the worker)
        bucket.layers = layers;
        if (bucket.stateDependentLayerIds) {
            bucket.stateDependentLayers = bucket.stateDependentLayerIds.map((lId) => layers.filter((l) => l.id === lId)[0]);
        }
        for (const layer of layers) {
            output[layer.id] = bucket;
        }
    }
    return output;
}
//# sourceMappingURL=bucket.js.map