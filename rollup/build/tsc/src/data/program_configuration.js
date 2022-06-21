import { packUint8ToFloat } from '../shaders/encode_attribute';
import { supportsPropertyExpression } from '../style-spec/util/properties';
import { register } from '../util/web_worker_transfer';
import { PossiblyEvaluatedPropertyValue } from '../style/properties';
import { StructArrayLayout1f4, StructArrayLayout2f8, StructArrayLayout4f16, PatternLayoutArray } from './array_types';
import { clamp } from '../util/util';
import patternAttributes from './bucket/pattern_attributes';
import EvaluationParameters from '../style/evaluation_parameters';
import FeaturePositionMap from './feature_position_map';
import { Uniform1f, UniformColor, Uniform4f } from '../render/uniform_binding';
function packColor(color) {
    return [
        packUint8ToFloat(255 * color.r, 255 * color.g),
        packUint8ToFloat(255 * color.b, 255 * color.a)
    ];
}
class ConstantBinder {
    constructor(value, names, type) {
        this.value = value;
        this.uniformNames = names.map(name => `u_${name}`);
        this.type = type;
    }
    setUniform(uniform, globals, currentValue) {
        uniform.set(currentValue.constantOr(this.value));
    }
    getBinding(context, location, _) {
        return (this.type === 'color') ?
            new UniformColor(context, location) :
            new Uniform1f(context, location);
    }
}
class CrossFadedConstantBinder {
    constructor(value, names) {
        this.uniformNames = names.map(name => `u_${name}`);
        this.patternFrom = null;
        this.patternTo = null;
        this.pixelRatioFrom = 1.0;
        this.pixelRatioTo = 1.0;
    }
    setConstantPatternPositions(posTo, posFrom) {
        this.pixelRatioFrom = posFrom.pixelRatio;
        this.pixelRatioTo = posTo.pixelRatio;
        this.patternFrom = posFrom.tlbr;
        this.patternTo = posTo.tlbr;
    }
    setUniform(uniform, globals, currentValue, uniformName) {
        const pos = uniformName === 'u_pattern_to' ? this.patternTo :
            uniformName === 'u_pattern_from' ? this.patternFrom :
                uniformName === 'u_pixel_ratio_to' ? this.pixelRatioTo :
                    uniformName === 'u_pixel_ratio_from' ? this.pixelRatioFrom : null;
        if (pos)
            uniform.set(pos);
    }
    getBinding(context, location, name) {
        return name.substr(0, 9) === 'u_pattern' ?
            new Uniform4f(context, location) :
            new Uniform1f(context, location);
    }
}
class SourceExpressionBinder {
    constructor(expression, names, type, PaintVertexArray) {
        this.expression = expression;
        this.type = type;
        this.maxValue = 0;
        this.paintVertexAttributes = names.map((name) => ({
            name: `a_${name}`,
            type: 'Float32',
            components: type === 'color' ? 2 : 1,
            offset: 0
        }));
        this.paintVertexArray = new PaintVertexArray();
    }
    populatePaintArray(newLength, feature, imagePositions, canonical, formattedSection) {
        const start = this.paintVertexArray.length;
        const value = this.expression.evaluate(new EvaluationParameters(0), feature, {}, canonical, [], formattedSection);
        this.paintVertexArray.resize(newLength);
        this._setPaintValue(start, newLength, value);
    }
    updatePaintArray(start, end, feature, featureState) {
        const value = this.expression.evaluate({ zoom: 0 }, feature, featureState);
        this._setPaintValue(start, end, value);
    }
    _setPaintValue(start, end, value) {
        if (this.type === 'color') {
            const color = packColor(value);
            for (let i = start; i < end; i++) {
                this.paintVertexArray.emplace(i, color[0], color[1]);
            }
        }
        else {
            for (let i = start; i < end; i++) {
                this.paintVertexArray.emplace(i, value);
            }
            this.maxValue = Math.max(this.maxValue, Math.abs(value));
        }
    }
    upload(context) {
        if (this.paintVertexArray && this.paintVertexArray.arrayBuffer) {
            if (this.paintVertexBuffer && this.paintVertexBuffer.buffer) {
                this.paintVertexBuffer.updateData(this.paintVertexArray);
            }
            else {
                this.paintVertexBuffer = context.createVertexBuffer(this.paintVertexArray, this.paintVertexAttributes, this.expression.isStateDependent);
            }
        }
    }
    destroy() {
        if (this.paintVertexBuffer) {
            this.paintVertexBuffer.destroy();
        }
    }
}
class CompositeExpressionBinder {
    constructor(expression, names, type, useIntegerZoom, zoom, PaintVertexArray) {
        this.expression = expression;
        this.uniformNames = names.map(name => `u_${name}_t`);
        this.type = type;
        this.useIntegerZoom = useIntegerZoom;
        this.zoom = zoom;
        this.maxValue = 0;
        this.paintVertexAttributes = names.map((name) => ({
            name: `a_${name}`,
            type: 'Float32',
            components: type === 'color' ? 4 : 2,
            offset: 0
        }));
        this.paintVertexArray = new PaintVertexArray();
    }
    populatePaintArray(newLength, feature, imagePositions, canonical, formattedSection) {
        const min = this.expression.evaluate(new EvaluationParameters(this.zoom), feature, {}, canonical, [], formattedSection);
        const max = this.expression.evaluate(new EvaluationParameters(this.zoom + 1), feature, {}, canonical, [], formattedSection);
        const start = this.paintVertexArray.length;
        this.paintVertexArray.resize(newLength);
        this._setPaintValue(start, newLength, min, max);
    }
    updatePaintArray(start, end, feature, featureState) {
        const min = this.expression.evaluate({ zoom: this.zoom }, feature, featureState);
        const max = this.expression.evaluate({ zoom: this.zoom + 1 }, feature, featureState);
        this._setPaintValue(start, end, min, max);
    }
    _setPaintValue(start, end, min, max) {
        if (this.type === 'color') {
            const minColor = packColor(min);
            const maxColor = packColor(max);
            for (let i = start; i < end; i++) {
                this.paintVertexArray.emplace(i, minColor[0], minColor[1], maxColor[0], maxColor[1]);
            }
        }
        else {
            for (let i = start; i < end; i++) {
                this.paintVertexArray.emplace(i, min, max);
            }
            this.maxValue = Math.max(this.maxValue, Math.abs(min), Math.abs(max));
        }
    }
    upload(context) {
        if (this.paintVertexArray && this.paintVertexArray.arrayBuffer) {
            if (this.paintVertexBuffer && this.paintVertexBuffer.buffer) {
                this.paintVertexBuffer.updateData(this.paintVertexArray);
            }
            else {
                this.paintVertexBuffer = context.createVertexBuffer(this.paintVertexArray, this.paintVertexAttributes, this.expression.isStateDependent);
            }
        }
    }
    destroy() {
        if (this.paintVertexBuffer) {
            this.paintVertexBuffer.destroy();
        }
    }
    setUniform(uniform, globals) {
        const currentZoom = this.useIntegerZoom ? Math.floor(globals.zoom) : globals.zoom;
        const factor = clamp(this.expression.interpolationFactor(currentZoom, this.zoom, this.zoom + 1), 0, 1);
        uniform.set(factor);
    }
    getBinding(context, location, _) {
        return new Uniform1f(context, location);
    }
}
class CrossFadedCompositeBinder {
    constructor(expression, type, useIntegerZoom, zoom, PaintVertexArray, layerId) {
        this.expression = expression;
        this.type = type;
        this.useIntegerZoom = useIntegerZoom;
        this.zoom = zoom;
        this.layerId = layerId;
        this.zoomInPaintVertexArray = new PaintVertexArray();
        this.zoomOutPaintVertexArray = new PaintVertexArray();
    }
    populatePaintArray(length, feature, imagePositions) {
        const start = this.zoomInPaintVertexArray.length;
        this.zoomInPaintVertexArray.resize(length);
        this.zoomOutPaintVertexArray.resize(length);
        this._setPaintValues(start, length, feature.patterns && feature.patterns[this.layerId], imagePositions);
    }
    updatePaintArray(start, end, feature, featureState, imagePositions) {
        this._setPaintValues(start, end, feature.patterns && feature.patterns[this.layerId], imagePositions);
    }
    _setPaintValues(start, end, patterns, positions) {
        if (!positions || !patterns)
            return;
        const { min, mid, max } = patterns;
        const imageMin = positions[min];
        const imageMid = positions[mid];
        const imageMax = positions[max];
        if (!imageMin || !imageMid || !imageMax)
            return;
        // We populate two paint arrays because, for cross-faded properties, we don't know which direction
        // we're cross-fading to at layout time. In order to keep vertex attributes to a minimum and not pass
        // unnecessary vertex data to the shaders, we determine which to upload at draw time.
        for (let i = start; i < end; i++) {
            this.zoomInPaintVertexArray.emplace(i, imageMid.tl[0], imageMid.tl[1], imageMid.br[0], imageMid.br[1], imageMin.tl[0], imageMin.tl[1], imageMin.br[0], imageMin.br[1], imageMid.pixelRatio, imageMin.pixelRatio);
            this.zoomOutPaintVertexArray.emplace(i, imageMid.tl[0], imageMid.tl[1], imageMid.br[0], imageMid.br[1], imageMax.tl[0], imageMax.tl[1], imageMax.br[0], imageMax.br[1], imageMid.pixelRatio, imageMax.pixelRatio);
        }
    }
    upload(context) {
        if (this.zoomInPaintVertexArray && this.zoomInPaintVertexArray.arrayBuffer && this.zoomOutPaintVertexArray && this.zoomOutPaintVertexArray.arrayBuffer) {
            this.zoomInPaintVertexBuffer = context.createVertexBuffer(this.zoomInPaintVertexArray, patternAttributes.members, this.expression.isStateDependent);
            this.zoomOutPaintVertexBuffer = context.createVertexBuffer(this.zoomOutPaintVertexArray, patternAttributes.members, this.expression.isStateDependent);
        }
    }
    destroy() {
        if (this.zoomOutPaintVertexBuffer)
            this.zoomOutPaintVertexBuffer.destroy();
        if (this.zoomInPaintVertexBuffer)
            this.zoomInPaintVertexBuffer.destroy();
    }
}
/**
 * ProgramConfiguration contains the logic for binding style layer properties and tile
 * layer feature data into GL program uniforms and vertex attributes.
 *
 * Non-data-driven property values are bound to shader uniforms. Data-driven property
 * values are bound to vertex attributes. In order to support a uniform GLSL syntax over
 * both, [Mapbox GL Shaders](https://github.com/mapbox/mapbox-gl-shaders) defines a `#pragma`
 * abstraction, which ProgramConfiguration is responsible for implementing. At runtime,
 * it examines the attributes of a particular layer, combines this with fixed knowledge
 * about how layers of the particular type are implemented, and determines which uniforms
 * and vertex attributes will be required. It can then substitute the appropriate text
 * into the shader source code, create and link a program, and bind the uniforms and
 * vertex attributes in preparation for drawing.
 *
 * When a vector tile is parsed, this same configuration information is used to
 * populate the attribute buffers needed for data-driven styling using the zoom
 * level and feature property data.
 *
 * @private
 */
