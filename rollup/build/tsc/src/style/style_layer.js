import { filterObject } from '../util/util';
import styleSpec from '../style-spec/reference/latest';
import { validateStyle, validateLayoutProperty, validatePaintProperty, emitValidationErrors } from './validate_style';
import { Evented } from '../util/evented';
import { Layout, Transitionable, PossiblyEvaluated, PossiblyEvaluatedPropertyValue } from './properties';
import { supportsPropertyExpression } from '../style-spec/util/properties';
const TRANSITION_SUFFIX = '-transition';
class StyleLayer extends Evented {
    constructor(layer, properties) {
        super();
        this.id = layer.id;
        this.type = layer.type;
        this._featureFilter = { filter: () => true, needGeometry: false };
        if (layer.type === 'custom')
            return;
        layer = layer;
        this.metadata = layer.metadata;
        this.minzoom = layer.minzoom;
        this.maxzoom = layer.maxzoom;
        if (layer.type !== 'background') {
            this.source = layer.source;
            this.sourceLayer = layer['source-layer'];
            this.filter = layer.filter;
        }
        if (properties.layout) {
            this._unevaluatedLayout = new Layout(properties.layout);
        }
        if (properties.paint) {
            this._transitionablePaint = new Transitionable(properties.paint);
            for (const property in layer.paint) {
                this.setPaintProperty(property, layer.paint[property], { validate: false });
            }
            for (const property in layer.layout) {
                this.setLayoutProperty(property, layer.layout[property], { validate: false });
            }
            this._transitioningPaint = this._transitionablePaint.untransitioned();
            //$FlowFixMe
            this.paint = new PossiblyEvaluated(properties.paint);
        }
    }
    getCrossfadeParameters() {
        return this._crossfadeParameters;
    }
    getLayoutProperty(name) {
        if (name === 'visibility') {
            return this.visibility;
        }
        return this._unevaluatedLayout.getValue(name);
    }
    setLayoutProperty(name, value, options = {}) {
        if (value !== null && value !== undefined) {
            const key = `layers.${this.id}.layout.${name}`;
            if (this._validate(validateLayoutProperty, key, name, value, options)) {
                return;
            }
        }
        if (name === 'visibility') {
            this.visibility = value;
            return;
        }
        this._unevaluatedLayout.setValue(name, value);
    }
    getPaintProperty(name) {
        if (name.endsWith(TRANSITION_SUFFIX)) {
            return this._transitionablePaint.getTransition(name.slice(0, -TRANSITION_SUFFIX.length));
        }
        else {
            return this._transitionablePaint.getValue(name);
        }
    }
    setPaintProperty(name, value, options = {}) {
        if (value !== null && value !== undefined) {
            const key = `layers.${this.id}.paint.${name}`;
            if (this._validate(validatePaintProperty, key, name, value, options)) {
                return false;
            }
        }
        if (name.endsWith(TRANSITION_SUFFIX)) {
            this._transitionablePaint.setTransition(name.slice(0, -TRANSITION_SUFFIX.length), value || undefined);
            return false;
        }
        else {
            const transitionable = this._transitionablePaint._values[name];
            const isCrossFadedProperty = transitionable.property.specification['property-type'] === 'cross-faded-data-driven';
            const wasDataDriven = transitionable.value.isDataDriven();
            const oldValue = transitionable.value;
            this._transitionablePaint.setValue(name, value);
            this._handleSpecialPaintPropertyUpdate(name);
            const newValue = this._transitionablePaint._values[name].value;
            const isDataDriven = newValue.isDataDriven();
            // if a cross-faded value is changed, we need to make sure the new icons get added to each tile's iconAtlas
            // so a call to _updateLayer is necessary, and we return true from this function so it gets called in
            // Style#setPaintProperty
            return isDataDriven || wasDataDriven || isCrossFadedProperty || this._handleOverridablePaintPropertyUpdate(name, oldValue, newValue);
        }
    }
    _handleSpecialPaintPropertyUpdate(_) {
        // No-op; can be overridden by derived classes.
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _handleOverridablePaintPropertyUpdate(name, oldValue, newValue) {
        // No-op; can be overridden by derived classes.
        return false;
    }
    isHidden(zoom) {
        if (this.minzoom && zoom < this.minzoom)
            return true;
        if (this.maxzoom && zoom >= this.maxzoom)
            return true;
        return this.visibility === 'none';
    }
    updateTransitions(parameters) {
        this._transitioningPaint = this._transitionablePaint.transitioned(parameters, this._transitioningPaint);
    }
    hasTransition() {
        return this._transitioningPaint.hasTransition();
    }
    recalculate(parameters, availableImages) {
        if (parameters.getCrossfadeParameters) {
            this._crossfadeParameters = parameters.getCrossfadeParameters();
        }
        if (this._unevaluatedLayout) {
            this.layout = this._unevaluatedLayout.possiblyEvaluate(parameters, undefined, availableImages);
        }
        this.paint = this._transitioningPaint.possiblyEvaluate(parameters, undefined, availableImages);
    }
    serialize() {
        const output = {
            'id': this.id,
            'type': this.type,
            'source': this.source,
            'source-layer': this.sourceLayer,
            'metadata': this.metadata,
            'minzoom': this.minzoom,
            'maxzoom': this.maxzoom,
            'filter': this.filter,
            'layout': this._unevaluatedLayout && this._unevaluatedLayout.serialize(),
            'paint': this._transitionablePaint && this._transitionablePaint.serialize()
        };
        if (this.visibility) {
            output.layout = output.layout || {};
            output.layout.visibility = this.visibility;
        }
        return filterObject(output, (value, key) => {
            return value !== undefined &&
                !(key === 'layout' && !Object.keys(value).length) &&
                !(key === 'paint' && !Object.keys(value).length);
        });
    }
    _validate(validate, key, name, value, options = {}) {
        if (options && options.validate === false) {
            return false;
        }
        return emitValidationErrors(this, validate.call(validateStyle, {
            key,
            layerType: this.type,
            objectKey: name,
            value,
            styleSpec,
            // Workaround for https://github.com/mapbox/mapbox-gl-js/issues/2407
            style: { glyphs: true, sprite: true }
        }));
    }
    is3D() {
        return false;
    }
    isTileClipped() {
        return false;
    }
    hasOffscreenPass() {
        return false;
    }
    resize() {
        // noop
    }
    isStateDependent() {
        for (const property in this.paint._values) {
            const value = this.paint.get(property);
            if (!(value instanceof PossiblyEvaluatedPropertyValue) || !supportsPropertyExpression(value.property.specification)) {
                continue;
            }
            if ((value.value.kind === 'source' || value.value.kind === 'composite') &&
                value.value.isStateDependent) {
                return true;
            }
        }
        return false;
    }
}
export default StyleLayer;
//# sourceMappingURL=style_layer.js.map