import GeoJSONWrapper from './geojson_wrapper';
import EXTENT from '../data/extent';
class MultiSourceLayerGeoJSONWrapper {
    constructor(sourceLayers, options) {
        const { extent = EXTENT } = options || {};
        const layers = {};
        Object.keys(sourceLayers).forEach((sourceLayerName) => {
            layers[sourceLayerName] = new GeoJSONWrapper(sourceLayers[sourceLayerName].features, {
                name: sourceLayerName,
                extent
            });
        });
        this.layers = layers;
    }
}
export default MultiSourceLayerGeoJSONWrapper;
//# sourceMappingURL=multi_source_geojson_wrapper.js.map