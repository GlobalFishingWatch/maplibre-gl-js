import StyleLayer from '../style_layer';
import assert from 'assert';
export function validateCustomStyleLayer(layerObject) {
    const errors = [];
    const id = layerObject.id;
    if (id === undefined) {
        errors.push({
            message: `layers.${id}: missing required property "id"`
        });
    }
    if (layerObject.render === undefined) {
        errors.push({
            message: `layers.${id}: missing required method "render"`
        });
    }
    if (layerObject.renderingMode &&
        layerObject.renderingMode !== '2d' &&
        layerObject.renderingMode !== '3d') {
        errors.push({
            message: `layers.${id}: property "renderingMode" must be either "2d" or "3d"`
        });
    }
    return errors;
}
class CustomStyleLayer extends StyleLayer {
    constructor(implementation) {
        super(implementation, {});
        this.onAdd = (map) => {
            if (this.implementation.onAdd) {
                this.implementation.onAdd(map, map.painter.context.gl);
            }
        };
        this.onRemove = (map) => {
            if (this.implementation.onRemove) {
                this.implementation.onRemove(map, map.painter.context.gl);
            }
        };
        this.implementation = implementation;
    }
    is3D() {
        return this.implementation.renderingMode === '3d';
    }
    hasOffscreenPass() {
        return this.implementation.prerender !== undefined;
    }
    recalculate() { }
    updateTransitions() { }
    hasTransition() { return false; }
    serialize() {
        assert(false, 'Custom layers cannot be serialized');
    }
}
export default CustomStyleLayer;
//# sourceMappingURL=custom_style_layer.js.map