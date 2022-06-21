import loadGeometry from './load_geometry';
/**
 * Construct a new feature based on a VectorTileFeature for expression evaluation, the geometry of which
 * will be loaded based on necessity.
 * @param {VectorTileFeature} feature
 * @param {boolean} needGeometry
 * @private
 */
export default function toEvaluationFeature(feature, needGeometry) {
    return { type: feature.type,
        id: feature.id,
        properties: feature.properties,
        geometry: needGeometry ? loadGeometry(feature) : [] };
}
//# sourceMappingURL=evaluation_feature.js.map