export default class ProgramConfiguration {
    constructor(layer, zoom, filterProperties) {
        this.binders = {};
        this._buffers = [];
        const keys = [];
        for (const property in layer.paint._values) {
            if (!filterProperties(property))
                continue;
            const value = layer.paint.get(property);
            if (!(value instanceof PossiblyEvaluatedPropertyValue) || !supportsPropertyExpression(value.property.specification)) {
                continue;
            }
            const names = paintAttributeNames(property, layer.type);
            const expression = value.value;
            const type = value.property.specification.type;
            const useIntegerZoom = value.property.useIntegerZoom;
            const propType = value.property.specification['property-type'];
            const isCrossFaded = propType === 'cross-faded' || propType === 'cross-faded-data-driven';
            if (expression.kind === 'constant') {
                this.binders[property] = isCrossFaded ?
                    new CrossFadedConstantBinder(expression.value, names) :
                    new ConstantBinder(expression.value, names, type);
                keys.push(`/u_${property}`);
            }
            else if (expression.kind === 'source' || isCrossFaded) {
                const StructArrayLayout = layoutType(property, type, 'source');
                this.binders[property] = isCrossFaded ?
                    new CrossFadedCompositeBinder(expression, type, useIntegerZoom, zoom, StructArrayLayout, layer.id) :
                    new SourceExpressionBinder(expression, names, type, StructArrayLayout);
                keys.push(`/a_${property}`);
            }
            else {
                const StructArrayLayout = layoutType(property, type, 'composite');
                this.binders[property] = new CompositeExpressionBinder(expression, names, type, useIntegerZoom, zoom, StructArrayLayout);
                keys.push(`/z_${property}`);
            }
        }
        this.cacheKey = keys.sort().join('');
    }
    getMaxValue(property) {
        const binder = this.binders[property];
        return binder instanceof SourceExpressionBinder || binder instanceof CompositeExpressionBinder ? binder.maxValue : 0;
    }
    populatePaintArrays(newLength, feature, imagePositions, canonical, formattedSection) {
        for (const property in this.binders) {
            const binder = this.binders[property];
            if (binder instanceof SourceExpressionBinder || binder instanceof CompositeExpressionBinder || binder instanceof CrossFadedCompositeBinder)
                binder.populatePaintArray(newLength, feature, imagePositions, canonical, formattedSection);
        }
    }
    setConstantPatternPositions(posTo, posFrom) {
        for (const property in this.binders) {
            const binder = this.binders[property];
            if (binder instanceof CrossFadedConstantBinder)
                binder.setConstantPatternPositions(posTo, posFrom);
        }
    }
    updatePaintArrays(featureStates, featureMap, vtLayer, layer, imagePositions) {
        let dirty = false;
        for (const id in featureStates) {
            const positions = featureMap.getPositions(id);
            for (const pos of positions) {
                const feature = vtLayer.feature(pos.index);
                for (const property in this.binders) {
                    const binder = this.binders[property];
                    if ((binder instanceof SourceExpressionBinder || binder instanceof CompositeExpressionBinder ||
                        binder instanceof CrossFadedCompositeBinder) && binder.expression.isStateDependent === true) {
                        //AHM: Remove after https://github.com/mapbox/mapbox-gl-js/issues/6255
                        const value = layer.paint.get(property);
                        binder.expression = value.value;
                        binder.updatePaintArray(pos.start, pos.end, feature, featureStates[id], imagePositions);
                        dirty = true;
                    }
                }
            }
        }
        return dirty;
    }
    defines() {
        const result = [];
        for (const property in this.binders) {
            const binder = this.binders[property];
            if (binder instanceof ConstantBinder || binder instanceof CrossFadedConstantBinder) {
                result.push(...binder.uniformNames.map(name => `#define HAS_UNIFORM_${name}`));
            }
        }
        return result;
    }
    getBinderAttributes() {
        const result = [];
        for (const property in this.binders) {
            const binder = this.binders[property];
            if (binder instanceof SourceExpressionBinder || binder instanceof CompositeExpressionBinder) {
                for (let i = 0; i < binder.paintVertexAttributes.length; i++) {
                    result.push(binder.paintVertexAttributes[i].name);
                }
            }
            else if (binder instanceof CrossFadedCompositeBinder) {
                for (let i = 0; i < patternAttributes.members.length; i++) {
                    result.push(patternAttributes.members[i].name);
                }
            }
        }
        return result;
    }
    getBinderUniforms() {
        const uniforms = [];
        for (const property in this.binders) {
            const binder = this.binders[property];
            if (binder instanceof ConstantBinder || binder instanceof CrossFadedConstantBinder || binder instanceof CompositeExpressionBinder) {
                for (const uniformName of binder.uniformNames) {
                    uniforms.push(uniformName);
                }
            }
        }
        return uniforms;
    }
    getPaintVertexBuffers() {
        return this._buffers;
    }
    getUniforms(context, locations) {
        const uniforms = [];
        for (const property in this.binders) {
            const binder = this.binders[property];
            if (binder instanceof ConstantBinder || binder instanceof CrossFadedConstantBinder || binder instanceof CompositeExpressionBinder) {
                for (const name of binder.uniformNames) {
                    if (locations[name]) {
                        const binding = binder.getBinding(context, locations[name], name);
                        uniforms.push({ name, property, binding });
                    }
                }
            }
        }
        return uniforms;
    }
    setUniforms(context, binderUniforms, properties, globals) {
        // Uniform state bindings are owned by the Program, but we set them
        // from within the ProgramConfiguraton's binder members.
        for (const { name, property, binding } of binderUniforms) {
            this.binders[property].setUniform(binding, globals, properties.get(property), name);
        }
    }
    updatePaintBuffers(crossfade) {
        this._buffers = [];
        for (const property in this.binders) {
            const binder = this.binders[property];
            if (crossfade && binder instanceof CrossFadedCompositeBinder) {
                const patternVertexBuffer = crossfade.fromScale === 2 ? binder.zoomInPaintVertexBuffer : binder.zoomOutPaintVertexBuffer;
                if (patternVertexBuffer)
                    this._buffers.push(patternVertexBuffer);
            }
            else if ((binder instanceof SourceExpressionBinder || binder instanceof CompositeExpressionBinder) && binder.paintVertexBuffer) {
                this._buffers.push(binder.paintVertexBuffer);
            }
        }
    }
    upload(context) {
        for (const property in this.binders) {
            const binder = this.binders[property];
            if (binder instanceof SourceExpressionBinder || binder instanceof CompositeExpressionBinder || binder instanceof CrossFadedCompositeBinder)
                binder.upload(context);
        }
        this.updatePaintBuffers();
    }
    destroy() {
        for (const property in this.binders) {
            const binder = this.binders[property];
            if (binder instanceof SourceExpressionBinder || binder instanceof CompositeExpressionBinder || binder instanceof CrossFadedCompositeBinder)
                binder.destroy();
        }
    }
}
export class ProgramConfigurationSet {
    constructor(layers, zoom, filterProperties = () => true) {
        this.programConfigurations = {};
        for (const layer of layers) {
            this.programConfigurations[layer.id] = new ProgramConfiguration(layer, zoom, filterProperties);
        }
        this.needsUpload = false;
        this._featureMap = new FeaturePositionMap();
        this._bufferOffset = 0;
    }
    populatePaintArrays(length, feature, index, imagePositions, canonical, formattedSection) {
        for (const key in this.programConfigurations) {
            this.programConfigurations[key].populatePaintArrays(length, feature, imagePositions, canonical, formattedSection);
        }
        if (feature.id !== undefined) {
            this._featureMap.add(feature.id, index, this._bufferOffset, length);
        }
        this._bufferOffset = length;
        this.needsUpload = true;
    }
    updatePaintArrays(featureStates, vtLayer, layers, imagePositions) {
        for (const layer of layers) {
            this.needsUpload = this.programConfigurations[layer.id].updatePaintArrays(featureStates, this._featureMap, vtLayer, layer, imagePositions) || this.needsUpload;
        }
    }
    get(layerId) {
        return this.programConfigurations[layerId];
    }
    upload(context) {
        if (!this.needsUpload)
            return;
        for (const layerId in this.programConfigurations) {
            this.programConfigurations[layerId].upload(context);
        }
        this.needsUpload = false;
    }
    destroy() {
        for (const layerId in this.programConfigurations) {
            this.programConfigurations[layerId].destroy();
        }
    }
}
function paintAttributeNames(property, type) {
    const attributeNameExceptions = {
        'text-opacity': ['opacity'],
        'icon-opacity': ['opacity'],
        'text-color': ['fill_color'],
        'icon-color': ['fill_color'],
        'text-halo-color': ['halo_color'],
        'icon-halo-color': ['halo_color'],
        'text-halo-blur': ['halo_blur'],
        'icon-halo-blur': ['halo_blur'],
        'text-halo-width': ['halo_width'],
        'icon-halo-width': ['halo_width'],
        'line-gap-width': ['gapwidth'],
        'line-pattern': ['pattern_to', 'pattern_from', 'pixel_ratio_to', 'pixel_ratio_from'],
        'fill-pattern': ['pattern_to', 'pattern_from', 'pixel_ratio_to', 'pixel_ratio_from'],
        'fill-extrusion-pattern': ['pattern_to', 'pattern_from', 'pixel_ratio_to', 'pixel_ratio_from'],
    };
    return attributeNameExceptions[property] || [property.replace(`${type}-`, '').replace(/-/g, '_')];
}
function getLayoutException(property) {
    const propertyExceptions = {
        'line-pattern': {
            'source': PatternLayoutArray,
            'composite': PatternLayoutArray
        },
        'fill-pattern': {
            'source': PatternLayoutArray,
            'composite': PatternLayoutArray
        },
        'fill-extrusion-pattern': {
            'source': PatternLayoutArray,
            'composite': PatternLayoutArray
        }
    };
    return propertyExceptions[property];
}
function layoutType(property, type, binderType) {
    const defaultLayouts = {
        'color': {
            'source': StructArrayLayout2f8,
            'composite': StructArrayLayout4f16
        },
        'number': {
            'source': StructArrayLayout1f4,
            'composite': StructArrayLayout2f8
        }
    };
    const layoutException = getLayoutException(property);
    return layoutException && layoutException[binderType] || defaultLayouts[type][binderType];
}
register('ConstantBinder', ConstantBinder);
register('CrossFadedConstantBinder', CrossFadedConstantBinder);
register('SourceExpressionBinder', SourceExpressionBinder);
register('CrossFadedCompositeBinder', CrossFadedCompositeBinder);
register('CompositeExpressionBinder', CompositeExpressionBinder);
register('ProgramConfiguration', ProgramConfiguration, { omit: ['_buffers'] });
register('ProgramConfigurationSet', ProgramConfigurationSet);
//# sourceMappingURL=program_configuration.js.map