import StyleLayer from '../style_layer';
import HeatmapBucket from '../../data/bucket/heatmap_bucket';
import properties from './heatmap_style_layer_properties';
import { renderColorRamp } from '../../util/color_ramp';
class HeatmapStyleLayer extends StyleLayer {
    constructor(layer) {
        super(layer, properties);
        // make sure color ramp texture is generated for default heatmap color too
        this._updateColorRamp();
    }
    createBucket(options) {
        return new HeatmapBucket(options);
    }
    _handleSpecialPaintPropertyUpdate(name) {
        if (name === 'heatmap-color') {
            this._updateColorRamp();
        }
    }
    _updateColorRamp() {
        const expression = this._transitionablePaint._values['heatmap-color'].value.expression;
        this.colorRamp = renderColorRamp({
            expression,
            evaluationKey: 'heatmapDensity',
            image: this.colorRamp
        });
        this.colorRampTexture = null;
    }
    resize() {
        if (this.heatmapFbo) {
            this.heatmapFbo.destroy();
            this.heatmapFbo = null;
        }
    }
    queryRadius() {
        return 0;
    }
    queryIntersectsFeature() {
        return false;
    }
    hasOffscreenPass() {
        return this.paint.get('heatmap-opacity') !== 0 && this.visibility !== 'none';
    }
}
export default HeatmapStyleLayer;
//# sourceMappingURL=heatmap_style_layer.js.map