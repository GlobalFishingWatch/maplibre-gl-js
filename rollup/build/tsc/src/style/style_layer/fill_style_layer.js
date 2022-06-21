import StyleLayer from '../style_layer';
import FillBucket from '../../data/bucket/fill_bucket';
import { polygonIntersectsMultiPolygon } from '../../util/intersection_tests';
import { translateDistance, translate } from '../query_utils';
import properties from './fill_style_layer_properties';
class FillStyleLayer extends StyleLayer {
    constructor(layer) {
        super(layer, properties);
    }
    recalculate(parameters, availableImages) {
        super.recalculate(parameters, availableImages);
        const outlineColor = this.paint._values['fill-outline-color'];
        if (outlineColor.value.kind === 'constant' && outlineColor.value.value === undefined) {
            this.paint._values['fill-outline-color'] = this.paint._values['fill-color'];
        }
    }
    createBucket(parameters) {
        return new FillBucket(parameters);
    }
    queryRadius() {
        return translateDistance(this.paint.get('fill-translate'));
    }
    queryIntersectsFeature(queryGeometry, feature, featureState, geometry, zoom, transform, pixelsToTileUnits) {
        const translatedPolygon = translate(queryGeometry, this.paint.get('fill-translate'), this.paint.get('fill-translate-anchor'), transform.angle, pixelsToTileUnits);
        return polygonIntersectsMultiPolygon(translatedPolygon, geometry);
    }
    isTileClipped() {
        return true;
    }
}
export default FillStyleLayer;
//# sourceMappingURL=fill_style_layer.js.map